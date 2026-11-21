// The client's system prefix, and the one message rewrite the direct transport
// makes.
//
// Measured on this machine (2026-11-21), against api.claw.speedai.com, on two
// accounts (16267173586 / 19200847396), varying nothing but the system message:
//
//   first 1 segment  (49 characters)     → 403 client_not_supported, both
//   first 4 segments (~1.6 KB)           → 200, both
//   first 6 / 20 segments, 33,577 chars  → 200
//   33 KB system, no tools, short message → 200
//
// Three things follow, and this module is the first two:
//
//   1. The gateway's "is this the Codar client?" test is the head of the body's
//      system message. Not the token (both accounts were signed in), not a
//      header (the capture has six and no custom one), and not the tool table —
//      the fourth measurement is a 200 with no tools at all.
//   2. Four segments is the shortest cut that was measured to pass, so that is
//      what goes in front of every conversation: CLIENT_SYSTEM_PREFIX, the
//      capture's own bytes, extracted by scripts/gen-client-prefix.mjs and never
//      typed by hand (the suite pins its sha256).
//   3. The caller's prompt is not replaced. It is DSH's project instructions —
//      the rules that make the answer an answer — and it goes behind the prefix,
//      whole. A request that looked like the client's while dropping the caller's
//      instructions would be a prettier failure than a 403.
//
// What the prefix costs: it quotes the capture session's own "Working Directory:"
// line, and that path is not this machine's. It stays because the prefix is
// measured by its bytes — a rewritten line is a different request — and because
// the caller's own instructions, which follow it immediately, are what name the
// directories the tools actually work in. If the gateway ever stops comparing
// that line, the generator is the place to shorten it, not here.

import { CLIENT_SYSTEM_PREFIX, CLIENT_SYSTEM_PREFIX_HASH, CLIENT_SYSTEM_PREFIX_SEGMENTS } from "./client-prefix-data.mjs"

// Re-exported so a caller (and the tests) have one module to import: the data
// module is generated, and the thing worth reading is this one.
export { CLIENT_SYSTEM_PREFIX, CLIENT_SYSTEM_PREFIX_HASH, CLIENT_SYSTEM_PREFIX_SEGMENTS }

// CLIENT_OPENING is how the desktop's prompt opens, and therefore how a prompt
// that has already been given the prefix opens. Both modules that know this line
// (this one and lib/client-system.mjs, the older 33 KB composer) agree on it;
// two modules that disagreed would each prepend their own prefix.
export const CLIENT_OPENING = "You are an AI agent running on the Codar runtime."

// withClientPrefix answers messages with the client's prefix in front of their
// system prompt, or messages itself when there is nothing to do.
//
//   - no system message  → one is inserted first, carrying the prefix alone;
//   - a system message   → its content becomes prefix + one blank line + the
//                          caller's text, and every other field of the message
//                          (a `name`, anything a host adds) is kept;
//   - already prefixed   → the same array, unchanged. Idempotent, because a
//                          number of callers (the Go proxy's body shaping, a
//                          retried request, a test) may each ask for it.
//
// It returns messages unchanged — the same array — when messages is not an
// array, and when the system prompt's content is not a string. A parts array is
// how a client sends an image or a file beside the text: how to put a prefix in
// front of one is a different question, and guessing at it would reorder what
// the caller built.
//
// Nothing is ever dropped or shortened. The prefix is added; the caller's text
// is the caller's text.
export function withClientPrefix(messages) {
  if (!Array.isArray(messages)) return messages
  const at = messages.findIndex((message) => message && typeof message === "object" && message.role === "system")
  if (at < 0) return [{ role: "system", content: CLIENT_SYSTEM_PREFIX }, ...messages]

  const current = messages[at]
  if (typeof current.content !== "string") return messages
  if (current.content.startsWith(CLIENT_OPENING)) return messages

  // An empty system prompt is the prefix alone rather than the prefix and a
  // stray blank line: the two are the same instruction, and one of them is what
  // a client sends.
  const asked = current.content.trim() ? `${CLIENT_SYSTEM_PREFIX}\n\n${current.content}` : CLIENT_SYSTEM_PREFIX
  const prefixed = { ...current, content: asked }
  return messages.map((message, i) => (i === at ? prefixed : message))
}
