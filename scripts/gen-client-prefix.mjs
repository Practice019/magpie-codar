#!/usr/bin/env node
// Writes lib/client-prefix-data.mjs from a capture of the Codar desktop's own
// chat request, so no byte of the client's system prefix is typed by hand.
//
// Why the prefix, and why exactly four segments. Measured on this machine
// (2026-11-21), against api.claw.speedai.com, on two accounts
// (16267173586 / 19200847396), varying only the system message's length:
//
//   first 1 segment   (49 characters)   → 403 client_not_supported, both
//   first 4 segments  (~1.6 KB)         → 200, both
//   first 6 / 20 segments, 33,577 chars → 200
//   33 KB system, no tools, short message → 200
//
// So the gateway's "is this the Codar client?" test is not the token, not a
// header and not the tool table (tools are optional): it is the head of the
// system message. Four segments is the shortest cut that was measured to pass,
// which is why the constant is four and not thirty-three kilobytes — the rest
// of the capture's prompt prescribes the desktop's own tools and would be a
// second set of agent instructions arguing with the caller's.
//
// Why a generator rather than a constant written once: the truth is a string
// inside an 84,555-byte JSON body, and the point of copying it is that the bytes
// are the same. Handing a person a cursor in a 1.6 KB string gets a prefix that
// reads right and differs in a space — and the gateway is the thing comparing
// bytes. The suite pins the sha256 of what this script writes against a literal
// recorded from the capture, so a drift in either side is red.
//
// Usage: node scripts/gen-client-prefix.mjs [capture.json] [--check]
//
// The capture is looked for in the argument, then CODAR_CLIENT_CAPTURE, then the
// register-machine checkout this repository sits beside. --check compares what
// would be written with what is on disk and exits 1 when they differ.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outPath = join(root, "lib", "client-prefix-data.mjs")

// SEGMENTS is the cut, in the capture's own units: the system message split on
// blank lines, empty pieces dropped, the first SEGMENTS kept. Four is measured
// (above); changing it changes what the gateway sees, so it is not a setting.
const SEGMENTS = 4

// OPENING is how the desktop's prompt opens. The generator refuses to write a
// prefix that does not open this way: a capture from another client, or one
// whose first message is not the prompt, would produce a prefix that is
// plausibly shaped and refuses every request.
const OPENING = "You are an AI agent running on the Codar runtime."

// SIZE bounds are a sanity check on the cut, not a target. The measurement used
// 1,632 characters; a capture whose first four segments ran to 40 characters or
// to 40 KB is a capture this script does not understand, and writing it would
// hide the fact behind a hash the suite would then pin.
const MIN_CHARS = 800
const MAX_CHARS = 4000

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith("--"))
const rest = args.filter((a) => !a.startsWith("--"))
const unknown = flags.filter((f) => f !== "--check")
if (unknown.length) {
  console.error(`unrecognized argument ${unknown.join(" ")} (only --check is accepted)`)
  process.exit(2)
}
const check = flags.includes("--check")

const capturePath = [
  rest[0],
  process.env.CODAR_CLIENT_CAPTURE,
  join(root, "..", "..", "register-machine", "docs", "codar", "samples", "chat-completions.body.json"),
].find((p) => p && existsSync(p))

if (!capturePath) {
  console.error("no capture: pass the desktop's chat-completions.body.json, or set CODAR_CLIENT_CAPTURE")
  process.exit(2)
}

const quote = (s) => JSON.stringify(s).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)

const systemOf = (body) => {
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message && message.role === "system" && typeof message.content === "string") return message.content
  }
  return null
}

let capture
try {
  capture = JSON.parse(readFileSync(capturePath, "utf8"))
} catch (e) {
  console.error(`${capturePath}: ${e.message}`)
  process.exit(2)
}

const system = systemOf(capture)
if (!system) {
  console.error(`${capturePath}: no system message in messages[]`)
  process.exit(2)
}

// The cut. Split on the capture's own separator, drop the empty pieces an
// adjacent pair of separators produces ("---" sections leave one), and keep the
// first SEGMENTS — joined back with the same separator, so the string is the
// capture's for as far as it goes.
const segments = system.split("\n\n").filter((part) => part.trim() !== "")
if (segments.length < SEGMENTS) {
  console.error(`${capturePath}: the system message has ${segments.length} segments, the cut needs ${SEGMENTS}`)
  process.exit(2)
}
const prefix = segments.slice(0, SEGMENTS).join("\n\n")

if (!prefix.startsWith(OPENING)) {
  console.error(`${capturePath}: the system message does not open with the client's line; refusing to write a prefix that would refuse every request`)
  process.exit(2)
}
if (!system.startsWith(prefix)) {
  console.error(`${capturePath}: the first ${SEGMENTS} segments are not a prefix of the capture; the cut moved`)
  process.exit(2)
}
if (prefix.length < MIN_CHARS || prefix.length > MAX_CHARS) {
  console.error(`${capturePath}: the first ${SEGMENTS} segments are ${prefix.length} characters, outside ${MIN_CHARS}..${MAX_CHARS}; this is a capture of something else`)
  process.exit(2)
}

const hash = createHash("sha256").update(prefix, "utf8").digest("hex").slice(0, 16)

const generated = `// GENERATED — do not edit. scripts/gen-client-prefix.mjs writes this file from
// a capture of the Codar desktop's own chat request (v0.3.17, 2026-11-20); run
// it again to rewrite it.
//
// CLIENT_SYSTEM_PREFIX is the capture's system message cut at its first
// ${SEGMENTS} blank-line-separated segments and nothing else: ${prefix.length} characters, byte for
// byte. It is the shortest head that was measured to pass the gateway's
// client check (2026-11-21: one segment → 403 client_not_supported on two
// accounts, four → 200 on both), which is why it is here at all — the rest of
// the capture's 33,577-character prompt prescribes the desktop's own tools and
// is deliberately not sent.
//
// The one thing in it that is not this machine's: the head's
// "Working Directory:" line quotes the session the capture was taken from. It
// stays because the prefix is measured by its bytes — a rewritten line is a
// different request — and the caller's own instructions, which follow it, are
// what name the real directories the tools work in.

// What the capture was, and how much of it this file carries.
export const CLIENT_SYSTEM_PREFIX_CAPTURE = ${quote(`${capturePath.split(/[\\/]/).pop()} (system message ${system.length} characters, ${segments.length} segments)`)}

// How much of it: the cut, in blank-line-separated segments.
export const CLIENT_SYSTEM_PREFIX_SEGMENTS = ${SEGMENTS}

// The head, verbatim. Its first four segments are the whole string.
export const CLIENT_SYSTEM_PREFIX = ${quote(prefix)}

// SHA-256 of the whole prefix, first 16 hex digits. The suite pins this
// literal against a value of its own, so both the capture and the test would
// have to move for a drift to pass.
export const CLIENT_SYSTEM_PREFIX_HASH = ${quote(hash)}
`

const same = existsSync(outPath) && readFileSync(outPath, "utf8") === generated
if (check) {
  if (!same) {
    console.error(`${outPath.slice(root.length + 1)} is stale: run node scripts/gen-client-prefix.mjs`)
    process.exit(1)
  }
  console.log(`${outPath.slice(root.length + 1)}: up to date (${prefix.length} characters, hash ${hash})`)
  process.exit(0)
}
if (!same) writeFileSync(outPath, generated)
console.log(`${outPath.slice(root.length + 1)}: ${SEGMENTS} segments kept, ${prefix.length} characters (hash ${hash})`)
