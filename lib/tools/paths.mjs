// The workspace boundary every file tool goes through.
//
// A relative path resolves against the turn's workspace and has to stay under
// it. The client refuses a path that contains ".." outright, which is the rule
// copied here: a tool that quietly followed "../../etc/passwd" out of the
// sandbox would read a file the conversation was never given, and the model
// would have no way to tell that its answer came from outside.
//
// Both checks are needed. The textual one rejects the dot-dot a caller typed
// before any filesystem call happens; the resolved one catches a path that
// spells no dot-dot but lands outside anyway — a symlink, or a sibling whose
// name begins with the workspace's own (C:\ws2 against C:\ws). The resolved
// check is also what keeps the message honest about which file was refused.

import { realpathSync } from "node:fs"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

import { toolError } from "./result.mjs"

// containsDotDot mirrors the client's own guard: any ".." segment, in either
// slash, at any depth.
export const containsDotDot = (path) => /(^|[\\/])\.\.([\\/]|$)/.test(String(path ?? ""))

// realpathOf answers the real path of the nearest existing ancestor, with the
// rest appended: a write to a file that does not exist yet still has to be
// checked, and its parent does exist.
export const realpathOf = (path) => {
  const absolute = resolve(path)
  const tail = []
  let head = absolute
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse())
    } catch {
      const parent = dirname(head)
      if (parent === head) return absolute
      tail.push(head.slice(parent.length).replace(/^[\\/]/, ""))
      head = parent
    }
  }
}

// isInside answers whether path is workspace itself or something under it.
export const isInside = (workspace, path) => {
  const root = realpathOf(workspace)
  const target = realpathOf(path)
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : root + sep)
}

// resolvePath turns a tool argument into an absolute path inside the
// workspace, or a tool error that says why. The message names the path the
// caller gave: "越界" without the path leaves the model guessing which of a
// patch's three paths was refused.
export const resolvePath = (ctx, raw, { allowRoot = false } = {}) => {
  const workspace = ctx?.workspace
  if (typeof workspace !== "string" || workspace === "") {
    return { error: toolError("没有可用的工作目录（ctx.workspace 为空），无法解析路径") }
  }
  if (typeof raw !== "string" || raw === "") {
    if (allowRoot) return { path: realpathOf(workspace) }
    return { error: toolError("缺少 path 参数") }
  }
  if (containsDotDot(raw)) {
    return { error: toolError(`路径越界：${raw} 含 ".."，文件工具只允许工作目录内的路径`) }
  }
  if (raw.includes("\0")) return { error: toolError(`路径越界：${raw} 含 NUL 字符`) }
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw)
  if (!isInside(workspace, absolute)) {
    return { error: toolError(`路径越界：${raw} 解析到 ${absolute}，不在工作目录 ${workspace} 内`) }
  }
  return { path: absolute }
}

// insideWorkspace is the boolean form, for code that already holds an
// absolute path (apply_patch's Delete File, a rename target).
export const insideWorkspace = (ctx, absolute) => {
  if (typeof ctx?.workspace !== "string" || ctx.workspace === "") return false
  if (containsDotDot(absolute)) return false
  return isInside(ctx.workspace, absolute)
}

// relative is what the tool results show: the workspace-relative path the
// model wrote, with forward slashes, so the strings in the transcript match
// the strings in the request.
export const relative = (ctx, absolute) => {
  const root = realpathOf(ctx.workspace)
  const target = realpathOf(absolute)
  if (target === root) return "."
  const tail = target.startsWith(root + sep) ? target.slice(root.length + 1) : absolute
  return tail.split(sep).join("/")
}
