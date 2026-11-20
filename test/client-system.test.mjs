// The system prompt in the client's shape, against the capture it is copied
// from.
//
// The truth is a capture of the desktop's own client (v0.3.17, 2026-11-20,
// docs/codar/samples/chat-completions.body.json in register-machine): a 33,577
// character system message that opens with a runtime block and continues in
// `# ` sections. lib/client-system-data.mjs is generated from that file, so
// these tests do not re-read the prompt — they check the properties the copy
// has to have, and the one literal (the head's hash) that makes a silent
// re-generation visible.
//
// The properties that matter, in the order they matter:
//   - the first 400 characters are the client's, byte for byte;
//   - the caller's own prompt is inside the result, whole;
//   - nothing that only the desktop's tool table can carry survives, and no
//     session's hardcoded path does;
//   - messages and tools are the caller's, value for value, in order;
//   - aligning twice is aligning once.
//
// The capture itself is only read by the last test, and only when it is there:
// a checkout has it beside this repository, a tarball has neither.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { CLIENT_KEY_ORDER, normalizeChatBody } from "../lib/client-body.mjs"
import { CLIENT_OPENING, CLIENT_SYSTEM_PREFIX, alignSystemPrompt } from "../lib/client-system.mjs"
import {
  CLIENT_SYSTEM_DROPPED,
  CLIENT_SYSTEM_HEAD,
  CLIENT_SYSTEM_HEAD_HASH,
  CLIENT_SYSTEM_SECTIONS,
} from "../lib/client-system-data.mjs"

const here = fileURLToPath(new URL("..", import.meta.url))

// callerSystem stands in for what magpie hands the transport: a prompt of the
// caller's own, with its own tools and its own conventions. The point of the
// alignment is that this text survives it, whole.
const callerSystem = [
  "You are magpie's agent.",
  "",
  "# Tools",
  "",
  "Use pwsh for commands, read for files, edit for changes.",
  "Prefer small diffs. Keep replies short.",
  "路径里的中文要原样保留。",
].join("\n")

const messagesWithSystem = () => [
  { role: "system", content: callerSystem },
  { role: "user", content: "帮我看一下这个文件" },
  { role: "assistant", content: "好" },
]

const sha16 = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)

// Every name the desktop's prompt uses for a tool the caller does not have.
// `exec` is deliberately absent: the head's PowerShell line names it, and the
// head is kept whole (the test below confines that to the head).
const DESKTOP_ONLY = ["apply_patch", "literature_add_to_project", "img2pptx", "task_write", "figure_checkpoint", "load_skill", "install_skill", "spawn_agent", "edit_file", "convert_document_to_pdf"]

test("the head is the capture's opening, hashed down to 16 hex digits", () => {
  // The literal is the value recorded from the capture when the module was
  // generated. Comparing it with the generated constant (rather than only with
  // the string on disk) means a regenerated data module from a different
  // capture has to change this line too.
  assert.equal(CLIENT_SYSTEM_HEAD_HASH, "ba32d3359d57cfb3")
  assert.equal(sha16(CLIENT_SYSTEM_HEAD.slice(0, 400)), "ba32d3359d57cfb3")
  assert.ok(CLIENT_SYSTEM_HEAD.startsWith(`${CLIENT_OPENING}\n\nRuntime info:\nOS: windows/amd64\nShell: `))
  // 400 characters is the claim the transport makes, so the head has to be at
  // least that long or the claim would rest on text nobody copied.
  assert.ok(CLIENT_SYSTEM_HEAD.length >= 400)
})

test("the client's prefix starts the composed prompt, byte for byte", () => {
  const out = alignSystemPrompt(messagesWithSystem())
  assert.ok(out[0].content.startsWith(CLIENT_SYSTEM_PREFIX))
  // And the composed prefix is still the capture's opening at 400 characters:
  // a head that matched while the prefix did not would be no prefix at all.
  assert.equal(out[0].content.slice(0, 400), CLIENT_SYSTEM_HEAD.slice(0, 400))
})

test("a conversation with no system prompt gets one, in front", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]
  const out = alignSystemPrompt(messages)
  assert.equal(out.length, 3)
  assert.equal(out[0].role, "system")
  assert.equal(out[0].content.slice(0, 400), CLIENT_SYSTEM_HEAD.slice(0, 400))
  // The messages that were there are the same objects, in the same order, and
  // the caller's array was not edited.
  assert.equal(out[1], messages[0])
  assert.equal(out[2], messages[1])
  assert.equal(messages.length, 2)
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"])
})

test("the caller's own prompt arrives whole, and its other fields with it", () => {
  const messages = [{ role: "system", content: callerSystem, name: "magpie-agent" }, { role: "user", content: "hi" }]
  const out = alignSystemPrompt(messages)
  assert.ok(out[0].content.includes(callerSystem), "the caller's prompt was not carried over verbatim")
  // A property a system message can carry is the caller's, not this module's
  // to drop while rewriting the content.
  assert.equal(out[0].name, "magpie-agent")
  // The caller's text is not the opening of the result: it sits after the head.
  assert.ok(!out[0].content.startsWith(callerSystem))
})

test("the result opens with the client's line, always", () => {
  for (const messages of [messagesWithSystem(), [{ role: "system", content: "" }], [{ role: "user", content: "hi" }]]) {
    const out = alignSystemPrompt(messages)
    assert.ok(out[0].content.startsWith(CLIENT_OPENING), `did not open with the client's line: ${out[0].content.slice(0, 40)}`)
  }
})

test("no session's hardcoded directory survives, and the head says where to look instead", () => {
  const out = alignSystemPrompt(messagesWithSystem())
  const content = out[0].content
  assert.ok(!content.includes("Working Directory:"), "the capture's capitalised Working Directory line survived")
  assert.ok(!content.includes("C:\\Users"), "a hardcoded user path survived")
  assert.ok(!content.includes("\\.codar\\sessions"), "a hardcoded session path survived")
  assert.ok(content.includes("Working directory: see the environment your tools report"), "the replacement line is missing")
  // The head itself is the only place a path could have come from, and it has
  // none: this asserts the head is what is being sent, not that it is innocent.
  assert.ok(content.includes("Shell: PowerShell;"))
})

test("no desktop-only tool name survives anywhere", () => {
  const content = alignSystemPrompt(messagesWithSystem())[0].content
  for (const name of DESKTOP_ONLY) assert.ok(!content.includes(name), `${name} survived into the aligned prompt`)
})

test("the kept sections carry no separator and no path; the dropped ones say why", () => {
  for (const section of CLIENT_SYSTEM_SECTIONS) {
    assert.ok(section.title.startsWith("# ") || section.title.length > 0)
    assert.ok(!section.text.includes("---"), `${section.title} still carries a ` + "`---` separator")
    assert.ok(!/[A-Za-z]:\\/.test(section.text), `${section.title} still quotes a Windows path`)
    assert.ok(section.text.startsWith("# "), `${section.title} does not start with its heading`)
  }
  // The sections that must not be sent are dropped, with the reason recorded:
  // a section that came back without a reason would be one nobody decided on.
  const dropped = new Map(CLIENT_SYSTEM_DROPPED.map((d) => [d.title, d.reason]))
  for (const title of ["# File Editing", "# Bundled Runtime", "# Task Management", "# Skills", "# Skill Installation"]) {
    assert.equal(dropped.get(title.replace(/^# /, "")), "tool", `${title} was not dropped as tool-bound`)
  }
  assert.ok(!dropped.has("Task Scope and Delivery"), "a generic section was dropped")
})

test("the head is the only place a desktop tool name survives", () => {
  // The Shell line is advice about the caller's own shell and is sent as it
  // was captured; everything after the prefix is this module's, and has no
  // business naming a tool the caller does not have.
  const content = alignSystemPrompt(messagesWithSystem())[0].content
  const after = content.slice(CLIENT_SYSTEM_PREFIX.length)
  assert.ok(CLIENT_SYSTEM_PREFIX.slice(0, 400) === content.slice(0, 400))
  // Word boundaries: "execution" in a section's title is a word, not a tool.
  for (const name of [...DESKTOP_ONLY, "exec", "read_file", "write_file", "list_dir"]) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(after), `${name} survived past the runtime head`)
  }
})

test("aligning twice is aligning once", () => {
  const once = alignSystemPrompt(messagesWithSystem())
  const twice = alignSystemPrompt(once)
  assert.deepEqual(twice, once)
  // Not merely equal: the second call recognizes the prompt and hands the same
  // array back, so a body cannot grow a second copy of the prefix per attempt.
  assert.equal(twice, once)
})

test("the caller's prompt is never shortened", () => {
  const out = alignSystemPrompt(messagesWithSystem())
  assert.ok(out[0].content.length >= callerSystem.length)
  assert.ok(out[0].content.length >= CLIENT_SYSTEM_PREFIX.length + callerSystem.length)
  // A long prompt is the caller's business: the composed prompt grows with it.
  const long = "x".repeat(40000)
  const big = alignSystemPrompt([{ role: "system", content: long }, { role: "user", content: "hi" }])
  assert.ok(big[0].content.includes(long))
  assert.ok(big[0].content.length > 40000)
})

test("a body that is not a conversation comes back as it came", () => {
  for (const bad of [undefined, null, "messages", 42, {}, { 0: { role: "system", content: "hi" } }]) {
    assert.equal(alignSystemPrompt(bad), bad)
  }
  // A system prompt whose content is a parts array is a shape this module does
  // not know how to wrap, and it says so by leaving it alone.
  const parts = [{ role: "system", content: [{ type: "text", text: "hi" }] }, { role: "user", content: "hi" }]
  assert.equal(alignSystemPrompt(parts), parts)
})

test("maxChars bounds the tail, never the head or the caller's text", () => {
  const cap = CLIENT_SYSTEM_PREFIX.length + callerSystem.length + 600
  const limited = alignSystemPrompt(messagesWithSystem(), { maxChars: cap })
  const content = limited[0].content
  assert.ok(content.length <= cap, `${content.length} characters came back for a ${cap} cap`)
  assert.ok(content.startsWith(CLIENT_SYSTEM_PREFIX.slice(0, 400)))
  assert.ok(content.includes(callerSystem))
  // Fewer sections than the uncapped prompt, and the ones kept are the first
  // ones: the order the capture has them in.
  const full = alignSystemPrompt(messagesWithSystem())[0].content
  assert.ok(content.length < full.length)
  assert.ok(full.includes(CLIENT_SYSTEM_SECTIONS[0].text))
  // A cap smaller than what cannot be dropped is not an excuse to cut the
  // caller's prompt: it comes back over the cap instead.
  const tiny = alignSystemPrompt(messagesWithSystem(), { maxChars: 10 })[0].content
  assert.ok(tiny.includes(callerSystem))
  assert.ok(tiny.startsWith(CLIENT_OPENING))
})

test("tools and every other message cross the body untouched, and the body keeps the client's shape", () => {
  const tools = [
    { type: "function", function: { name: "pwsh", description: "Run a command.", parameters: { type: "object", properties: { command: { type: "string" } } } } },
    { type: "function", function: { name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  ]
  const messages = messagesWithSystem()
  const raw = JSON.stringify({ model: "deepseek-v4.1-flash", messages, stream: true, max_tokens: 0, tools })
  const out = normalizeChatBody(raw, { alignSystem: true })
  const body = JSON.parse(out)

  assert.deepEqual(Object.keys(body), CLIENT_KEY_ORDER)
  assert.equal(body.messages[0].content.slice(0, 400), CLIENT_SYSTEM_HEAD.slice(0, 400))
  assert.ok(body.messages[0].content.includes(callerSystem))
  // tools: the same JSON text, not merely equal values.
  assert.equal(JSON.stringify(body.tools), JSON.stringify(tools))
  // The rest of the conversation: same values, same order, untouched.
  assert.deepEqual(body.messages.slice(1), messages.slice(1))
  // The input body was not edited.
  assert.deepEqual(JSON.parse(raw).messages, messages)

  // Without the option, the system prompt is the caller's, as it always was.
  const plain = JSON.parse(normalizeChatBody(raw))
  assert.deepEqual(plain.messages, messages)
  assert.equal(plain.messages[0].content, callerSystem)
})

test("normalizing an already-aligned body leaves its prompt alone", () => {
  const raw = JSON.stringify({ model: "m", messages: messagesWithSystem(), stream: true })
  const once = normalizeChatBody(raw, { alignSystem: true })
  const twice = normalizeChatBody(once, { alignSystem: true })
  assert.equal(twice, once)
  assert.equal(JSON.parse(once).messages[0].content.split(CLIENT_OPENING).length - 1, 1, "the prefix was copied twice")
})

test("the capture the data was generated from still opens the same way", (t) => {
  // The literal above is the archive; this is the live check, and it only runs
  // where the capture is. A tarball has neither the capture nor the checkout
  // beside it, and skipping is the honest answer there.
  const capture = [
    process.env.CODAR_CLIENT_CAPTURE,
    join(here, "..", "..", "register-machine", "docs", "codar", "samples", "chat-completions.body.json"),
  ].find((p) => p && existsSync(p))
  if (!capture) return t.skip("no capture of the desktop's request in this tree")
  const body = JSON.parse(readFileSync(capture, "utf8"))
  const system = body.messages.find((m) => m.role === "system").content
  assert.equal(sha16(system.slice(0, 400)), CLIENT_SYSTEM_HEAD_HASH)
  assert.equal(system.slice(0, 400), CLIENT_SYSTEM_HEAD.slice(0, 400))
  // And the head is a prefix of the whole thing, not a reconstruction of it.
  assert.ok(system.startsWith(CLIENT_SYSTEM_HEAD))
})
