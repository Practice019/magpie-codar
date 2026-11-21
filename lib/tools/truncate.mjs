// Oversized tool results: saved whole, shown in part.
//
// The client's own rule, from its system prompt: "When exec output or a
// web_search or web_fetch result is too long, the result names a file holding
// all of it: read that file instead of re-running the command." So a long
// result is not dropped — it is written under the workspace's tool-outputs/
// directory and the reply says where, in bytes and in lines.
//
// The file lives inside the workspace because the model's next read_file
// resolves relative paths there; a path outside it (a temp directory the
// sandbox then refuses) would be a pointer the model cannot follow.

import { createHash } from "node:crypto"
import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { stampFor } from "./clock.mjs"

// saveWhole writes text under workspace/tool-outputs and answers its
// workspace-relative path and byte count. It does not swallow a write failure:
// the caller shows the truncated result either way and loses only the pointer
// if this returns null, and a throw there would turn a long answer into a
// failed tool call.
export const saveWhole = (ctx, kind, text, { limit = 20 } = {}) => {
  if (typeof ctx?.workspace !== "string" || ctx.workspace === "") return null
  try {
    const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8)
    const name = `${kind}-${stampFor()}-${digest}.txt`
    const dir = join(ctx.workspace, "tool-outputs")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, text, "utf8")
    return {
      path: `tool-outputs/${name}`,
      bytes: statSync(file).size,
      lines: text.split("\n").length,
      limit
    }
  } catch {
    return null
  }
}

// headAndTail is the shape the client shows for a saved result: the start,
// then a line saying what was left out and where the rest is, then the end.
export const headAndTail = (text, { head = 4000, tail = 2000, pointer = null } = {}) => {
  if (text.length <= head + tail) return text
  const skipped = text.length - head - tail
  const where = pointer
    ? `完整输出已保存到 ${pointer.path}（${pointer.bytes} 字节，${pointer.lines} 行），可用 read_file 读取剩余部分`
    : `完整输出未能保存，中间 ${skipped} 个字符已省略`
  return `${text.slice(0, head)}\n\n…（中间省略 ${skipped} 个字符）${where}…\n\n${text.slice(-tail)}`
}

// clipCuts a string at maxChars, saying so: the message is the difference
// between "this is the page" and "this is the start of the page".
export const clipWithNote = (text, maxChars) => {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n…（已截断：共 ${text.length} 个字符，只显示前 ${maxChars} 个）`
}
