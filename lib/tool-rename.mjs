// The rename: the client's tool names on the way in, the host's on the way out,
// and the calls in between handed back to the host to run.
//
// Why this file exists, in one measurement (2026-11-21, a real account, varying
// only the body's tools):
//
//   client prefix + the 44 tools, as captured   → 200
//   client prefix + one tool of the host's own  → 403 client_not_supported
//   no prefix + the 44 tools                    → 403 client_not_supported
//   client prefix + only read_file              → 403 client_not_supported
//
// So the table leaving this plugin is the client's 44 and nothing else — it is
// not a preference, and a "helpful" extra tool costs the whole turn. But a
// conversation built on that table comes back with `read_file`, `exec`,
// `list_dir`, and the host (DSH) has `read`, `pwsh`, `glob`. The names are the
// only thing that crosses; the plugin executes nothing.
//
// Three rewrites, one for each direction a request travels:
//
//   prepareChatBody    the caller's tools → the client's 44, and (on the second
//                      turn) every name the host echoed back → the codar name the
//                      model said.
//   renameAnswer       the assistant's tool_calls → the caller's names, so the
//                      host runs them as its own tools. Non-streaming JSON and
//                      streaming SSE both.
//   the ledger         tool_call_id → the codar name, kept for the length of the
//                      turn. `__codarName` rides along in the answer for a host
//                      that keeps it, but a host that rebuilds the message from
//                      known fields drops it, and the ledger is then the only
//                      record of which name the model actually said.
//
// What is deliberately not here: any tool implementation. This module imports the
// definitions and the map, and nothing that can run anything — no file system, no
// child process, no tool registry. test/tool-rename.test.mjs applies the same
// plain search a reviewer would (a call of `attach(` rather than the words in
// this paragraph) to this file and lib/tool-map.mjs, so "the plugin never
// executes a tool" is a property of what got imported rather than a promise in a
// comment.

import { TOOL_DEFINITIONS } from "./tools/definitions.generated.mjs"
import { callerNameOf, codarNameOf } from "./tool-map.mjs"

// NAMES and COMPLETE are the 44 as a set and, separately, the ones no other name
// extends. A streamed name arrives in fragments ("read_" then "file"), and the
// only honest test that a fragment is a whole name is that the 44 contain it and
// no longer name starts with it: "read_" is a prefix of both read_file and
// read_pdf_text and must wait; "read_file" is a whole name and may go out. The
// leaf set is computed once, from the capture's own list, so a name added
// tomorrow cannot leave a stale copy behind.
const NAMES = TOOL_DEFINITIONS.map((entry) => entry.function.name)
const COMPLETE = new Set(NAMES.filter((name) => !NAMES.some((other) => other !== name && other.startsWith(name))))

// clientTools is the table that goes out: the capture's own array, cloned so no
// caller can edit the one copy this process keeps. The registry module answers the
// same array through toolDefinitions(), but importing it would pull in the nine
// handlers with it — and then "the plugin executes nothing" would be true by
// discipline instead of by construction.
const clientTools = () => TOOL_DEFINITIONS.map((entry) => structuredClone(entry))

// LEDGER_LIMIT bounds the tool_call_id ledger. magpie is one process that stays
// up for days; a map that only grows is a leak that shows up as memory. Entries
// are only needed from the answer that names a call to the request that carries
// its result, which is one turn — 512 is far more than a turn can hold and far
// less than a leak.
const LEDGER_LIMIT = 512
const ledger = new Map()

// rememberCall records which codar name a tool_call_id stood for. A repeated id
// is moved to the end rather than duplicated: the newest name is the one the next
// request will pair with.
export function rememberCall(id, codarName) {
  if (typeof id !== "string" || !id || typeof codarName !== "string" || !codarName) return
  ledger.delete(id)
  ledger.set(id, codarName)
  while (ledger.size > LEDGER_LIMIT) ledger.delete(ledger.keys().next().value)
}

// rememberedCall is that record, or "" when the id was never seen — a call from
// another process, or one whose entry aged out.
export const rememberedCall = (id) => (typeof id === "string" ? ledger.get(id) ?? "" : "")

// forgetCalls empties the ledger. It is for the suite: one test's `call_1` must
// not be another's, and a process that ran a thousand turns in a test file would
// otherwise answer by luck.
export const forgetCalls = () => ledger.clear()

// parseObject is JSON text as an object, or null. An array, a number, a
// truncated body: all null. Every rewrite here is about named fields inside an
// object, and a shape without those fields has nothing to rewrite.
const parseObject = (text) => {
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

// callerNamesOf is the names the host's own tools carry. This is the vocabulary
// the answer is translated into, so it is read before the table is replaced —
// after that the caller's names exist nowhere in the request.
export const callerNamesOf = (tools) =>
  new Set((Array.isArray(tools) ? tools : []).map((entry) => entry?.function?.name).filter((name) => typeof name === "string" && name))

// restoreToolNames puts the codar names back on the assistant's tool_calls, in
// place, and answers how many it changed.
//
// This is the rewrite the second turn needs and the one that is easiest to
// forget. The host answers a call by sending back
//   [assistant(tool_calls=[{id:"call_1", function:{name:"read"}}]), tool(id:"call_1", content:"…")]
// and the vendor pairs a tool message with the call that asked for it. A call
// whose name is `read` is a call to a tool the client never offered; whether the
// vendor refuses that outright or quietly loses the pairing, the turn is broken
// and the sentence is about the wrong thing. So the name goes back to `read_file`
// and the pair is self-consistent again.
//
// Three sources, in this order: `__codarName` (if the host kept it), the ledger
// (what this process actually sent), and the reverse map (the last resort, which
// cannot tell edit_file from apply_patch). `__codarName` is removed either way:
// it is this plugin's field, and the vendor's body should carry nothing it did
// not ask for.
export function restoreToolNames(body) {
  const messages = body?.messages
  if (!Array.isArray(messages)) return 0
  let restored = 0
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = call?.function
        if (!fn || typeof fn !== "object") continue
        const said = typeof fn.__codarName === "string" ? fn.__codarName : ""
        delete fn.__codarName
        const name = typeof fn.name === "string" ? fn.name : ""
        if (!name) continue
        const codar = said || rememberedCall(call.id) || codarNameOf(name)
        if (!codar || codar === name) continue
        fn.name = codar
        restored += 1
      }
    }
    // Some hosts name the tool on the tool message itself, the old OpenAI way.
    // The same mapping applies, and an unknown name is left as it is.
    if (message.role === "tool" && typeof message.name === "string" && message.name) {
      const codar = rememberedCall(message.tool_call_id) || codarNameOf(message.name)
      if (codar && codar !== message.name) {
        message.name = codar
        restored += 1
      }
    }
  }
  return restored
}

// prepareChatBody is the request-side rewrite: the caller's tools replaced by the
// client's 44, and the caller's names put back where the host left its own.
//
// It answers `callerTools` as a Set — the vocabulary renameAnswer translates
// into — because that list exists nowhere in the body once the table is replaced.
// A body that is not a JSON object comes back untouched with an empty set: the
// transport already made sure a chat completion is JSON, and this function's job
// is not to turn a bad request into a different one.
export function prepareChatBody(raw) {
  const body = typeof raw === "string" ? parseObject(raw) : null
  if (!body) return { body: raw, callerTools: new Set(), restored: 0 }
  const callerTools = callerNamesOf(body.tools)
  const restored = restoreToolNames(body)
  body.tools = clientTools()
  return { body: JSON.stringify(body), callerTools, restored }
}

// renameToolCalls renames the assistant's calls in a non-streamed answer, in
// place, and answers how many it changed. A call to one of the 35 that has no
// host name keeps the codar name: the host will refuse a tool it never declared,
// and that refusal names the tool the model asked for — which is the only useful
// thing to show. Renaming it to something invented would turn "the model wanted
// the literature library" into "the model called a tool that does not exist".
export function renameToolCalls(payload, callerTools) {
  const calls = payload?.choices?.[0]?.message?.tool_calls
  if (!Array.isArray(calls)) return 0
  let changed = 0
  for (const call of calls) {
    const fn = call?.function
    if (!fn || typeof fn !== "object") continue
    const original = typeof fn.name === "string" ? fn.name : ""
    if (!original) continue
    const mapped = callerNameOf(original, callerTools)
    if (!mapped || mapped === original) continue
    fn.name = mapped
    fn.__codarName = original
    rememberCall(call.id, original)
    changed += 1
  }
  return changed
}

// headersOf is a Response's headers without the two a rewrite falsifies. The body
// was decompressed by fetch, so `content-encoding: gzip` would describe bytes
// that are no longer gzipped, and `content-length` counted the bytes before the
// rename. Both are a smaller body's worth of wrong, and both break a client that
// trusts them.
const headersOf = (answer) => {
  const headers = new Headers(answer.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return headers
}

// rebuilt is a Response carrying `text`, with the upstream's status and its
// headers as far as they still describe this body.
const rebuilt = (answer, text, headers = headersOf(answer)) =>
  new Response(text, { status: answer.status, statusText: answer.statusText, headers })

// renameAnswer is the response-side entry: the answer the vendor produced, with
// its tool_calls renamed for the host.
//
// A streamed answer is wrapped, never read: `pipeThrough` hands the host the
// vendor's own bytes as they arrive, and the wrapper only touches a `data:` line
// that carries a tool_calls fragment. Nothing calls clone() on a text/event-stream
// here, and nothing awaits its body — AGENTS.md's costliest trap is exactly this
// file's easiest mistake (a clone flattens the timeline, a 4 KB peek deadlocks).
export function renameAnswer(answer, callerTools) {
  if (!answer || !answer.body) return answer
  const type = answer.headers?.get?.("content-type") ?? ""
  if (/text\/event-stream/i.test(type)) return renameStream(answer, callerTools)
  return renameJson(answer, callerTools)
}

// renameJson reads a non-streamed answer, renames what it carries and answers a
// new Response. An error body, an HTML page, a body that is not JSON at all:
// passed through as the text it was, with the headers corrected. Reading here is
// safe by definition — this branch is not a stream.
async function renameJson(answer, callerTools) {
  const text = await answer.text()
  const payload = parseObject(text)
  if (!payload) return rebuilt(answer, text)
  const changed = renameToolCalls(payload, callerTools)
  if (!changed) return rebuilt(answer, text)
  return rebuilt(answer, JSON.stringify(payload))
}

// aFrame is one SSE event line rewritten, or the line it was when nothing in it
// names a tool. `state` carries the fragments of a name that has not finished
// arriving yet, and which indices have already been handed to the host.
const aFrame = (line, state, callerTools) => {
  if (!line.startsWith("data:")) return line
  const payload = line.slice(5).trim()
  if (!payload.startsWith("{")) {
    // `[DONE]` and anything else that is not JSON: released names go out first,
    // so a fragmented name is never left behind a terminator the host stops at.
    return payload === "[DONE]" ? `${releasePending(state, callerTools)}${line}` : line
  }
  if (!payload.includes("tool_calls")) return line
  let event
  try {
    event = JSON.parse(payload)
  } catch {
    return line
  }
  const deltas = event?.choices?.[0]?.delta?.tool_calls
  if (!Array.isArray(deltas) || deltas.length === 0) return line
  let touched = false
  for (const call of deltas) {
    const fn = call?.function
    if (!fn || typeof fn !== "object") continue
    if (typeof fn.name !== "string" || !fn.name) continue
    const index = Number.isInteger(call.index) ? call.index : 0
    const name = `${state.names.get(index) ?? ""}${fn.name}`
    state.names.set(index, name)
    if (state.emitted.has(index)) {
      // A fragment after the whole name went out. The host already has the name,
      // and appending a second copy to it would be the call with the wrong tool.
      delete fn.name
      touched = true
      continue
    }
    if (!COMPLETE.has(name)) {
      // Still a prefix of some name: hold the fragment, send the frame on
      // without a name. Nothing is buffered from the host's side — this frame
      // still carries the call's id and whatever arguments came with it.
      delete fn.name
      touched = true
      continue
    }
    const mapped = callerNameOf(name, callerTools) || name
    fn.name = mapped
    if (mapped !== name) fn.__codarName = name
    rememberCall(call.id, name)
    state.emitted.add(index)
    touched = true
  }
  return touched ? `data: ${JSON.stringify(event)}\n` : line
}

// releasePending hands the host any name the stream stopped in the middle of. It
// is one synthetic frame per unfinished call, in the same delta shape the vendor
// uses, and it is emitted only where a terminator or the end of the stream makes
// "later" impossible: in front of the `[DONE]` (a host stops reading at it, so a
// frame behind it is never read), or at the flush of a stream that carried none.
// A call whose name the vendor cut in half cannot be executed by any name; this
// at least gives the host the half the model actually said.
function releasePending(state, callerTools) {
  let out = ""
  for (const [index, name] of state.names) {
    if (state.emitted.has(index)) continue
    const mapped = callerNameOf(name, callerTools) || name
    const fn = mapped === name ? { name } : { name: mapped, __codarName: name }
    out += `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: fn }] } }] })}\n\n`
    state.emitted.add(index)
  }
  return out
}

// renameStream is that wrapper. Lines are reassembled across chunk boundaries
// (a frame can split anywhere), and one chunk writes one chunk out — including an
// empty one — so a stream with no tool_calls is the vendor's own bytes in the
// vendor's own chunk count, which is what the suite measures.
function renameStream(answer, callerTools) {
  const state = { names: new Map(), emitted: new Set() }
  const decoder = new TextDecoder("utf-8")
  const encoder = new TextEncoder()
  let pending = ""
  const body = answer.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        let out = ""
        let at = pending.indexOf("\n")
        while (at >= 0) {
          out += aFrame(pending.slice(0, at + 1), state, callerTools)
          pending = pending.slice(at + 1)
          at = pending.indexOf("\n")
        }
        controller.enqueue(encoder.encode(out))
      },
      flush(controller) {
        pending += decoder.decode()
        let out = pending ? aFrame(pending, state, callerTools) : ""
        pending = ""
        out += releasePending(state, callerTools)
        if (out) controller.enqueue(encoder.encode(out))
      },
    }),
  )
  return rebuilt(answer, body)
}
