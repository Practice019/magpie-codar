// The six file tools the client routes between.
//
// Each one is behaviour, so each is written to answer the way the captured
// listings and replies do, not merely to do the right thing with the bytes:
//
//   read_file   numbered lines, offset/limit in lines, and a first line that
//               says which lines these are out of how many — the client's
//               system prompt tells the model those numbers are not content,
//               which only works if they are actually there.
//   write_file  creates parent directories, says how many bytes landed.
//   edit_file   replaces an exact old_text; every old_text is matched against
//               the original text, not against earlier edits, and the whole
//               call fails without writing if any one of them does not match.
//   list_dir    the client's own two-line shapes: "    name (N bytes)" for a
//               file, "📁 name (0 bytes)" for a directory, ordered by name.
//   apply_patch the envelope from apply_patch's own description.
//   now         the captured sentence.
//
// Two decisions worth naming. list_dir prints a directory's size as
// "(0 bytes)" because that is what the capture shows for every directory —
// a real directory size is a filesystem artifact, not something the model can
// use, and printing it would make the format differ from the one the client
// taught the model to read. And read_file's trailer ("to continue, read from
// offset=N") is only printed when the call really was cut short: a trailer on
// a complete read would send the model back for lines that do not exist.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { nowSentence } from "./clock.mjs"
import { relative, resolvePath } from "./paths.mjs"
import { toolError, toolOk } from "./result.mjs"
import { clipWithNote, headAndTail, saveWhole } from "./truncate.mjs"

// The client's own ceilings, from read_file's description: 2000 lines and
// 50 KB per call, and any single line over 2000 characters cut off.
const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024
const MAX_LINE_CHARS = 2000

// lineCount counts lines the way a reader does: "a\nb\n" is two lines, and a
// file that does not end in a newline still has a last line.
export const lineCount = (lines) => (lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length)

const decode = (buffer) => {
  // A UTF-8 BOM is not part of the text; leaving it in makes line 1 start with
  // an invisible character that a later edit_file cannot reproduce.
  const text = buffer.toString("utf8")
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

const readFailure = (ctx, raw, error) => {
  if (error?.code === "ENOENT") return toolError(`读不到 ${relative(ctx, resolve(ctx.workspace, raw))}：文件不存在`)
  if (error?.code === "EISDIR") return toolError(`读不到 ${raw}：这是一个目录，不是文件`)
  if (error?.code === "EACCES" || error?.code === "EPERM") return toolError(`读不到 ${raw}：没有权限（${error.code}）`)
  return toolError(`读不到 ${raw}：${error?.message ?? String(error)}`)
}

export const readFile = (ctx, args) => {
  const raw = args?.path
  const resolved = resolvePath(ctx, raw)
  if (resolved.error) return resolved.error
  const shown = relative(ctx, resolved.path)

  let text
  try {
    if (statSync(resolved.path).isDirectory()) return toolError(`读不到 ${shown}：这是一个目录，请用 list_dir`)
    text = decode(readFileSync(resolved.path))
  } catch (error) {
    return readFailure(ctx, shown, error)
  }

  const lines = text.split("\n")
  const total = lineCount(lines)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  const offset = Math.max(1, Math.trunc(Number(args?.offset ?? 1)) || 1)
  if (total > 0 && offset > total) {
    return toolError(`${shown} 只有 ${total} 行，offset=${offset} 超出文件末尾`)
  }
  const limit = Math.min(MAX_LINES, Math.max(1, Math.trunc(Number(args?.limit ?? MAX_LINES)) || MAX_LINES))

  const picked = []
  let bytes = 0
  let clipped = 0
  let next = total + 1
  for (let i = offset - 1; i < total; i++) {
    if (picked.length >= limit) {
      next = i + 1
      break
    }
    let line = lines[i]
    if (line.length > MAX_LINE_CHARS) {
      line = `${line.slice(0, MAX_LINE_CHARS)}…（本行共 ${lines[i].length} 个字符，已截断）`
      clipped++
    }
    const cost = Buffer.byteLength(line, "utf8") + 8
    if (bytes + cost > MAX_BYTES && picked.length > 0) {
      next = i + 1
      break
    }
    bytes += cost
    picked.push(`${i + 1}\t${line}`)
  }

  const first = picked.length > 0 ? offset : 0
  const last = picked.length > 0 ? offset + picked.length - 1 : 0
  const head = `[第 ${first}-${last} 行，共 ${total} 行]`
  const notes = []
  if (clipped > 0) notes.push(`有 ${clipped} 行超过 ${MAX_LINE_CHARS} 个字符，已被截断`)
  if (next <= total) notes.push(`还有 ${total - next + 1} 行未显示，继续读请用 offset=${next}`)

  return toolOk([head, ...picked, ...notes.map((n) => `（${n}）`)].join("\n"))
}

export const writeFile = (ctx, args) => {
  const raw = args?.path
  const content = typeof args?.content === "string" ? args.content : ""
  const resolved = resolvePath(ctx, raw)
  if (resolved.error) return resolved.error
  try {
    mkdirSync(dirname(resolved.path), { recursive: true })
    writeFileSync(resolved.path, content, "utf8")
  } catch (error) {
    return toolError(`写不进 ${raw}：${error?.message ?? String(error)}`)
  }
  const bytes = Buffer.byteLength(content, "utf8")
  return toolOk(`${relative(ctx, resolved.path)}：已写入 ${bytes} 字节（${content.split("\n").length} 行）`)
}

// similarity is a cheap Dice coefficient over character bigrams: enough to
// pick the line a mistyped old_text was aiming at, and stable enough that the
// suggestion a reader sees does not change with a hash seed.
const bigrams = (text) => {
  const counts = new Map()
  const points = Array.from(text.toLowerCase())
  for (let i = 0; i < points.length - 1; i++) {
    const key = points[i] + points[i + 1]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export const similarity = (a, b) => {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const [key, count] of left) shared += Math.min(count, right.get(key) ?? 0)
  return (2 * shared) / (left.size + right.size)
}

// nearestLines answers the lines of text closest to wanted, best first.
export const nearestLines = (text, wanted, count = 3) => {
  const scored = text
    .split("\n")
    .map((line, i) => ({ line, number: i + 1, score: similarity(line, wanted) }))
    .filter((c) => c.line.trim() !== "")
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, count).filter((c) => c.score > 0.2)
}

const quote = (text) => {
  const lines = text.split("\n")
  const heads = lines.slice(0, 5).map((l) => `    | ${l}`)
  if (lines.length > 5) heads.push(`    | …（共 ${lines.length} 行）`)
  return heads.join("\n")
}

export const editFile = (ctx, args) => {
  const raw = args?.path
  const resolved = resolvePath(ctx, raw)
  if (resolved.error) return resolved.error
  const shown = relative(ctx, resolved.path)

  const edits = Array.isArray(args?.edits) ? args.edits : []
  if (edits.length === 0) return toolError(`${shown}：edits 为空，没有要替换的内容`)

  let text
  try {
    text = decode(readFileSync(resolved.path))
  } catch (error) {
    if (error?.code === "ENOENT") return toolError(`${shown}：文件不存在，无法编辑`)
    return editFailure(shown, error)
  }

  const planned = []
  const problems = []
  for (const edit of edits) {
    const oldText = typeof edit?.old_text === "string" ? edit.old_text : edit?.old_string
    const newText = typeof edit?.new_text === "string" ? edit.new_text : edit?.new_string
    if (typeof oldText !== "string" || oldText === "") {
      problems.push("有一项 edit 缺少 old_text（或为空）")
      continue
    }
    if (typeof newText !== "string") {
      problems.push(`没有找到对 old_text 的替换文本 new_text：\n${quote(oldText)}`)
      continue
    }
    const at = text.indexOf(oldText)
    const again = at === -1 ? -1 : text.indexOf(oldText, at + 1)
    if (at === -1) {
      const nearest = nearestLines(text, oldText)
      const hint = nearest.length > 0
        ? `最接近的原文片段：\n${nearest.map((c) => `    第 ${c.number} 行：${c.line}`).join("\n")}`
        : "文件里没有相近的行可提示"
      problems.push(`没有找到这段 old_text：\n${quote(oldText)}\n${hint}`)
      continue
    }
    if (again !== -1) {
      problems.push(`old_text 不唯一（出现 ${countOf(text, oldText)} 处），请带上更多上下文让它唯一：\n${quote(oldText)}`)
      continue
    }
    planned.push({ at, oldText, newText })
  }

  if (problems.length > 0) {
    return toolError(`${shown}：${problems.length} 处编辑未能应用，文件未改动。\n\n${problems.join("\n\n")}`)
  }

  planned.sort((a, b) => a.at - b.at)
  for (let i = 1; i < planned.length; i++) {
    const previous = planned[i - 1]
    if (previous.at + previous.oldText.length > planned[i].at) {
      return toolError(`${shown}：第 ${i} 处与第 ${i + 1} 处编辑的重叠区重叠，文件未改动`)
    }
  }

  let out = ""
  let cursor = 0
  for (const edit of planned) {
    out += text.slice(cursor, edit.at) + edit.newText
    cursor = edit.at + edit.oldText.length
  }
  out += text.slice(cursor)

  try {
    writeFileSync(resolved.path, out, "utf8")
  } catch (error) {
    return editFailure(shown, error)
  }
  const delta = out.length - text.length
  const sign = delta >= 0 ? "+" : ""
  return toolOk(`${shown}：已应用 ${planned.length} 处编辑（${sign}${delta} 个字符，${Buffer.byteLength(out, "utf8")} 字节）`)
}

const countOf = (text, needle) => {
  let count = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    count++
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

const editFailure = (shown, error) => toolError(`${shown}：编辑失败（${error?.code ?? ""} ${error?.message ?? String(error)}）`)

// listDir answers the client's own listing. The captured one, for
// C:\Users\21877\.codar, began:
//    "   .config.lock (0 bytes)\n📁 background (0 bytes)\n📁 bio (0 bytes)\n..."
// so: a file is three spaces, its name, then " (N bytes)"; a directory is the
// folder glyph, its name, then " (0 bytes)"; and the order is by name across
// both kinds — the dot file leads, which a directories-first list would not
// do. A trailing slash on a directory name would be a fourth, differing
// signal, so the glyph carries "this is a directory" instead.
export const listDir = (ctx, args) => {
  const resolved = resolvePath(ctx, args?.path, { allowRoot: true })
  if (resolved.error) return resolved.error
  const shown = relative(ctx, resolved.path)

  let entries
  try {
    if (!statSync(resolved.path).isDirectory()) return toolError(`列不出 ${shown}：这是一个文件，不是目录`)
    entries = readdirSync(resolved.path, { withFileTypes: true })
  } catch (error) {
    if (error?.code === "ENOENT") return toolError(`列不出 ${shown || String(args?.path)}：目录不存在`)
    return toolError(`列不出 ${shown}：${error?.message ?? String(error)}`)
  }

  if (entries.length === 0) return toolOk("（空目录）")

  const lines = entries
    .map((entry) => {
      if (entry.isDirectory()) return { name: entry.name, line: `📁 ${entry.name} (0 bytes)` }
      let bytes = 0
      try {
        bytes = statSync(join(resolved.path, entry.name)).size
      } catch {
        // A dangling symlink or a file removed mid-listing: the name is still
        // worth showing, and a zero is honest about what could be measured.
        bytes = 0
      }
      return { name: entry.name, line: `   ${entry.name} (${bytes} bytes)` }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => entry.line)

  return toolOk(lines.join("\n"))
}

export const nowTool = () => toolOk(nowSentence())

// apply_patch's envelope, from the tool's own description.
//
// The parse is deliberately literal. Three section headers start a file, the
// envelope must open and close, and every line inside a section either carries
// a prefix or is blank. A patch that half-applies is worse than one that does
// not apply: the model is told which section failed and re-sends the whole
// thing, while a half-applied patch leaves a tree neither of them describes.
// So all sections are validated in memory first, and only a fully valid
// batch is written.

export const parsePatch = (patch) => {
  if (typeof patch !== "string" || patch.trim() === "") {
    return { error: toolError("patch 是空的：需要 *** Begin Patch / *** End Patch 包裹的文件段") }
  }
  const lines = patch.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  let begun = false
  let ended = false
  const sections = []
  let current = null

  for (const line of lines) {
    if (line === "*** Begin Patch") {
      if (begun) return { error: toolError("*** Begin Patch 重复出现") }
      if (sections.length > 0) return { error: toolError("*** Begin Patch 必须在所有文件段之前") }
      begun = true
      continue
    }
    if (line === "*** End Patch") {
      if (!begun) return { error: toolError("遇到 *** End Patch，但之前没有 *** Begin Patch") }
      if (current) {
        sections.push(current)
        current = null
      }
      ended = true
      break
    }
    const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line)
    if (header) {
      if (!begun) return { error: toolError("文件段出现在 *** Begin Patch 之前；patch 必须用 *** Begin Patch 开头") }
      if (current) sections.push(current)
      const kind = header[1]
      const target = header[2].trim()
      if (kind === "Move to") {
        if (!current) return { error: toolError("*** Move to: 必须紧跟在 *** Update File: 之后") }
        current.move = target
        continue
      }
      current = { kind, path: target, text: [], move: null, line: sections.length + 1 }
      continue
    }
    if (line.startsWith("*** ")) {
      return { error: toolError(`不认识的段落头：${line}`) }
    }
    if (!current) {
      if (line.trim() === "") continue
      return { error: toolError(`*** Begin Patch 之后的第一段必须先有一个文件头（*** Add File / Update File / Delete File），却读到了：${line}`) }
    }
    current.text.push(line)
  }

  if (!begun) return { error: toolError("找不到 *** Begin Patch；patch 必须用它开头，用 *** End Patch 结尾") }
  if (!ended && current) sections.push(current)
  if (!ended) return { error: toolError("patch 没有 *** End Patch 结尾") }
  if (sections.length === 0) return { error: toolError("patch 里没有任何文件段") }
  return { sections }
}

// hunks splits a section's lines into hunks at @@ anchors. A hunk with no
// "-" or "+" line is refused: its context lines would match nothing and the
// patch would appear to succeed while changing nothing.
export const hunksOf = (section) => {
  const hunks = []
  let hunk = null
  for (const line of section.text) {
    if (line.startsWith("@@")) {
      if (hunk) hunks.push(hunk)
      hunk = { anchor: line.slice(2).trim(), lines: [] }
      continue
    }
    if (!hunk) {
      if (line.trim() === "") continue
      hunk = { anchor: "", lines: [] }
    }
    hunk.lines.push(line)
  }
  if (hunk) hunks.push(hunk)
  return hunks
}

// addLines answers a file's body from an Add File section: every line must be
// a "+" line or blank (a blank line in a patch the client writes is " ").
const addLines = (section) => {
  const body = []
  for (const line of section.text) {
    if (line === "") {
      body.push("")
      continue
    }
    if (line.startsWith("+")) {
      body.push(line.slice(1))
      continue
    }
    if (line.startsWith(" ")) {
      body.push(line.slice(1))
      continue
    }
    return { error: `Add File 段里只能有 + 开头的行，却读到：${line}` }
  }
  return { text: body.map((l) => `${l}\n`).join("") }
}

// applyHunks replays one section's hunks against the original text. Each hunk
// is located by its context and "-" lines; the anchor text only narrows the
// search to a region, it is never edited.
const applyHunks = (original, hunks) => {
  const lines = original.split("\n")
  const trailing = lines.length > 0 && lines[lines.length - 1] === ""
  if (trailing) lines.pop()

  for (const hunk of hunks) {
    const changed = hunk.lines.some((l) => l.startsWith("-") || l.startsWith("+"))
    if (!changed) return { error: "这一段没有 - 或 + 行，不能应用" }

    const before = []
    const after = []
    const oldLines = []
    const newLines = []
    for (const line of hunk.lines) {
      const prefix = line.startsWith("@@") ? "@" : line.slice(0, 1)
      const body = line.startsWith("@@") ? line : line.slice(1)
      if (prefix === " " || prefix === "") {
        oldLines.push(body)
        newLines.push(body)
      } else if (prefix === "-") {
        oldLines.push(body)
      } else if (prefix === "+") {
        newLines.push(body)
      } else {
        return { error: `不认识的补丁行前缀 ${JSON.stringify(prefix)}：${line}` }
      }
    }

    const searchFrom = hunk.anchor ? Math.max(0, findAnchor(lines, hunk.anchor)) : 0
    const found = findSequence(lines, oldLines, searchFrom)
    if (found === -1) return { error: "找不到这段上下文，无法定位", hunk }

    if (oldLines.length === 0) {
      lines.splice(found, 0, ...newLines)
    } else {
      lines.splice(found, oldLines.length, ...newLines)
    }
    before.push(found)
    after.push(newLines.length)
  }
  return { text: lines.join("\n") + (trailing ? "\n" : "") }
}

const findAnchor = (lines, anchor) => {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(anchor)) return i
    if (/(^|\s)(func|class|def|function|fn|impl)\s/.test(lines[i]) && lines[i].includes(anchor)) return i
  }
  return 0
}

const findSequence = (lines, wanted, from = 0) => {
  if (wanted.length === 0) return from
  outer: for (let i = from; i <= lines.length - wanted.length; i++) {
    for (let j = 0; j < wanted.length; j++) {
      if (lines[i + j] !== wanted[j]) continue outer
    }
    return i
  }
  return -1
}

export const applyPatch = (ctx, args) => {
  const parsed = parsePatch(args?.patch)
  if (parsed.error) return parsed.error

  // Everything is resolved and replayed before a single byte is written, so a
  // bad second section cannot leave the first one applied.
  const plan = []
  for (const section of parsed.sections) {
    const resolved = resolvePath(ctx, section.path)
    if (resolved.error) {
      return toolError(`第 ${section.line} 段（${section.kind} ${section.path}）：${resolved.error.content}`)
    }
    const shown = relative(ctx, resolved.path)

    if (section.kind === "Add File") {
      const body = addLines(section)
      if (body.error) return toolError(`第 ${section.line} 段（Add File ${shown}）：${body.error}`)
      plan.push({ kind: "add", path: resolved.path, shown, content: body.text })
      continue
    }

    if (section.kind === "Delete File") {
      if (!existsSync(resolved.path)) return toolError(`第 ${section.line} 段（Delete File ${shown}）：文件不存在`)
      plan.push({ kind: "delete", path: resolved.path, shown })
      continue
    }

    let original
    try {
      original = decode(readFileSync(resolved.path))
    } catch (error) {
      if (error?.code === "ENOENT") return toolError(`第 ${section.line} 段（Update File ${shown}）：文件不存在，要用 *** Add File: 新增`)
      return toolError(`第 ${section.line} 段（Update File ${shown}）：读不到（${error?.message ?? String(error)}）`)
    }
    const hunks = hunksOf(section)
    if (hunks.length === 0) return toolError(`第 ${section.line} 段（Update File ${shown}）：没有任何 @@ 段落`)

    const result = applyHunks(original, hunks)
    if (result.error) {
      const anchor = hunks.map((h) => h.anchor).filter(Boolean).join(" / ")
      return toolError(
        `第 ${section.line} 段（Update File ${shown}）：${result.error}${anchor ? `（@@ ${anchor}）` : ""}；` +
          `patch 未写入任何文件，请核对上下文行后重发整份 patch`
      )
    }

    let moveTo = null
    if (section.move) {
      const resolvedMove = resolvePath(ctx, section.move)
      if (resolvedMove.error) {
        return toolError(`第 ${section.line} 段（Move to ${section.move}）：${resolvedMove.error.content}`)
      }
      moveTo = resolvedMove.path
    }
    plan.push({ kind: "update", path: resolved.path, shown, content: result.text, moveTo, moveShown: section.move })
  }

  const done = []
  for (const step of plan) {
    try {
      if (step.kind === "add") {
        mkdirSync(dirname(step.path), { recursive: true })
        writeFileSync(step.path, step.content, "utf8")
        done.push(`已新增 ${step.shown}`)
        continue
      }
      if (step.kind === "delete") {
        unlinkSync(step.path)
        done.push(`已删除 ${step.shown}`)
        continue
      }
      writeFileSync(step.path, step.content, "utf8")
      if (step.moveTo) {
        mkdirSync(dirname(step.moveTo), { recursive: true })
        writeFileSync(step.moveTo, step.content, "utf8")
        unlinkSync(step.path)
        done.push(`已更新并重命名为 ${step.moveShown}`)
      } else {
        done.push(`已更新 ${step.shown}`)
      }
    } catch (error) {
      return toolError(`${done.length > 0 ? `${done.join("；")}；但` : ""}写 ${step.shown} 失败：${error?.message ?? String(error)}`)
    }
  }
  return toolOk(done.join("\n"))
}

export const fileTool = {
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  list_dir: listDir,
  apply_patch: applyPatch,
  now: nowTool
}

// Exported for the two callers that need the same clip rule (web_fetch): one
// definition of "cut off" keeps the wording consistent across tools.
export { clipWithNote, headAndTail, saveWhole }
