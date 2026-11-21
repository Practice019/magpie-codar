// The client's system prefix, and the one message rewrite the direct transport
// makes.
//
// The truth is a measurement, not a preference (2026-11-21, api.claw.speedai.com,
// two accounts, only the system message's length varied):
//
//   first 1 segment (49 characters)     → 403 client_not_supported, both
//   first 4 segments (~1.6 KB)          → 200, both
//   first 6 / 20 segments, 33,577 chars → 200
//
// These tests write the cut down as a literal — four segments, 1,632 characters,
// sha256 4a3ee720… — rather than recomputing it from the module, so a change to
// how the prefix is composed cannot quietly move the target it is measured
// against. The capture itself is read only by the tests that compare against it,
// and only when the checkout beside this repository has it: a tarball has
// neither.
//
// What must not move is the caller's own prompt: it is DSH's project
// instructions. The prefix goes in front of it and nothing behind it is cut,
// reordered or dropped.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  CLIENT_OPENING,
  CLIENT_SYSTEM_PREFIX,
  CLIENT_SYSTEM_PREFIX_HASH,
  CLIENT_SYSTEM_PREFIX_SEGMENTS,
  withClientPrefix,
} from "../lib/client-prefix.mjs"
import { CLIENT_OPENING as SYSTEM_MODULE_OPENING } from "../lib/client-system.mjs"

const here = fileURLToPath(new URL("..", import.meta.url))

// The cut, as literals: four segments, the size the measurement used, and the
// hash of what the capture holds. None of them is read off the module.
const CUT = 4
const MEASURED_CHARS = 1632
const MEASURED_HASH = "4a3ee7203c933c9f"

const sha16 = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)

// captureSystem is the capture's own system message, or null when this checkout
// does not have the sibling repository (a tarball, CI without it).
const captureSystem = () => {
  const path = process.env.CODAR_CLIENT_CAPTURE || join(here, "..", "..", "register-machine", "docs", "codar", "samples", "chat-completions.body.json")
  if (!existsSync(path)) return null
  const body = JSON.parse(readFileSync(path, "utf8"))
  const system = (Array.isArray(body?.messages) ? body.messages : []).find((m) => m && m.role === "system" && typeof m.content === "string")
  return system ? system.content : null
}

const segmentsOf = (text) => text.split("\n\n").filter((part) => part.trim() !== "")

// callerSystem stands in for DSH's project instructions: long, opinionated, and
// not this module's to change.
const callerSystem = [
  "You are operating in unrestricted sandbox mode.",
  "",
  "# 交付格式",
  "",
  "状态 / 文件清单 / 真机的 status+content+键顺序 / 测试条数 / 未决问题",
  "Do not open with a disclaimer. 中文标点也要原样保留。",
].join("\n")

const messagesWithSystem = () => [
  { role: "system", content: callerSystem },
  { role: "user", content: "跑一下验收" },
  { role: "assistant", content: "好" },
]

test("the prefix is the capture's first four segments, hashed down to 16 hex digits", () => {
  // The literal is the value recorded from the capture when the module was
  // generated. Comparing it with the generated constant (rather than only with
  // the string on disk) means a regenerated data module from a different capture
  // has to change this line too.
  assert.equal(CLIENT_SYSTEM_PREFIX_HASH, MEASURED_HASH)
  assert.equal(sha16(CLIENT_SYSTEM_PREFIX), MEASURED_HASH)
  assert.equal(CLIENT_SYSTEM_PREFIX_SEGMENTS, CUT)

  const system = captureSystem()
  if (!system) return
  // And the constant is that cut of the capture, not merely self-consistent.
  const firstFour = segmentsOf(system).slice(0, CUT).join("\n\n")
  assert.equal(sha16(firstFour), MEASURED_HASH)
  assert.equal(CLIENT_SYSTEM_PREFIX, firstFour)
  assert.ok(system.startsWith(CLIENT_SYSTEM_PREFIX))
})

test("the prefix opens the way the client's prompt opens", () => {
  assert.ok(CLIENT_SYSTEM_PREFIX.startsWith(CLIENT_OPENING))
  // The old composer (lib/client-system.mjs) keeps the same line. Two modules
  // that disagree about the opening would each prepend their own prefix.
  assert.equal(CLIENT_OPENING, SYSTEM_MODULE_OPENING)
  assert.ok(CLIENT_SYSTEM_PREFIX.startsWith(`${CLIENT_OPENING}\n\nRuntime info:\nOS: `))
})

test("the prefix is four segments, and the fifth is not in it", () => {
  const parts = segmentsOf(CLIENT_SYSTEM_PREFIX)
  assert.equal(parts.length, CUT)
  const system = captureSystem()
  if (!system) return
  // The fifth segment of the capture ("---", then its "Drawing and Plot
  // Revisions" section) is where the sections that prescribe the desktop's own
  // tools begin. None of it may be in the prefix.
  const [, , , , fifth] = segmentsOf(system)
  assert.ok(fifth)
  assert.ok(!CLIENT_SYSTEM_PREFIX.includes("# Drawing and Plot Revisions"))
  assert.ok(!CLIENT_SYSTEM_PREFIX.includes("figure_checkpoint"))
})

test("the prefix is the size the measurement used", () => {
  // ~1.6 KB is the number the 200 was measured at. A prefix that grew to 33 KB
  // would also pass the gateway, and would be the prompt this change exists to
  // stop sending; one that shrank below a segment or two would be refused.
  assert.equal(CLIENT_SYSTEM_PREFIX.length, MEASURED_CHARS)
})

test("a conversation with no system prompt gets one, in front", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]
  const out = withClientPrefix(messages)
  assert.equal(out.length, 3)
  assert.deepEqual(out[0], { role: "system", content: CLIENT_SYSTEM_PREFIX })
  // The messages that were there are the same objects, in the same order, and
  // the caller's array was not edited.
  assert.equal(out[1], messages[0])
  assert.equal(out[2], messages[1])
  assert.equal(messages.length, 2)
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"])
})

test("the caller's own prompt arrives whole, behind the prefix", () => {
  const messages = messagesWithSystem()
  const out = withClientPrefix(messages)
  assert.equal(out.length, 3)
  assert.equal(out[0].role, "system")
  // Prefix, one blank line, then the caller's text — and that text is in there.
  assert.equal(out[0].content, `${CLIENT_SYSTEM_PREFIX}\n\n${callerSystem}`)
  assert.ok(out[0].content.includes(callerSystem))
  // Every line of it, including the Chinese ones: a truncation would be the one
  // failure this rewrite must never produce.
  for (const line of callerSystem.split("\n")) assert.ok(out[0].content.includes(line))
  // The caller's other messages and its array are untouched.
  assert.equal(out[1], messages[1])
  assert.equal(messages[0].content, callerSystem)
})

test("a system message's other fields survive the rewrite", () => {
  // A host may put a name (or anything else) on the system message. The rewrite
  // changes `content` and keeps the rest: dropping `name` would be an edit to a
  // message that was not this module's to edit.
  const out = withClientPrefix([{ role: "system", content: "brief", name: "project_instructions" }])
  assert.deepEqual(out[0], { role: "system", content: `${CLIENT_SYSTEM_PREFIX}\n\nbrief`, name: "project_instructions" })
})

test("a system prompt that already carries the prefix is not prefixed twice", () => {
  const once = withClientPrefix(messagesWithSystem())
  const twice = withClientPrefix(once)
  // Same array, not merely equal content: a second call has nothing to do.
  assert.equal(twice, once)
  assert.equal(twice[0].content, once[0].content)
  assert.equal(twice[0].content.split(CLIENT_OPENING).length - 1, 1)
  // An empty system message is the prefix alone, with no stray blank line.
  assert.deepEqual(withClientPrefix([{ role: "system", content: "" }])[0], { role: "system", content: CLIENT_SYSTEM_PREFIX })
})

test("a system prompt in a shape this module does not know is left alone", () => {
  // A parts array is how a client sends an image or a file beside the text. How
  // to put a prefix in front of one is not the same question, and guessing at it
  // would reorder what the caller built — so it is handed back as it came.
  const parts = [{ type: "text", text: "hello" }]
  const withParts = [{ role: "system", content: parts }, { role: "user", content: "hi" }]
  assert.equal(withClientPrefix(withParts), withParts)
  // A conversation that is not an array is not a conversation to rewrite.
  assert.equal(withClientPrefix(undefined), undefined)
  assert.equal(withClientPrefix(null), null)
  assert.equal(withClientPrefix("messages"), "messages")
})

test("the data file is what the generator would write for it", () => {
  // The constant and its generator cannot drift apart without this failing: the
  // hash is pinned above, and this says the file on disk is the script's output.
  const run = spawnSync(process.execPath, [join(here, "scripts", "gen-client-prefix.mjs"), "--check"], { encoding: "utf8" })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  assert.match(run.stdout, /up to date/)
})

test("the generator refuses an argument it does not know", () => {
  // A misspelt --chek silently regenerating the file is the kind of thing this
  // repository answers with exit 2 everywhere else.
  const run = spawnSync(process.execPath, [join(here, "scripts", "gen-client-prefix.mjs"), "--chek"], { encoding: "utf8" })
  assert.equal(run.status, 2, `${run.stdout}${run.stderr}`)
  assert.match(run.stdout + run.stderr, /unrecognized argument/)
})
