// The local tool layer: the 44 definitions the client sends, and the nine of
// them this plugin can answer itself.
//
// The definitions are not written here by hand. They are generated from a
// captured request — scripts/gen-tool-catalog.mjs reads the client's own
// chat-completions.tools.json and writes lib/tools/definitions.generated.mjs —
// because the server compares the shape it receives, and a hand-copied array
// drifts by one comma without anyone noticing. The first test pins the
// serialised form of the array to the sha256 of that capture: if a later edit
// reorders a key or drops a field, the hash stops matching and says so.
//
// The nine implementations are behaviour, so they are tested through runTool —
// the same entry the conversation loop uses — not through their own modules.
// Two things in particular are pinned by observation rather than by taste:
// list_dir's line format (a captured listing of the client's own home
// directory) and now's sentence (a captured reply). A test that only checks
// "contains the name" would pass on a format the model then mis-parses.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  IMPLEMENTED, TOOL_DEFINITIONS, isImplemented, runTool, toolDefinitions
} from "../lib/tools/index.mjs"

// The sha256 of the capture's own bytes, taken once from
// register-machine/docs/codar/samples/chat-completions.tools.json. It is a
// literal on purpose: recomputing it from the array under test would compare
// the array with itself and could never disagree.
const CAPTURE_SHA256 = "5759ba70ba114c9554bc9f6b7e9bcf9430e8c907539b6fdf8b9268c4563ad8b9"

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")

// A workspace per test: every path the tools touch resolves under it, so a
// test can assert on the tree afterwards without another test's leftovers.
const workspace = () => mkdtempSync(join(tmpdir(), "codar-tools-"))
const ctx = (ws, extra = {}) => ({ workspace: ws, signal: undefined, timeoutMs: 20000, sessionId: "test", ...extra })

const call = (name, args, ws, extra) => runTool(name, args, ctx(ws, extra))

test("the definitions are the capture's own bytes, all 44 of them", () => {
  assert.equal(TOOL_DEFINITIONS.length, 44, "the client sends 44 tools")
  const text = JSON.stringify(TOOL_DEFINITIONS, null, 2)
  assert.equal(sha256(text), CAPTURE_SHA256, "the array no longer serialises to the captured bytes")
})

test("toolDefinitions() hands the runtime an OpenAI tools array", () => {
  const all = toolDefinitions()
  assert.equal(all.length, 44)
  for (const entry of all) {
    assert.equal(entry.type, "function", "every entry is type=function")
    assert.equal(typeof entry.function.name, "string")
    assert.equal(typeof entry.function.description, "string")
    assert.equal(entry.function.parameters.type, "object")
  }
  const only = toolDefinitions({ only: ["now", "read_file"] })
  assert.deepEqual(only.map((t) => t.function.name), ["now", "read_file"], "filtering keeps the capture's order, not the caller's")
  assert.deepEqual(toolDefinitions({ only: ["no_such_tool"] }), [], "an unknown name selects nothing rather than throwing")
})

test("isImplemented draws the line where this cut actually is", () => {
  assert.equal(IMPLEMENTED.size, 9, "nine tools are answered locally")
  for (const name of ["read_file", "write_file", "edit_file", "list_dir", "apply_patch", "now", "exec", "web_fetch", "web_search"]) {
    assert.equal(isImplemented(name), true, `${name} is implemented`)
  }
  for (const name of ["literature_search_library", "img2pptx", "understand_image", "render_pdf_pages", "spawn_agent"]) {
    assert.equal(isImplemented(name), false, `${name} is not implemented`)
  }
})

test("read_file numbers every line from one", async () => {
  const ws = workspace()
  writeFileSync(join(ws, "a.txt"), "alpha\nbeta\ngamma\n", "utf8")
  const res = await call("read_file", { path: "a.txt" }, ws)
  assert.equal(res.is_error, false, res.content)
  assert.match(res.content, /^\[第 1-3 行，共 3 行\]\n/, res.content)
  assert.match(res.content, /\n1\talpha\n2\tbeta\n3\tgamma\n?$/, res.content)
})

test("read_file's offset and limit select a slice and say where to continue", async () => {
  const ws = workspace()
  writeFileSync(join(ws, "a.txt"), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"), "utf8")
  const res = await call("read_file", { path: "a.txt", offset: 3, limit: 2 }, ws)
  assert.equal(res.is_error, false, res.content)
  assert.match(res.content, /^\[第 3-4 行，共 10 行\]\n/, res.content)
  assert.match(res.content, /\n3\tline3\n4\tline4\n/, res.content)
  assert.doesNotMatch(res.content, /line1\b/, "nothing outside the slice is shown")
  assert.match(res.content, /offset=5/, "a truncated read names the offset that continues it")
})

test("read_file on a missing file fails and names the path", async () => {
  const ws = workspace()
  const res = await call("read_file", { path: "nope.txt" }, ws)
  assert.equal(res.is_error, true)
  assert.match(res.content, /nope\.txt/, res.content)
})

test("write_file writes, and read_file reads the same bytes back", async () => {
  const ws = workspace()
  const text = "第一行\nsecond line\n"
  const res = await call("write_file", { path: "sub/dir/b.txt", content: text }, ws)
  assert.equal(res.is_error, false, res.content)
  assert.match(res.content, /已写入 22 字节/, res.content)
  assert.equal(readFileSync(join(ws, "sub/dir/b.txt"), "utf8"), text, "parent directories are created too")
  const back = await call("read_file", { path: "sub/dir/b.txt" }, ws)
  assert.match(back.content, /\n1\t第一行\n2\tsecond line$/, "the closing newline does not become a numbered line of its own")
})

test("edit_file replaces an exact old_text and leaves the rest alone", async () => {
  const ws = workspace()
  writeFileSync(join(ws, "a.txt"), "keep me\nold value\ntail\n", "utf8")
  const res = await call("edit_file", { path: "a.txt", edits: [{ old_text: "old value", new_text: "new value" }] }, ws)
  assert.equal(res.is_error, false, res.content)
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "keep me\nnew value\ntail\n")
  assert.match(res.content, /a\.txt/, res.content)
})

test("edit_file accepts old_string/new_string as the other spelling", async () => {
  const ws = workspace()
  writeFileSync(join(ws, "a.txt"), "x = 1\n", "utf8")
  const res = await call("edit_file", { path: "a.txt", edits: [{ old_string: "x = 1", new_string: "x = 2" }] }, ws)
  assert.equal(res.is_error, false, res.content)
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "x = 2\n")
})

test("edit_file with an old_text that is not there fails, and suggests a nearby line", async () => {
  const ws = workspace()
  writeFileSync(join(ws, "a.txt"), "def calculate():\n    return 1\n", "utf8")
  const res = await call("edit_file", { path: "a.txt", edits: [{ old_text: "def calculat()", new_text: "x" }] }, ws)
  assert.equal(res.is_error, true)
  assert.match(res.content, /没有找到/, res.content)
  assert.match(res.content, /def calculate\(\):/, `the nearest line is shown, got: ${res.content}`)
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "def calculate():\n    return 1\n", "a failed edit writes nothing")
})

test("edit_file refuses an old_text that appears more than once", async () => {
  const ws = workspace()
  writeFileSync(join(ws, "a.txt"), "same\nsame\n", "utf8")
  const res = await call("edit_file", { path: "a.txt", edits: [{ old_text: "same", new_text: "once" }] }, ws)
  assert.equal(res.is_error, true)
  assert.match(res.content, /2 处|多处|不唯一/, res.content)
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "same\nsame\n")
})

test("list_dir prints the client's own line format, byte for byte", async () => {
  // The captured listing of the client's home directory began:
  //   "   .config.lock (0 bytes)\n📁 background (0 bytes)\n📁 bio (0 bytes)\n..."
  // So a file is three spaces then the name then " (N bytes)", a directory is
  // the folder glyph then " (0 bytes)", and the order is by name — the dot
  // file came before the directories, which a dirs-first listing would not do.
  const ws = workspace()
  mkdirSync(join(ws, "background"))
  mkdirSync(join(ws, "bio"))
  writeFileSync(join(ws, ".config.lock"), "", "utf8")
  writeFileSync(join(ws, "config.json"), "{\"a\":1}", "utf8")
  const res = await call("list_dir", { path: "." }, ws)
  assert.equal(res.is_error, false, res.content)
  assert.equal(res.content, [
    "   .config.lock (0 bytes)",
    "📁 background (0 bytes)",
    "📁 bio (0 bytes)",
    "   config.json (7 bytes)"
  ].join("\n"), `got:\n${JSON.stringify(res.content)}`)
})

test("list_dir on a path that is not a directory fails", async () => {
  const ws = workspace()
  const res = await call("list_dir", { path: "missing" }, ws)
  assert.equal(res.is_error, true)
  assert.match(res.content, /missing/, res.content)
})

test("apply_patch Add File creates the file with its + lines", async () => {
  const ws = workspace()
  const patch = ["*** Begin Patch", "*** Add File: src/new.py", "+first line", "+second line", "*** End Patch"].join("\n")
  const res = await call("apply_patch", { patch }, ws)
  assert.equal(res.is_error, false, res.content)
  assert.equal(readFileSync(join(ws, "src/new.py"), "utf8"), "first line\nsecond line\n")
})

test("apply_patch Update File changes one line and keeps its neighbours", async () => {
  const ws = workspace()
  writeFileSync(join(ws, "config.yaml"), "a: 1\nmax-num-seqs: 128\nz: 3\n", "utf8")
  const patch = [
    "*** Begin Patch",
    "*** Update File: config.yaml",
    "@@",
    " a: 1",
    "-max-num-seqs: 128",
    "+max-num-seqs: 512",
    " z: 3",
    "*** End Patch"
  ].join("\n")
  const res = await call("apply_patch", { patch }, ws)
  assert.equal(res.is_error, false, res.content)
  assert.equal(readFileSync(join(ws, "config.yaml"), "utf8"), "a: 1\nmax-num-seqs: 512\nz: 3\n")
})

test("apply_patch Delete File removes it", async () => {
  const ws = workspace()
  writeFileSync(join(ws, "old.py"), "x\n", "utf8")
  const patch = ["*** Begin Patch", "*** Delete File: old.py", "*** End Patch"].join("\n")
  const res = await call("apply_patch", { patch }, ws)
  assert.equal(res.is_error, false, res.content)
  assert.equal(existsSync(join(ws, "old.py")), false)
})

test("apply_patch says which section failed to locate", async () => {
  const ws = workspace()
  writeFileSync(join(ws, "a.txt"), "one\ntwo\n", "utf8")
  const patch = [
    "*** Begin Patch",
    "*** Update File: a.txt",
    "@@ nowhere",
    " not-there",
    "-also-not-there",
    "+replacement",
    "*** End Patch"
  ].join("\n")
  const res = await call("apply_patch", { patch }, ws)
  assert.equal(res.is_error, true)
  assert.match(res.content, /第 1 段/, res.content)
  assert.match(res.content, /a\.txt/, res.content)
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "one\ntwo\n", "a failed patch writes nothing")
})

test("apply_patch without an envelope is refused", async () => {
  const ws = workspace()
  const res = await call("apply_patch", { patch: "just some text" }, ws)
  assert.equal(res.is_error, true)
  assert.match(res.content, /Begin Patch/, res.content)
})

test("now answers in the client's sentence, CST and all", async () => {
  const ws = workspace()
  const res = await call("now", {}, ws)
  assert.equal(res.is_error, false, res.content)
  assert.match(res.content, /^现在是 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（CST，UTC\+08:00），星期[日一二三四五六]。$/u, res.content)
})

test("exec runs through pwsh and reports stdout with the exit code", async () => {
  const ws = workspace()
  const res = await call("exec", { command: "Write-Output hi" }, ws)
  assert.equal(res.is_error, false, res.content)
  assert.match(res.content, /^stdout:\n/, res.content)
  assert.match(res.content, /\nhi\n/, res.content.replace(/\r/g, "\\r"), "the shell's line ending does not reach the model")
  assert.match(res.content, /stderr:\n/, res.content)
  assert.match(res.content, /exit code: 0/, res.content)
})

test("exec reports a non-zero exit and the stderr that came with it", async () => {
  const ws = workspace()
  const res = await call("exec", { command: "Write-Error 'boom'; exit 3" }, ws)
  assert.equal(res.is_error, true, "a failed command is a tool error")
  assert.match(res.content, /exit code: 3/, res.content)
  assert.match(res.content, /boom/, res.content)
})

test("exec kills a command that outruns its timeout and says so", async () => {
  const ws = workspace()
  const res = await call("exec", { command: "Start-Sleep -Seconds 5", timeout_ms: 300 }, ws)
  assert.equal(res.is_error, true)
  assert.match(res.content, /超时/, res.content)
})

test("exec with background:true degrades honestly instead of pretending", async () => {
  const ws = workspace()
  const res = await call("exec", { command: "Write-Output hi", background: true }, ws)
  assert.equal(res.is_error, false, "a missing feature must not look like a failed command")
  assert.match(res.content, /后台任务暂不支持/, res.content)
})

test("a tool this cut does not implement is answered, not thrown", async () => {
  const ws = workspace()
  for (const name of ["literature_search_library", "img2pptx", "understand_image"]) {
    const res = await call(name, {}, ws)
    assert.equal(res.is_error, false, "the model retries forever on a thrown or errored tool")
    assert.match(res.content, new RegExp(`${name}：本环境未实现`), res.content)
  }
  const unknown = await call("no_such_tool", {}, ws)
  assert.equal(unknown.is_error, false)
  assert.match(unknown.content, /未实现/, unknown.content)
})

test("a path that climbs out of the workspace is refused", async () => {
  const ws = workspace()
  for (const path of ["../../etc/passwd", "..\\..\\Windows\\win.ini", "/etc/passwd/../../x"]) {
    const res = await call("read_file", { path }, ws)
    assert.equal(res.is_error, true, `${path} must not be read`)
    assert.match(res.content, /越界/, `${path} → ${res.content}`)
  }
})

test("web_fetch strips HTML and truncates to max_chars", async () => {
  const ws = workspace()
  const html = "<html><head><style>p{}</style><script>var x=1</script></head><body><h1>T</h1><p>hello &amp; goodbye</p></body></html>"
  const fetchImpl = async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
  const res = await call("web_fetch", { url: "https://example.test/a" }, ws, { fetchImpl })
  assert.equal(res.is_error, false, res.content)
  assert.match(res.content, /hello & goodbye/, res.content)
  assert.doesNotMatch(res.content, /<h1>|var x=1|p\{\}/, "tags, scripts and styles are gone")
  const short = await call("web_fetch", { url: "https://example.test/a", max_chars: 6 }, ws, { fetchImpl })
  assert.equal(short.is_error, false)
  assert.match(short.content, /已截断/, short.content)
})

test("web_fetch with no reachable transport explains itself without failing the turn", async () => {
  const ws = workspace()
  const fetchImpl = async () => {
    throw new Error("getaddrinfo ENOTFOUND example.test")
  }
  const res = await call("web_fetch", { url: "https://example.test/a" }, ws, { fetchImpl })
  assert.equal(res.is_error, false, "an environment without network is not a broken tool call")
  assert.match(res.content, /未配置|取不到/, res.content)
  assert.match(res.content, /example\.test/, "the reply names the address it could not reach")
  assert.match(res.content, /链接未确认可达/, res.content)
})

test("web_search does not pretend to have a backend", async () => {
  const ws = workspace()
  const res = await call("web_search", { query: "codar" }, ws)
  assert.equal(res.is_error, false)
  assert.match(res.content, /未配置搜索后端/, res.content)
  assert.match(res.content, /codar/, res.content)
})
