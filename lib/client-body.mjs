// The chat body's shape: the request the Codar desktop actually sends.
//
// The headers were already the desktop's — native/cmd/codar-proxy keeps
// Authorization, Content-Type, X-Api-Key and Anthropic-Version, lets Go write
// its own User-Agent, and drops everything else. The body was not: an OpenAI
// client's body left with its own keys in its own order, a max_tokens the
// desktop never sends, and no thinking at all. A capture of the desktop
// (v0.3.17, 2026-11-20; docs/codar/samples/chat-completions.body.json in
// register-machine) says what it sends instead: seven top-level keys, in this
// order —
//
//   messages, model, reasoning_effort, stream, stream_options, thinking, tools
//
// — with reasoning_effort "high", thinking {"type":"enabled"} and
// stream_options {"include_usage":true} on a streamed request. That is what
// normalizeChatBody writes.
//
// Only the shape is copied. messages, tools and the system prompt inside them
// are the caller's, value for value: they are the agent's tool table and its
// conversation, and a body that looked right while dropping a tool would be a
// prettier failure. The one message that can be rewritten is the system prompt,
// and only when the caller asks for it (alignSystem below, and
// lib/client-system.mjs for what "the client's prompt" costs).

import { alignSystemPrompt } from "./client-system.mjs"

export const CLIENT_KEY_ORDER = ["messages", "model", "reasoning_effort", "stream", "stream_options", "thinking", "tools"]

// isChatCompletionUrl answers whether this URL is a chat completion — the one
// request whose body is reshaped. Everything else the plugin posts (daily-sign,
// status, gettoken, agent/balance, the activities) has its own shape and is
// left exactly as the caller wrote it; a body rewritten there would be a body
// the vendor never agreed to.
//
// /v1/messages is deliberately not matched. The claude family is served on
// that path, and it is proxied, but its body is a different schema: max_tokens
// is required rather than forbidden, reasoning_effort and stream_options do
// not exist there, and no capture of the desktop's Anthropic request was taken.
// There is no truth to copy, so the rule this module is built on applies —
// what cannot be made the same is left alone.
export function isChatCompletionUrl(url) {
  let u
  try {
    u = typeof url === "string" ? new URL(url) : url
  } catch {
    return false
  }
  return Boolean(u) && typeof u.pathname === "string" && /(^|\/)chat\/completions\/?$/.test(u.pathname)
}

// normalizeChatBody is that body: the client's key order, the client's fixed
// values, and no max_tokens unless the host set one. It answers the JSON text
// to send, compact like the capture. A string that is not a JSON object (a
// truncated body, an array, a number) comes back exactly as it arrived — a bad
// request is the caller's, and this is not the place to turn it into a
// different bad request.
//
// options.alignSystem wraps the system prompt in the client's own
// (alignSystemPrompt, lib/client-system.mjs). It is off unless asked for,
// because it is the one rewrite here that touches a message's content rather
// than the body's frame, and a caller that wants its prompt delivered as
// written should get it that way.
export function normalizeChatBody(raw, options = {}) {
  if (typeof raw !== "string") return raw
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return raw
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return raw
  body = withAlignedSystem(body, options)

  // The values that go out, before they are ordered: everything the body has
  // of the client's keys, then the three the client decides itself.
  const wanted = new Map()
  for (const key of CLIENT_KEY_ORDER) if (Object.hasOwn(body, key)) wanted.set(key, body[key])
  // reasoning_effort is "high" in the capture, for the one model it covers. A
  // host asking for another rung gets high as well: a per-model ladder would be
  // a guess the capture does not support, and the shape is what is being copied.
  wanted.set("reasoning_effort", "high")
  wanted.set("thinking", { type: "enabled" })
  // include_usage is only meaningful on a streamed request, and the client only
  // sends it on one. A non-streamed body is given none; if the host wrote its
  // own there, it is left as the host wrote it rather than dropped.
  if (body.stream === true) wanted.set("stream_options", { include_usage: true })

  const entries = []
  for (const key of CLIENT_KEY_ORDER) if (wanted.has(key)) entries.push([key, wanted.get(key)])
  for (const [key, value] of Object.entries(body)) {
    if (CLIENT_KEY_ORDER.includes(key)) continue
    // max_tokens is not sent by the desktop, so a default is dropped: the body
    // is then the client's, exactly. An explicit positive cap is kept instead —
    // it is the caller's output limit, and dropping it would let an answer run
    // past the length the caller asked for. The trade-off is stated rather than
    // hidden: a body with no cap is byte-for-byte the client's, and a body whose
    // limit the user set names that limit after the client's own keys.
    if (key === "max_tokens" && !(typeof value === "number" && Number.isFinite(value) && value > 0)) continue
    entries.push([key, value])
  }
  // fromEntries defines own data properties, so a body carrying "__proto__"
  // keeps it as a key here instead of writing this object's prototype.
  return clientJSON(Object.fromEntries(entries))
}

// withAlignedSystem is the body with its system prompt aligned, or the body
// itself when nothing was asked for or nothing changed. It is done here, on the
// object that was just parsed, rather than on the raw text: one parse for one
// request, and a second JSON round trip would be a second place for a body to
// be rewritten.
const withAlignedSystem = (body, options) => {
  if (options?.alignSystem !== true) return body
  const messages = alignSystemPrompt(body.messages)
  return messages === body.messages ? body : { ...body, messages }
}

// clientJSON writes a body the way the desktop's encoder does.
//
// The capture is Go's encoding/json output: compact (no spaces after ":" or
// ","), and with Go's default HTML escaping, which writes <, > and & as
// \u003c, \u003e and \u0026 — the sample carries 10, 11 and 6 of them — and
// U+2028/U+2029 as escapes too. Those five characters are the whole difference
// between JSON.stringify and the capture: stringifying the captured body with
// them escaped is byte-identical to the 83,515-byte file, which is what makes
// "the same request" a thing that can be measured rather than claimed. The
// replacement is safe on JSON.stringify's output: <, > and & cannot appear
// outside a string literal there, and a literal backslash is already written
// as \\, so no escape sequence is cut in half.
const clientJSON = (value) =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
