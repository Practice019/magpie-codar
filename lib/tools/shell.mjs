// exec: one shell command, its output, its exit code.
//
// On Windows the command goes to pwsh -NoProfile -Command, which is what the
// client's system prompt tells the model to write for ("Shell: PowerShell; use
// Get-ChildItem (not ls) …"). -NoProfile keeps a user's profile script from
// printing banners into every result, and -NonInteractive keeps a command that
// asks a question from hanging until the timeout.
//
// Three shapes matter more than the bytes:
//
//   Output.   The reply is "stdout:\n…\nstderr:\n…\nexit code: N", the layout
//             the client uses, so the model keeps reading results the way it
//             was taught. stdout is never merged into stderr; the client's own
//             prompt tells the model not to write 2>&1 for that reason.
//   Timeout.  A command that outruns its timeout is killed — the whole process
//             tree, so a child that would outlive the parent does not keep the
//             workspace busy — and the reply says 超时 with the budget. It is a
//             tool error, because a partial result being silently reported as
//             a complete one is how a wrong answer gets written to disk.
//   Exit.     A non-zero exit is a tool error with its stderr intact. The
//             prompt tells the model to check $LASTEXITCODE; this is the same
//             rule applied by the tool, so an exit 3 cannot be mistaken for a
//             success with warnings.
//
// background:true is a real feature of the client — a managed task list with
// status, tail and stop. This cut has no task supervisor, so the request is
// answered honestly ("后台任务暂不支持") with is_error:false: the model should
// run the command in the foreground instead, not conclude the command failed
// and retry an identical background call.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"

import { resolvePath } from "./paths.mjs"
import { toolError, toolOk } from "./result.mjs"
import { headAndTail, saveWhole } from "./truncate.mjs"

const DEFAULT_TIMEOUT_MS = 10000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const BACKGROUND_NOTE =
  "后台任务暂不支持：本环境没有任务管理器，exec 的 background/status/tail/send/stop 都还不可用。" +
  "命令没有被执行。请去掉 background 在同一轮前台执行；如果确实很长，把 timeout_ms 调大到需要的时长。"

// shellFor picks the interpreter for this host. Windows gets pwsh when it is
// on PATH and powershell.exe otherwise: the prompt says PowerShell, and either
// one is PowerShell, so the fallback keeps exec usable on a machine without
// PowerShell 7 rather than failing every command.
export const shellFor = (platform = process.platform, env = process.env) => {
  if (platform !== "win32") {
    return { command: "/bin/sh", args: ["-c"], shell: false }
  }
  const pwsh = which("pwsh", env)
  if (pwsh) return { command: pwsh, args: ["-NoProfile", "-NonInteractive", "-Command"], shell: false }
  return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command"], shell: false }
}

// which is a PATH lookup that does not need a subprocess: spawning `where`
// would itself need a timeout and a kill path for a question with a cheap
// answer in the filesystem.
export const which = (name, env = process.env) => {
  const exts = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue
    for (const ext of ["", ...exts]) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

// environmentFor builds the child's environment. The default keeps the host's
// variables (a stripped PATH breaks every command that calls another program)
// and adds two the reply can point at; "service" drops the client's own
// CODAR_* variables, as the tool's description says the external-service
// profile does.
export const environmentFor = (mode, ctx, workdir) => {
  const env = { ...process.env }
  if (mode === "service") {
    for (const key of Object.keys(env)) if (key.startsWith("CODAR_")) delete env[key]
  }
  if (typeof ctx?.sessionId === "string" && ctx.sessionId !== "" && !env.CODAR_SESSION_ID) {
    env.CODAR_SESSION_ID = ctx.sessionId
  }
  env.PWD = workdir
  return env
}

// decodeOutput reads a Buffer as UTF-8, with one fallback: Windows programs
// still on the ANSI code page (chcp 936) write GBK, and a GBK buffer decoded as
// UTF-8 is a string of replacement characters — the model cannot tell that
// from a broken program. Only when the result contains U+FFFD is the GBK
// reading tried, and only when it decodes cleanly is it used.
export const decodeOutput = (buffer) => {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer)
  if (!utf8.includes("\uFFFD")) return normalizeNewlines(utf8)
  try {
    return normalizeNewlines(new TextDecoder("gbk", { fatal: true }).decode(buffer))
  } catch {
    return normalizeNewlines(utf8)
  }
}

// normalizeNewlines turns CRLF into LF. PowerShell writes CRLF on Windows, and
// a CR left in the result shows up in everything the model copies next: a path
// read from a listing and pasted into a command carries an invisible carriage
// return, and a line it quotes for a patch is then not the line in the file.
export const normalizeNewlines = (text) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

const clip = (text, limit = 20000) => {
  if (text.length <= limit * 2) return text
  return `${text.slice(0, limit)}\n…（共 ${text.length} 个字符，中间省略）\n${text.slice(-limit)}`
}

export const execTool = async (ctx, args) => {
  const command = typeof args?.command === "string" ? args.command : ""
  if (command.trim() === "") return toolError("缺少 command：exec 需要一个要执行的命令字符串")

  if (args?.background) return toolOk(BACKGROUND_NOTE)

  const action = typeof args?.action === "string" ? args.action : "run"
  if (action !== "run") {
    return toolOk(`后台任务暂不支持：action=${action} 需要任务管理器（task_id），本环境没有；命令没有被执行。`)
  }

  const workdirResolved = resolvePath(ctx, typeof args?.cwd === "string" && args.cwd !== "" ? args.cwd : ".", { allowRoot: true })
  if (workdirResolved.error) return workdirResolved.error
  const workdir = workdirResolved.path

  const wanted = Number(args?.timeout_ms)
  const timeoutMs = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
  const shell = shellFor()
  const env = environmentFor(args?.environment === "service" ? "service" : "runtime", ctx, workdir)

  return await new Promise((settle) => {
    let stdout = []
    let stderr = []
    let settled = false
    let timedOut = false

    let child
    try {
      child = spawn(shell.command, [...shell.args, command], {
        cwd: workdir,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32"
      })
    } catch (error) {
      settle(toolError(`exec 起不来（${shell.command}）：${error?.message ?? String(error)}`))
      return
    }

    const killTree = () => {
      try {
        if (process.platform === "win32") {
          // taskkill /T takes the child tree too: pwsh's own process would die
          // alone and leave a Start-Sleep, or a compiler it launched, running.
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        } else {
          process.kill(-child.pid, "SIGKILL")
        }
      } catch {
        try {
          child.kill("SIGKILL")
        } catch {}
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)

    const onAbort = () => {
      if (settled) return
      timedOut = timedOut !== true
      killTree()
    }
    if (ctx?.signal) {
      if (ctx.signal.aborted) onAbort()
      else ctx.signal.addEventListener("abort", onAbort, { once: true })
    }

    child.stdout?.on("data", (chunk) => stdout.push(chunk))
    child.stderr?.on("data", (chunk) => stderr.push(chunk))

    if (typeof args?.input === "string" && args.input !== "") {
      try {
        child.stdin.end(args.input, "utf8")
      } catch {}
    } else {
      try {
        child.stdin.end()
      } catch {}
    }

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (ctx?.signal) ctx.signal.removeEventListener("abort", onAbort)

      const out = decodeOutput(Buffer.concat(stdout))
      const err = decodeOutput(Buffer.concat(stderr))
      if (timedOut || ctx?.signal?.aborted) {
        const tail = [out.trim(), err.trim()].filter(Boolean).join("\n").slice(-2000)
        settle(toolError(
          `超时：命令在 ${timeoutMs} ms 内没有结束，已终止整个进程树。\n` +
            (tail ? `终止前的输出：\n${tail}` : "终止前没有输出。")
        ))
        return
      }

      const exitCode = typeof code === "number" ? code : signal ? 128 : 1
      const whole = Buffer.concat([...stdout, ...stderr])
      const pointer = whole.length > 40000 ? saveWhole(ctx, "exec", `${out}\n--- stderr ---\n${err}`) : null
      const body = [
        `stdout:\n${headAndTail(clip(out), { pointer })}`,
        `stderr:\n${headAndTail(clip(err))}`,
        `exit code: ${exitCode}`
      ].join("\n")

      settle(exitCode === 0 ? toolOk(body) : toolError(body))
    }

    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle(toolError(`exec 起不来（${shell.command}）：${error?.message ?? String(error)}`))
    })
    child.on("close", (code, signal) => finish(code, signal))
  })
}

// cwdOf is exported for the tests that need to know which directory a command
// ran in without asking the command itself.
export const cwdOf = (ctx) => (typeof ctx?.workspace === "string" ? resolve(ctx.workspace) : dirname(tmpdir()))
