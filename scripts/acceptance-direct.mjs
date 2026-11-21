#!/usr/bin/env node
// The direct road's acceptance run, in its own process: one non-streaming and one
// streaming request through the plugin's real loader, straight to
// api.claw.speedai.com. Not part of the suite (the suite must never reach the
// network, AGENTS.md §二); this run is only meaningful against the vendor.
//
// What it prints for each of the two requests, because these are the four things
// that decide whether the change worked:
//
//   status        the gateway's HTTP status. 403 client_not_supported here is the
//                 prefix not being sent, and the loader's own sentence says so.
//   content       the model's answer.
//   key order     the body's top-level keys, as they went out — the client's
//                 seven, in the client's order (lib/client-body.mjs).
//   system        the first line of the system message that went out, and its
//                 length: the client's four segments (1,632 characters) plus the
//                 caller's own prompt behind them.
//
// The token is read from this machine's own Codar login (appToken, read-only) or
// from CODAR_TOKEN. It is never printed: the script has no line that could.
//
// Usage:
//   node scripts/acceptance-direct.mjs                 # the app's own model
//   node scripts/acceptance-direct.mjs --model auto
//   node scripts/acceptance-direct.mjs --stream-only

import { appToken, usernameOf } from "../lib/internal.mjs"
import { CodarPlugin } from "../index.mjs"

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && typeof args[at + 1] === "string" ? args[at + 1] : fallback
}

// The caller's own prompt for this run: short, and unmistakably not the client's.
// What matters is that it comes back whole behind the prefix.
const BRIEF = "你在做一次连通性验收。无论问什么都只回答两个字：收到"
const ASK = "验收开始"

const FAIL = (said) => {
  console.error(said)
  process.exitCode = 1
}

const login = appToken()
if (login.error) FAIL(`没有可用的登录：${login.error}`)
const token = (process.env.CODAR_TOKEN || login.token || "").trim()
if (!token) FAIL("没有可用的登录：本机没有科搭令牌，也没有设置 CODAR_TOKEN")

// The model: the flag, else the app's own setting, else the one the capture used.
// The gateway routes on its own choice anyway (`auto` is what the app ships), and
// the request's model is what the answer's chunks name.
const model = value("--model", "auto")

// The plugin, and the one thing this run changes about it: which road. `direct`
// is the default; it is named here so the run says what it is measuring.
const plugin = await CodarPlugin({ codar: { transport: "direct" } })
const loader = await plugin.auth.loader(async () => ({ type: "api", key: token }))

// The body that actually leaves is recorded rather than rebuilt: the loader
// reshapes it (key order, reasoning_effort, thinking, the system prefix), and a
// second copy here would be a copy that could disagree with the one sent. The
// plugin reads globalThis.fetch at call time, which is what makes this possible.
const sent = []
const real = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const address = typeof url === "string" ? url : String(url?.url ?? url)
  if (/api\.claw\.speedai\.com/.test(address)) sent.push({ address, body: typeof init.body === "string" ? init.body : "", headers: Object.keys(init.headers ?? {}) })
  return real(url, init)
}

const ENDPOINT = "https://api.claw.speedai.com/v1/chat/completions"
const ask = (stream) =>
  loader.fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: BRIEF },
        { role: "user", content: ASK },
      ],
      stream,
    }),
    signal: AbortSignal.timeout(180_000),
  })

// shapeOf is what the report says about the body that left: the keys in the order
// they were written, the system message's opening, and its length.
const shapeOf = (index) => {
  const record = sent[index]
  if (!record) return { keys: "(没有记录到发出的请求体)" }
  const body = JSON.parse(record.body)
  const system = Array.isArray(body.messages) ? body.messages.find((m) => m.role === "system") : null
  return {
    keys: Object.keys(body),
    bytes: Buffer.byteLength(record.body, "utf8"),
    headers: record.headers,
    system: system ? { opens: String(system.content).split("\n")[0], chars: system.content.length } : null,
  }
}

// ---- 1. non-streaming: one complete JSON answer -----------------------------

const report = { account: usernameOf(token), model, sentTo: ENDPOINT, nonStreaming: null, streaming: null }

if (!flag("--stream-only")) {
  const answer = await ask(false)
  const said = await answer.text()
  let content = ""
  try {
    content = JSON.parse(said)?.choices?.[0]?.message?.content ?? ""
  } catch {
    content = said.slice(0, 400)
  }
  report.nonStreaming = { status: answer.status, contentType: answer.headers.get("content-type"), content, request: shapeOf(0) }
  if (answer.status !== 200) FAIL(`非流式：HTTP ${answer.status} ${said.slice(0, 400)}`)
}

// ---- 2. streaming: the vendor's SSE, passed through ------------------------

if (!flag("--non-stream-only")) {
  const answer = await ask(true)
  let text = ""
  let chunks = 0
  let usage = null
  if (answer.body) {
    const reader = answer.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (!data || data === "[DONE]") continue
        chunks += 1
        try {
          const event = JSON.parse(data)
          const delta = event?.choices?.[0]?.delta?.content
          if (typeof delta === "string") text += delta
          if (event?.usage) usage = event.usage
        } catch {
          // a keep-alive or a line this run does not need
        }
      }
    }
  }
  report.streaming = { status: answer.status, contentType: answer.headers.get("content-type"), chunks, content: text, usage, request: shapeOf(sent.length - 1) }
  if (answer.status !== 200) FAIL(`流式：HTTP ${answer.status}`)
  if (!text) FAIL("流式：没有收到任何 delta")
}

globalThis.fetch = real
console.log(JSON.stringify(report, null, 2))
console.log(
  [
    `账号 ${report.account} | 模型 ${model} | ${ENDPOINT}`,
    report.nonStreaming ? `非流式 ${report.nonStreaming.status} | 键序 ${report.nonStreaming.request.keys.join(" → ")} | 正文「${report.nonStreaming.content}」` : "",
    report.streaming ? `流式 ${report.streaming.status} | ${report.streaming.chunks} 段 | 键序 ${report.streaming.request.keys.join(" → ")} | 正文「${report.streaming.content}」` : "",
  ]
    .filter(Boolean)
    .join("\n"),
)
