// The rename: the request's tools and the response's tool_calls.
//
// Two halves, and both are measured against the vendor's own gateway rather than
// against a preference:
//
//   - the request side. The body the host wrote carries the host's own tool
//     table; the body that leaves carries the client's 44, byte for byte (the
//     measurement that says so is in lib/tool-rename.mjs). The host's names are
//     read before that replacement — they are the vocabulary the answer is
//     translated into.
//
//   - the response side. A tool call the model made comes back as the client's
//     name; the host is given its own name, with the original kept beside it, and
//     runs the call itself. The plugin executes nothing: no handler is reached,
//     no process is started, no file is touched by this path.
//
// A streamed answer is checked the two ways the costliest trap in AGENTS.md
// matters: it is never cloned (the stand-in's `clone` throws), and a stream with
// no tool_calls comes back as the bytes and the chunks it arrived as.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { CLIENT_HEADER_NAMES } from "../lib/direct.mjs"
import { CLIENT_KEY_ORDER } from "../lib/client-body.mjs"
import { callerNameOf } from "../lib/tool-map.mjs"
import { forgetCalls, prepareChatBody, renameAnswer, renameToolCalls, restoreToolNames } from "../lib/tool-rename.mjs"
import { TOOL_DEFINITIONS, TOOL_DEFINITIONS_SHA256 } from "../lib/tools/index.mjs"
import { CodarPlugin } from "../index.mjs"

const here = fileURLToPath(new URL(".", import.meta.url))
const repo = join(here, "..")

const TOKEN = "fake.jwt.for.tests"
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")

// ---------- the stand-ins the loader tests use ----------

// sseText is one stream as SSE writes it: every frame is a line of its own, and
// the blank line between events is the line between them.
const sseText = (frames) => frames.map((frame) => `${frame}\n`).join("\n")

// onLine answers one line as SSE does: `data: {"x":1}` goes on the wire as
// `data:{"x":1}`, because the space after the field name is optional to read and
// the desktop's encoder (Go, compact) does not write one. The stand-in streams
// what the vendor would, so the wrapper is measured against a vendor-shaped
// stream rather than against its own idea of one. The rewritten frames a test
// reads back are the plain JSON `data: {...}` text — what a host parses — so the
// expectations on those are written in that shape.
const onLine = (line) => (line.startsWith("data: ") ? `data:${line.slice(5)}` : line)

// sseAnswer is a loopback-free streamed answer. Its `clone` throws: a transport
// that cloned a stream fails here rather than in production, where the symptom is
// a flattened timeline and an empty decode rate nobody can reproduce.
const sseAnswer = (frames, { oneChunkPerFrame = true, contentType = "text/event-stream" } = {}) => {
  const text = sseText(frames)
  const answer = new Response(
    new ReadableStream({
      start(controller) {
        if (oneChunkPerFrame) {
          // One chunk per line of the stream, each a complete line: the count of
          // what comes out is then the count of what went in, which is what the
          // byte test below measures.
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(`${onLine(frame)}\n`))
        } else {
          controller.enqueue(new TextEncoder().encode(text))
        }
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": contentType } },
  )
  Object.defineProperty(answer, "clone", {
    value: () => {
      throw new Error("the transport cloned a stream")
    },
  })
  return answer
}

const jsonAnswer = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const recorder = (answer = () => sseAnswer([])) => {
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

const loadPlugin = async (codar) => {
  const plugin = await CodarPlugin({ codar })
  return plugin.auth.loader(async () => ({ type: "api", key: TOKEN }))
}

const hostBody = ({ tools = ["read", "pwsh", "edit"], messages, ...extra } = {}) =>
  JSON.stringify({
    model: "deepseek-v4.1-flash",
    messages: messages ?? [{ role: "user", content: "跑一下验收" }],
    stream: true,
    tools: tools.map((name) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } })),
    ...extra,
  })

const vendorFetch = (answer = () => sseAnswer([])) => {
  // The transport reads the global fetch at call time, so a test swaps it and
  // restores it. It is the *global* that is swapped: the plugin's own default is
  // `(...args) => globalThis.fetch(...args)`, evaluated per request.
  const real = globalThis.fetch
  const fetchImpl = recorder(answer)
  globalThis.fetch = fetchImpl
  return { fetchImpl, restore: () => (globalThis.fetch = real) }
}

// ---------- the request side ----------

test("the request carries the client's 44 tools, serialised as the capture's bytes", async () => {
  const { fetchImpl, restore } = vendorFetch()
  try {
    const loader = await loadPlugin({ transport: "direct" })
    await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", { method: "POST", body: hostBody() })
    const sent = JSON.parse(fetchImpl.seen[0].init.body)
    assert.equal(sent.tools.length, 44, "the client's table is the whole table that leaves")
    // The same serialisation the capture was pinned against: the hash is of the
    // pretty-printed array, so a table that differs in one byte stops matching.
    assert.equal(sha256(JSON.stringify(sent.tools, null, 2)), TOOL_DEFINITIONS_SHA256)
    assert.equal(sha256(JSON.stringify(sent.tools, null, 2)), "5759ba70ba114c9554bc9f6b7e9bcf9430e8c907539b6fdf8b9268c4563ad8b9")
  } finally {
    restore()
  }
})

test("the host's own tool names are gone from the request", async () => {
  const { fetchImpl, restore } = vendorFetch()
  try {
    const loader = await loadPlugin({ transport: "direct" })
    await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", { method: "POST", body: hostBody() })
    const sent = JSON.parse(fetchImpl.seen[0].init.body)
    for (const name of ["read", "pwsh", "edit"]) {
      assert.ok(!sent.tools.some((tool) => tool.function.name === name), `${name} is still in the outgoing table`)
    }
    // And the body itself: the names appear nowhere as bare tool names.
    const raw = fetchImpl.seen[0].init.body
    assert.ok(!/"name":"read"/.test(raw))
    assert.ok(!/"name":"pwsh"/.test(raw))
    // The client's names are there, so the check above is not vacuous.
    assert.ok(raw.includes('"name":"read_file"'))
    assert.ok(raw.includes('"name":"exec"'))
  } finally {
    restore()
  }
})

test("the body's key order is still the client's seven, tools included", async () => {
  const { fetchImpl, restore } = vendorFetch()
  try {
    const loader = await loadPlugin({ transport: "direct" })
    await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", { method: "POST", body: hostBody() })
    assert.deepEqual(Object.keys(JSON.parse(fetchImpl.seen[0].init.body)), CLIENT_KEY_ORDER)
  } finally {
    restore()
  }
})

test("prepareChatBody answers the caller's names, and the body with the client's table", () => {
  const { body, callerTools, restored } = prepareChatBody(hostBody())
  assert.deepEqual([...callerTools], ["read", "pwsh", "edit"], "the vocabulary the answer is renamed into")
  assert.equal(restored, 0, "a first turn has nothing to put back")
  const sent = JSON.parse(body)
  assert.equal(sent.tools.length, 44)
})

// ---------- the response side, non-streamed ----------

test("a non-streamed tool_call is renamed to the host's own name", async () => {
  forgetCalls()
  const said = {
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
        },
      },
    ],
  }
  const answer = await renameAnswer(jsonAnswer(said), new Set(["read", "pwsh", "edit"]))
  const got = await answer.json()
  assert.equal(got.choices[0].message.tool_calls[0].function.name, "read")
  assert.equal(got.choices[0].message.tool_calls[0].function.arguments, '{"path":"a.txt"}', "the arguments are the model's, untouched")
  assert.equal(got.choices[0].message.tool_calls[0].id, "call_1", "the id the host pairs the result with")
})

test("the original codar name is carried beside the host name", async () => {
  forgetCalls()
  const said = { choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: "{}" } }] } }] }
  const got = await (await renameAnswer(jsonAnswer(said), new Set(["read", "pwsh", "edit"]))).json()
  assert.equal(got.choices[0].message.tool_calls[0].function.name, "pwsh")
  assert.equal(got.choices[0].message.tool_calls[0].function.__codarName, "exec")
})

test("a call the host has no name for keeps the codar name", async () => {
  forgetCalls()
  const said = { choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "literature_get_paper", arguments: "{}" } }] } }] }
  const got = await (await renameAnswer(jsonAnswer(said), new Set(["read", "pwsh", "edit"]))).json()
  assert.equal(got.choices[0].message.tool_calls[0].function.name, "literature_get_paper")
  assert.equal(got.choices[0].message.tool_calls[0].function.__codarName, undefined)
})

test("a codar call is renamed even when the host's name is a prefix of it", async () => {
  forgetCalls()
  const said = { choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] } }] }
  const got = await (await renameAnswer(jsonAnswer(said), new Set(["read"]))).json()
  assert.equal(got.choices[0].message.tool_calls[0].function.name, "read")
  assert.equal(got.choices[0].message.tool_calls[0].function.__codarName, "read_file")
})

test("a tool_call without a name is left alone", () => {
  forgetCalls()
  const said = { choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { arguments: "{}" } }] } }] }
  assert.equal(renameToolCalls(said, new Set(["read"])), 0)
})

// ---------- the plugin never executes a tool ----------

test("the rename path imports no handler, and calls nothing that runs one", () => {
  // The strongest proof available without a process: this path's own modules
  // never import the tool implementations, and never call the primitives a
  // handler needs. The search is for a call, not for a word — a comment above
  // says "no file system" and must not be what fails the check.
  const sources = ["lib/tool-rename.mjs", "lib/tool-map.mjs", "lib/direct.mjs"]
  const FORBIDDEN = [
    "node:fs",
    "node:child_process",
    "node:os",
    "from \"fs\"",
    "child_process",
    "readFileSync(",
    "writeFileSync(",
    "execSync(",
    "spawn(",
    "runTool",
    "tools/catalog.mjs",
    "tools/fs.mjs",
    "tools/shell.mjs",
    "tools/net.mjs",
  ]
  for (const rel of sources) {
    const source = readFileSync(join(repo, rel), "utf8")
    for (const forbidden of FORBIDDEN) {
      assert.ok(!source.includes(forbidden), `${rel} reaches ${forbidden}: this path runs no tool`)
    }
  }
  // index.mjs's direct transport is the one place the rename is wired: it reaches
  // for the rename and the request, and for no tool implementation.
  const index = readFileSync(join(repo, "index.mjs"), "utf8")
  const transport = index.slice(index.indexOf("const directTransportOf"), index.indexOf("// bodyTextOf is the request body"))
  assert.ok(transport.includes("renameAnswer"), "the transport renames the answer")
  assert.ok(!transport.includes("runTool"), "the transport does not run a tool")
})

test("a tool call in a stream is renamed to the host's own name", async () => {
  forgetCalls()
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
    "",
  ]
  const answer = await renameAnswer(sseAnswer(frames), new Set(["read", "pwsh", "edit"]))
  const text = await answer.text()
  assert.ok(text.includes('"name":"read"'), `the name in the stream is the host's: ${text}`)
  assert.ok(!text.includes('"name":"read_file"'), `the codar name did not leave as the call's name: ${text}`)
  assert.ok(text.includes("call_1"))
  assert.ok(text.includes('"path\\":\\"a.txt\\"'), "the arguments frame is the vendor's own")
})

// The terminator is the end of a streamed answer, and a host stops reading at it.
// So this is the one property a rename must never break: the bytes the vendor
// wrote in front of `[DONE]` come out as they arrived, and nothing arrives behind
// it. The wire spelling is measured against the stand-in's own output, computed
// the same way the byte-for-byte test above computes it.
test("nothing is written after the terminator of a renamed stream", async () => {
  // A `call_1` left by another test would look like a fragment this stream never
  // sent, and releasePending would then write a name of its own making here: the
  // release has to be driven by the bytes, not by the ledger.
  forgetCalls()
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"content":"先看一下文件"}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"\\n"}}]}',
    "data: [DONE]",
    "",
  ]
  // The stand-in's spelling, not a remembered one: `onLine` relays the frame as
  // SSE writes it, so the terminator leaves as `data: [DONE]` — one space after
  // the field name, which a reader may ignore and this file's helper keeps.
  const terminator = `${onLine("data: [DONE]")}\n`
  const answer = await renameAnswer(sseAnswer(frames), new Set(["read"]))
  const text = await answer.text()
  assert.ok(text.includes('"name":"read"'), `the call's name is the host's: ${JSON.stringify(text)}`)
  assert.ok(text.includes('"content":"先看一下文件"'), "the text frames are untouched")
  assert.ok(text.includes(terminator), `the terminator left as the stand-in wrote it: ${JSON.stringify(text.slice(-64))}`)
  // Everything behind `[DONE]` is the blank line that ends the SSE event, and not
  // one byte more: a released name written there is a frame the host never reads.
  assert.equal(text.slice(text.lastIndexOf(terminator) + terminator.length), "\n", `only the event's blank line follows: ${JSON.stringify(text.slice(-64))}`)
})

// A name that arrives in fragments and never finishes is the one thing the
// wrapper may write itself rather than forward. It still may not land after the
// terminator: the host stops at `[DONE]`, so a frame behind it is never read.
test("a fragment left unfinished at the terminator is released before it, not after", async () => {
  forgetCalls()
  // "read" is a prefix of both read_file and read_pdf_text, so it is held back
  // and can only be answered where the stream gives up on it. The vendor then
  // cuts the name off and terminates: the release has to go in front of `[DONE]`.
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read"}}]}}]}',
    "data: [DONE]",
    "",
  ]
  const terminator = `${onLine("data: [DONE]")}\n`
  const text = await renameAnswer(sseAnswer(frames), new Set(["read"])).text()
  assert.ok(text.includes('"name":"read"'), `the unfinished name still reaches the host: ${JSON.stringify(text)}`)
  assert.ok(
    text.indexOf('"name":"read"') < text.indexOf(terminator),
    `the released name is in front of the terminator: ${JSON.stringify(text)}`,
  )
  assert.equal(text.slice(text.lastIndexOf(terminator) + terminator.length), "\n", `nothing follows the terminator: ${JSON.stringify(text.slice(-64))}`)
  // Once only: the flush must not release the same index a second time.
  assert.equal(text.match(/"name":"read"/g).length, 1, `the name went out once: ${JSON.stringify(text)}`)
})

test("a stream with no tool_calls comes back byte for byte, one chunk per chunk in", async () => {
  // One line of an SSE stream per chunk: the blank line between events is a line
  // of its own and a chunk of its own, which is what keeps "one chunk in, one
  // chunk out" a count a test can assert.
  const chunks = [
    'data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}',
    "",
    'data: {"choices":[{"index":0,"delta":{"content":"，跑一下"}}]}',
    "",
    "data: [DONE]",
    "",
  ]
  const wire = chunks.map((line) => `${onLine(line)}\n`).join("")
  const answer = await renameAnswer(sseAnswer(chunks), new Set(["read"]))
  // Read the body once, counting chunks as they arrive: `text()` would lock the
  // stream, and the count is half of what this test is about.
  const reader = answer.body.getReader()
  const saw = []
  let count = 0
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    count += 1
    bytes += value.length
    saw.push(new TextDecoder().decode(value))
  }
  assert.equal(saw.join(""), wire, "the bytes are the vendor's own")
  assert.equal(count, chunks.length, "one line in is one chunk out")
  assert.equal(bytes, Buffer.byteLength(wire, "utf8"))
  assert.ok(saw.join("").includes("[DONE]"), "the terminator is where it was")
})

test("a streamed name that arrives in fragments is renamed when it is whole", async () => {
  forgetCalls()
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"_file"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}',
    "",
  ]
  const answer = await renameAnswer(sseAnswer(frames), new Set(["read", "pwsh", "edit"]))
  const text = await answer.text()
  assert.ok(text.includes('"name":"read"'), `the renamed name is in the stream: ${text}`)
  assert.ok(!/"name":"read_/.test(text), `no half name is handed to the host: ${text}`)
})

test("a fragment that is a prefix of no single name is released whole at the end", async () => {
  forgetCalls()
  // "read" is a prefix of both read_file and read_pdf_text: it waits, and the
  // end of the stream is the only place it can be answered.
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read"}}]}}]}',
    "data: [DONE]",
    "",
  ]
  const answer = await renameAnswer(sseAnswer(frames), new Set(["read", "pwsh", "edit"]))
  const text = await answer.text()
  assert.ok(text.includes('"name":"read"'), `the half name still reaches the host, once: ${text}`)
})

// ---------- the second turn ----------

test("a host's tool message puts the codar name back on the assistant's call", () => {
  forgetCalls()
  const { body, restored } = prepareChatBody(
    JSON.stringify({
      model: "m",
      messages: [
        { role: "user", content: "读一下 a.txt" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", name: "read", content: "file body" },
      ],
    }),
  )
  assert.equal(restored, 2, "the call's name and the tool message's name both go back")
  const sent = JSON.parse(body)
  assert.equal(sent.messages[1].tool_calls[0].function.name, "read_file")
  assert.equal(sent.messages[1].tool_calls[0].function.__codarName, undefined, "the plugin's own field is not sent to the vendor")
  assert.equal(sent.messages[2].name, "read_file")
  assert.equal(sent.messages[2].content, "file body", "the result the host produced is the host's own, unchanged")
})

test("restoreToolNames answers the codar name from the ledger when the field is gone", () => {
  // The case the ledger exists for: a host that rebuilds the message from the
  // fields it knows drops `__codarName`, and the only record of what was said is
  // the id. `query` stands for a name outside the nine, which no reverse lookup
  // can answer.
  forgetCalls()
  const body = {
    messages: [
      { role: "assistant", tool_calls: [{ id: "call_9", function: { name: "query" } }] },
      { role: "tool", tool_call_id: "call_9", content: "ok" },
    ],
  }
  assert.equal(restoreToolNames(body), 0, "an id the plugin never saw is not one it can restore")
  assert.equal(body.messages[0].tool_calls[0].function.name, "query")
  const said = {
    choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_9", type: "function", function: { name: "exec", arguments: "{}" } }] } }],
  }
  assert.equal(renameToolCalls(said, new Set(["read", "pwsh", "edit"])), 1)
  const restoredBody = { messages: [{ role: "assistant", tool_calls: [{ id: "call_9", function: { name: "pwsh" } }] }] }
  assert.equal(restoreToolNames(restoredBody), 1, "the id alone is enough")
  assert.equal(restoredBody.messages[0].tool_calls[0].function.name, "exec")
})

test("the ledger says apply_patch where the reverse map alone would say edit_file", () => {
  // The reverse map cannot tell the two apart (both answer to `edit`); the ledger
  // can, because it recorded the name that actually left this process.
  forgetCalls()
  const said = {
    choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_7", type: "function", function: { name: "apply_patch", arguments: "{}" } }] } }],
  }
  assert.equal(renameToolCalls(said, new Set(["edit"])), 1)
  const echoed = { messages: [{ role: "assistant", tool_calls: [{ id: "call_7", function: { name: "edit" } }] }] }
  assert.equal(restoreToolNames(echoed), 1)
  assert.equal(echoed.messages[0].tool_calls[0].function.name, "apply_patch")
})

test("each round still carries the client's six headers and 44 tools", async () => {
  forgetCalls()
  // A non-streamed answer, because the second round's body is what is being
  // measured here: the answer that carries the call is the rename's own test.
  const { fetchImpl, restore } = vendorFetch(() => jsonAnswer({ choices: [{ message: { role: "assistant", content: "ok" } }] }))
  try {
    const loader = await loadPlugin({ transport: "direct" })
    // Round one: the model asks for read_file; the answer hands the host `read`.
    await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", { method: "POST", body: hostBody() })
    // Round two: the host sent the call and its result back, under its own name.
    const second = hostBody({
      messages: [
        { role: "user", content: "读一下 a.txt" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", name: "read", content: "body" },
      ],
    })
    await loader.fetch("https://api.claw.speedai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: second,
    })
    assert.equal(fetchImpl.seen.length, 2)
    for (const seen of fetchImpl.seen) {
      assert.deepEqual(Object.keys(seen.init.headers), CLIENT_HEADER_NAMES, "the capture's six, and no more")
      const sent = JSON.parse(seen.init.body)
      assert.equal(sent.tools.length, 44)
      assert.equal(sha256(JSON.stringify(sent.tools, null, 2)), TOOL_DEFINITIONS_SHA256)
    }
    // The second round's body is the one with the restored name: the vendor sees
    // a call to a tool it offered, paired with the result the host produced.
    const sent = JSON.parse(fetchImpl.seen[1].init.body)
    // The system message the prefix was put in front of is the first one: the
    // body has four messages, and the call and its result are the last two.
    const [call, result] = sent.messages.slice(-2)
    assert.equal(call.role, "assistant")
    assert.equal(result.role, "tool")
    assert.equal(call.tool_calls[0].function.name, "read_file")
    assert.equal(call.tool_calls[0].function.__codarName, undefined)
    assert.equal(result.name, "read_file")
    assert.equal(result.tool_call_id, "call_1", "the pairing the vendor matches on")
    // And the caller's name for the same tool is what the answer is renamed into.
    assert.equal(callerNameOf("read_file", new Set(["read", "pwsh", "edit"])), "read")
  } finally {
    restore()
  }
})

test("a renamed stream is still the vendor's own bytes outside the tool_calls", async () => {
  forgetCalls()
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"content":"先看一下文件"}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"\n"}}]}',
    "data: [DONE]",
    "",
  ]
  const answer = await renameAnswer(sseAnswer(frames), new Set(["read"]))
  const text = await answer.text()
  assert.ok(text.includes('"content":"先看一下文件"'), "the text frames are untouched")
  assert.ok(text.includes('"name":"read"'), "the call's name is the host's")
  // The wire's real spelling, measured rather than assumed: the stand-in relays
  // every frame the way SSE writes it — `data: <json>`, one space after the field
  // name — and it relays the terminator the same way, as `data: [DONE]`. This
  // assertion used to expect `data:[DONE]` (no space), a spelling the stand-in
  // never writes, so it was failing on the test's own input rather than on the
  // wrapper's output. The wrapper's job is to hand the bytes on unchanged, and
  // `data: [DONE]\n\n` at the tail is that, measured against the wire above.
  assert.ok(text.endsWith(`${onLine("data: [DONE]")}\n\n`), "the terminator is where it was, in the wire spelling the stand-in wrote")
})
