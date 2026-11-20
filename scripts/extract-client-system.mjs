#!/usr/bin/env node
// Writes lib/client-system-data.mjs from a capture of the Codar desktop's own
// chat request, so no line of that prompt is retyped by hand.
//
// Why a generator rather than a constant written once: the truth is a 33,577
// character system message inside an 83,515 byte JSON body, and the point of
// copying it is that the bytes are the same. Handing a person a cursor in a
// 33 KB file gets a prompt that reads right and differs in a space, and nobody
// can tell by looking. This script reads the capture, keeps the head verbatim,
// splits the rest at its `# ` headings, and writes the survivors out as string
// constants; the test suite then pins the head's hash against the value this
// script recorded, so a drift in either side is red.
//
// What is kept, and what is not:
//
//   - the runtime head (opening line, Runtime info, OS, Shell) is kept byte for
//     byte, hardcoded paths and all. It is the client's identity prefix, which
//     is the whole point, and its PowerShell advice is true of the caller's
//     shell too. Rendered by lib/client-system.mjs with the two lines below it
//     rewritten, because those two are the session's own.
//   - a section is kept only when it says nothing about a tool the desktop has
//     and the caller does not (exec, read_file, write_file, edit_file,
//     apply_patch, list_dir, load_skill, install_skill, task_write,
//     figure_checkpoint, spawn_agent, the converters, …), and nothing that
//     hardcodes a path. A kept section is the capture's text, unedited; a
//     dropped one is listed by title in CLIENT_SYSTEM_DROPPED with the reason.
//
// The one declared edit: a kept section whose text quotes an absolute path
// gets that path replaced, because the path is a session's and not an
// instruction. `edits` in the generated file's header says so.
//
// Usage: node scripts/extract-client-system.mjs [capture.json] [--check]
//
// The capture is looked for in the argument, then CODAR_CLIENT_CAPTURE, then
// the register-machine checkout this repository sits beside. --check compares
// what would be written with what is on disk and exits 1 when they differ.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outPath = join(root, "lib", "client-system-data.mjs")

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

// TOOL_BOUND is the vocabulary of the desktop's own tools: a paragraph that
// asks for one of these is a paragraph the caller cannot act on. Word
// boundaries, so `read_file` does not match inside a longer identifier, and
// `literature_[a-z_]+` covers the family without listing every member.
const TOOL_BOUND =
  /\b(?:exec|read_file|write_file|edit_file|apply_patch|list_dir|load_skill|install_skill|task_write|figure_checkpoint|understand_image|img2pptx|spawn_agent|convert_document_to_pdf|read_pdf_text|render_pdf_pages|load_workspace_dependencies|literature_[a-z_]+)\b/

// ABSOLUTE_PATH finds a Windows path: a drive letter, a colon, a backslash.
// The one section that quotes one is rewritten rather than dropped (see
// `edits`), but a section can only be rewritten to a placeholder when the path
// is quoted, which is what the replacement matches.
const ABSOLUTE_PATH = /"[A-Za-z]:\\[^"]*"/g
const PATH_PLACEHOLDER = '"the working directory your tools report"'

const quote = (s) => JSON.stringify(s).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)

const systemOf = (body) => {
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message && message.role === "system" && typeof message.content === "string") return message.content
  }
  return null
}

// trimSection drops the blank lines and the `---` separator a section is
// delimited by, and nothing else: a section's own text is copied as it landed.
const trimSection = (text) => {
  const lines = text.split("\n")
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start += 1
  while (end > start && (!lines[end - 1].trim() || lines[end - 1].trim() === "---")) end -= 1
  return lines.slice(start, end).join("\n")
}

// sectionsOf splits the text after the head at its `# ` headings. Text before
// the first heading is the draft's file-tool routing, which is the caller's
// business and is left to the caller: it is returned as the first entry with no
// title, and the caller of this function decides what to do with it.
const sectionsOf = (text) => {
  const out = []
  let current = { title: "", lines: [] }
  for (const line of text.split("\n")) {
    if (/^# /.test(line)) {
      out.push(current)
      current = { title: line.slice(2).trim(), lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  out.push(current)
  return out.map((s) => ({ title: s.title, text: trimSection(s.lines.join("\n")) }))
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

const lines = system.split("\n")
// The head is the runtime block: the opening line through the Shell line, the
// last line of it that describes the machine. The file-tool routing below it is
// the desktop's own and is not part of the head.
const shellAt = lines.findIndex((line) => line.startsWith("Shell: "))
if (shellAt < 0) {
  console.error(`${capturePath}: no "Shell: " line in the system message; the head moved`)
  process.exit(2)
}
const head = lines.slice(0, shellAt + 1).join("\n")
if (!system.startsWith(head)) {
  console.error("the head is not a prefix of the capture")
  process.exit(2)
}
if (!head.startsWith("You are an AI agent running on the Codar runtime.\n\nRuntime info:\nOS: ")) {
  console.error("the head does not open the way the client's does; refusing to write a prefix that does not match")
  process.exit(2)
}
// The prefix the transport claims is the first 400 characters. A head shorter
// than that would make the claim rest on text this file does not control.
if (head.length < 400) {
  console.error(`the head is ${head.length} characters, shorter than the 400 the transport copies`)
  process.exit(2)
}

const kept = []
const dropped = []
const edits = []
for (const section of sectionsOf(lines.slice(shellAt + 1).join("\n"))) {
  if (!section.title) continue
  if (TOOL_BOUND.test(section.text)) {
    dropped.push({ title: section.title, reason: "tool" })
    continue
  }
  if (section.text.match(ABSOLUTE_PATH)) {
    // Kept only if the path is quoted, so the rewrite leaves a sentence that
    // still reads: a bare path would leave the section pointing nowhere.
    const text = section.text.replace(ABSOLUTE_PATH, PATH_PLACEHOLDER)
    if (text.match(ABSOLUTE_PATH)) {
      dropped.push({ title: section.title, reason: "path" })
      continue
    }
    edits.push({ title: section.title, from: section.text.match(ABSOLUTE_PATH)[0].slice(0, 24), to: PATH_PLACEHOLDER })
    kept.push({ title: section.title, text })
    continue
  }
  kept.push(section)
}

const hashOf = (text) => createHash("sha256").update(text.slice(0, 400), "utf8").digest("hex").slice(0, 16)

const generated = `// GENERATED — do not edit. scripts/extract-client-system.mjs writes this file
// from a capture of the Codar desktop's own chat request (v0.3.17, 2026-11-20);
// run it again to rewrite it.
//
// CLIENT_SYSTEM_HEAD is the capture's runtime block byte for byte: the opening
// line, "Runtime info:", OS, and the long Shell line. The caller's own system
// prompt is wrapped in it (lib/client-system.mjs), so the prefix the gateway
// sees is the client's for as far as this file reaches — which is why the two
// session-specific lines below it are not here: the capture's
// "Working Directory:" is one machine's, and "Current time: use the now tool"
// names a tool the caller may not have.
//
// CLIENT_SYSTEM_SECTIONS is what survives of the other ${kept.length + dropped.length} sections: the ones that
// prescribe no tool of the desktop's and quote no absolute path. Each text is
// the capture's, unedited — the head is the only place a desktop-only name
// survives, and it survives because it is the prefix being copied.
// CLIENT_SYSTEM_DROPPED says which sections went and why: "tool" for a section
// built around exec/read_file/apply_patch/load_skill/…, "path" for one that
// could not be kept without a session's directory in it.

// What the capture was and how long its system message ran.
export const CLIENT_SYSTEM_CAPTURE = ${quote(`${capturePath.split(/[\\/]/).pop()} (${system.length} characters)`)}

// The runtime head, verbatim. Exact, not approximate: the first 400 characters
// of this string are the first 400 the desktop sends.
export const CLIENT_SYSTEM_HEAD = ${quote(head)}

// SHA-256 of those first 400 characters, first 16 hex digits. The suite pins
// this literal against a value of its own, so both the capture and the test
// would have to move for a drift to pass.
export const CLIENT_SYSTEM_HEAD_HASH = ${quote(hashOf(head))}

// The sections that can be sent to a caller with a different tool table.
export const CLIENT_SYSTEM_SECTIONS = [
${kept.map((s) => `  {\n    title: ${quote(s.title)},\n    text: ${quote(s.text)},\n  },`).join("\n")}
]

// The sections that cannot: each names a tool only the desktop has, or could
// not be kept without a session's path in it.
export const CLIENT_SYSTEM_DROPPED = [
${dropped.map((d) => `  { title: ${quote(d.title)}, reason: ${quote(d.reason)} },`).join("\n")}
]
${
  edits.length
    ? `
// The declared edits: a kept section whose text quoted an absolute path has it
// replaced, so the instruction survives and the session's directory does not.
export const CLIENT_SYSTEM_EDITS = [
${edits.map((e) => `  { title: ${quote(e.title)}, from: ${quote(e.from)}, to: ${quote(e.to)} },`).join("\n")}
]
`
    : ""
}`

const same = existsSync(outPath) && readFileSync(outPath, "utf8") === generated
if (check) {
  if (!same) {
    console.error(`${outPath.slice(root.length + 1)} is stale: run node scripts/extract-client-system.mjs`)
    process.exit(1)
  }
  console.log(`${outPath.slice(root.length + 1)}: up to date (${kept.length} sections kept, ${dropped.length} dropped)`)
  process.exit(0)
}
if (!same) writeFileSync(outPath, generated)
console.log(`${outPath.slice(root.length + 1)}: ${kept.length} sections kept, ${dropped.length} dropped, head ${head.length} characters (hash ${hashOf(head)})`)
