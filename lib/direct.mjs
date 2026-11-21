// The direct transport: the desktop's own request, sent by this plugin to the
// vendor's gateway, with no `codar.exe serve` in between.
//
// Why this exists at all. The old road was measured, and it was right at the
// time: a direct call came back 403 {"code":"client_not_supported","message":
// "This login credential is restricted to Codar."} whatever headers or body a
// client copied, and the same account asked through the app's own local server
// answered 200. The check was assumed to be "is this the app's process". It is
// not: it is the head of the body's system message. Measured on this machine
// (2026-11-21, two accounts), varying only that message's length:
//
//   first 1 segment (49 characters)      → 403 client_not_supported, both
//   first 4 segments (~1.6 KB)           → 200, both
//   first 6 / 20 segments, 33,577 chars  → 200
//   33 KB system, no tools, short message → 200
//
// So the conversation can go straight to api.claw.speedai.com, which is better
// in three ways: no desktop app has to be installed or running, no 19 KB app
// system prompt is paid on every session, and the answer arrives as the SSE
// stream the vendor sent — not as a stream re-cut by a bridge that first had to
// flatten magpie's messages into the server's one `{"message": "…"}` string.
// The prefix itself is lib/client-prefix.mjs; the body's shape is
// lib/client-body.mjs. This module is only the request.
//
// The transport's one rule, and it is not negotiable: a streamed answer is
// handed to the host exactly as fetch produced it. No clone, no read, no
// "peek": `clone().text()` on a text/event-stream flattens the timeline and
// leaves decode_ms/decode_tps empty forever (AGENTS.md's costliest trap #1), and
// reading 4 KB and cancelling deadlocks instead. The error path is the only
// place this module reads a body, and an error answer is JSON, never a stream.

// CLIENT_USER_AGENT is the desktop's own: every API call in the capture
// (register-machine's raw-capture.jsonl) carries Go's default client UA, so the
// plugin sends the same string the app does rather than Node's.
export const CLIENT_USER_AGENT = "Go-http-client/1.1"

// CHAT_PATH is the one route this transport sends. A base that already ends in
// /v1 (which is how the provider's baseURL is written down) is not given a
// second one — see chatEndpoint.
export const CHAT_PATH = "/v1/chat/completions"

// CLIENT_HEADER_NAMES is the capture's header list — host, user-agent,
// content-length, authorization, content-type, accept-encoding — as far as a
// fetch can state it: `host` is written by the transport itself and cannot be
// set from here, and `accept: application/json` is stated because the body is
// JSON and a client that asks for it is the one the capture came from. The list
// is exported and ordered so a test can assert that nothing else goes out: an
// X-Codar-* header would be a second identity to explain, and the capture has
// none.
export const CLIENT_HEADER_NAMES = ["user-agent", "content-length", "authorization", "content-type", "accept", "accept-encoding"]

// lengthOf is a body's size in bytes, not characters. The sample request is full
// of Chinese: telling the vendor `content-length` from `String.length` would cut
// it, and fetch would refuse the mismatch instead.
const lengthOf = (body) => {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8")
  if (body && typeof body.byteLength === "number") return body.byteLength
  return 0
}

// clientHeaders is the client's headers, in the capture's order. A request with
// no token carries no Authorization at all rather than "Bearer " — the host will
// refuse it, and an empty credential is a different answer to explain.
export function clientHeaders(token, body) {
  const entries = [
    ["user-agent", CLIENT_USER_AGENT],
    ["content-length", String(lengthOf(body))],
  ]
  const key = typeof token === "string" ? token.trim() : ""
  if (key) entries.push(["authorization", `Bearer ${key}`])
  entries.push(["content-type", "application/json"], ["accept", "application/json"], ["accept-encoding", "gzip"])
  return Object.fromEntries(entries)
}

// chatEndpoint is the address this transport posts to. The provider's base is
// written down with /v1 (`https://api.claw.speedai.com/v1`), a caller's own may
// be the bare host, and one that already names the endpoint gets neither added:
// the three shapes are one address, and posting to /v1/v1/chat/completions is
// the kind of mistake that only shows up as a 404 nobody reads.
export function chatEndpoint(baseUrl) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "")
  if (!base) return ""
  if (/\/chat\/completions$/.test(base)) return base
  if (/\/v1$/.test(base)) return `${base}/chat/completions`
  return `${base}${CHAT_PATH}`
}

// MAX_REFUSAL_CHARS bounds what a refusal's sentence may carry. A vendor that
// answers an HTML error page has nothing in it a person can act on, and the
// whole page in a card line would push out the part that is the reason.
const MAX_REFUSAL_CHARS = 400

// saidOf is a refusal's own sentence, in the shapes the gateway uses: a bare
// `{code, message}`, an OpenAI `{error:{message, code}}`, and a plain string.
const saidOf = (text) => {
  try {
    const body = JSON.parse(text)
    const said = body?.message ?? body?.error?.message ?? body?.msg ?? body?.error
    if (typeof said === "string") return said
  } catch {
    // not JSON: the body itself is the sentence, cut below
  }
  return String(text ?? "")
}

const codeOf = (text) => {
  try {
    const body = JSON.parse(text)
    const code = body?.code ?? body?.error?.code ?? body?.error?.type ?? body?.detail?.code
    return typeof code === "string" ? code : ""
  } catch {
    return ""
  }
}

// scrubToken cuts the credential out of a sentence before it can reach a host's
// log or a card. The vendor does echo what it was sent sometimes, and the token
// is the one string in this request that must never be printed twice.
const scrubToken = (text, token) => {
  const key = typeof token === "string" ? token.trim() : ""
  const said = String(text ?? "")
  return key ? said.split(key).join("…") : said
}

// upstreamError is a refusal as the host can act on it. `client_not_supported`
// gets the hint that belongs to it — the prefix is the one thing a caller can
// fix, and the measurement is what says so. A 401 is a sign-in that lapsed, which
// the host renews or asks to redo (the same `signIn: "expired"` the card uses).
const upstreamError = (status, text, token) => {
  const said = scrubToken(saidOf(text), token).slice(0, MAX_REFUSAL_CHARS)
  const code = codeOf(text)
  const at = `（${status}${code ? ` ${code}` : ""}）`
  const hint = code === "client_not_supported" ? "；system 前缀可能缺失（lib/client-prefix.mjs 的前 4 段没有发出去），或该账号被风控" : ""
  const error = new Error(`codar 直连: 上游拒绝了请求${at}${hint}${said ? `：${said}` : ""}`)
  error.status = status
  if (code) error.code = code
  error.detail = said
  if (status === 401) error.signIn = "expired"
  return error
}

// chatDirect is the request: POST the body to the base's chat completions route
// with the client's six headers, and answer the fetch's own Response.
//
// A 2xx is returned untouched — streaming or not, the host reads it. Anything
// else is read (an error answer is a small JSON object, never a stream) and
// thrown, because a 403 that arrives as a Response with nobody looking at it is
// how the direct road refused and looked like a hung request.
//
// `fetchImpl` is injected so the suite never reaches the network; a caller that
// passes nothing gets the global fetch, read at call time (magpie's own tests
// swap it after the plugin is built).
export async function chatDirect({ baseUrl, token, body, signal, fetchImpl } = {}) {
  const endpoint = chatEndpoint(baseUrl)
  if (!endpoint) throw new Error("codar 直连: 没有上游地址（baseUrl 是空的），这次请求没有发出去")
  const send = typeof fetchImpl === "function" ? fetchImpl : (...args) => globalThis.fetch(...args)
  const answer = await send(endpoint, {
    method: "POST",
    headers: clientHeaders(token, body),
    body,
    ...(signal ? { signal } : {}),
  })
  if (answer.ok) return answer
  throw upstreamError(answer.status, await answer.text(), token)
}
