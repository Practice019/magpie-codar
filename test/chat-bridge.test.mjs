// The two halves of the bridge no unit test can prove on its own: what magpie's
// OpenAI body becomes inside the server's one-message field, and whether the
// whole road — the host's fetch, the plugin's loader, the bridge, a server that
// speaks the real event shapes — produces a stream and a JSON body an OpenAI
// client can read.
//
// The prompts below are pinned as text because they are a request body: the
// server accepts one string and no roles, so every role magpie sends has to
// survive as something the model will read as that role. A future change to the
// wording is a change to every conversation's meaning, and it should cost a
// second thought here.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"

import { messagesToPrompt } from "../lib/chat-bridge.mjs"
import { codarServeExecutable } from "../lib/serve.mjs"
import { CodarPlugin } from "../index.mjs"
import { testables } from "../lib/internal.mjs"

// The plugin must not start the Go proxy or reach the vendor from these tests:
// a machine with a built native/bin would answer the host's fetch itself, and
// every request here is meant for the fake serve.
testables.nativeFetch = null
testables.chatFetch = null
testables.switches.announceSignIn = false

const DEBUG_POINT = "只用一句话回答"

// ---- messagesToPrompt ------------------------------------------------------

test("messagesToPrompt: a system message leads, then the user's own words", () => {
  // The shape for one turn: the system text first, then the user's line. The
  // server has no system role, so the system text is simply the opening of the
  // one message — which is what the vendor's own client does with its own
  // prompt (it is the first block of the message it sends).
  const got = messagesToPrompt([
    { role: "system", content: "你是科搭。" },
    { role: "user", content: "你好" },
  ])
  assert.equal(got, "你是科搭。\n\n你好")
})

test("messagesToPrompt: several system messages are joined, they do not replace one another", () => {
  // magpie can hand over two: the provider's own and a tool's. Joining in
  // order is the only reading that keeps both; the first one winning would
  // silently drop whatever a tool had to say about itself.
  const got = messagesToPrompt([
    { role: "system", content: "第一条。" },
    { role: "system", content: "第二条。" },
    { role: "user", content: "走" },
  ])
  assert.equal(got, "第一条。\n\n第二条。\n\n走")
})

test("messagesToPrompt: every turn of a conversation is kept, labelled by role", () => {
  // The server keeps no conversation of its own: the whole history is the
  // message. Turns are labelled 用户/助手 so a model that has only ever seen
  // one string can still tell who said what, and the last user turn — the one
  // being answered — is the body's own text with no label, because it is the
  // request rather than a transcript line.
  const got = messagesToPrompt([
    { role: "system", content: "你是科搭。" },
    { role: "user", content: "第一个问题" },
    { role: "assistant", content: "第一个回答" },
    { role: "user", content: "第二个问题" },
  ])
  assert.equal(got, "你是科搭。\n\n用户：第一个问题\n\n助手：第一个回答\n\n第二个问题")
})

test("messagesToPrompt: a tool's result keeps the tool's name", () => {
  // A tool result is the only place magpie tells the model what a call
  // answered, and the name says which call — a model that cannot tell
  // `read_file` from `run_command` will answer as if the wrong one ran. So the
  // name is inside the text, and the call the assistant asked for is a turn of
  // its own rather than being dropped.
  const got = messagesToPrompt([
    { role: "system", content: "你是科搭。" },
    { role: "user", content: "读一下 a.txt" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", name: "read_file", content: "hello" },
  ])
  assert.match(got, /助手：/, "the turn that asked for the call is kept")
  assert.match(got, /read_file/, "the call's name is kept")
  assert.match(got, /\{"path":"a\.txt"\}/, "and its arguments")
  assert.match(got, /工具结果（read_file）：hello/, "the result names the tool it came from")
  assert.ok(got.endsWith("工具结果（read_file）：hello"), "and it is the last thing the model reads")
})

test("messagesToPrompt: content parts and a nameless tool are still readable", () => {
  // A part-list content (an image turn, a file turn) is flattened to its text
  // parts: the server's field is a string, and a part that cannot be flattened
  // is a part this bridge never promised to carry. A tool result with no name
  // is still a tool result — the label without it.
  const got = messagesToPrompt([
    { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
    { role: "assistant", content: null },
    { role: "tool", content: "42" },
  ])
  assert.equal(got, "看图\n\n助手：\n\n工具结果：42")
})

test("messagesToPrompt: nothing to say is an empty message, never a body the server refuses", () => {
  // The server answers `{"message": ""}` with 400 "message is required", so
  // the bridge's caller must know when there is nothing to send: an undefined
  // is the answer here, and the loader turns it into an error that says so
  // rather than a request the server will refuse.
  assert.equal(messagesToPrompt([]), "")
  assert.equal(messagesToPrompt(undefined), "")
  assert.equal(messagesToPrompt([{ role: "user", content: "   " }]), "")
  assert.equal(messagesToPrompt([{ role: "system", content: "只有系统" }]), "只有系统", "a system-only body is still its text")
})

// ---- end to end: the host's fetch → plugin loader → fake serve ------------

const settings = {
  paths: { home: "C:\\Users\\x\\.codar" },
  provider: { model: "auto", provider_profiles: { speedai: { model: "auto", speedai_logged_in: true } } },
  settings: { permission_mode: "full" },
}

const EVENTS = [
  { data: { started_at: 1 }, event: "run_started", session_id: "web-ui" },
  { data: { disposition: "admitted", run: { model: "auto" } }, event: "run_state", session_id: "web-ui" },
  { data: { text: "成功" }, event: "text_delta", session_id: "web-ui" },
  { data: { input_tokens: 12, output_tokens: 2, total_tokens: 14 }, event: "context_usage", session_id: "web-ui" },
  { completed_at: 2, data: { input_tokens: 12, output_tokens: 2, total_tokens: 14 }, event: "result", outcome: "completed", provider_stop_reason: "stop", reason: "", session_id: "web-ui" },
  { completed_at: 2, data: null, event: "done", session_id: "web-ui" },
]

const fakeServe = async ({ chat } = {}) => {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8")
      const body = text ? JSON.parse(text) : null
      requests.push({ method: req.method, path: req.url, body })
      if (req.method === "GET" && req.url === "/api/chat/runs") {
        // the server's own answer on a machine with nothing running (measured)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ runs: [] }))
        return
      }
      if (req.method === "GET" && req.url === "/api/desktop/settings") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(settings))
        return
      }
      if (req.method === "POST" && req.url === "/api/chat") {
        // the run's events name the session the request named (measured: a
        // request with session_id answers events with that session_id)
        const forSession = EVENTS.map((e) => ({ ...e, session_id: body?.session_id ?? e.session_id }))
        ;(chat ?? ((r) => {
          r.writeHead(200, { "Content-Type": "text/event-stream" })
          for (const e of forSession) r.write(`data: ${JSON.stringify(e)}\n\n`)
          r.end()
        }))(res, body)
        return
      }
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "not found" }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address()
  return { port, requests, close: () => new Promise((r) => server.close(r)) }
}

// deadPort is a real port with nothing on it (see serve.test.mjs's copy for why
// it is not a made-up one: fetch refuses port 9 outright).
const deadPort = async () => {
  const probe = createServer()
  const taken = await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(probe.address().port)))
  await new Promise((r) => probe.close(r))
  return taken
}

const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6InUxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.sig"
const auth = async () => ({ type: "api", key: TOKEN })

// chatFetchOf is where the bridge enters: the host asks the loader for a fetch
// and calls it with the request it built (host.js's `typeof o.fetch ===
// "function" ? o.fetch : fetch`). Everything below goes through that one
// function, so the test covers the road the host takes and not a copy of it.
const loaderFetch = async (fake, body, { stream = true, model = "auto" } = {}) => {
  const p = await CodarPlugin({ codar: { port: fake.port, bin: process.env.CODAR_BIN || codarServeExecutable() } })
  const opts = await p.auth.loader(auth)
  const res = await opts.fetch(`http://127.0.0.1:${fake.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream, messages: body }),
  })
  return res
}

test("end to end: a streaming chat is an OpenAI event stream of at least two data lines", async () => {
  // The acceptance case in the brief: the host's own request shape in, SSE
  // out, more than one chunk on the wire. The bridge is transparent about the
  // body it sends — one message field, the prompt the bridge built — because
  // that is the only shape the server accepts.
  const fake = await fakeServe()
  try {
    const res = await loaderFetch(fake, [
      { role: "system", content: DEBUG_POINT },
      { role: "user", content: "说成功" },
    ])
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type"), /text\/event-stream/)
    const text = await res.text()
    const lines = text.split("\n").filter((l) => l.startsWith("data: "))
    assert.ok(lines.length >= 2, `only ${lines.length} data lines`)
    assert.equal(fake.requests.filter((r) => r.path === "/api/chat").length, 1, "one conversation, one request")
    const sent = fake.requests.find((r) => r.path === "/api/chat").body
    assert.deepEqual(Object.keys(sent).sort(), ["message", "session_id"], "the server's two fields, and nothing else")
    assert.equal(sent.message, `${DEBUG_POINT}\n\n说成功`)
    assert.match(sent.session_id, /^mw-[a-z0-9]+$/, "and the session this conversation is")
    const chunks = lines.map((l) => l.slice(6)).filter((d) => d.trim() !== "[DONE]").map((d) => JSON.parse(d))
    assert.equal(chunks.map((c) => c.choices[0].delta?.content ?? "").join(""), "成功")
    assert.ok(text.trimEnd().endsWith("data: [DONE]"))
  } finally {
    await fake.close()
  }
})

test("end to end: a non-streaming chat is one complete JSON answer", async () => {
  // A client that asked for stream:false gets a chat.completion object: the
  // whole text under choices[0].message.content, the finish reason beside it,
  // and the server's token counts in usage. No `data:` lines at all.
  const fake = await fakeServe()
  try {
    const res = await loaderFetch(fake, [{ role: "user", content: "说成功" }], { stream: false })
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type"), /application\/json/)
    const body = await res.json()
    assert.equal(body.object, "chat.completion")
    assert.equal(body.choices[0].message.role, "assistant")
    assert.equal(body.choices[0].message.content, "成功")
    assert.equal(body.choices[0].finish_reason, "stop")
    assert.equal(body.usage.total_tokens, 14)
    assert.equal(body.usage.prompt_tokens, 12, "the server's own count")
  } finally {
    await fake.close()
  }
})

test("end to end: the server's error event reaches magpie as an error, not as a hang", async () => {
  // The failure this bridge was written to avoid: an account out of points
  // answers an `error` event whose code is insufficient_quota, and the stream
  // ends. A host that is handed a stream that simply stops waits forever.
  //
  // The bridge retries an error event once on a fresh session now (lib/serve.mjs's
  // session retry), so this fixture answers the same error to every attempt: what
  // is asserted is the answer the person ends up with — the vendor's code, and an
  // end to the stream — not how many times the server was asked.
  const fake = await fakeServe({
    chat: (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ data: { code: "insufficient_quota", message: "Not enough points" }, event: "error" })}\n\n`)
      res.write(`data: ${JSON.stringify({ data: null, event: "done" })}\n\n`)
      res.end()
    },
  })
  try {
    const res = await loaderFetch(fake, [{ role: "user", content: "hi" }])
    const text = await res.text()
    const chunks = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).filter((d) => d.trim() !== "[DONE]").map((d) => JSON.parse(d))
    const closing = chunks.find((c) => c.choices?.[0]?.finish_reason)
    assert.ok(closing, "the stream closed")
    assert.equal(closing.choices[0].finish_reason, "error", "an error is not a normal end")
    // The sentence the person reads: what was tried (a new session), the
    // vendor's own words in brackets, and the code the vendor gave.
    assert.equal(closing.error?.code, "insufficient_quota", "and said what went wrong")
    assert.match(String(closing.error?.message), /已自动切新会话重试/, "the person is told the retry happened")
    assert.match(String(closing.error?.message), /Not enough points/, "the vendor's sentence survives the retry")
    assert.ok(text.trimEnd().endsWith("data: [DONE]"), "the client sees an end")
  } finally {
    await fake.close()
  }
})

test("end to end: each request names its own session, and the body says so", async () => {
  // Where the incident meets the host's own road: the loader's fetch is the
  // only thing magpie calls for a conversation, and every call of it must name
  // a session — a body without one is the server's one fixed `web-ui`, which is
  // how every conversation of the day ended up in one place (517961
  // prompt_tokens). Two requests, two sessions; and the host's messages arrive
  // in the message field as before.
  const fake = await fakeServe()
  try {
    for (const text of ["第一轮", "第二轮"]) {
      const res = await loaderFetch(fake, [{ role: "user", content: text }])
      await res.text()
    }
    const chats = fake.requests.filter((r) => r.path === "/api/chat")
    assert.equal(chats.length, 2)
    assert.ok(chats.every((r) => /^mw-[a-z0-9]+$/.test(r.body.session_id ?? "")), "every request named a session")
    assert.notEqual(chats[0].body.session_id, chats[1].body.session_id, "two requests shared one session")
    assert.deepEqual(
      chats.map((r) => r.body.message),
      ["第一轮", "第二轮"],
      "the host's conversation is what was sent",
    )
    assert.ok(!fake.requests.some((r) => r.path === "/api/chat/interrupt"), "a fresh session had nothing to interrupt")
  } finally {
    await fake.close()
  }
})

test("end to end: a server that will not start is an error the host can show", async () => {
  // No server on the port and none that can be started: the loader's fetch
  // answers a failed response whose body says what was waited for. A plugin
  // that threw a bare TypeError made magpie show the bridge's stack instead of
  // a sentence a person can act on.
  const port = await deadPort()
  const p = await CodarPlugin({ codar: { port, bin: "C:\\nowhere\\codar.exe", serveTimeoutMs: 120 } })
  const opts = await p.auth.loader(auth)
  const res = await opts.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "auto", stream: false, messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(res.status, 502)
  const said = await res.text()
  assert.match(said, /codar serve/, "the error names what is missing, as a person would")
  assert.ok(said.includes(String(port)), "and the port it waited on")
})

test("the bridge's own server is the app's binary, or the one the options name", () => {
  // The options a host passes reach the spawn: a machine whose app lives
  // somewhere else says so once, in one place.
  const saved = process.env.CODAR_BIN
  try {
    process.env.CODAR_BIN = "D:\\app\\codar.exe"
    assert.equal(codarServeExecutable(), "D:\\app\\codar.exe")
  } finally {
    if (saved === undefined) delete process.env.CODAR_BIN
    else process.env.CODAR_BIN = saved
  }
})
