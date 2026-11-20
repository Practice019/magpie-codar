// The chat body's shape, against the captured request it is copied from.
//
// The truth is a capture of the desktop's own client (v0.3.17, 2026-11-20,
// docs/codar/samples/chat-completions.body.json in register-machine): seven
// top-level keys in one order, reasoning_effort "high", thinking enabled,
// stream_options include_usage, and no max_tokens. These tests write that down
// as literals rather than recomputing it, so a change to how the module builds
// a body cannot quietly move the target it is measured against.
//
// What must not move is the content: messages and tools are the caller's tool
// table and conversation, and they are compared value for value below.

import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:net"

import { CLIENT_KEY_ORDER, isChatCompletionUrl, normalizeChatBody } from "../lib/client-body.mjs"
import { sendVia } from "../lib/native.mjs"

// mageBody stands in for what the host hands the transport: the OpenAI
// client's own body — model first, max_tokens present, no thinking — which is
// the shape that was leaving before this module.
const magpieBody = {
  model: "deepseek-v4.1-flash",
  messages: [
    { role: "system", content: "You are an AI agent running on the Codar runtime." },
    { role: "user", content: "你好" },
  ],
  stream: true,
  stream_options: { include_usage: true },
  temperature: 0.7,
  max_tokens: 32000,
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ],
}

const keysOf = (body) => Object.keys(JSON.parse(normalizeChatBody(JSON.stringify(body))))

test("the client's key order is the one the capture shows", () => {
  // Literal, from the capture; the module's exported list is checked against
  // it rather than against itself.
  assert.deepEqual(CLIENT_KEY_ORDER, ["messages", "model", "reasoning_effort", "stream", "stream_options", "thinking", "tools"])
})

test("a host body leaves with the client's keys first and its own keys after", () => {
  // temperature and max_tokens are the host's, not the client's: both land
  // after tools, in the order they arrived.
  assert.deepEqual(keysOf(magpieBody), [...CLIENT_KEY_ORDER, "temperature", "max_tokens"])
})

test("reasoning_effort is the client's fixed high", () => {
  const asked = { messages: [], model: "m", stream: true }
  assert.equal(JSON.parse(normalizeChatBody(JSON.stringify(asked))).reasoning_effort, "high")
  // The capture has one value; a host asking for another gets high too.
  for (const wanted of ["low", "medium", "minimal", null, 3]) {
    const out = JSON.parse(normalizeChatBody(JSON.stringify({ ...asked, reasoning_effort: wanted })))
    assert.equal(out.reasoning_effort, "high", `reasoning_effort ${JSON.stringify(wanted)} was not replaced`)
  }
})

test("thinking is the client's enabled object, whatever arrived", () => {
  const bare = JSON.parse(normalizeChatBody(JSON.stringify({ messages: [], model: "m" })))
  assert.deepEqual(bare.thinking, { type: "enabled" })
  const disabled = JSON.parse(normalizeChatBody(JSON.stringify({ messages: [], model: "m", thinking: { type: "disabled", budget_tokens: 1024 } })))
  assert.deepEqual(disabled.thinking, { type: "enabled" })
})

test("a streamed request carries stream_options include_usage", () => {
  const bare = JSON.parse(normalizeChatBody(JSON.stringify({ messages: [], model: "m", stream: true })))
  assert.deepEqual(bare.stream_options, { include_usage: true })
  // The client sends exactly this object, so a shape of the host's own is
  // replaced by it rather than merged with it.
  const own = JSON.parse(normalizeChatBody(JSON.stringify({ messages: [], model: "m", stream: true, stream_options: { include_usage: false, chunk_size: 5 } })))
  assert.deepEqual(own.stream_options, { include_usage: true })
})

test("a non-streamed request is given no stream_options", () => {
  for (const body of [{ messages: [], model: "m", stream: false }, { messages: [], model: "m" }]) {
    const out = JSON.parse(normalizeChatBody(JSON.stringify(body)))
    assert.ok(!Object.hasOwn(out, "stream_options"), `${JSON.stringify(body)} gained stream_options`)
  }
  // The stream flag itself is the host's to decide; it is never flipped.
  assert.equal(JSON.parse(normalizeChatBody(JSON.stringify({ messages: [], model: "m", stream: false }))).stream, false)
})

test("max_tokens is dropped unless the host set a real cap", () => {
  for (const gone of [undefined, 0, -1, null, "", "large", NaN]) {
    const body = { messages: [], model: "m", ...(gone === undefined ? {} : { max_tokens: gone }) }
    const out = JSON.parse(normalizeChatBody(JSON.stringify(body)))
    assert.ok(!Object.hasOwn(out, "max_tokens"), `max_tokens ${String(gone)} survived`)
  }
  // An explicit positive cap is the caller's output limit: it stays, and it
  // stays in the host's own key order (after tools).
  const kept = JSON.parse(normalizeChatBody(JSON.stringify({ messages: [], model: "m", tools: [], max_tokens: 32000 })))
  assert.equal(kept.max_tokens, 32000)
  assert.deepEqual(Object.keys(kept).filter((k) => !CLIENT_KEY_ORDER.includes(k)), ["max_tokens"])
})

test("messages and tools cross over untouched", () => {
  const out = JSON.parse(normalizeChatBody(JSON.stringify(magpieBody)))
  assert.deepEqual(out.messages, magpieBody.messages)
  assert.deepEqual(out.tools, magpieBody.tools)
  assert.equal(out.model, magpieBody.model)

  // Same values, at scale, and serialized the way they arrived: a big table
  // that lost a byte would still parse, so the strings are compared too.
  const bigMessages = Array.from({ length: 40 }, (_, i) => ({ role: i === 0 ? "system" : "user", content: `message ${i} — ${"内容".repeat(60)}` }))
  const bigTools = Array.from({ length: 20 }, (_, i) => ({
    type: "function",
    function: { name: `tool_${i}`, description: `Tool ${i}.`, parameters: { type: "object", properties: { q: { type: "string" } } } },
  }))
  const big = normalizeChatBody(JSON.stringify({ messages: bigMessages, model: "m", stream: true, tools: bigTools }))
  const back = JSON.parse(big)
  assert.deepEqual(back.messages, bigMessages)
  assert.deepEqual(back.tools, bigTools)
  assert.ok(big.includes(JSON.stringify(bigMessages)), "messages did not survive as the same JSON text")
  assert.ok(big.includes(JSON.stringify(bigTools)), "tools did not survive as the same JSON text")
})

test("a body that is not a JSON object is passed through unchanged", () => {
  for (const raw of ['{"messages":[}', "null", "[1,2]", '"a string"', "42", "true", "", "not json at all"]) {
    assert.equal(normalizeChatBody(raw), raw, `${JSON.stringify(raw)} was rewritten`)
  }
  // Nothing is thrown: a bad body is the caller's request, not this module's
  // exception to raise.
  assert.doesNotThrow(() => normalizeChatBody("{"))
})

test("only chat completions are reshaped, by URL", () => {
  const yes = [
    "https://api.claw.speedai.com/v1/chat/completions",
    "https://api.claw.speedai.com/chat/completions",
    "https://api.claw.speedai.com/v1/chat/completions?trace=1",
    "https://api.claw.speedai.com/v1/chat/completions/",
    new URL("https://api.claw.speedai.com/v1/chat/completions"),
  ]
  for (const url of yes) assert.equal(isChatCompletionUrl(url), true, `${String(url)} was not recognized`)
  const no = [
    "https://api.kuaipaper.com/v1/daily-sign",
    "https://api.kuaipaper.com/v1/daily-sign/status",
    "https://api.claw.speedai.com/v1/agent/balance",
    "https://api.kuaipaper.com/v1/gettoken",
    "https://api.claw.speedai.com/v1/codar/models",
    "https://codar-web.speedai.com/api/sessions",
    // Anthropic-compatible, and deliberately left alone: a different schema,
    // no capture of the client's own request, nothing to copy.
    "https://api.claw.speedai.com/v1/messages",
    "https://api.claw.speedai.com/v1/chat/completions-extra",
    "not a url",
    "",
  ]
  for (const url of no) assert.equal(isChatCompletionUrl(url), false, `${String(url)} was recognized`)
})

test("the client's own escaping is reproduced byte for byte", () => {
  // The capture is Go's encoding/json: compact, with < > & written as \u003c
  // \u003e \u0026 (10, 11 and 6 of them in the sample). These expected strings
  // are literal, not built from the module.
  const raw = '{"messages":[{"role":"user","content":"a & b < c > d"}],"model":"m","stream":false}'
  const want = '{"messages":[{"role":"user","content":"a \\u0026 b \\u003c c \\u003e d"}],"model":"m","reasoning_effort":"high","stream":false,"thinking":{"type":"enabled"}}'
  assert.equal(normalizeChatBody(raw), want)
  // No whitespace anywhere, the way the capture has none.
  assert.ok(!normalizeChatBody(raw).includes(": "))
  assert.ok(!normalizeChatBody(raw).includes(", "))
})

test("normalizing twice is normalizing once, and the input is not edited", () => {
  const raw = JSON.stringify(magpieBody)
  const once = normalizeChatBody(raw)
  assert.equal(normalizeChatBody(once), once)
  assert.equal(raw, JSON.stringify(magpieBody))
  // A fresh object every time: nothing the caller owns is shared back.
  const a = JSON.parse(normalizeChatBody(raw))
  const b = JSON.parse(normalizeChatBody(raw))
  assert.notEqual(a, b)
  assert.notEqual(a.thinking, b.thinking)
})

test("a body that is not a string is handed back as it came", () => {
  const bytes = new Uint8Array([0x7b, 0x7d])
  const buffer = Buffer.from("{}")
  assert.equal(normalizeChatBody(bytes), bytes)
  assert.equal(normalizeChatBody(buffer), buffer)
  assert.equal(normalizeChatBody(undefined), undefined)
  assert.equal(normalizeChatBody(null), null)
})

// wire is a loopback server that answers every connection with an empty JSON
// object and keeps the request head and body it was sent. TCP rather than a
// unix socket, so this runs on Windows too (the proxy's Windows transport is
// the same one).
async function wire() {
  const seen = []
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    let buf = Buffer.alloc(0)
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d])
      const end = buf.indexOf("\r\n\r\n")
      if (end < 0) return
      const head = buf.subarray(0, end).toString("latin1")
      const rest = buf.subarray(end + 4)
      const length = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? 0)
      if (rest.length < length) return
      seen.push({ head, body: rest.subarray(0, length) })
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}")
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return {
    seen,
    info: { transport: "tcp", address: `127.0.0.1:${server.address().port}` },
    close: () =>
      new Promise((r) => {
        server.close(() => r())
        for (const socket of sockets) socket.destroy()
      }),
  }
}

test("sendVia writes a chat completion the client's way and everything else as it came", async () => {
  const s = await wire()
  const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } }]
  const chat = JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "你好" }], stream: true, max_tokens: 0, temperature: 0.3, tools })
  const sign = '{"username":"user_17144748694_4590"}'
  try {
    const sent = await sendVia(s.info, new URL("https://api.claw.speedai.com/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: chat,
    })
    assert.equal(sent.status, 200)
    await sent.text()
    const again = await sendVia(s.info, new URL("https://api.kuaipaper.com/v1/daily-sign"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: sign,
    })
    await again.text()

    const [first, second] = s.seen
    assert.equal(first.head.split("\r\n")[0], "POST /v1/chat/completions HTTP/1.1")
    const body = JSON.parse(first.body.toString())
    assert.deepEqual(Object.keys(body), [...CLIENT_KEY_ORDER, "temperature"])
    // The system prompt on the way out is the client's (lib/client-system.mjs):
    // this body had none, so one is put in front, and the caller's own message
    // is behind it, value for value.
    assert.equal(body.messages.length, 2)
    assert.equal(body.messages[0].role, "system")
    assert.ok(body.messages[0].content.startsWith("You are an AI agent running on the Codar runtime."))
    assert.deepEqual(body.messages[1], { role: "user", content: "你好" })
    assert.deepEqual(body.tools, tools)
    assert.equal(body.reasoning_effort, "high")
    // The body on the wire is not the one the caller handed over, and its
    // Content-Length is the new body's, not the old one's.
    assert.notEqual(first.body.toString(), chat)
    assert.ok(first.head.includes(`Content-Length: ${first.body.length}`))
    assert.ok(!first.head.includes(`Content-Length: ${Buffer.byteLength(chat)}`))

    // A check-in body is not a chat body: it leaves byte for byte.
    assert.equal(second.head.split("\r\n")[0], "POST /v1/daily-sign HTTP/1.1")
    assert.equal(second.body.toString(), sign)
  } finally {
    await s.close()
  }
})
