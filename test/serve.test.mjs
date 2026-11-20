// The bridge to `codar serve`: the desktop's own local server on 127.0.0.1:8080
// answers the chat, and this plugin asks it instead of the gateway.
//
// Why the bridge exists at all, in one line: a direct call to
// api.claw.speedai.com with any headers or body is refused with
// {"code":"client_not_supported","message":"This login credential is restricted
// to Codar."} (measured 2026-11-21), while the same account's credential asked
// through the app's own server answers 200 and the model replies. So the
// conversation goes where the app's own conversation goes: to loopback.
//
// What the server says (measured 2026-11-21, codar.exe serve, this machine):
//   POST /api/chat  {"message": "hi"}  → application/json? no: Server-Sent
//   Events, `data: {json}\n\n` per line, each carrying the vendor's own fields:
//     {"data":{"started_at":…},"event":"run_started","op_id":"sse_…",…}
//     {"data":{"disposition":"admitted","run":{…}},"event":"run_state",…}
//     {"data":{"text":"你好！有什么可以帮你的"},"event":"text_delta",…}
//     {"data":{"model":"auto","input_tokens":19522,…},"event":"context_usage",…}
//     {"data":{…},"event":"result","outcome":"completed","provider_stop_reason":"stop",…}
//     {"data":null,"event":"done",…}
//     refused: HTTP 400 {"error":"message is required"} (application/json)
//
// The failure the suite has to catch is not a wrong byte: it is a bridge that
// hangs. A `result` with an outcome other than "completed" must reach magpie as
// an error, and a server that is not there must reach magpie as an error too —
// never as a stream that opens and then says nothing.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  CODAR_PORT,
  DEFAULT_CODAR_HOME,
  SCAN_MAX_DIRS_PER_ROOT,
  SCAN_MAX_ENTRIES,
  chatStream,
  codarServeExecutable,
  ensureServe,
  forgetScannedCodar,
  openAIStream,
  resolveServeExecutable,
  serveBase,
  sseToOpenAI,
} from "../lib/serve.mjs"

// ---- helpers ---------------------------------------------------------------

// sseBody answers the byte sequence the real server sends: one `data: ` line
// per event, a blank line between, the last one without its trailing blank
// (measured: the server closes the stream after `done`).
const sseBody = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")

const EVENTS = [
  { data: { started_at: 1795208712724 }, event: "run_started", op_id: "sse_1_web-ui", session_id: "web-ui" },
  { data: { disposition: "admitted", run: { model: "auto", reasoning_effort: "high" } }, event: "run_state", op_id: "sse_1_web-ui", session_id: "web-ui" },
  { data: { text: "你好！有什么可以帮你的" }, event: "text_delta", op_id: "sse_1_web-ui", session_id: "web-ui" },
  { data: { text: "吗" }, event: "text_delta", op_id: "sse_1_web-ui", session_id: "web-ui" },
  { data: { text: "？" }, event: "text_delta", op_id: "sse_1_web-ui", session_id: "web-ui" },
  { data: { model: "auto", input_tokens: 19522, output_tokens: 9, total_tokens: 19531 }, event: "context_usage", op_id: "sse_1_web-ui", session_id: "web-ui" },
  { completed_at: 1795208714470, data: { model: "auto", input_tokens: 19522, output_tokens: 9, total_tokens: 19531 }, event: "result", outcome: "completed", op_id: "sse_1_web-ui", provider_stop_reason: "stop", reason: "", session_id: "web-ui" },
  { completed_at: 1795208714470, data: null, event: "done", op_id: "sse_1_web-ui", session_id: "web-ui" },
]
const ANSWER = "你好！有什么可以帮你的吗？"

// listen starts a fake serve on a free loopback port and answers with
// { port, url, close, requests }. Every request is recorded with its method,
// path, headers and parsed body, so a bridge that sends the wrong shape is
// visible rather than inferred. `routes` maps "METHOD /path" to a handler
// (req, res, call) → void; anything unrouted is a 404 in the server's own JSON
// shape, which is what a bridge pointed at the wrong path should meet.
// deadPort is a port on this machine with nothing listening on it: a real,
// unused port rather than a made-up one, because fetch refuses a port it calls
// forbidden outright (9 answers "bad port" before a socket is ever opened, and
// that refusal is not the connection failure this suite is about).
const deadPort = async () => {
  const probe = createServer()
  const taken = await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(probe.address().port)))
  await new Promise((r) => probe.close(r))
  return taken
}

const listen = async (routes = {}, port = 0) => {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8")
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = text
      }
      const call = { method: req.method, path: req.url, headers: req.headers, body }
      requests.push(call)
      const handler = routes[`${req.method} ${req.url}`] ?? routes[req.url] ?? routes[req.method]
      if (!handler) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "not found" }))
        return
      }
      handler(req, res, call)
    })
  })
  await new Promise((r) => server.listen(port, "127.0.0.1", r))
  const bound = server.address().port
  return {
    port: bound,
    url: `http://127.0.0.1:${bound}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  }
}

// settings is the answer the real server gives at /api/desktop/settings: the
// model the account is set to rides in provider.speedai.model (measured), and
// the home and config path the server itself is using.
const settings = (model = "auto") => ({
  paths: { config: `${DEFAULT_CODAR_HOME}\\config.json`, home: DEFAULT_CODAR_HOME, sessions_dir: `${DEFAULT_CODAR_HOME}\\sessions` },
  provider: {
    active_profile: "speedai",
    api_base: "https://api.claw.speedai.com/v1",
    auth_type: "speedai",
    configured: true,
    model,
    provider_profiles: { speedai: { api_base: "https://api.claw.speedai.com/v1", model, speedai_logged_in: true, speedai_username: "user_1" } },
    speedai_logged_in: true,
  },
  settings: { permission_mode: "full", default_model: "gpt-6.2-sol", default_reasoning_effort: "high" },
})

// sseHandler answers the chat the way the server does: event lines over the
// connection, chunk by chunk, then close. `chunk` is how many events go out per
// write — one is the real shape (each event arrives on its own). The caller
// names the whole sequence, `done` included: the server sends exactly one, and
// a fixture that added a second would be testing a conversation that cannot
// happen.
const sseHandler =
  (events = EVENTS, { status = 200, chunk = 1, delayMs = 0 } = {}) =>
  async (req, res) => {
    res.writeHead(status, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" })
    if (chunk === 0) {
      res.end(sseBody(events))
      return
    }
    for (let i = 0; i < events.length; i += chunk) {
      res.write(sseBody(events.slice(i, i + chunk)))
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    }
    res.end()
  }

// openaiChunks parses the OpenAI stream a bridge answered back into the chunks
// it carried. A `data: [DONE]` line is not a chunk and is reported separately
// by doneSent, because the host needs it exactly once.
const openaiChunks = (text) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .filter((d) => d.trim() && d.trim() !== "[DONE]")
    .map((d) => JSON.parse(d))

// first pulls one event out of a stream so its generator starts: a generator
// body runs on the first next(), and the rejection a test expects happens
// there — an assertion that only constructs the iterator never sees it.
const first = async (iter) => {
  for await (const event of iter) return event
  return null
}

// collect drains the bridge's async iterator into a list: the chunks of a
// streamed answer are produced one at a time, from a source that may be a
// network stream, so reading them is itself asynchronous.
const collect = async (iter) => {
  const out = []
  for (;;) {
    const step = await iter.next()
    if (step?.done) break
    out.push(step.value)
  }
  return out
}

const doneSent = (text) => text.split("\n").filter((l) => l.trim() === "data: [DONE]").length

// fakeTree is a filesystem a test states, so "which path is used when three of
// them could be" is a fact rather than a property of the machine running the
// suite. `files` are the paths that exist; `dirs` maps a directory to the names
// in it; `config` is what config.json answers (no config at all when it is
// absent). Every call is recorded, which is what the scan's bounds and the
// "CODAR_BIN is never scanned over" rule are asserted on: a scan that ran shows
// up as a readdir, and a candidate that was looked at shows up as an exists.
const fakeTree = ({ files = [], dirs = {}, config } = {}) => {
  const there = new Set(files)
  const listed = new Map(Object.entries(dirs).map(([dir, names]) => [dir, names.map((name) => (typeof name === "string" ? { name, dir: true } : name))]))
  const calls = { exists: [], readdir: [], readFile: [] }
  const miss = (what, path) => {
    const e = new Error(`ENOENT: no such file or directory, ${what} '${path}'`)
    e.code = "ENOENT"
    return e
  }
  return {
    calls,
    existsSync(path) {
      calls.exists.push(path)
      return there.has(path)
    },
    readdirSync(dir) {
      calls.readdir.push(dir)
      const entries = listed.get(dir)
      if (!entries) throw miss("scandir", dir)
      return entries.map((entry) => ({ name: entry.name, isDirectory: () => entry.dir !== false, isFile: () => entry.dir === false }))
    },
    readFileSync(path) {
      calls.readFile.push(path)
      if (typeof config !== "string") throw miss("open", path)
      return config
    },
  }
}

// INSTALLED is this machine's own layout, which is the case the drive scan
// exists for: no standard install, no config field, and the app inside
// D:\software under a folder named after the installer it came from.
const INSTALLED = "D:\\software\\Codar-Setup-latest\\codar-desktop\\resources\\bin\\codar.exe"
const INSTALL_DIRS = { "D:\\": ["software", "temp"], "D:\\software": ["Codar-Setup-latest"], "D:\\temp": [] }

// WIN_LOCAL is a %LOCALAPPDATA% a test can state, and WIN_STANDARD is where the
// vendor's per-user setup puts the binary under it. The string is built with
// join(), as the module builds it, so the two agree on a machine whose
// separator is not a backslash as well.
const WIN_LOCAL = "C:\\Users\\u\\AppData\\Local"
const WIN_STANDARD = join(WIN_LOCAL, "Programs", "Codar", "resources", "bin", "codar.exe")

// winMachine is the machine the ensureServe tests run against: a Windows
// install where the vendor put it, so no test depends on whether this
// computer's app is installed, and none can start this computer's real app.
const winMachine = (files = [WIN_STANDARD]) => fakeTree({ files, dirs: INSTALL_DIRS })

// ---- A) codarServeExecutable ----------------------------------------------

test("codarServeExecutable names the desktop's server per platform, and CODAR_BIN overrides it", () => {
  // The server is a subcommand of the app's own binary, so its path is the
  // app's install path per platform. The install figures are the vendor's own
  // (Codar-Setup, 0.3.x): Windows drops the app into %LOCALAPPDATA%\Programs,
  // macOS into /Applications, Linux into the user's .local share. The
  // filesystem is stated rather than read: what this test is about is the path
  // the platform names, not whether this computer has the app.
  const saved = process.env.CODAR_BIN
  const empty = () => fakeTree({})
  const home = "C:\\Users\\u\\.codar"
  try {
    delete process.env.CODAR_BIN
    forgetScannedCodar()
    assert.equal(codarServeExecutable("win32", WIN_LOCAL, { fs: empty(), home, roots: [] }), WIN_STANDARD)
    assert.equal(codarServeExecutable("darwin", "/Users/u", { fs: empty(), home, roots: [] }), "/Applications/Codar.app/Contents/Resources/bin/codar")
    assert.equal(codarServeExecutable("linux", "/home/u", { fs: empty(), home, roots: [] }), join("/home/u/.local/share", "codar", "resources", "bin", "codar"))
    // The environment variable is what a machine that installed the app
    // somewhere else says: the path it names is the path used, verbatim.
    process.env.CODAR_BIN = INSTALLED
    assert.equal(codarServeExecutable("win32", WIN_LOCAL, { fs: empty(), home, roots: [] }), process.env.CODAR_BIN, "CODAR_BIN is the executable")
    process.env.CODAR_BIN = "   "
    assert.notEqual(codarServeExecutable("win32", "C:\\x", { fs: empty(), home, roots: [] }), "   ", "a blank value is not a path")
  } finally {
    if (saved === undefined) delete process.env.CODAR_BIN
    else process.env.CODAR_BIN = saved
  }
})


test("codarServeExecutable: CODAR_BIN is the answer the moment it is set, and no drive is walked for it", () => {
  // The environment variable wins outright — over an install this search could
  // find — because the person said where the app is. The scan is what must not
  // happen: a CODAR_BIN is a statement about this machine, and walking three
  // drives to answer with something else would hide a typo behind a server
  // nobody asked for.
  const saved = process.env.CODAR_BIN
  const tree = fakeTree({ files: [INSTALLED], dirs: INSTALL_DIRS })
  try {
    process.env.CODAR_BIN = "D:\\elsewhere\\bin\\codar.exe"
    forgetScannedCodar()
    assert.equal(codarServeExecutable("win32", WIN_LOCAL, { fs: tree, home: "C:\\h\\.codar", roots: ["D:\\"] }), process.env.CODAR_BIN, "CODAR_BIN wins over an install the scan could find")
    assert.equal(tree.calls.readdir.length, 0, "the drives were walked over a CODAR_BIN")
    assert.equal(tree.calls.exists.length, 0, "and no path was even looked for")
  } finally {
    if (saved === undefined) delete process.env.CODAR_BIN
    else process.env.CODAR_BIN = saved
    forgetScannedCodar()
  }
})

test("ensureServe: a CODAR_BIN that is not there is named as missing, not scanned over", async () => {
  // The failure a person can act on names the path they gave and says nothing is
  // at it. Falling back to the scan would start a different install than the one
  // they pointed at, and the sentence would send them looking for an app they
  // already have.
  const saved = process.env.CODAR_BIN
  const named = "D:\\nowhere\\codar.exe"
  const tree = fakeTree({ files: [INSTALLED], dirs: INSTALL_DIRS })
  try {
    process.env.CODAR_BIN = named
    forgetScannedCodar()
    let spawned = 0
    const got = await ensureServe({ port: 6555, probe: () => false, spawn: () => (spawned++, {}), platform: "win32", localAppData: WIN_LOCAL, fs: tree, roots: ["D:\\"], timeoutMs: 100 })
    assert.equal(got.ok, false)
    assert.ok(got.reason.includes(named), `the reason does not name ${named}`)
    assert.match(got.reason, /不存在/, "the reason does not say the path is not there")
    assert.equal(spawned, 0, "the missing executable was spawned anyway")
    assert.equal(tree.calls.readdir.length, 0, "the install the scan could find was used instead")
  } finally {
    if (saved === undefined) delete process.env.CODAR_BIN
    else process.env.CODAR_BIN = saved
    forgetScannedCodar()
  }
})

test("codarServeExecutable: a standard install, or the path the app's config.json records, is used when it is there", () => {
  // The vendor's three layouts: the per-user install under the app's own name,
  // the same under the folder the setup extracted (codar-desktop), and the
  // all-users install under %PROGRAMFILES%. A machine has one of them; the test
  // states each in turn and checks that the one that is there is the one used —
  // and that no drive was walked to find it.
  //
  // The app's own config.json is the next thing a machine can say: an
  // `install_dir` (the folder the app sits in) or an `app_path` (the executable
  // itself) is read from it rather than making the person repeat the path in
  // CODAR_BIN. Both fields are stated here, each with no standard install to
  // answer first.
  const saved = process.env.CODAR_BIN
  const programFiles = "D:\\Program Files"
  const standard = [
    join(WIN_LOCAL, "Programs", "Codar", "resources", "bin", "codar.exe"),
    join(WIN_LOCAL, "Programs", "codar-desktop", "resources", "bin", "codar.exe"),
    join(programFiles, "Codar", "resources", "bin", "codar.exe"),
  ]
  const installDir = "D:\\apps\\Codar"
  const recorded = [
    ["install_dir", installDir, join(installDir, "codar-desktop", "resources", "bin", "codar.exe")],
    ["app_path", "D:\\apps\\Codar\\bin\\codar.exe", "D:\\apps\\Codar\\bin\\codar.exe"],
  ]
  try {
    delete process.env.CODAR_BIN
    for (const only of standard) {
      forgetScannedCodar()
      const tree = fakeTree({ files: [only], dirs: INSTALL_DIRS })
      const got = resolveServeExecutable("win32", WIN_LOCAL, { fs: tree, home: "C:\\h\\.codar", programFiles, roots: ["D:\\"] })
      assert.equal(got.path, only, `the standard path ${only} was not the answer`)
      assert.equal(got.source, "standard")
      assert.equal(tree.calls.readdir.length, 0, "a standard install was answered by walking a drive")
    }
    for (const [field, value, expected] of recorded) {
      forgetScannedCodar()
      const tree = fakeTree({ files: [expected], dirs: INSTALL_DIRS, config: JSON.stringify({ [field]: value }) })
      const got = resolveServeExecutable("win32", WIN_LOCAL, { fs: tree, home: "C:\\h\\.codar", programFiles, roots: ["D:\\"] })
      assert.equal(got.path, expected, `config.json's ${field} was not used`)
      assert.equal(got.source, "config")
      assert.equal(tree.calls.readdir.length, 0, `config.json's ${field} was answered by walking a drive`)
    }
  } finally {
    if (saved === undefined) delete process.env.CODAR_BIN
    else process.env.CODAR_BIN = saved
  }
})

test("codarServeExecutable: a Codar* folder on a drive is found when no standard install is", () => {
  // The machine this was written on: no install in any standard place, no
  // install_dir in config.json, and the app in D:\software\Codar-Setup-latest.
  // The layout the scan is for is a `Codar*` folder one name below a drive root
  // — and it must not go further: a copy three names down is never opened, nor
  // even looked at.
  const saved = process.env.CODAR_BIN
  const tooDeep = "D:\\a\\b\\Codar-too-deep\\codar-desktop\\resources\\bin\\codar.exe"
  const dirs = { "D:\\": ["a", "software"], "D:\\a": ["b"], "D:\\a\\b": ["Codar-too-deep"], "D:\\software": ["Codar-Setup-latest"] }
  try {
    delete process.env.CODAR_BIN
    forgetScannedCodar()
    const tree = fakeTree({ files: [INSTALLED, tooDeep], dirs })
    const got = resolveServeExecutable("win32", WIN_LOCAL, { fs: tree, home: "C:\\h\\.codar", roots: ["D:\\"] })
    assert.equal(got.path, INSTALLED, "the drive's own install was not found")
    assert.equal(got.source, "scan")
    assert.equal(got.scanned, true)
    assert.deepEqual(got.drives, ["D:\\"], "the scan walked a drive it was not given")
    assert.ok(!tree.calls.exists.includes(tooDeep), "a folder three names below the drive root was opened")
    assert.ok(!tree.calls.readdir.includes("D:\\a\\b"), "the scan went past its depth")
  } finally {
    if (saved === undefined) delete process.env.CODAR_BIN
    else process.env.CODAR_BIN = saved
    forgetScannedCodar()
  }
})

test("codarServeExecutable: the drive scan runs once and its answer is remembered", () => {
  // A miss must not cost a disk walk per request: the scan is remembered, so a
  // machine whose app is installed somewhere unusual pays for the walk when the
  // process starts, not when a conversation starts.
  const saved = process.env.CODAR_BIN
  try {
    delete process.env.CODAR_BIN
    forgetScannedCodar()
    const tree = fakeTree({ files: [INSTALLED], dirs: INSTALL_DIRS })
    const machine = { fs: tree, home: "C:\\h\\.codar", roots: ["D:\\"] }
    const first = resolveServeExecutable("win32", WIN_LOCAL, machine)
    const walked = tree.calls.readdir.length
    assert.ok(walked > 0, "the first call never walked the drive")
    assert.equal(first.path, INSTALLED)
    const second = resolveServeExecutable("win32", WIN_LOCAL, machine)
    assert.equal(second.path, INSTALLED, "the remembered answer is not the one the first call gave")
    assert.equal(second.source, "scan")
    assert.equal(tree.calls.readdir.length, walked, "the second call walked the drive again")
  } finally {
    if (saved === undefined) delete process.env.CODAR_BIN
    else process.env.CODAR_BIN = saved
    forgetScannedCodar()
  }
})

test("codarServeExecutable: the drive scan is bounded — a directory of 1000 entries is not stat()ed in full", () => {
  // The bound is what keeps a miss cheap on a machine whose root holds a
  // thousand folders: at most SCAN_MAX_ENTRIES names of a directory are looked
  // at, and only SCAN_MAX_DIRS_PER_ROOT directories of a drive are opened. The
  // test states a drive of 1000 `Codar*` folders and counts what the scan did.
  const saved = process.env.CODAR_BIN
  const many = Array.from({ length: 1000 }, (_, i) => `Codar-${i}`)
  try {
    delete process.env.CODAR_BIN
    forgetScannedCodar()
    const tree = fakeTree({ files: [], dirs: { "D:\\": many } })
    const got = resolveServeExecutable("win32", WIN_LOCAL, { fs: tree, home: "C:\\h\\.codar", roots: ["D:\\"] })
    assert.equal(got.source, "standard", "nothing was there, so the search falls back to the standard path")
    const checked = tree.calls.exists.filter((path) => /^D:\\Codar-\d+\\codar-desktop/.test(path))
    assert.ok(checked.length > 0, "the scan skipped the drive's folders entirely")
    assert.ok(checked.length < many.length, `stat()ed ${checked.length} of the drive's 1000 folders`)
    assert.ok(checked.length <= SCAN_MAX_ENTRIES, `stat()ed ${checked.length} folders, past the ${SCAN_MAX_ENTRIES} bound`)
    assert.ok(tree.calls.readdir.length <= 1 + SCAN_MAX_DIRS_PER_ROOT, `opened ${tree.calls.readdir.length} directories on one drive`)
  } finally {
    if (saved === undefined) delete process.env.CODAR_BIN
    else process.env.CODAR_BIN = saved
    forgetScannedCodar()
  }
})


test("serveBase and CODAR_PORT are the loopback address the server listens on", () => {
  assert.equal(serveBase(8080), "http://127.0.0.1:8080")
  assert.equal(CODAR_PORT, 8080, "the server's own default port")
  assert.equal(serveBase(9000), "http://127.0.0.1:9000", "another port is the user's own")
})

test("DEFAULT_CODAR_HOME is the app's home, from CODAR_HOME when it is set", () => {
  // The app takes CODAR_HOME over ~/.codar (the same rule internal.mjs's
  // configPath reads the token under), and the server is spawned with it so
  // the spawned server is the same install the user signed in to.
  const saved = process.env.CODAR_HOME
  try {
    delete process.env.CODAR_HOME
    assert.match(DEFAULT_CODAR_HOME(), /\.codar$/)
    process.env.CODAR_HOME = "D:\\custom-codar"
    assert.equal(DEFAULT_CODAR_HOME(), "D:\\custom-codar")
  } finally {
    if (saved === undefined) delete process.env.CODAR_HOME
    else process.env.CODAR_HOME = saved
  }
})

// ---- B) ensureServe --------------------------------------------------------

test("ensureServe: a server already answering is joined, not started", async () => {
  // The person usually has the app open: a second server would fight the first
  // for the port (and the session), so a live one is used as it is.
  const fake = await listen({ "GET /api/desktop/settings": (req, res) => res.end(JSON.stringify(settings())) })
  let spawned = 0
  try {
    const got = await ensureServe({ port: fake.port, spawn: () => (spawned++, {}) })
    assert.deepEqual(got, { ok: true, port: fake.port, spawned: false })
    assert.equal(spawned, 0, "a server was started over a live one")
    assert.equal(fake.requests[0].path, "/api/desktop/settings", "readiness is the settings endpoint")
  } finally {
    await fake.close()
  }
})

test("ensureServe: a silent port is started once, and the wait ends when it answers", async () => {
  // The spawn is given the app's home and detached stdio: the server outlives
  // the request that needed it (the desktop's own server is the app's, and a
  // plugin that killed it mid-answer would cut the conversation).
  const port = await new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  let spawned = 0
  let args = null
  let options = null
  let fake = null
  const spawn = (cmp, a, o) => {
    spawned += 1
    args = [cmp, a, o]
    options = o
    // the spawned server comes up on the second probe, as the real one does
    // within a second or so of the process starting
    setTimeout(async () => {
      fake = await listen({ "GET /api/desktop/settings": (req, res) => res.end(JSON.stringify(settings())) }, port)
    }, 60)
    return { pid: 1234, unref() {} }
  }
  try {
    const got = await ensureServe({ port, spawn, home: "D:\\codar-home", timeoutMs: 5000, intervalMs: 20, platform: "win32", localAppData: WIN_LOCAL, fs: winMachine(), roots: [] })
    assert.equal(got.ok, true)
    assert.equal(got.spawned, true, "the answer says a server was started")
    assert.equal(spawned, 1, "the server was started more than once")
    assert.deepEqual(args[1], ["serve"], "the subcommand is `serve`")
    assert.equal(args[0], WIN_STANDARD, "the app's own binary")
    assert.equal(options.env.CODAR_HOME, "D:\\codar-home", "the server runs on the home the user signed in to")
    assert.equal(options.detached, true, "and outlives the request")
    assert.equal(options.stdio, "ignore", "its output is not the plugin's")
  } finally {
    if (fake) await fake.close()
  }
})

test("ensureServe: nothing answering inside the deadline answers {ok:false, reason}", async () => {
  // A port that never comes up must not hold a conversation open: the bridge
  // has to say why, in words a host's error line can carry.
  const started = Date.now()
  const port = await deadPort()
  const got = await ensureServe({ port, spawn: () => ({ pid: 1, unref() {} }), timeoutMs: 120, intervalMs: 20, platform: "win32", localAppData: WIN_LOCAL, fs: winMachine(), roots: [] })
  assert.equal(got.ok, false)
  assert.equal(typeof got.reason, "string")
  assert.ok(got.reason.includes(String(port)), "the reason names the port it waited on")
  assert.ok(Date.now() - started < 3000, "the deadline is the one it was given")
})

test("ensureServe: concurrent callers start one server between them", async () => {
  // magpie asks for two conversations at once, and two spawns would be one
  // server that loses the port and one that owns it — with the loser's callers
  // waiting on a port they will never own.
  const port = await new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  let spawned = 0
  let fake = null
  const spawn = () => {
    spawned += 1
    setTimeout(async () => {
      fake = await listen({ "GET /api/desktop/settings": (req, res) => res.end(JSON.stringify(settings())) }, port)
    }, 80)
    return { pid: 99, unref() {} }
  }
  try {
    const all = await Promise.all([1, 2, 3, 4].map(() => ensureServe({ port, spawn, timeoutMs: 5000, intervalMs: 20, platform: "win32", localAppData: WIN_LOCAL, fs: winMachine(), roots: [] })))
    assert.equal(spawned, 1, `started ${spawned} servers for four callers`)
    assert.ok(all.every((r) => r.ok), "every caller is told the server is there")
    assert.ok(all.find((r) => r.spawned), "the caller that started it says so (the rest joined it)")
  } finally {
    if (fake) await fake.close()
  }
})

// ---- C) chatStream ---------------------------------------------------------

test("chatStream sends one message and yields the server's events in order", async () => {
  // The contract is one string: `{"message": "..."}`. No system field, no
  // messages array, no model field — the server's own settings choose the
  // model, and anything else is refused with 400 {"error":"message is required"}.
  const fake = await listen({ "POST /api/chat": sseHandler() })
  try {
    const events = []
    for await (const e of chatStream({ port: fake.port, message: "hi" })) events.push(e)
    assert.equal(fake.requests.length, 1)
    assert.deepEqual(fake.requests[0].body, { message: "hi" }, "the body the server accepts, exactly")
    assert.match(fake.requests[0].headers["content-type"], /application\/json/)
    assert.match(fake.requests[0].headers.accept, /text\/event-stream/)
    assert.deepEqual(
      events.map((e) => e.event),
      ["run_started", "run_state", "text_delta", "text_delta", "text_delta", "context_usage", "result", "done"],
    )
    assert.equal(events[2].data.text, "你好！有什么可以帮你的")
    assert.equal(events[6].outcome, "completed", "the envelope's own outcome reaches the caller")
    assert.equal(events[6].provider_stop_reason, "stop")
  } finally {
    await fake.close()
  }
})

test("chatStream reads events split across reads and ignores comments and blanks", async () => {
  // A stream that arrives in fixed-size chunks cuts events in half; a parser
  // that assumed one event per read would drop half an answer. The server also
  // sends `: ` comment lines on some builds (an SSE keep-alive is the usual
  // way a Go server holds a connection), which are not events.
  const fake = await listen({
    "POST /api/chat": (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const body = sseBody(EVENTS.slice(2, 4))
      for (let i = 0; i < body.length; i += 7) res.write(body.slice(i, i + 7))
      res.write(": keep-alive\n\n")
      res.end()
    },
    "GET /api/desktop/settings": (req, res) => res.end(JSON.stringify(settings())),
  })
  try {
    const events = []
    for await (const e of chatStream({ port: fake.port, message: "hi" })) events.push(e)
    assert.deepEqual(events.map((e) => e.data.text), ["你好！有什么可以帮你的", "吗"])
  } finally {
    await fake.close()
  }
})

test("a refused chat answers the server's own error, not a stream that never opens", async () => {
  // Measured: a body the server cannot read is HTTP 400 application/json
  // {"error":"message is required"}. The plugin's caller must get that as a
  // thrown error with the vendor's words — not an empty iterator.
  const fake = await listen({
    "POST /api/chat": (req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "message is required" }))
    },
    "GET /api/desktop/settings": (req, res) => res.end(JSON.stringify(settings())),
  })
  try {
    // The rejection is raised when the generator starts, which is the first
    // pull — so the test pulls one event through `for await`, the same way the
    // host reads the stream.
    await assert.rejects(async () => {
      for await (const _ of chatStream({ port: fake.port, message: "" })) break
    }, (e) => {
      assert.match(String(e.message), /message is required/, "the server's own words")
      assert.equal(e.status, 400)
      return true
    })
  } finally {
    await fake.close()
  }
})

test("a port with no server on it is an error, not a hang", async () => {
  // A closed loopback port answers ECONNREFUSED at once on a healthy machine;
  // the explicit `timeoutMs` covers the machine where it does not (a firewall
  // that drops the SYN instead of refusing it), so the test cannot wait on the
  // host's own network behaviour. Past that bound the read must still end —
  // with the address in the message, not with a conversation left open.
  const port = await new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  const started = Date.now()
  await assert.rejects(async () => {
    await first(chatStream({ port, message: "hi", timeoutMs: 3000 }))
  }, /127\.0\.0\.1/)
  assert.ok(Date.now() - started < 5000)
})

// ---- D) sseToOpenAI --------------------------------------------------------

test("sseToOpenAI turns text_delta into choices[0].delta.content, one chunk per event", async () => {
  // What an OpenAI client reads: every answer character rides a chunk's
  // delta.content, and the stream ends with a chunk whose finish_reason says
  // why. The reply text, joined, is what the server spelled — byte for byte.
  const chunks = await collect(sseToOpenAI(EVENTS, { model: "auto" }))
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")
  assert.equal(text, ANSWER)
  const first = chunks.find((c) => c.choices?.[0]?.delta?.content === "你好！有什么可以帮你的")
  assert.ok(first, "the first delta is its own chunk")
  assert.equal(first.object, "chat.completion.chunk")
  assert.equal(first.model, "auto")
  assert.equal(typeof first.id, "string")
  assert.ok(first.id.length > 0, "a chunk carries an id")
  assert.equal(first.choices[0].index, 0)
  assert.equal(first.created > 0, true, "and a creation time the client can show")
})

test("sseToOpenAI ends with finish_reason stop and the usage the server reported", async () => {
  // The `result` event is where the server states why the run ended and how
  // many tokens it took: provider_stop_reason "stop" and the token counts
  // under `data`. Both belong on the closing chunk, and the usage must be the
  // server's numbers, not a count of the chunks this bridge made up.
  const chunks = await collect(sseToOpenAI(EVENTS, { model: "auto" }))
  const closing = chunks.find((c) => c.choices?.[0]?.finish_reason)
  assert.ok(closing, "no chunk said finish_reason")
  assert.equal(closing.choices[0].finish_reason, "stop")
  assert.equal(closing.choices[0].delta?.content ?? "", "", "the closing chunk carries no text")
  assert.deepEqual(closing.usage, { prompt_tokens: 19522, completion_tokens: 9, total_tokens: 19531 })
  // `done` adds nothing: one closing chunk, not two.
  assert.equal(chunks.filter((c) => c.choices?.[0]?.finish_reason).length, 1)
})

test("sseToOpenAI states a run that did not complete instead of a silent stream", async () => {
  // The server's refusal verdict arrives as a `result` whose outcome is not
  // "completed", or as an `error` event carrying a code
  // (insufficient_quota / provider_permission_denied were seen). A bridge that
  // swallowed either left magpie waiting on a conversation that was over.
  const refused = [...EVENTS.slice(0, 3), { data: { code: "insufficient_quota", message: "Not enough points" }, event: "error" }]
  const chunks = await collect(sseToOpenAI(refused, { model: "auto" }))
  const closing = chunks.find((c) => c.choices?.[0]?.finish_reason)
  assert.ok(closing, "an error must still close the stream")
  assert.ok(closing.error, "and carry the server's error code")
  assert.equal(closing.error.code, "insufficient_quota")
  assert.match(closing.error.message, /Not enough points/, "with the servers's own words")
  assert.notEqual(closing.choices[0].finish_reason, "stop", "an error is not a normal end")

  const failed = [...EVENTS.slice(0, 3), { data: { reason: "provider down" }, event: "result", outcome: "failed" }]
  const other = (await collect(sseToOpenAI(failed, { model: "auto" }))).find((c) => c.choices?.[0]?.finish_reason)
  assert.ok(other.error, "an outcome other than completed is an error too")
  assert.match(other.error.message, /provider down/)
})

test("openAIStream writes data: lines with a blank line after each, and one [DONE]", async () => {
  // The wire shape an OpenAI client parses: `data: {chunk}\n\n` per chunk, and
  // one `data: [DONE]` at the very end. A stream that omitted the blank line
  // would make the client wait for more JSON, and one that repeated [DONE] made
  // some clients report a second finish.
  const res = openAIStream(EVENTS, { model: "auto" })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8")
  const text = await res.text()
  assert.equal(doneSent(text), 1, "exactly one [DONE]")
  assert.ok(text.trimEnd().endsWith("data: [DONE]"), "and it is the last line")
  assert.equal(openaiChunks(text).length, (await collect(sseToOpenAI(EVENTS, { model: "auto" }))).length, "every chunk is on the wire")
  // the trailing newline of each chunk is there: `data: ` lines are separated
  // by a blank line, which is what a client's parser splits on
  assert.match(text, /}\n\ndata: /)
})

test("the model a chunk carries is the server's, read from its settings", async () => {
  // The provider's model field is what magpie shows in its picker and in a
  // message's header, so it comes from the server's own setting rather than a
  // name this plugin guessed.
  const fake = await listen({
    "GET /api/desktop/settings": (req, res) => res.end(JSON.stringify(settings("deepseek-v4.1-flash"))),
    "POST /api/chat": sseHandler(),
  })
  try {
    // sseToOpenAI reads its events one at a time from their iterator; a stream
    // opened before it is read has to be closed when the assertion is done,
    // because an open socket a ReadableStream is still reading never lets the
    // test runner's process settle.
    const stream = chatStream({ port: fake.port, message: "hi" })
    try {
      const chunks = await collect(sseToOpenAI(stream, { model: "auto" }))
      assert.equal(chunks[0].model, "auto")
    } finally {
      await stream.return?.()
    }
  } finally {
    await fake.close()
  }
  assert.ok(existsSync(fileURLToPath(new URL("../lib/serve.mjs", import.meta.url))), "the module under test is the one that ships")
})
