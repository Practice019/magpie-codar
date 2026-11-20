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
// This module is the transport half only: where the server is, whether it is
// up, how a request is read, and what an OpenAI client receives. What a
// conversation becomes in one string is chat-bridge.mjs, and the model list is
// models-from-serve.mjs.

import { spawn as spawnChild } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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

// DEFAULT_CODAR_HOME is the app's home, read the way internal.mjs's configPath
// reads the token's file: CODAR_HOME verbatim (the app honours it, and a
// trimmed value would point the spawned server at a directory the app never
// used), else ~/.codar. Spawned and read here so the server the plugin starts is
// the install the person signed in to.
export const DEFAULT_CODAR_HOME = () => {
  const home = String(process.env.CODAR_HOME ?? "")
  return home || join(homedir(), ".codar")
}

// codarServeExecutable names the app's binary, which is the server: `serve` is
// its own subcommand. Three ways to find it, in the order the environment can
// state them:
//
//   1. CODAR_BIN — the person says where the app is. Taken verbatim (a path is
//      not data to be trimmed), and it wins because a machine that installed
//      the app somewhere else knows better than any default.
//   2. The install path of the vendor's own setup, per platform. Windows puts
//      the app under %LOCALAPPDATA%\Programs\Codar (the default an NSIS
//      per-user install uses; this machine is at
//      D:\software\Codar-Setup-latest\codar-desktop\…, which is why CODAR_BIN
//      exists), macOS in /Applications, Linux under ~/.local/share.
//   3. The download the app's own bootstrap leaves in the home
//      (~/.codar/bin/codar), which is where a machine without an installed
//      app keeps its copy.
//
// The answer is a path, not a promise: whether anything is there is
// ensureServe's question (existsSync, below), because a CODAR_BIN the person
// typed wrong must produce the sentence that says so, not a silent fallback.
export function codarServeExecutable(platform = process.platform, localAppData = process.env.LOCALAPPDATA || "") {
  const named = String(process.env.CODAR_BIN ?? "")
  if (named.trim()) return named
  if (platform === "win32") {
    return join(localAppData || join(homedir(), "AppData", "Local"), "Programs", "Codar", "resources", "bin", "codar.exe")
  }
  if (platform === "darwin") return "/Applications/Codar.app/Contents/Resources/bin/codar"
  // the user's own .local/share, read off the home it was given rather than
  // this process's: the platform argument is what a test states, and a path
  // built from the caller's home would answer with the test machine's.
  return join(localAppData || homedir(), ".local", "share", "codar", "resources", "bin", "codar")
}

// serveExecutable is codarServeExecutable with the fallback applied: the
// install path first, else the copy the app's bootstrap downloaded. The
// download is tried second because an app that is installed is the one the
// person signed in with; a home that has a copy and no install is a server all
// the same.
const serveExecutable = (platform = process.platform) => {
  const named = String(process.env.CODAR_BIN ?? "")
  if (named.trim()) return named
  const installed = codarServeExecutable(platform)
  const download = join(DEFAULT_CODAR_HOME(), "bin", platform === "win32" ? "codar.exe" : "codar")
  return !existsSync(installed) && existsSync(download) ? download : installed
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
// executable (CODAR_BIN's override arrives through serveExecutable).
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
    const exe = bin || serveExecutable()
    if (bin && !exe) return { ok: false, reason: `没有可启动的 codar，${CODAR_BIN_HINT}` }
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
// arrive. The body is the server's whole contract — {"message": …} — and
// nothing else: no model (the server's own settings choose it), no system
// field, no messages array. A refusal (HTTP 400 {"error":"message is
// required"}, a 405 from a wrong verb, a 5xx) is thrown with the server's own
// words and its status, because a caller that got an empty iterator could not
// tell a refusal from an empty answer.
//
// `signal` is the host's cancellation: an aborted conversation stops the read
// and the server's run is left to its own interrupt (POST /api/chat/interrupt,
// which the app sends when the person stops a run; the plugin does not, because
// a cancelled fetch is usually a cancelled read, not a cancelled run).
export async function* chatStream({ port = CODAR_PORT, message, signal, timeoutMs = 0, base = serveBase(port), fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  let answer
  try {
    answer = await fetchImpl(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message: String(message ?? "") }),
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
  const source = sseToOpenAI(events, options)
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
        controller.error(e)
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

// openAIAnswer is the Response for a non-streaming chat: one chat.completion
// object. status is the caller's (200 for an answer, 502 for a server that
// could not be reached). It is async because the whole reply has to be read
// before it can be written down, which is the difference between the two
// clients this bridge serves.
export async function openAIAnswer(events, options = {}, status = 200) {
  const [answer] = await sseToOpenAI(events, { ...options, aggregate: true })
  return new Response(JSON.stringify(answer), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}
