// The chat goes through the desktop app's own local server, not the gateway.
//
// Why this exists. A direct call to api.claw.speedai.com is refused for every
// client that is not the app, whatever headers or body it writes:
//
//   HTTP 403 {"code":"client_not_supported",
//             "message":"This login credential is restricted to Codar."}
//   (measured 2026-11-21, the account's own token, every header shape the
//    desktop sends)
//
// The same token, asked through `codar.exe serve`, answers a normal reply
// ("成功", outcome "completed") and the account is not restricted for it — the
// app's own server is the client the vendor admits, and it is where the app's
// own conversations go. So the bridge sends the conversation there: one
// loopback port the plugin spawns (or joins) and one HTTP request per turn.
//
// What the server offers (measured 2026-11-21, codar.exe serve, this machine,
// CODAR_HOME=C:\Users\21877\.codar, listening 127.0.0.1:8080):
//
//   GET  /api/desktop/settings  200 {"paths":{"home",…},"provider":{…},
//                                "settings":{"model", "permission_mode", …}}
//   GET  /api/health            200 {"agent":"codar","mode":"server",
//                                "provider_configured":true,"status":"ok",…}
//   GET  /api/projects          200 {"projects":[…]}
//   GET  /api/chat/runs         200 {"runs":[…]}
//   POST /api/chat              {"message":"…"} → Server-Sent Events
//   POST /api/chat/interrupt   中断
//   (POST on any of the read-only routes: 405 Method Not Allowed — the server
//    refuses a verb it has no route for in the same words, so a bridge that
//    asks the wrong verb cannot mistake a 405 for an answer)
//
// The chat's event lines, in the order the server sends them:
//
//   {"data":{"started_at":…},"event":"run_started","op_id":"sse_…","session_id":"web-ui"}
//   {"data":{"disposition":"admitted","run":{"model":"auto",…}},"event":"run_state",…}
//   {"data":{"text":"成功"},"event":"text_delta",…}
//   {"data":{"model":"auto","input_tokens":19522,…},"event":"context_usage",…}
//   {"data":{…},"event":"result","outcome":"completed","provider_stop_reason":"stop",…}
//   {"data":null,"event":"done",…}
//
// A run that goes wrong says so in an `error` event whose data.code is the
// vendor's word (insufficient_quota, provider_permission_denied, …), and a body
// the server cannot read is HTTP 400 application/json {"error":"message is
// required"}.
//
// ---- sessions: the one field the bridge never sent (incident 2026-11-21) ----
//
// Until this section existed the bridge sent {"message": …} and nothing else,
// so the server put every conversation of every request into its one fixed
// session `web-ui`. What the person saw was 「一会儿能用一会儿不能用」, and what
// the server answered was HTTP 200 carrying, inside the stream, 「这个会话还有
// 未完成的运行或待批准的工具调用。请先等待完成，或批准/拒绝当前工具调用后再发送
// 新消息。」 — a 200, not a 502, which is why it read as intermittent rather
// than as one broken thing. Measured on that machine: prompt_tokens: 517961,
// because each turn was appended to the session's history and the bridge then
// re-sent magpie's whole history on top of it. One conversation can only end
// with one session per conversation, so the bridge names one.
//
// The session contract, measured 2026-11-21 and not to be re-measured:
//
//   {"message":"hi","session_id":"test-sess-1"}  → 200, events say session_id=test-sess-1  ✅
//   {"message":"hi","sessionId":"test-sess-2"}   → 200, events say session_id=web-ui        ❌
//   {"message":"hi","session":"test-sess-3"}     → 200, events say session_id=web-ui        ❌
//   GET  /api/chat/runs  → {"runs":[…]}    (a run carries id, session_id, status)
//   POST /api/chat/interrupt → exists (the binary also carries api_chat_interrupt)
//   POST /api/chat/steer, POST /api/chat/permissions → exist, unused here
//   the binary's own error strings: run_owner_mismatch, INVALID_SESSION_ID,
//   RUN_CONTROL_FAILED, 无效会话参数, run id is required
//
// Both wrong spellings answer 200: the field name is not checked, it is
// ignored, and the events are the only place the real answer shows up. That is
// why chatStream asserts on the envelope instead of trusting the status — a
// server that changed the field name again would otherwise be a silent return
// to one shared session.
//
// This module is the transport half only: where the server is, whether it is
// up, how a request is read, and what an OpenAI client receives. What a
// conversation becomes in one string is chat-bridge.mjs, and the model list is
// models-from-serve.mjs.

import { spawn as spawnChild } from "node:child_process"
import * as nodeFs from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// The message's ceiling is the bridge's own rule (chat-bridge.mjs states it and
// why), re-exported here because it is one half of the same incident this module
// answers: the session is one conversation per request, and the message is the
// one conversation's text — past this many characters it is cut in the middle,
// so a session can never again reach the 517961 prompt tokens measured on
// 2026-11-21.
export { MAX_PROMPT_CHARS } from "./chat-bridge.mjs"

// CODAR_PORT is the port the server listens on when it is started with no
// argument. Measured: `codar.exe serve` says "listening on 127.0.0.1:8080" and
// answers there. The plugin's options may name another, and the environment's
// CODAR_SERVE_PORT does too (the suite uses it so a test never touches the
// person's own app server).
export const CODAR_PORT = 8080

// SERVE_TIMEOUT_MS is how long ensureServe waits for a server it started. The
// app's own start-up takes about a second on this machine (a Go binary and the
// config read); twenty seconds is the bound the brief fixed, and it is generous
// enough for a cold disk and a machine waking from sleep. Past it, the person
// gets a sentence instead of a conversation that never opens.
export const SERVE_TIMEOUT_MS = 20 * 1000

// SERVE_PROBE_MS is how often the wait asks again. The server binds its port
// before it finishes starting, so the first answer is usually within one or two
// probes; a tighter interval would only cost connections.
export const SERVE_PROBE_MS = 500

// CODAR_SESSION_PREFIX is the front of every session id this bridge names. The
// server names its own `web-ui` and the app's pages name theirs, so a prefix
// tells whose session a run in GET /api/chat/runs belongs to — the runs route
// is server-wide, and interrupting a run that is not this bridge's would stop
// a conversation the person is having in the app itself.
export const CODAR_SESSION_PREFIX = "mw-"

// DEFAULT_CODAR_HOME is the app's home, read the way internal.mjs's configPath
// reads the token's file: CODAR_HOME verbatim (the app honours it, and a
// trimmed value would point the spawned server at a directory the app never
// used), else ~/.codar. Spawned and read here so the server the plugin starts is
// the install the person signed in to.
export const DEFAULT_CODAR_HOME = () => {
  const home = String(process.env.CODAR_HOME ?? "")
  return home || join(homedir(), ".codar")
}

// ---- where the app's binary is ----------------------------------------------
//
// codarServeExecutable names the app's binary, which is the server: `serve` is
// its own subcommand. Five ways to find it, in the order this machine can state
// them, and the first one whose path is actually there wins:
//
//   1. CODAR_BIN — the person says where the app is. Taken verbatim (a path is
//      not data to be trimmed), and it wins outright: a machine that installed
//      the app somewhere else knows better than any default. A CODAR_BIN that
//      points at nothing is still the answer, so ensureServe can say which path
//      the person gave and that nothing is at it — falling through to the
//      defaults below would turn a typo into a server nobody asked this process
//      to start.
//   2. The vendor's standard install paths, per platform. Windows puts the app
//      under %LOCALAPPDATA%\Programs (the default an NSIS per-user install
//      uses) or %PROGRAMFILES%; macOS in /Applications; Linux under
//      ~/.local/share. This machine is at none of them — it is at
//      D:\software\Codar-Setup-latest\codar-desktop\…, which is what 5 is for.
//   3. The download the app's own bootstrap leaves in the home
//      (~/.codar/bin/codar), which is where a machine without an installed app
//      keeps its copy.
//   4. The app's own config.json, when it records where it was installed
//      (`install_dir` / `app_path`). It is the app's file, not this plugin's: a
//      field this code does not know is ignored, and a file that is missing or
//      is not JSON is no file at all.
//   5. A bounded scan of the drives for a `Codar*` folder that holds the
//      desktop app (`codar-desktop\resources\bin\codar.exe`). The vendor's
//      setup extracts into a folder named after the installer it came from, so
//      the folder's name is not fixed — `Codar-Setup-latest` is this machine's.
//      The scan runs only after every named path has missed, looks at most two
//      folder names below a drive root, reads at most SCAN_MAX_ENTRIES entries
//      of each directory it opens and at most SCAN_MAX_DIRS_PER_ROOT
//      directories per drive, and remembers its answer (scannedInstalls) so a
//      request never walks a disk twice.
//
// Resolution answers {path, source, candidates, scanned, drives}, not just a
// path, because two callers need different halves of it: codarServeExecutable
// hands a caller the path, and ensureServe writes the sentence a person can act
// on — which paths were looked at, and whether the scan ran.

// The drives a Windows scan walks. The order is the order a person reads them
// in; the bound is what keeps a machine with more drives from turning a miss
// into a tour of the disk.
export const SCAN_ROOTS = ["C:\\", "D:\\", "E:\\"]

// SCAN_MAX_ROOTS is how many of SCAN_ROOTS a scan walks, and is the literal
// figure the brief for this code fixed: three drives, no more.
export const SCAN_MAX_ROOTS = 3

// SCAN_MAX_ENTRIES is how many entries of one directory a scan reads. A folder
// with thousands of children (a downloads folder, a package cache) costs one
// slice rather than a stat per child.
export const SCAN_MAX_ENTRIES = 200

// SCAN_MAX_DIRS_PER_ROOT is how many directories a scan opens per drive. The
// two figures are what keep the fallback bounded: at most 3 × 200 directories
// are opened, and the answer is remembered afterwards.
export const SCAN_MAX_DIRS_PER_ROOT = 200

// SCAN_DEPTH counts folder names below a drive root: 2 is
// D:\software\Codar-Setup-latest, the layout this machine has, and the deepest
// a scan ever looks. A `Codar*` folder at the drive root itself is also found,
// by the first pass.
export const SCAN_DEPTH = 2

// CODAR_FOLDER is the folder-name pattern a scan looks for. The vendor's setup
// names the extracted folder after the installer it came from, so the name
// starts with "Codar" and the rest is not fixed.
const CODAR_FOLDER = /^Codar/i

// scannedInstalls remembers what a drive scan found, per set of roots and
// binary name: {path: ""} for "looked and found nothing", {path} for a hit. The
// key includes the roots so a test that scans a made-up drive cannot answer for
// the real one. A remembered hit is checked for existence on the way out (the
// app may have been moved since), and forgetScannedCodar drops the lot.
const scannedInstalls = new Map()

// forgetScannedCodar drops the remembered scan answers. Nothing in the plugin
// calls it — a moved app is a restarted process — but a test that walks a
// made-up drive has to start from "not looked yet".
export function forgetScannedCodar() {
  scannedInstalls.clear()
}

// existsSafe is existsSync that cannot throw: an injected filesystem in a test,
// or a permission error on a real path, is "not there" rather than a failed
// resolution.
const existsSafe = (fs, path) => {
  try {
    return Boolean(path) && Boolean(fs?.existsSync?.(path))
  } catch {
    return false
  }
}

// winPath joins Windows path parts the way the app's own paths are written.
// The scan runs on Windows only, but it is written with backslashes rather than
// node:path's join so that the path it answers with is the same string on any
// machine that runs the suite — path.join would use the host's separator, and a
// Windows path built on CI would come back with slashes in it.
const winPath = (...parts) =>
  parts.reduce((whole, part) => {
    const text = String(part ?? "")
    if (!text) return whole
    return whole ? `${whole.replace(/\\+$/, "")}\\${text.replace(/^\\+/, "")}` : text
  }, "")

// standardInstalls is where each platform's own setup puts the binary, in the
// order a machine usually has them: the per-user install first (that is what
// the vendor's installer defaults to), then the alternate folder name, then the
// all-users install. The home the paths are built from is the one the caller
// gave, because a path built from this process's home would answer with the
// test machine's rather than the platform's.
const standardInstalls = (platform, localAppData, programFiles) => {
  if (platform === "win32") {
    const local = localAppData || join(homedir(), "AppData", "Local")
    return [
      join(local, "Programs", "Codar", "resources", "bin", "codar.exe"),
      join(local, "Programs", "codar-desktop", "resources", "bin", "codar.exe"),
      join(programFiles || "C:\\Program Files", "Codar", "resources", "bin", "codar.exe"),
    ]
  }
  if (platform === "darwin") return ["/Applications/Codar.app/Contents/Resources/bin/codar"]
  // the user's own .local/share, read off the home it was given rather than
  // this process's: the platform argument is what a test states.
  return [join(localAppData || homedir(), ".local", "share", "codar", "resources", "bin", "codar")]
}

// configInstalls reads the app's own config.json for an install path it
// recorded. A field that names the executable is taken as it is; one that names
// the folder the app sits in is read the way an install is laid out under it.
// Nothing here is a promise — the paths come back as candidates, and the
// caller's existence check decides.
const configInstalls = (fs, home, exeName) => {
  let text
  try {
    text = String(fs?.readFileSync?.(join(home, "config.json"), "utf8") ?? "")
  } catch {
    return []
  }
  if (!text.trim()) return []
  let config
  try {
    config = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch {
    return []
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return []
  const desktop = config.desktop && typeof config.desktop === "object" ? config.desktop : {}
  const said = [config.install_dir, config.app_path, desktop.install_dir, desktop.app_path]
  const out = []
  for (const value of said) {
    const dir = typeof value === "string" ? value.trim() : ""
    if (!dir) continue
    // a field whose last name is the executable's is the executable, taken as
    // it is; anything else names a folder, read the way an install is laid out
    // under it. The comparison is on the last name and case-insensitive,
    // because Windows paths are — a folder called `Codar` is a folder, not the
    // `codar.exe` inside it.
    const last = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""
    if (last.toLowerCase() === exeName.toLowerCase()) out.push(dir)
    else out.push(join(dir, "codar-desktop", "resources", "bin", exeName), join(dir, "resources", "bin", exeName))
  }
  return out
}

// scanForInstall walks the drives for a `Codar*` folder holding the desktop
// app, breadth first and depth-bounded: every entry of a root is checked before
// any folder inside it is opened, so a `Codar` folder at D:\ answers before
// D:\anything is read, and the search never goes deeper than SCAN_DEPTH names
// below the drive root. Directories are opened at most SCAN_MAX_DIRS_PER_ROOT
// times per drive, and each opendir is sliced to SCAN_MAX_ENTRIES names, so a
// drive whose root holds a thousand folders costs a bounded walk rather than a
// stat per folder. The first existing candidate is the answer; nothing there is
// "".
const scanForInstall = ({
  fs,
  roots,
  exeName,
  maxDirsPerRoot = SCAN_MAX_DIRS_PER_ROOT,
  maxEntries = SCAN_MAX_ENTRIES,
  depth = SCAN_DEPTH,
}) => {
  const listed = new Map()
  const list = (dir) => {
    if (listed.has(dir)) return listed.get(dir)
    let entries = []
    try {
      const got = fs?.readdirSync?.(dir, { withFileTypes: true })
      entries = Array.isArray(got) ? got.slice(0, maxEntries) : []
    } catch {
      // a path that is not a directory, or one this process may not read, is a
      // directory with nothing in it
      entries = []
    }
    listed.set(dir, entries)
    return entries
  }
  // a fake filesystem in a test is allowed to answer plain names; the real one
  // answers Dirents, whose isDirectory() is what keeps files out of the walk
  const isFolder = (entry) => (typeof entry?.isDirectory === "function" ? entry.isDirectory() : Boolean(entry?.isDirectory))
  const nameOf = (entry) => String(entry?.name ?? entry ?? "")
  const opened = new Map()
  let front = roots.map((root) => ({ root, dir: root }))
  for (let level = 1; level <= depth && front.length; level += 1) {
    const next = []
    for (const { root, dir } of front) {
      // the drive root itself is not charged against the per-drive budget: it is
      // the one directory a scan must open to learn anything at all
      if (level > 1) {
        const count = opened.get(root) ?? 0
        if (count >= maxDirsPerRoot) continue
        opened.set(root, count + 1)
      }
      for (const entry of list(dir)) {
        if (!isFolder(entry)) continue
        const name = nameOf(entry)
        if (!name) continue
        const child = winPath(dir, name)
        if (CODAR_FOLDER.test(name)) {
          const candidate = winPath(child, "codar-desktop", "resources", "bin", exeName)
          if (existsSafe(fs, candidate)) return candidate
        }
        if (level < depth) next.push({ root, dir: child })
      }
    }
    front = next
  }
  return ""
}

// resolveServeExecutable is the whole search: CODAR_BIN, the standard install
// paths, the bootstrap download, the app's config.json, then the bounded scan.
// The answer names which step answered, and lists every path that was tried, so
// ensureServe's failure sentence can carry the search rather than "not found".
export function resolveServeExecutable(platform = process.platform, localAppData = process.env.LOCALAPPDATA || "", options = {}) {
  const said = options && typeof options === "object" ? options : {}
  const {
    fs = nodeFs,
    home = DEFAULT_CODAR_HOME(),
    programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files",
    roots = SCAN_ROOTS,
    scan = true,
    cache = scannedInstalls,
  } = said
  const named = String(process.env.CODAR_BIN ?? "")
  if (named.trim()) return { path: named, source: "env", candidates: [named], scanned: false, drives: [] }
  const exeName = platform === "win32" ? "codar.exe" : "codar"
  const candidates = []
  for (const path of standardInstalls(platform, localAppData, programFiles)) candidates.push({ path, source: "standard" })
  // the download is tried after an installed app: an install is the one the
  // person signed in with, and a home that has a copy and no install is a
  // server all the same
  candidates.push({ path: join(home, "bin", exeName), source: "download" })
  for (const path of configInstalls(fs, home, exeName)) candidates.push({ path, source: "config" })
  const found = candidates.find((candidate) => existsSafe(fs, candidate.path))
  if (found) return { path: found.path, source: found.source, candidates: candidates.map((c) => c.path), scanned: false, drives: [] }
  // Nothing named was there: the scan is the last resort, and only Windows has
  // drives to walk in this sense. A caller that named no roots at all gets the
  // drives the brief fixed; anything that is not a list of roots is the same as
  // none.
  const drives = platform === "win32" && scan && Array.isArray(roots) ? roots.filter((root) => typeof root === "string" && root).slice(0, SCAN_MAX_ROOTS) : []
  if (drives.length) {
    const key = `${exeName}|${drives.join(",")}`
    const remembered = cache?.get?.(key)
    const stale = remembered && remembered.path && !existsSafe(fs, remembered.path)
    if (remembered && !stale) {
      if (remembered.path) return { path: remembered.path, source: "scan", candidates: candidates.map((c) => c.path), scanned: true, drives }
    } else {
      const hit = scanForInstall({ fs, roots: drives, exeName })
      cache?.set?.(key, { path: hit })
      if (hit) return { path: hit, source: "scan", candidates: candidates.map((c) => c.path), scanned: true, drives }
    }
  }
  // Nothing exists: the first standard path is the answer anyway, because a
  // caller that shows a path is better than one that shows "undefined", and
  // ensureServe's sentence says which of them was tried.
  const first = candidates[0] ?? { path: "", source: "standard" }
  return { path: first.path, source: first.source, candidates: candidates.map((c) => c.path), scanned: drives.length > 0, drives }
}

// codarServeExecutable is the resolver's path, in the signature callers have
// used all along (platform, then the %LOCALAPPDATA% to build from). The options
// object is for a test: a fake filesystem, a made-up drive, another home.
export function codarServeExecutable(platform = process.platform, localAppData = process.env.LOCALAPPDATA || "", options = {}) {
  return resolveServeExecutable(platform, localAppData, options).path
}

// serveBase is the server's address: loopback only. The server binds 127.0.0.1
// and nothing else (measured: nothing answers on the LAN address), and the
// plugin's requests carry no credential at all — the server already holds the
// sign-in — so a host written here would be a host that gets a conversation it
// was never meant to see. Not a user-settable value.
export const serveBase = (port = CODAR_PORT) => `http://127.0.0.1:${port}`

// servePortOf says which port this process should use: the option, the
// environment, or the default. A value that is not a usable port is the default
// rather than a fetch to "http://127.0.0.1:NaN" — a broken setting should read
// as "the usual port", which then answers the sentence about what is missing.
export const servePortOf = (options = {}) => {
  const said = options.port ?? process.env.CODAR_SERVE_PORT
  const port = Number(said)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : CODAR_PORT
}

// ready answers whether the server at port is up and usable: GET
// /api/desktop/settings, 2xx, JSON, and a body that carries a provider. All
// three matter — a port held by some other program answers a 200 with a page,
// and "something is listening" is not "the app's server is listening".
const ready = async (port, { timeoutMs = 1500, signal } = {}) => {
  try {
    const res = await fetch(`${serveBase(port)}/api/desktop/settings`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return false
    const body = await res.json()
    return Boolean(body && typeof body === "object" && body.provider && typeof body.provider === "object")
  } catch {
    return false
  }
}

// inFlight holds the start that is already running, per port. Two conversations
// asked for at once must not start two servers: the second one loses the port
// and its caller waits on a port it will never own. Keyed by port because a
// process that watches two ports starts one server for each.
const inFlight = new Map()

// ensureServe answers a usable server: {ok:true, port, spawned}. The port is
// probed first — the person usually has the app open, and a live server is used
// as it is — and only a silent port is started, detached with its output
// discarded (the server outlives the request that needed it; the desktop's
// server is the app's, and a plugin that killed it mid-answer would cut the
// conversation). Every wait is bounded and the bound is the caller's: past it
// the answer is {ok:false, reason} in words a host can show.
//
// `spawn` and `probe` are the two dependencies a test replaces; production
// passes neither. `home` is the CODAR_HOME the server runs with, `bin` the
// executable a caller named, and `platform` / `localAppData` / `fs` / `roots`
// are how a test states the machine the search should believe in.
export async function ensureServe(options = {}) {
  const {
    port = CODAR_PORT,
    home = DEFAULT_CODAR_HOME(),
    bin,
    spawn = spawnChild,
    probe = ready,
    log = () => {},
    signal,
    timeoutMs = SERVE_TIMEOUT_MS,
    intervalMs = SERVE_PROBE_MS,
    platform = process.platform,
    localAppData = process.env.LOCALAPPDATA || "",
    fs = nodeFs,
    roots,
  } = options && typeof options === "object" ? options : {}
  if (await probe(port, { signal })) return { ok: true, port, spawned: false }
  // A start already under way for this port is joined, not repeated: the four
  // callers a host makes at once all pass the check above (the port is silent
  // for all of them), so the second one has to find the first one's promise.
  // The lookup and the spawn happen inside the claimed promise, and the claim
  // is recorded before anything in it runs, so there is no window in which two
  // callers can each start a server.
  const waiting = inFlight.get(port)
  if (waiting) return waiting
  let started
  started = (async () => {
    // The executable is only looked up when the caller named none: a caller
    // that named one (an option, a test) is starting that program, and a
    // machine with no install at the vendor's default path is not a reason to
    // refuse a path it was told about.
    const resolution = bin
      ? { path: String(bin), source: "option", candidates: [String(bin)], scanned: false, drives: [] }
      : resolveServeExecutable(platform, localAppData, { fs, home, roots })
    const exe = resolution.path
    // A path that is not there is said now, not spawned: spawn() reports a
    // missing program as an asynchronous 'error', so a spawn would look like a
    // slow start and spend the whole deadline before the person saw a sentence.
    // A CODAR_BIN the person typed wrong is one of those paths, and the reason
    // says so without falling through to the defaults — a scan here would hide
    // the typo behind a server nobody asked for.
    //
    // A bare command name (`codar`, no separator, no drive letter) is left to
    // spawn's own PATH lookup: "not in this directory" is not the question for
    // a name the operating system resolves.
    const pathLike = /[\\/]/.test(exe) || /^[a-zA-Z]:/.test(exe)
    if (!exe || (pathLike && !existsSafe(fs, exe))) return { ok: false, port, reason: missingExecutableReason(resolution, port) }
    let child
    try {
      child = spawn(exe, ["serve"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        // The app itself starts its server with CODAR_MODE=desktop (native.mjs
        // spawns the proxy with the same value); the server takes the home so
        // it reads the sign-in the person made in the app.
        env: { ...process.env, CODAR_MODE: "desktop", CODAR_HOME: home },
      })
    } catch (e) {
      return { ok: false, reason: `无法启动 ${exe} serve（${whyOf(e)}），${CODAR_BIN_HINT}` }
    }
    // The child is not ours to wait on: a server still starting when the
    // conversation ends must not be torn down with the request, and an
    // unhandled 'error' on a spawn that failed would take the host down.
    child?.on?.("error", (e) => log(`codar serve did not start: ${whyOf(e)}`))
    child?.unref?.()
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
    while (Date.now() < deadline) {
      await sleep(Math.max(1, Number(intervalMs) || SERVE_PROBE_MS))
      if (signal?.aborted) return { ok: false, reason: "已取消" }
      if (await probe(port, { signal })) return { ok: true, port, spawned: true }
    }
    return {
      ok: false,
      reason: `codar serve 在 ${Math.round(timeoutMs / 1000)} 秒内没有在 127.0.0.1:${port} 上就绪，请在科搭客户端里打开一次，或运行 \`codar serve\``,
    }
  })()
  inFlight.set(port, started)
  // `started` itself is what is held; the cleanup hangs off a separate
  // promise so the map stores the start and not a settling copy of it.
  started.then(
    () => inFlight.delete(port),
    () => inFlight.delete(port),
  )
  return started
}

// CODAR_BIN_HINT is the sentence a person can act on when no executable is
// found. It names both ways to say where the app is, because the install path
// is the vendor's choice and the app's bootstrap copy is inside CODAR_HOME.
const CODAR_BIN_HINT = "请确认科搭客户端已安装，或用环境变量 CODAR_BIN 指向它（例如 CODAR_BIN=D:\\software\\Codar-Setup-latest\\codar-desktop\\resources\\bin\\codar.exe）"

// missingExecutableReason is why there is no server to start, in the words of
// the step that failed. The three answers a person can act on are different:
//
//   - a CODAR_BIN that names nothing: that path, and that it is not there —
//     saying "not found" instead would send the person looking for an install
//     they already have, one variant of the path away;
//   - an executable the host's own settings named: the same, without the
//     environment variable's name on it;
//   - nothing anywhere: every path the search tried, in order, plus whether
//     the drive scan ran — a failure a person can read as a checklist rather
//     than a shrug.
const missingExecutableReason = (resolution, port) => {
  const at = `127.0.0.1:${port}`
  if (resolution.source === "env") {
    return `CODAR_BIN 指向的 ${resolution.path} 不存在，codar serve 无法启动（${at}）。请把它改成实际路径，或删掉它让插件自己去常见的安装位置找。`
  }
  if (resolution.source === "option") {
    return `设置里指定的 codar.exe ${resolution.path} 不存在，codar serve 无法启动（${at}）。`
  }
  const looked = resolution.candidates.map((path) => `  - ${path}`).join("\n")
  const scanned = resolution.scanned
    ? `  - 已扫描 ${(resolution.drives ?? []).join("、")} 上名为 Codar* 的文件夹（最多 ${SCAN_DEPTH} 层、每盘 ${SCAN_MAX_DIRS_PER_ROOT} 个目录、每个目录 ${SCAN_MAX_ENTRIES} 个条目）`
    : ""
  const searched = [looked, scanned].filter(Boolean).join("\n")
  return `没有找到能启动 codar serve 的可执行文件（${at} 上没有服务在听）。按顺序查找过：\n${searched}\n${CODAR_BIN_HINT}`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const whyOf = (e) => (typeof e?.message === "string" && e.message ? e.message : e?.code || "未知错误")

// parseSse reads a body of `data: …` lines into events. The server sends one
// event per line separated by a blank line, and the reply may arrive in pieces
// cut anywhere (a 7-byte read splits a JSON object in half), so this buffers
// until a line is complete. A `: comment` line (the usual SSE keep-alive) and a
// blank line carry nothing. A line that is not JSON is not an event: the
// server's own fields are JSON, and a broken one is dropped rather than
// reported as an event of its own — the `done` line and the socket closing are
// what end the reply.
export async function* parseSse(body) {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    let at
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      const event = lineOf(line)
      if (event) yield event
    }
  }
  buffer += decoder.decode()
  const last = lineOf(buffer)
  if (last) yield last
}

// lineOf is one line as an event, or null. `data:` may be written with or
// without the space after the colon (both are SSE), and the value is the whole
// rest of the line.
const lineOf = (line) => {
  const text = line.replace(/\r$/, "")
  if (!text || text.startsWith(":")) return null
  const data = /^data:(.*)$/.exec(text)
  if (!data) return null
  const raw = data[1].replace(/^ /, "").trim()
  if (!raw || raw === "[DONE]") return null
  try {
    const event = JSON.parse(raw)
    return event && typeof event === "object" ? event : null
  } catch {
    return null
  }
}

// chatStream asks the server one question and yields its events as they
// arrive. The body is the server's contract — {"message": …, "session_id": …}
// — and nothing else: no model (the server's own settings choose it), no system
// field, no messages array. A refusal (HTTP 400 {"error":"message is
// required"}, a 405 from a wrong verb, a 5xx) is thrown with the server's own
// words and its status, because a caller that got an empty iterator could not
// tell a refusal from an empty answer.
//
// `sessionId` is the conversation's session. Left out, each call names a fresh
// one (sessionIdFor): the default, because the server appends a request to its
// session's history and the bridge already carries magpie's history in the
// message — one session per call is the only reading that does not accumulate
// both. `session` carries the id from call to call when the person asked for
// reuse instead ({session:"reuse"}, see serveSessionOf); it is an object the
// caller keeps, so the same id survives the plugin instance's constants.
//
// `signal` is the host's cancellation: an aborted conversation stops the read
// and the server's run is left to its own interrupt (POST /api/chat/interrupt,
// which the app sends when the person stops a run; the bridge sends it before a
// conversation, not after one, because a cancelled fetch is usually a cancelled
// read, not a cancelled run).
//
// Two things happen before the message is sent, and both exist because the
// server answers 200 to a conversation it will not run:
//
//   1. a session that already has an unfinished run is interrupted first
//      (interruptBusy): sending into it is the 「还有未完成的运行」 refusal, and
//      an interrupt that does not take effect is answered by moving to a new
//      session rather than by waiting — nothing here blocks;
//   2. an `error` event inside a stream is retried once on a new session, and
//      only then reported, in a sentence that says the retry happened.
export async function* chatStream({ port = CODAR_PORT, message, sessionId, session, signal, timeoutMs = 0, base = serveBase(port), fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const named = sessionId ? String(sessionId) : serveSessionOf(session)
  let asked = named
  let tried = 0
  for (;;) {
    // The interrupt happens on the session the conversation is about to use: a
    // run left over from a request the host abandoned (a page that was closed
    // mid-answer) is exactly what the busy refusal is waiting for.
    asked = (await interruptBusy({ base, sessionId: asked, fetchImpl })) ?? asked
    // The session the caller asked for was replaced, so the caller's own object
    // says the one in use — otherwise the next call under {"session":"reuse"}
    // would walk back into the busy session this one just left.
    if (session && typeof session === "object" && asked !== named) session.id = asked
    let failed = null
    let answered = false
    // A cancelled conversation is not a failed one: the host's signal aborts the
    // read, and `done` ends the loop with nothing to retry. Without this the
    // abort would arrive as a stream that ended early and be read as an error.
    try {
      for await (const event of streamOnce({ base, message, sessionId: asked, signal, timeoutMs, fetchImpl })) {
        // The envelope's own session is the only proof the field was read (both
        // wrong spellings answer 200 and put web-ui here). A server that named
        // another session is a server whose contract moved: throwing here is
        // what keeps this from silently becoming one shared session again.
        if (typeof event?.session_id === "string" && event.session_id !== asked) throw sessionMismatch(asked, event.session_id, base)
        if (String(event?.event ?? "") === "error") {
          // A run that errored is over; the lines that follow it are the
          // server's own bookkeeping (done), and yielding both would give the
          // caller an answer and an error about the same run.
          failed = errorOf(event)
          continue
        }
        if (failed) continue
        answered = true
        yield event
      }
    } catch (e) {
      if (e?.code === "SESSION_MISMATCH" || signal?.aborted) throw e
      // The server refusing the request itself is not a run that failed: 400
      // {"error":"message is required"} and 405 (a route it does not have) are
      // about this bridge, and sending the same body again would be refused the
      // same way — twice the traffic for the same sentence. Those go straight to
      // the caller with the status the server gave.
      if (e?.status === 400 || e?.status === 405) throw e
      // Anything else — a connection that broke mid-answer, a 5xx — is a failed
      // send, and is retried the same way: one new session, then a sentence. A
      // cancelled one is not retried: the person stopped it, and a second request
      // would be a conversation they did not ask for.
      failed = { code: e?.code ?? "stream_closed", message: whyOf(e) }
    }
    if (!failed) return
    tried += 1
    if (tried > CODAR_SESSION_RETRIES) throw retriedOut(failed, tried, base)
    // A new session, not the same one interrupted again: the run that failed may
    // be one that will not stop (RUN_CONTROL_FAILED), and a retry that met it
    // twice would be a wait in disguise. Text already yielded is not taken back;
    // the retry's answer follows it, because the person has read it.
    asked = sessionIdFor()
    if (session && typeof session === "object") session.id = asked
  }
}

// CODAR_SESSION_RETRIES is how many times one conversation is sent again after
// an error event: one. A second retry would hide a real outage behind three
// identical failures and three times the tokens, and the sentence the caller
// gets after the first is already the answer to "what was tried".
const CODAR_SESSION_RETRIES = 1

// INTERRUPT_PATHS is where an interrupt may live, in order. The brief's own
// measurement says /api/chat/interrupt exists (the binary carries
// api_chat_interrupt); the fallback is /api/chat/runs/interrupt, the other
// spelling a server that lists runs at /api/chat/runs usually pairs one with. A
// 404 from the first is one loopback request, and a server whose route moved
// between builds should not make the bridge give up the session for nothing.
const INTERRUPT_PATHS = ["/api/chat/interrupt", "/api/chat/runs/interrupt"]

// streamOnce is one POST /api/chat read to its end, with no session bookkeeping
// of its own: the retry and the interrupt live in chatStream, so a caller
// reading this generator sees exactly the bytes the server sent for one request.
async function* streamOnce({ base, message, sessionId, signal, timeoutMs, fetchImpl }) {
  let answer
  try {
    answer = await fetchImpl(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message: String(message ?? ""), session_id: sessionId }),
      signal: timeoutMs ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]) : signal,
    })
  } catch (e) {
    // Nothing answering is the same news as a refusal: a caller that got a
    // bare "fetch failed" could not tell it from a broken body.
    throw unreachable(base, e)
  }
  if (!answer.ok) {
    const said = await answer.text().catch(() => "")
    throw serverError(answer.status, said, base)
  }
  yield* parseSse(answer.body)
}

// sessionMismatch is a server that put the run somewhere else, as the caller's
// error: both ids, because the next reader has to know which side to fix. The
// code is this module's own (SESSION_MISMATCH) — the server has no such string,
// and a caller looking for the server's vocabulary should not find a made-up
// word among it.
const sessionMismatch = (asked, used, base) => {
  const e = new Error(`codar serve 把这次对话放进了另一个会话：请求的是 ${asked}，它回的是 ${used}（${base}/api/chat）。可能是服务端改了字段名，会话复用会退回成所有请求共用一个会话`)
  e.code = "SESSION_MISMATCH"
  e.status = 502
  return e
}

// retriedOut is the second failure of one conversation, as the caller's error.
// The person is told what was tried — a new session — and the server's own
// sentence is kept in brackets (截断), because that sentence names the actual
// cause (a quota, a permission, a run that will not stop) and this module must
// not put words in the vendor's mouth.
const retriedOut = (failed, tries, base) => {
  const said = String(failed?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || failed?.code || "没有说明原因"
  const e = new Error(`QwenWork/Codar: 上一个会话还没结束（已自动切新会话重试 ${tries} 次）：${said}（${base}/api/chat）`)
  e.code = failed?.code ?? "upstream_error"
  e.status = 502
  return e
}

// serveSessionOf names the session a call uses and keeps it: a fresh id unless
// the caller asked for reuse, in which case the object it passed carries the id
// from then on. The object is the caller's (one per plugin instance), because a
// module-level session would outlive the instance and make two accounts share
// one conversation.
export function serveSessionOf(session) {
  if (session && typeof session === "object" && session.session === "reuse") {
    if (typeof session.id !== "string" || !session.id) session.id = sessionIdFor()
    return session.id
  }
  return sessionIdFor()
}

// sessionIdFor names one conversation: mw- and fourteen hex characters (17 in
// all; the brief's floor is 16, and a "mw-<hex12>" — the shape the brief sketched
// — is 15, one short of it). The prefix says whose session it is (see
// CODAR_SESSION_PREFIX), and the rest is random because two requests inside the
// same millisecond — magpie answers a fan-out of them — must not collide.
// Randomness comes from the platform's own source (crypto, not Math.random), so
// an id is not guessable from another.
export function sessionIdFor() {
  const bytes = new Uint8Array(7)
  // webcrypto's getRandomValues is in every Node this plugin supports (>=20);
  // the fallback is for a host that froze it, and it is still a fresh id.
  try {
    globalThis.crypto.getRandomValues(bytes)
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return CODAR_SESSION_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

// ---- the run a session already has -----------------------------------------
//
// GET /api/chat/runs is the server's own list of runs, server-wide: the app's
// web UI's runs, its sessions, and this bridge's. Two rules follow, and both
// are about not interfering:
//
//   1. only a run whose session_id is the one about to be used is looked at —
//      the app may well be running a conversation of its own at the same time,
//      and an interrupt meant for a leftover magpie run must not stop it;
//   2. only a run that has not ended is interrupted (unusableRunOf). `running`
//      is the status measured on a busy session; a finished one is left alone,
//      because interrupting it is either refused (the bridge would then move
//      sessions for no reason) or, worse, meaningful to the server.

// unusableRunOf says a run has not ended: its status is one the server uses for
// a run still holding the session. A run with no status at all is not counted —
// the shape GET /api/chat/runs answers is not measured past `{id, session_id,
// status}` (the binary's own strings name runs by id: "run id is required"), so
// an entry without a status is a run this module cannot call busy. Erring that
// way is deliberate: an interrupt that was not needed costs nothing, while
// switching sessions for a run that was already over would throw away the
// server's history for no reason.
const LIVE_STATUS = new Set(["running", "in_progress", "pending", "waiting", "queued", "awaiting_approval", "interrupted"])
export const unusableRunOf = (run) => {
  if (!run || typeof run !== "object") return false
  const status = String(run.status ?? run.state ?? "").toLowerCase()
  return LIVE_STATUS.has(status)
}

// interruptBusy is the session a conversation will actually use: `sessionId`,
// or a new one when the interrupt could not be made to take effect. It answers
// null when nothing had to change, which is the ordinary case — a fresh session
// has no runs at all.
//
// Every step here is bounded and none of it throws: a runs route that is
// missing (an older server), a list that cannot be read, an interrupt refused
// with {run_id} after {session_id} — all three end with a session the
// conversation can use. A bridge that raised on them would turn a working
// server into an outage over a question it only asked to be polite.
async function interruptBusy({ base, sessionId, fetchImpl }) {
  const runs = await runsOf({ base, fetchImpl })
  if (!runs) return null
  const busy = runs.filter((run) => String(run?.session_id ?? "") === sessionId && unusableRunOf(run))
  if (!busy.length) return null
  // The newest unfinished run first: a session that has several is a session
  // whose older ones are presumably already stopped, and the last one is the one
  // holding it.
  const stop = busy[busy.length - 1]
  // The body shape is not measured past what the brief fixed (try {session_id},
  // then {run_id}), so both are tried on the same run and the session is only
  // given up when neither stopped it. A session that was handed a new session is
  // a session the next run of this conversation starts fresh in.
  if (await interruptRun({ base, sessionId, run: stop, fetchImpl })) return null
  return sessionIdFor()
}

// runsOf reads GET /api/chat/runs: the list, or null when the route is not
// there or does not answer the shape. `runs` may be absent (an empty list on a
// server that has never run anything) — that is a list of none, not a missing
// route, and the difference matters: {} is what this server answers.
const runsOf = async ({ base, fetchImpl }) => {
  try {
    const answer = await fetchImpl(`${base}/api/chat/runs`, { method: "GET", headers: { Accept: "application/json" } })
    if (!answer.ok) return null
    const said = await answer.json()
    const list = Array.isArray(said?.runs) ? said.runs : Array.isArray(said) ? said : null
    return list
  } catch {
    return null
  }
}

// interruptRun asks the server to stop one run. One request, one body carrying
// both fields the server may need: {session_id} (measured to be a field the
// server reads) and {run_id} when the list named one (the binary's own string
// "run id is required" says a route wants one). Two shapes were tried in turn at
// first and that was wrong twice over: a 2xx to {session_id} ended the search
// before {run_id} was ever sent, and a refusal to the first shape spent a second
// round trip on every busy session. One body that states both is what a caller
// actually has, and the server ignores the field it does not need — which is
// exactly the behaviour measured for a wrong field name on /api/chat (ignored,
// 200, no complaint).
//
// The answer is whether the run is believed stopped: a 2xx (the server's run list
// is the authority either way, and re-reading it would be a third request per
// conversation), or a refusal whose body says the run is not the caller's —
// run_owner_mismatch means this bridge has no claim on it, which for a leftover is
// as good as stopped. Everything else (404, RUN_CONTROL_FAILED,
// INVALID_SESSION_ID) is "not stopped", and the caller moves to a new session.
const interruptRun = async ({ base, sessionId, run, fetchImpl }) => {
  const body = { session_id: sessionId, ...(run?.id ? { run_id: String(run.id) } : {}) }
  const said = []
  for (const site of INTERRUPT_PATHS) {
    try {
      const answer = await fetchImpl(`${base}${site}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      // The answer body is the server's own; a 2xx is the whole contract, and
      // reading it would be one more way to fail an interrupt that worked.
      if (answer.ok) return true
      said.push(await answer.text().catch(() => ""))
    } catch {
      return false
    }
  }
  return said.some((text) => /run_owner_mismatch/.test(text))
}

// unreachable is a port with no server on it as the caller's error: the address
// and why, in a sentence a host can put on a line (the code is Node's own,
// ECONNREFUSED for a port nothing listens on).
const unreachable = (base, cause) => {
  const e = new Error(`连不上 ${base}：${whyOf(cause?.cause ?? cause)}。请先打开科搭客户端，或运行 \`codar serve\``)
  e.code = cause?.cause?.code ?? cause?.code
  e.cause = cause
  return e
}

// serverError is a refused chat as the caller's error: the server's own
// sentence when its body carries one ({error:"…"}, or a code/message pair),
// else the status line. `status` is kept on the error for the bridge to turn
// into the right HTTP answer.
const serverError = (status, said, base) => {
  let words = ""
  try {
    const body = JSON.parse(said)
    words = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : typeof body?.code === "string" ? body.code : ""
  } catch {
    words = String(said ?? "").trim().slice(0, 200)
  }
  const e = new Error(`codar serve 拒绝了这次对话：${words || `HTTP ${status}`}（${base}/api/chat）`)
  e.status = status
  return e
}

// STOP_REASONS are the ends of a run that are not an error: the server names
// why a run stopped in `provider_stop_reason` (measured: "stop"), and an
// OpenAI client reads its own vocabulary in finish_reason. A reason this table
// does not know is passed on as the server wrote it rather than folded into
// "stop": a client showing an unfamiliar reason is honest, one showing "stop"
// over a cut-off answer is not.
const STOP_REASONS = { stop: "stop", length: "length", max_tokens: "length", tool_calls: "tool_calls", content_filter: "content_filter", function_call: "function_call" }

// sseToOpenAI turns the server's events into OpenAI chat.completion.chunk
// objects — or, with `aggregate`, into a one-element iterator holding the
// whole chat.completion a stream:false caller gets. The mapping is the whole
// point of the bridge and is one-way:
//
//   text_delta.data.text        → choices[0].delta.content
//   result.provider_stop_reason → choices[0].finish_reason (on the closing chunk)
//   result.data/context_usage   → usage (prompt/completion/total tokens)
//   error.data.code/message     → the closing chunk's `error`, and
//                                 finish_reason "error" — an error is not a
//                                 normal end, and a client that read "stop"
//                                 would report a complete answer
//
// The reply text is exactly what the events spelled, in order: nothing is
// trimmed, joined or re-wrapped, because the answer is the model's own bytes.
// The chunks are produced lazily (the generator starts on the first `next`),
// so a long answer streams instead of arriving as a list the host holds.
//
// The closing chunk is written once the events end — on `done`, or on the
// socket closing after a `result`, because the server sends both and a reply
// cut after `result` (a dropped `done` line on a closed connection) must still
// be a finished conversation. An upstream that fails after `done` has no line
// left to say so; that case is a stream that closed, which the client already
// treats as the end.
export function sseToOpenAI(events, options = {}) {
  const { model = "auto", id, created, aggregate = false } = options && typeof options === "object" ? options : {}
  // The events are read one at a time from their own iterator, which may be an
  // async one: the bridge's events come from a network stream (chatStream is an
  // async generator), and its next() answers a promise. A list and a plain
  // generator are taken the same way, so a collected answer and a live one
  // travel this one road.
  const stamp = created ?? Math.floor(Date.now() / 1000)
  const name = id ?? `chatcmpl-${randomId()}`
  const head = (delta, extra = {}) => ({ id: name, object: "chat.completion.chunk", created: stamp, model, choices: [{ index: 0, delta, ...extra }] })
  // A plain iterator rather than a generator function: the mapping runs on the
  // caller's first `next`, so an aggregate answer is built when it is asked for
  // and a streamed one starts when its first chunk is pulled.
  const state = { failed: null, usage: null, finish: "stop", text: "" }
  const read = (event) => {
    const kind = String(event?.event ?? "")
    if (kind === "text_delta") {
      const text = typeof event.data?.text === "string" ? event.data.text : ""
      if (text) state.text += text
      return text || null
    }
    if (kind === "error") {
      state.failed = errorOf(event)
      return null
    }
    if (kind === "result") {
      const tokens = tokensOf(event.data)
      if (tokens) state.usage = tokens
      if (event.outcome && event.outcome !== "completed" && !state.failed) {
        state.failed = { code: String(event.outcome), message: String(event.reason || event.data?.reason || `运行未完成（${event.outcome}）`) }
      }
      const said = STOP_REASONS[event.provider_stop_reason] ?? event.provider_stop_reason ?? STOP_REASONS[event.data?.stop_reason] ?? event.data?.stop_reason
      if (typeof said === "string" && said) state.finish = said
    }
    return null
  }
  // close is what every road ends with: the last chunk, carrying the finish
  // reason and — when the server gave any — the token counts and the error.
  const close = () => {
    const chunk = head({}, { finish_reason: state.failed ? "error" : state.finish })
    if (state.usage) chunk.usage = state.usage
    if (state.failed) chunk.error = state.failed
    return chunk
  }
  // pull reads the next event whatever its iterator answers with: a plain
  // iterator's {done,value} and an async one's promise of the same are one shape
  // once awaited, which is why this bridge can serve a collected answer and a
  // network stream on one road.
  const cursor = events?.[Symbol.asyncIterator]?.() ?? events?.[Symbol.iterator]?.() ?? events ?? { next: () => ({ done: true }) }
  const pull = async () => cursor.next()
  if (aggregate) {
    // the whole answer is one object: the text the events spelled, and the
    // same close that a stream ends with, folded into a chat.completion
    const done = (async () => {
      for (;;) {
        const step = await pull()
        if (step?.done) break
        read(step?.value)
      }
      const answer = { id: name, object: "chat.completion", created: stamp, model, choices: [{ index: 0, message: { role: "assistant", content: state.text }, finish_reason: state.failed ? "error" : state.finish }] }
      if (state.usage) answer.usage = state.usage
      if (state.failed) answer.error = state.failed
      return [answer]
    })()
    return done
  }
  // A streamed answer is itself an async iterator of chunks: every text_delta
  // is one chunk, and the close is the last.
  let finished = false
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      if (finished) return { value: undefined, done: true }
      for (;;) {
        const step = await pull()
        if (step?.done) {
          finished = true
          return { value: close(), done: false }
        }
        const text = read(step?.value)
        if (text) return { value: head({ content: text }), done: false }
      }
    },
    async return(value) {
      finished = true
      await cursor.return?.()
      return { value, done: true }
    },
  }
}

// errorOf is an error event as the chunk's field: the vendor's code word and
// its sentence. Measured codes: insufficient_quota, provider_permission_denied.
const errorOf = (event) => {
  const data = event?.data && typeof event.data === "object" ? event.data : {}
  const code = String(data.code ?? data.error ?? event?.code ?? "upstream_error")
  const message = String(data.message ?? event?.message ?? data.detail ?? "codar serve 报告了错误")
  return { code, message }
}

// tokensOf is the usage the server reported: its own input/output counts, read
// where the events carry them (the result's data, or the context_usage event).
// A missing count is left out rather than invented — an OpenAI client shows
// what it is given and a made-up 0 reads as "no tokens were used".
const tokensOf = (data) => {
  if (!data || typeof data !== "object") return null
  const prompt = Number(data.input_tokens)
  const completion = Number(data.output_tokens)
  const total = Number(data.total_tokens)
  if (!Number.isFinite(prompt) && !Number.isFinite(completion) && !Number.isFinite(total)) return null
  return {
    ...(Number.isFinite(prompt) ? { prompt_tokens: prompt } : {}),
    ...(Number.isFinite(completion) ? { completion_tokens: completion } : {}),
    ...(Number.isFinite(total) ? { total_tokens: total } : {}),
  }
}

// randomId is the chunk id, in the shape an OpenAI client expects
// ("chatcmpl-…"). Not a secret and not a session: a client shows it, and some
// clients use it to tell two streams apart, so it only has to be unique here.
const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6)

// openAIStream is the Response for a streaming chat: `data: {chunk}\n\n` per
// chunk and one `data: [DONE]` after them. The blank line after each chunk is
// what an SSE client's parser splits on — without it the client waits for more
// JSON, which is the failure this whole module exists to prevent. The headers
// are the event ones a streamed answer needs (an SSE content type, no caching),
// so the caller hands this straight to the host as the answer to its fetch.
//
// One chunk per pull: the events already arrive one line at a time, and a pull
// that drained the whole reply would hold the answer until the model finished —
// the thing streaming exists to avoid.
export function openAIStream(events, options = {}) {
  const encoder = new TextEncoder()
  // A failed conversation is an answer, not a stream that breaks: the events are
  // read to their end here so the closing chunk can carry the sentence, and the
  // failure is reported the way sseToOpenAI already reports an `error` event —
  // as the last chunk's `error` with finish_reason "error". A ReadableStream that
  // called controller.error() would reach the host as a broken request instead
  // (the host's fetch would reject), and the person would see a stack where a
  // sentence belongs.
  let source
  try {
    source = sseToOpenAI(events, options)
  } catch (e) {
    return failedStreamResponse(e)
  }
  let closing = false
  const body = new ReadableStream({
    async pull(controller) {
      if (closing) {
        controller.close()
        return
      }
      try {
        const step = await source.next()
        if (!step?.done) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(step.value)}\n\n`))
          return
        }
        closing = true
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      } catch (e) {
        // The pull failed: the text already sent stays sent, and the failure
        // becomes the last chunk — the same shape an `error` event would have
        // taken, so a client reads one kind of failure.
        closing = true
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(failureChunk(options?.model, e))}\n\n`))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      }
    },
    async cancel() {
      // The client stopped reading: the bridge's own iterator is ended so the
      // server's stream is not left half-read behind a reader that is gone.
      await source.return?.()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" },
  })
}

// failureChunk is a failed conversation as the closing chunk: no text, a
// finish_reason of "error", and the sentence in `error`. The code is the
// failure's own (the vendor's code when the server named one, this module's own
// SESSION_MISMATCH / stream_closed otherwise), so a client's error list keeps
// the words it was written for.
const failureChunk = (model, e) => ({
  id: `chatcmpl-${randomId()}`,
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: typeof model === "string" && model ? model : "auto",
  choices: [{ index: 0, delta: {}, finish_reason: "error" }],
  error: { code: String(e?.code ?? "upstream_error"), message: String(e?.message ?? "codar serve 报告了错误") },
})

// failedStreamResponse is a stream that had already failed before its first
// chunk could be produced (a failure found in the first pull, before anything was
// written): the chunk above, then [DONE], as a Response. Same shape as the live
// failure above, so a caller reads one kind of answer either way.
const failedStreamResponse = (e) => {
  const body = `data: ${JSON.stringify(failureChunk(undefined, e))}\n\ndata: [DONE]\n\n`
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" },
  })
}

// openAIAnswer is the Response for a non-streaming chat: one chat.completion
// object. status is the caller's (200 for an answer, 502 for a server that
// could not be reached). It is async because the whole reply has to be read
// before it can be written down, which is the difference between the two
// clients this bridge serves.
export async function openAIAnswer(events, options = {}, status = 200) {
  let answer
  try {
    ;[answer] = await sseToOpenAI(events, { ...options, aggregate: true })
  } catch (e) {
    // The same rule as the streamed answer (openAIStream): a failed
    // conversation is a chat.completion with finish_reason "error" and the
    // sentence in `error`, because the host reads this body as the answer and a
    // rejected promise would reach the person as a stack. The status stays the
    // caller's — a bridge that did not reach the server at all (502) has already
    // answered one of these before this point.
    answer = {
      id: `chatcmpl-${randomId()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: typeof options?.model === "string" && options.model ? options.model : "auto",
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "error" }],
      error: { code: String(e?.code ?? "upstream_error"), message: String(e?.message ?? "codar serve 报告了错误") },
    }
  }
  return new Response(JSON.stringify(answer), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}
