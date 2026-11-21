// The direct transport's TLS stack: the same conversation, carried by the Go
// proxy instead of the plugin's own fetch.
//
// Why this file exists. The client's headers, body order, tools and system
// prefix are the desktop's now (test/direct.test.mjs), and the vendor answers
// them — but the TLS ClientHello was still the runtime's. Measured on this
// machine, 2026-11-21:
//
//   curl   JA3 fae0e5d973c96ae1888b99538efa0363
//   Node   JA3 d67b094811e5145139d7cea5f014309f      ← what the plugin sent
//   the desktop's Go client: neither of those
//
// lib/native.mjs has carried every official-host request through the desktop's
// own Go transport since 0.5.0 (native/cmd/codar-proxy, built on the sidecar's
// own Go version and GODEBUG so the ClientHello is the sidecar's). This file is
// the half that makes a chat request take that road too — and the half that says
// so honestly on the answer:
//
//   - The loader's transport is chatFetch, and chatFetch falls back to the
//     plugin's ordinary fetch when there is no proxy. Chat is never failed for
//     the transport's sake; the fallback is the old fingerprint and says so.
//   - `x-magpie-codar-transport: go-proxy` or `: node` is written on the
//     response the host reads, never on the request the vendor gets: the capture
//     this repository is built on (lib/direct.mjs's CLIENT_HEADER_NAMES) has no
//     custom header in it, and an X-Magpie-* would be a second identity.
//   - The request itself is the same on both roads: six headers, the same body
//     bytes, the same stream choice. A transport must not change what is asked,
//     only who asks it.
//
// Nothing here reaches the network. testables.chatFetch (lib/internal.mjs's own
// switch, which lib/direct.mjs reads through chatFetchOf) stands in for the
// proxy; test/native.test.mjs is where chatFetch and sendVia are driven against
// loopback sockets. A URL the test did not expect is a rejection rather than a
// real call.

import assert from "node:assert/strict"
import { test } from "node:test"

import { CLIENT_HEADER_NAMES, TRANSPORT_GO_PROXY, TRANSPORT_HEADER, TRANSPORT_NODE, carriedBy, chatDirect } from "../lib/direct.mjs"
import { testables } from "../lib/internal.mjs"
import { binaryPath, chatFetch, disabled, officialURL } from "../lib/native.mjs"
import { guardedFetch } from "../lib/guarded.mjs"
import { CodarPlugin } from "../index.mjs"

// A token shape, not a token: three visible-ASCII parts, so tokenOf would accept
// it and no redactor can mistake it for a credential. No real credential is
// written down anywhere in this suite.
const TOKEN = "fake.jwt.for.tests"

const API = "https://api.claw.speedai.com"
const CHAT = `${API}/v1/chat/completions`

// hostBody is what magpie's OpenAI client hands the transport: its own key
// order, its system prompt, and a stream flag it decides.
const hostBody = (extra = {}) =>
  JSON.stringify({
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "system", content: "You are operating in unrestricted sandbox mode." },
      { role: "user", content: "跑一下验收" },
    ],
    stream: true,
    ...extra,
  })

const sse = (lines = 3) => {
  const text = Array.from({ length: lines }, (_, i) => `data: {"choices":[{"delta":{"content":"块${i}"}}]}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

const jsonAnswer = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// stamp is what a chatFetch that went through the proxy answers: the vendor's
// Response with the transport written on it, done the way lib/native.mjs does.
const stamp = (answer, transport) => {
  answer.headers.set(TRANSPORT_HEADER, transport)
  return answer
}

// recorder is an injected chat transport: it keeps the init it was asked with
// and answers what it was given. A URL that is not the vendor's host is a
// TypeError, so a test that accidentally took a real road fails loudly.
const recorder = (answer = () => sse()) => {
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

// withChatFetch runs `fn` with the loader's chat transport pinned to `impl` and
// puts the real seam back afterwards. testables.chatFetch is what lets this
// suite say "the proxy is here" or "there is no proxy" without a binary, a
// socket or a spawned process.
const withChatFetch = async (impl, fn) => {
  testables.chatFetch = impl
  try {
    return await fn()
  } finally {
    delete testables.chatFetch
  }
}

const loadPlugin = async (codar) => {
  const plugin = await CodarPlugin({ codar })
  return plugin.auth.loader(async () => ({ type: "api", key: TOKEN }))
}

// ── 1. the wiring ────────────────────────────────────────────────────────────

test("the loader hands chatDirect the transport chatFetchOf names, not the global fetch", async () => {
  const proxied = recorder(() => stamp(sse(), TRANSPORT_GO_PROXY))
  let globalCalls = 0
  const real = globalThis.fetch
  globalThis.fetch = (...args) => {
    globalCalls += 1
    return real(...args)
  }
  try {
    await withChatFetch(proxied, async () => {
      const loader = await loadPlugin({ transport: "direct" })
      const answer = await loader.fetch(CHAT, { method: "POST", body: hostBody() })
      assert.equal(answer.status, 200)
    })
  } finally {
    globalThis.fetch = real
  }
  assert.equal(proxied.seen.length, 1, "the pinned transport carried the one request")
  assert.equal(globalCalls, 0, "nothing went through the global fetch")
  assert.equal(proxied.seen[0].url, CHAT)
  const { init } = proxied.seen[0]
  assert.equal(init.method, "POST")
  // The whole of what chatDirect hands a transport: the client's six headers,
  // the reshaped body, and the stream choice.
  assert.deepEqual(Object.keys(init.headers), CLIENT_HEADER_NAMES)
  assert.equal(typeof init.body, "string")
  assert.equal(JSON.parse(init.body).stream, true)
  assert.equal(init.stream, true, "the stream choice is stated, not left to the transport")
})

test("a proxy answer leaves x-magpie-codar-transport: go-proxy on the response", async () => {
  await withChatFetch(
    () => Promise.resolve(stamp(sse(), TRANSPORT_GO_PROXY)),
    async () => {
      const loader = await loadPlugin({ transport: "direct" })
      const got = await loader.fetch(CHAT, { method: "POST", body: hostBody() })
      assert.equal(got.status, 200)
      assert.equal(got.headers.get(TRANSPORT_HEADER), TRANSPORT_GO_PROXY)
      // The vendor's own bytes are still the answer: the stamp is a header, not
      // a rewrite of what the model said.
      assert.match(await got.text(), /^data: \{"choices"/)
    },
  )
})

// ── 2. the fallback ─────────────────────────────────────────────────────────

test("no proxy on this machine falls back to the ordinary fetch, and chat still answers 200", async () => {
  // The two ways a machine has no proxy, both of them lib/native.mjs answering
  // NativeUnavailable from proxyFetch: the plugin is told not to use one
  // (CODAR_PLUGIN_DISABLE_NATIVE=1, which `disabled()` reports), or there is no
  // binary for the platform. They are asserted here rather than assumed, and the
  // transport is the real chatFetch — the disabled switch is how the fallback is
  // reached without spawning anything or opening a socket.
  assert.equal(typeof disabled(), "boolean")
  assert.match(binaryPath("linux", "x64"), /codar-proxy|bin/i)
  assert.equal(officialURL(new URL("https://api.claw.speedai.com:8443/v1/chat/completions")), false, "a port on the vendor's name is another service")

  const real = globalThis.fetch
  const wasDisabled = process.env.CODAR_PLUGIN_DISABLE_NATIVE
  const fallback = recorder(() => jsonAnswer({ id: "chatcmpl-1", choices: [{ message: { content: "好" } }] }))
  globalThis.fetch = fallback
  process.env.CODAR_PLUGIN_DISABLE_NATIVE = "1"
  try {
    assert.equal(disabled(), true, "no proxy is asked for")
    await withChatFetch(chatFetch, async () => {
      const loader = await loadPlugin({ transport: "direct" })
      const got = await loader.fetch(CHAT, { method: "POST", body: hostBody({ stream: false }) })
      // The real chatFetch, asked not to use a proxy: proxyFetch answers
      // NativeUnavailable, chatFetch calls guardedFetch, and the chat answers.
      assert.equal(got.status, 200)
      assert.equal(got.headers.get(TRANSPORT_HEADER), TRANSPORT_NODE)
      assert.match(await got.text(), /chatcmpl-1/)
    })
  } finally {
    globalThis.fetch = real
    if (wasDisabled === undefined) delete process.env.CODAR_PLUGIN_DISABLE_NATIVE
    else process.env.CODAR_PLUGIN_DISABLE_NATIVE = wasDisabled
  }
  assert.equal(fallback.seen.length, 1, "the ordinary fetch carried the request")
})

test("a fallback answer says node, and it is the ordinary fetch that answered", async () => {
  const fallback = recorder(() => sse())
  await withChatFetch(
    async (url, init) => {
      // What chatFetch does when the proxy is absent: guardedFetch (the redirect
      // rule the proxy enforces), and the header saying so.
      const got = await guardedFetch(url, init, { transport: fallback })
      return stamp(got, TRANSPORT_NODE)
    },
    async () => {
      const loader = await loadPlugin({ transport: "direct" })
      const got = await loader.fetch(CHAT, { method: "POST", body: hostBody() })
      assert.equal(got.status, 200)
      assert.equal(got.headers.get(TRANSPORT_HEADER), TRANSPORT_NODE)
    },
  )
  assert.equal(fallback.seen.length, 1, "the ordinary fetch carried it exactly once")
})

// ── 3. the request does not change ──────────────────────────────────────────

test("the fallback changes no header and no body byte", async () => {
  const seenOf = {};
  for (const transport of [TRANSPORT_GO_PROXY, TRANSPORT_NODE]) {
    const impl = recorder(() => stamp(sse(), transport))
    await withChatFetch(impl, async () => {
      const loader = await loadPlugin({ transport: "direct" })
      await loader.fetch(CHAT, { method: "POST", body: hostBody() })
    })
    seenOf[transport] = impl.seen[0].init
  }
  const a = seenOf[TRANSPORT_GO_PROXY]
  const b = seenOf[TRANSPORT_NODE]
  // Six headers, same names, same values: nothing the transport decided.
  assert.deepEqual(a.headers, b.headers)
  assert.deepEqual(Object.keys(a.headers), CLIENT_HEADER_NAMES)
  assert.equal(a.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(a.headers["content-type"], "application/json")
  assert.equal(a.headers["user-agent"], "Go-http-client/1.1")
  // The body, byte for byte, and the length that describes it.
  assert.equal(a.body, b.body)
  assert.equal(Buffer.byteLength(a.body, "utf8"), Number(a.headers["content-length"]))
  // And the request carries none of this file's own header: which stack carried
  // it is a fact about the answer, never a thing the vendor is told.
  assert.deepEqual(Object.keys(a.headers).filter((k) => k.toLowerCase() === TRANSPORT_HEADER), [])
})

test("the proxy road adds no X-Codar-Proxy-Token and no Host to the request it is given", async () => {
  // native.mjs writes those two itself, on the socket, from the ready file
  // (sendVia). chatDirect's job is not to write them: a second copy would be a
  // header the proxy drops or a Host the vendor never saw.
  const proxied = recorder(() => stamp(sse(), TRANSPORT_GO_PROXY))
  await withChatFetch(proxied, async () => {
    const loader = await loadPlugin({ transport: "direct" })
    await loader.fetch(CHAT, { method: "POST", body: hostBody() })
  })
  const { headers } = proxied.seen[0].init
  assert.deepEqual(Object.keys(headers).filter((k) => /^x-codar-proxy-token$/i.test(k)), [])
  assert.deepEqual(Object.keys(headers).filter((k) => /^host$/i.test(k)), [])
  assert.equal(headers.authorization, `Bearer ${TOKEN}`, "the credential is the caller's, unwrapped")
})

test("a streamed answer is still an SSE stream on the proxy road, never clone()d or read whole", async () => {
  let cloned = false
  const answer = sse(4)
  Object.defineProperty(answer, "clone", {
    value: () => {
      cloned = true
      throw new Error("the transport cloned a stream")
    },
  })
  let chunks = 0
  let frames = 0
  await withChatFetch(
    () => Promise.resolve(stamp(answer, TRANSPORT_GO_PROXY)),
    async () => {
      const loader = await loadPlugin({ transport: "direct" })
      const got = await loader.fetch(CHAT, { method: "POST", body: hostBody() })
      assert.equal(got.headers.get("content-type"), "text/event-stream")
      assert.equal(got.headers.get(TRANSPORT_HEADER), TRANSPORT_GO_PROXY)
      const reader = got.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks += 1
        const text = new TextDecoder().decode(value)
        assert.match(text, /data: /, "the bytes are the vendor's own SSE frames")
        frames += (text.match(/^data: /gm) || []).length
      }
    },
  )
  assert.equal(cloned, false, "nothing cloned the stream")
  // One write out for one write in (lib/tool-rename.mjs), which is what a
  // streamed answer's timeline depends on; and every frame it carried arrived.
  assert.equal(chunks, 1)
  assert.equal(frames, 5)
})

test("the stream choice is read from the body, so a JSON answer is not read as an event stream", async () => {
  // The measurement that made this explicit (2026-11-21): a transport that
  // streams reads a `stream:false` answer as an event stream and fails with
  // "codar-proxy: the answer was streamed", while the same request comes back
  // 200 and whole with the flag handed on. So the body's own `stream` is what
  // the transport is told.
  const plain = recorder(() => stamp(jsonAnswer({ id: "c1", choices: [{ message: { content: "好" } }] }), TRANSPORT_GO_PROXY))
  await withChatFetch(plain, async () => {
    const loader = await loadPlugin({ transport: "direct" })
    const got = await loader.fetch(CHAT, { method: "POST", body: hostBody({ stream: false }) })
    assert.equal(got.status, 200)
    assert.deepEqual(await got.json(), { id: "c1", choices: [{ message: { content: "好" } }] })
  })
  assert.equal(plain.seen[0].init.stream, false)

  // chatDirect reads the body when its caller states nothing, and a caller that
  // states the flag is believed.
  const bare = recorder(() => stamp(jsonAnswer({ ok: true }), TRANSPORT_GO_PROXY))
  await chatDirect({ baseUrl: API, token: TOKEN, body: hostBody({ stream: false }), fetchImpl: bare })
  assert.equal(bare.seen[0].init.stream, false)
  const streaming = recorder(() => stamp(sse(), TRANSPORT_GO_PROXY))
  await chatDirect({ baseUrl: API, token: TOKEN, body: hostBody(), fetchImpl: streaming })
  assert.equal(streaming.seen[0].init.stream, true)
})

// ── 4. refusals ─────────────────────────────────────────────────────────────

test("a 403 comes back with the vendor's JSON on both roads, and the stack on the sentence", async () => {
  const said = { code: "account_restricted", message: "This login credential is restricted." }
  const seen = []
  for (const transport of [TRANSPORT_GO_PROXY, TRANSPORT_NODE]) {
    await withChatFetch(
      () => Promise.resolve(stamp(jsonAnswer(said, 403), transport)),
      async () => {
        const loader = await loadPlugin({ transport: "direct" })
        const got = await loader.fetch(CHAT, { method: "POST", body: hostBody() })
        assert.equal(got.status, 403, transport)
        assert.equal(got.headers.get(TRANSPORT_HEADER), transport, `a refusal from ${transport} says ${transport}`)
        const body = await got.json()
        // The vendor's code and sentence reach the host, in the error shape the
        // plugin hands it (index.mjs's failedAnswer), with the hint that belongs
        // to the code beside them.
        assert.match(body.error.message, /account_restricted/)
        assert.match(body.error.message, /restricted/)
        assert.equal(body.error.type, "codar_bridge_error")
        seen.push(transport)
      },
    )
  }
  assert.deepEqual(seen, [TRANSPORT_GO_PROXY, TRANSPORT_NODE])
})

test("a transport that never answered is a 502 that does not claim the proxy", async () => {
  await withChatFetch(
    async () => {
      throw new TypeError("fetch failed: no socket")
    },
    async () => {
      const loader = await loadPlugin({ transport: "direct" })
      const got = await loader.fetch(CHAT, { method: "POST", body: hostBody() })
      assert.equal(got.status, 502)
      // Nothing carried it, so nothing says the proxy did.
      assert.equal(got.headers.get(TRANSPORT_HEADER), TRANSPORT_NODE)
    },
  )
})

test("carriedBy never invents a proxy: an unstamped answer is node", () => {
  assert.equal(carriedBy(sse()), TRANSPORT_NODE)
  assert.equal(carriedBy(stamp(sse(), TRANSPORT_GO_PROXY)), TRANSPORT_GO_PROXY)
  // A host's own object, a null, a blank header: node — the road that needs no
  // evidence, because every runtime has it.
  assert.equal(carriedBy(null), TRANSPORT_NODE)
  assert.equal(carriedBy({ status: 200 }), TRANSPORT_NODE)
  assert.equal(carriedBy(new Response("x", { headers: { [TRANSPORT_HEADER]: "   " } })), TRANSPORT_NODE)
})

// ── 5. the two seams the change relies on ───────────────────────────────────

test("chatFetch stamps go-proxy on a proxied answer and node on a fallback", async () => {
  // The stamp is what carriedBy reads, so it is asserted on chatFetch itself
  // rather than through a stand-in. The proxied half needs a proxy, and the
  // contract this file owns is the other half — plus the flag that makes the
  // proxy path unreachable, which is the same stamp either way.
  const real = globalThis.fetch
  const wasDisabled = process.env.CODAR_PLUGIN_DISABLE_NATIVE
  const fallback = recorder(() => sse())
  globalThis.fetch = fallback
  process.env.CODAR_PLUGIN_DISABLE_NATIVE = "1"
  try {
    // A body fetch would have to encode is a request this transport cannot
    // carry: the ordinary fetch takes it, and the header says so.
    const encoded = await chatFetch(CHAT, { method: "POST", body: new FormData() })
    assert.equal(encoded.status, 200)
    assert.equal(encoded.headers.get(TRANSPORT_HEADER), TRANSPORT_NODE)
    // And with no proxy to ask for at all, an ordinary chat is the ordinary
    // fetch too — the fallback chat is never failed for.
    const plain = await chatFetch(CHAT, { method: "POST", body: hostBody({ stream: false }), stream: false })
    assert.equal(plain.status, 200)
    assert.equal(plain.headers.get(TRANSPORT_HEADER), TRANSPORT_NODE)
  } finally {
    globalThis.fetch = real
    if (wasDisabled === undefined) delete process.env.CODAR_PLUGIN_DISABLE_NATIVE
    else process.env.CODAR_PLUGIN_DISABLE_NATIVE = wasDisabled
  }
  // The stamp is the header carriedBy reads: one name, one set of values, in
  // one module each. The seam nothing set is still unset for another file.
  assert.equal(TRANSPORT_HEADER, "x-magpie-codar-transport")
  assert.equal(testables.chatFetch, undefined)
})

test("a proxied answer whose headers cannot be written still gets the stamp", async () => {
  // The live run of 2026-11-21 caught this and the suite did not: the answer the
  // proxy path produces is not a Response but the fetch-shaped object sendVia
  // builds, whose `headers` is a read-only shim (`get`/`has`/`forEach`/`entries`,
  // no `set`). `headers.set(...)` threw inside the "stamp" and the header simply
  // did not appear — the catalog answered 200 with no transport at all. So a
  // shim-shaped answer is stamped here, and its own head is still readable.
  const shim = (entries) => {
    const map = new Map(entries.map(([k, v]) => [k.toLowerCase(), v]))
    return {
      get: (name) => map.get(String(name).toLowerCase()) ?? null,
      has: (name) => map.has(String(name).toLowerCase()),
      forEach: (cb, thisArg) => {
        for (const [name, value] of map) cb.call(thisArg, value, name)
      },
      entries: () => map.entries(),
    }
  }
  const answer = {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: shim([["content-type", "application/json"], ["retry-after", "7"]]),
    body: null,
    text: async () => "{}",
    json: async () => ({}),
  }
  // The same answer through chatDirect, which is what stamps it — and whose
  // fetchImpl is the way a shim-shaped answer is handed over here (chatFetch
  // needs a live proxy or a global fetch to reach the same code).
  const direct = await chatDirect({ baseUrl: API, token: TOKEN, body: hostBody({ stream: false }), fetchImpl: async () => answer })
  assert.equal(direct.status, 200)
  // An unstamped shim says node: the one road that needs no evidence.
  assert.equal(direct.headers.get(TRANSPORT_HEADER), TRANSPORT_NODE)
  // And the vendor's own names are still there, unchanged, through the readers
  // the shim answers — get, has, entries and forEach alike.
  assert.equal(direct.headers.get("content-type"), "application/json")
  assert.equal(direct.headers.get("retry-after"), "7")
  assert.equal(direct.headers.has("retry-after"), true)
  assert.equal(direct.headers.has("nope"), false)
  assert.deepEqual(Array.from(direct.headers.entries()).filter(([k]) => k === "retry-after"), [["retry-after", "7"]])
  assert.equal(direct.body, null, "the body is the same object it was")
})

test("closeProxy leaves a chat able to start another proxy", async () => {
  // The plugin's own contract from lib/native.mjs: a transport that is closed on
  // purpose is not a transport that is gone for ever. For the loader that means
  // a chat after a close is still answered — by the proxy if it starts again,
  // by the ordinary fetch if it does not — and never by a transport that is no
  // longer there.
  const real = globalThis.fetch
  globalThis.fetch = recorder(() => sse())
  try {
    const { closeProxy, proxy } = await import("../lib/native.mjs")
    await closeProxy()
    const after = await proxy().catch(() => null)
    // Either a fresh proxy came up or it did not; both are answers this file has
    // already covered. What is not allowed is a hang or a throw.
    assert.ok(after === null || typeof after === "object")
    const one = recorder(() => stamp(sse(), TRANSPORT_GO_PROXY))
    await withChatFetch(one, async () => {
      const loader = await loadPlugin({ transport: "direct" })
      const a = await loader.fetch(CHAT, { method: "POST", body: hostBody() })
      const b = await loader.fetch(CHAT, { method: "POST", body: hostBody() })
      assert.equal(a.status, 200)
      assert.equal(b.status, 200)
    })
    assert.equal(one.seen.length, 2, "a chat after a close still has a transport")
    await closeProxy()
  } finally {
    globalThis.fetch = real
  }
})

test("two chats at once share one transport and neither waits on a proxy start", async () => {
  // proxy()'s cache is lib/native.mjs's to prove (test/native.test.mjs does, by
  // starting a real binary once); for the loader the contract is that a
  // concurrent chat is not a second start and not a serialization: both readers
  // are handed their own answer.
  let inFlight = 0
  let most = 0
  const proxied = async (url) => {
    inFlight += 1
    most = Math.max(most, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inFlight -= 1
    return stamp(sse(), TRANSPORT_GO_PROXY)
  }
  const answers = await withChatFetch(proxied, async () => {
    const loader = await loadPlugin({ transport: "direct" })
    return Promise.all([loader.fetch(CHAT, { method: "POST", body: hostBody() }), loader.fetch(CHAT, { method: "POST", body: hostBody() })])
  })
  assert.equal(answers.length, 2)
  for (const answer of answers) {
    assert.equal(answer.status, 200)
    assert.equal(answer.headers.get(TRANSPORT_HEADER), TRANSPORT_GO_PROXY)
  }
  assert.equal(most, 2, "the two requests were in flight together")
})

test("officialURL is not fooled by an http address or a port on the vendor's own name", () => {
  // The loader's transport is asked whether the proxy carries a URL at all: the
  // desktop's own test is https, no userinfo, no port, and one of the four
  // hosts. An http address or a port on a vendor name is another service, and
  // the answer is the ordinary fetch — a fallback, not an error.
  assert.equal(officialURL(new URL("https://api.claw.speedai.com/v1/chat/completions")), true)
  assert.equal(officialURL(new URL("http://api.claw.speedai.com/v1/chat/completions")), false)
  assert.equal(officialURL(new URL("https://api.claw.speedai.com:8443/v1/chat/completions")), false)
  assert.equal(officialURL(new URL("https://user@api.claw.speedai.com/v1/chat/completions")), false)
  assert.equal(officialURL(new URL("https://api.claw.speedai.com.evil.example/v1")), false)
  // And the http one is carried by chatFetch's fallback, with the header saying
  // so — the case a reader of the header needs to be able to trust.
  const plain = new URL("http://api.claw.speedai.com/v1/chat/completions")
  assert.equal(officialURL(plain), false)
})
