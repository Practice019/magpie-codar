// The direct transport: the desktop's own request, sent by this plugin to the
// vendor's gateway, with no codar.exe in between.
//
// Two halves, because the change has two halves:
//
//   - chatDirect itself (lib/direct.mjs): the six headers the capture shows,
//     the chat completions path, the body handed over as it arrived, and a
//     streamed answer returned untouched — never cloned, never read (AGENTS.md's
//     costliest trap #1 is a `clone().text()` on a text/event-stream: the
//     timeline flattens and decode_ms/decode_tps are empty forever). A refused
//     request has to say what the vendor said, because the 403 this transport
//     exists to avoid is `client_not_supported` and the fix is the system
//     prefix.
//
//   - the loader wiring (index.mjs): magpie's OpenAI body leaves in the client's
//     key order with the client's own fixed values, the caller's tools cross over
//     byte for byte, the caller's system prompt sits behind the client's prefix
//     with nothing cut, and `codar.transport: "serve"` still takes the old road.
//
// Nothing here reaches the network: every request goes through an injected
// fetch, and a URL the test did not expect is a rejection rather than a real
// call.

import assert from "node:assert/strict"
import { test } from "node:test"

import { CLIENT_KEY_ORDER, normalizeChatBody } from "../lib/client-body.mjs"
import { CLIENT_SYSTEM_PREFIX } from "../lib/client-prefix.mjs"
import { CLIENT_HEADER_NAMES, chatDirect, chatEndpoint, clientHeaders } from "../lib/direct.mjs"
import { CodarPlugin } from "../index.mjs"

// A token shape, not a token: a made-up three-part string, in visible ASCII so
// tokenOf would accept it and no redactor could mistake it for a credential. No
// real credential is written down anywhere in the suite, and the transport must
// not print whatever it is given either (see the refusal test below).
const TOKEN = "fake.jwt.for.tests"

const chatBody = () => JSON.stringify({ messages: [{ role: "user", content: "你好" }], model: "deepseek-v4.1-flash", stream: true })

// sseAnswer is a loopback-free stand-in for the vendor's streamed answer. Its
// `clone` throws: a transport that cloned the stream would fail here rather than
// in production, where the symptom is a flattened timeline and an empty decode
// rate nobody can reproduce.
const sseAnswer = (text = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n') => {
  const answer = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
  Object.defineProperty(answer, "clone", {
    value: () => {
      throw new Error("the transport cloned a stream")
    },
  })
  return answer
}

// recorder is an injected fetch that keeps what it was asked and answers with
// `answer`. A URL outside the vendor's host is refused the way a closed port is,
// so a test that accidentally takes the old road (loopback) fails loudly instead
// of hanging.
const recorder = (answer = () => sseAnswer()) => {
  const seen = []
  const impl = async (url, init = {}) => {
    const address = typeof url === "string" ? url : url?.url ?? String(url)
    seen.push({ url: address, init })
    if (!/^https:\/\/api\.claw\.speedai\.com\//.test(address)) throw new TypeError(`fetch failed: ${address}`)
    return answer(address, init)
  }
  impl.seen = seen
  return impl
}

const jsonAnswer = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

test("the request carries the client's six headers and nothing else", async () => {
  const fetchImpl = recorder()
  const body = chatBody()
  await chatDirect({ baseUrl: "https://api.claw.speedai.com", token: TOKEN, body, fetchImpl })

  const { init } = fetchImpl.seen[0]
  // The capture's own list (chat-completions.headers.json): host, user-agent,
  // content-length, authorization, content-type, accept-encoding. `host` is
  // written by fetch itself and cannot be set from here, so the six this
  // transport states are those minus host, plus the accept a JSON client sends.
  assert.deepEqual(CLIENT_HEADER_NAMES, ["user-agent", "content-length", "authorization", "content-type", "accept", "accept-encoding"])
  assert.deepEqual(Object.keys(init.headers), CLIENT_HEADER_NAMES)
  assert.equal(init.headers["user-agent"], "Go-http-client/1.1")
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(init.headers["content-type"], "application/json")
  assert.equal(init.headers.accept, "application/json")
  assert.equal(init.headers["accept-encoding"], "gzip")
  // The length is the body's bytes, not its characters: the sample carries
  // Chinese, and a character count would cut the request.
  assert.equal(init.headers["content-length"], String(Buffer.byteLength(body, "utf8")))
  // Nothing of this plugin's own invention: the gateway was measured against a
  // client that sends no custom header, and an X-Codar-* would be a second
  // identity to explain.
  assert.deepEqual(Object.keys(init.headers).filter((k) => /^x-codar-/i.test(k)), [])
  assert.deepEqual(Object.keys(init.headers).filter((k) => k === "host" || k === "connection"), [])
})

test("the request goes to the chat completions path, whatever shape the base has", async () => {
  for (const baseUrl of [
    "https://api.claw.speedai.com",
    "https://api.claw.speedai.com/",
    "https://api.claw.speedai.com/v1",
    "https://api.claw.speedai.com/v1/",
  ]) {
    const fetchImpl = recorder()
    await chatDirect({ baseUrl, token: TOKEN, body: chatBody(), fetchImpl })
    const { url, init } = fetchImpl.seen[0]
    assert.equal(new URL(url).pathname, "/v1/chat/completions", `from ${baseUrl}`)
    assert.equal(init.method, "POST")
  }
  // A base that already names the endpoint is not given a second one.
  assert.equal(chatEndpoint("https://api.claw.speedai.com/v1/chat/completions"), "https://api.claw.speedai.com/v1/chat/completions")
  // And no base at all is a sentence, not a request to an empty URL.
  await assert.rejects(() => chatDirect({ baseUrl: "", token: TOKEN, body: chatBody(), fetchImpl: recorder() }), /没有上游地址/)
})

test("a streamed answer is handed back untouched, never cloned", async () => {
  const answer = sseAnswer()
  const fetchImpl = async () => answer
  const got = await chatDirect({ baseUrl: "https://api.claw.speedai.com", token: TOKEN, body: chatBody(), fetchImpl })
  // The very Response the vendor's fetch produced: a copy would have to be read
  // to be useful, and reading it is the failure this guards against.
  assert.equal(got, answer)
  assert.ok(got.body, "the body is still readable by the host")
  assert.equal(await got.text(), 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n')
})

test("a non-streamed answer is one complete JSON body", async () => {
  const said = { id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "好" } }] }
  const got = await chatDirect({ baseUrl: "https://api.claw.speedai.com", token: TOKEN, body: chatBody(), fetchImpl: async () => jsonAnswer(said) })
  assert.equal(got.status, 200)
  assert.deepEqual(await got.json(), said)
})

test("the body leaves exactly as it was handed over", async () => {
  const fetchImpl = recorder()
  const body = chatBody()
  await chatDirect({ baseUrl: "https://api.claw.speedai.com", token: TOKEN, body, fetchImpl })
  // Byte for byte, not re-serialized: the escaping and the key order were
  // decided in client-body.mjs, and a second round trip here would undo both.
  assert.equal(fetchImpl.seen[0].init.body, body)
})

test("a 403 client_not_supported says what it is and where to look", async () => {
  const refused = () =>
    jsonAnswer({ code: "client_not_supported", message: "This login credential is restricted to Codar." }, 403)
  await assert.rejects(
    () => chatDirect({ baseUrl: "https://api.claw.speedai.com", token: TOKEN, body: chatBody(), fetchImpl: async () => refused() }),
    (e) => {
      assert.equal(e.status, 403)
      assert.equal(e.code, "client_not_supported")
      assert.match(e.message, /client_not_supported/)
      // The measurement is the hint: this code is what a system message without
      // the client's head gets, and that is the one thing a caller can fix.
      assert.match(e.message, /system 前缀可能缺失/)
      // The vendor's own words are kept beside it.
      assert.match(e.message, /restricted to Codar/)
      return true
    },
  )
})

test("another refusal is reported by its status and its sentence", async () => {
  const answer = jsonAnswer({ error: { message: "concurrent_limit_exceeded" } }, 429)
  await assert.rejects(
    () => chatDirect({ baseUrl: "https://api.claw.speedai.com", token: TOKEN, body: chatBody(), fetchImpl: async () => answer }),
    (e) => {
      assert.equal(e.status, 429)
      assert.match(e.message, /concurrent_limit_exceeded/)
      // The prefix hint belongs to the 403: saying it about a rate limit would
      // send the person to the wrong field.
      assert.ok(!/system 前缀可能缺失/.test(e.message))
      return true
    },
  )
  // A 401 is a sign-in that lapsed, which the host renews or re-asks for.
  const expired = jsonAnswer({ error: { message: "token expired" } }, 401)
  await assert.rejects(
    () => chatDirect({ baseUrl: "https://api.claw.speedai.com", token: TOKEN, body: chatBody(), fetchImpl: async () => expired }),
    (e) => {
      assert.equal(e.status, 401)
      assert.equal(e.signIn, "expired")
      return true
    },
  )
})

test("a refusal that quotes the credential does not carry it into the sentence", async () => {
  const answer = jsonAnswer({ error: { message: `bad key ${TOKEN}` } }, 403)
  await assert.rejects(
    () => chatDirect({ baseUrl: "https://api.claw.speedai.com", token: TOKEN, body: chatBody(), fetchImpl: async () => answer }),
    (e) => {
      assert.ok(!e.message.includes(TOKEN), "the token is never printed")
      assert.ok(!String(e.detail || "").includes(TOKEN))
      return true
    },
  )
})

test("clientHeaders leaves the credential out when there is none", () => {
  // A request with no token is the host's own business (it will be refused), but
  // an "authorization: Bearer " header would be a different, emptier lie.
  const headers = clientHeaders("", "{}")
  assert.deepEqual(Object.keys(headers), CLIENT_HEADER_NAMES.filter((k) => k !== "authorization"))
})

// The loader's own road, through the plugin: this is what magpie calls on every
// chat request, so the shape that leaves here is the shape the gateway sees.

const loadPlugin = async (codar) => {
  const plugin = await CodarPlugin({ codar })
  return plugin.auth.loader(async () => ({ type: "api", key: TOKEN }))
}

// hostBody is what magpie's OpenAI-compatible client hands the transport: its
// own key order, no thinking, its tools, and DSH's project instructions as the
// system message.
const callerSystem = ["You are operating in unrestricted sandbox mode.", "", "# 交付格式", "状态 / 文件清单 / 测试条数"].join("\n")

const hostBody = (extra = {}) =>
  JSON.stringify({
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "system", content: callerSystem },
      { role: "user", content: "跑一下验收" },
    ],
    stream: true,
    stream_options: { include_usage: true },
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    ...extra,
  })

const vendorFetch = (answer = () => sseAnswer()) => {
  const real = globalThis.fetch
  const fetchImpl = recorder(answer)
  globalThis.fetch = fetchImpl
  return { fetchImpl, restore: () => (globalThis.fetch = real) }
}

test("the loader sends the client's body: key order, effort, stream options, thinking", async () => {
  const { fetchImpl, restore } = vendorFetch()
  try {
    const loader = await loadPlugin({ transport: "direct" })
    const answer = await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: hostBody(),
    })
    assert.equal(answer.status, 200)
    const sent = JSON.parse(fetchImpl.seen[0].init.body)
    // Exactly the client's seven keys, in the client's order, and none of the
    // host's own (hostBody carries none; extra keys are another test below).
    assert.deepEqual(Object.keys(sent), CLIENT_KEY_ORDER)
    assert.equal(sent.reasoning_effort, "high")
    assert.deepEqual(sent.thinking, { type: "enabled" })
    assert.deepEqual(sent.stream_options, { include_usage: true })
    assert.equal(sent.stream, true)
  } finally {
    restore()
  }
})

test("the caller's tools cross over byte for byte", async () => {
  const { fetchImpl, restore } = vendorFetch()
  const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }]
  const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true, tools })
  try {
    const loader = await loadPlugin({ transport: "direct" })
    await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", { method: "POST", body })
    const raw = fetchImpl.seen[0].init.body
    // The array as the host wrote it, character for character: the tools are the
    // agent's own table, and a re-serialized copy is a different table.
    assert.ok(raw.includes(JSON.stringify(tools)), "the tools array is the caller's own text")
    assert.deepEqual(JSON.parse(raw).tools, tools)
  } finally {
    restore()
  }
})

test("the caller's system prompt sits behind the client's prefix, whole", async () => {
  const { fetchImpl, restore } = vendorFetch()
  try {
    const loader = await loadPlugin({ transport: "direct" })
    await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", { method: "POST", body: hostBody() })
    const sent = JSON.parse(fetchImpl.seen[0].init.body)
    assert.equal(sent.messages.length, 2)
    assert.equal(sent.messages[0].role, "system")
    assert.equal(sent.messages[0].content, `${CLIENT_SYSTEM_PREFIX}\n\n${callerSystem}`)
    // And nothing behind it moved: the user turn is the caller's own.
    assert.deepEqual(sent.messages[1], { role: "user", content: "跑一下验收" })
  } finally {
    restore()
  }
})

test("a body with no system prompt gets the prefix on its own", async () => {
  const { fetchImpl, restore } = vendorFetch()
  try {
    const loader = await loadPlugin({ transport: "direct" })
    await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }),
    })
    const sent = JSON.parse(fetchImpl.seen[0].init.body)
    assert.deepEqual(sent.messages[0], { role: "system", content: CLIENT_SYSTEM_PREFIX })
    assert.deepEqual(sent.messages[1], { role: "user", content: "hi" })
  } finally {
    restore()
  }
})

test("the default road is direct: the request reaches the gateway itself", async () => {
  const { fetchImpl, restore } = vendorFetch()
  try {
    // No transport named: the default. It goes to the vendor, not to loopback.
    const loader = await loadPlugin(undefined)
    await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", { method: "POST", body: hostBody() })
    assert.equal(fetchImpl.seen.length, 1)
    assert.ok(fetchImpl.seen[0].url.startsWith("https://api.claw.speedai.com/v1/chat/completions"))
  } finally {
    restore()
  }
})

test("a refused direct answer reaches the host as a sentence, not a stream that never speaks", async () => {
  const refused = jsonAnswer({ code: "client_not_supported", message: "This login credential is restricted to Codar." }, 403)
  const { restore } = vendorFetch(() => refused)
  try {
    const loader = await loadPlugin({ transport: "direct" })
    const answer = await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", { method: "POST", body: hostBody() })
    assert.equal(answer.status, 403)
    const said = await answer.text()
    assert.match(said, /client_not_supported/)
    assert.match(said, /system 前缀可能缺失/)
  } finally {
    restore()
  }
})

test("transport: serve still takes the old road", async () => {
  const { fetchImpl, restore } = vendorFetch()
  try {
    // A port nothing listens on and a binary that is not there: the serve bridge
    // must answer its own 502 rather than fall through to the gateway.
    const loader = await loadPlugin({ transport: "serve", port: 1, bin: "C:\\no-such-codar\\codar.exe", serveTimeoutMs: 100 })
    const answer = await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", { method: "POST", body: hostBody() })
    assert.equal(answer.status, 502)
    assert.ok((await answer.text()).length > 0, "the bridge's own sentence")
    // The regression this guards: a request that took the old road must not have
    // gone to the vendor as well.
    assert.deepEqual(fetchImpl.seen.filter((s) => /api\.claw\.speedai\.com/.test(s.url)), [])
  } finally {
    restore()
  }
})

test("a request that is not a chat completion is left as the host wrote it", async () => {
  const { fetchImpl, restore } = vendorFetch(() => jsonAnswer({ ok: true }))
  const body = JSON.stringify({ model: "claude-sonnet-4", max_tokens: 64, messages: [{ role: "user", content: "hi" }] })
  try {
    const loader = await loadPlugin({ transport: "direct" })
    const answer = await loader.fetch("https://api.claw.speedai.com/v1/messages", { method: "POST", body })
    assert.equal(answer.status, 200)
    // The Anthropic body's shape is not the OpenAI one and was never captured;
    // the rule this repository is built on is that what cannot be made the same
    // is left alone — including no system prefix and no key reordering.
    assert.equal(fetchImpl.seen[0].init.body, body)
    assert.deepEqual(Object.keys(JSON.parse(fetchImpl.seen[0].init.body)), ["model", "max_tokens", "messages"])
  } finally {
    restore()
  }
})

test("normalizeChatBody is the one place the body is shaped, prefix included", () => {
  // The wiring above goes through this function; pinning it here means a change
  // to the merge in client-body.mjs cannot pass by only being right in index.mjs.
  const out = JSON.parse(normalizeChatBody(hostBody(), { alignSystem: true }))
  assert.equal(out.messages[0].content, `${CLIENT_SYSTEM_PREFIX}\n\n${callerSystem}`)
  // Without the flag the caller's prompt is delivered as written: the rewrite is
  // asked for, never a default of the shape.
  const plain = JSON.parse(normalizeChatBody(hostBody()))
  assert.equal(plain.messages[0].content, callerSystem)
})
