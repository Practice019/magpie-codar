// The system prompt, in the shape the desktop's own client sends it.
//
// The headers were already the desktop's (native/cmd/codar-proxy), the body's
// keys are since client-body.mjs, and the system prompt inside the body was
// not: magpie's own agent instructions left with the model seeing a prompt no
// Codar client ever sends. A capture of the desktop (v0.3.17, 2026-11-20;
// docs/codar/samples/chat-completions.body.json in register-machine) has that
// prompt, 33,577 characters of it, and this module wraps the caller's system
// prompt in the part of it that can honestly be sent.
//
// Why not the whole thing. The capture's prompt is the desktop's, and three
// things in it are false for anyone else:
//
//   1. "Working Directory: C:\Users\…\.codar\sessions\session_…\workspace" is
//      one session's path, written into the prompt. Sent as it stands, a model
//      believes it works in a directory that does not exist on this machine and
//      opens files that are not there. The line is rewritten to point at what
//      the tools report; the path is not written anywhere.
//   2. Most of it prescribes the desktop's own tools — exec, read_file,
//      write_file, apply_patch, load_skill, task_write, figure_checkpoint,
//      spawn_agent, the document converters — and the tool table in this very
//      request is magpie's (pwsh, read, edit, …). A prompt that says "use
//      apply_patch" beside a tool table with no apply_patch in it is worse than
//      no prompt: the model calls a tool that is not there and the turn is
//      spent on an error. Those sections are dropped whole rather than carved
//      up, because a paragraph removed from the middle of one leaves the
//      sentence that referred to it.
//   3. The rest would be a second set of agent instructions arguing with the
//      caller's own. What is kept is what cannot argue: scope, deliverables,
//      file references, narration, response language.
//
// Why the head is kept entire. The first 400 characters are the client's
// identity prefix, and being that prefix is the whole point of copying it — a
// prefix that stops in the middle of a sentence is not the same request. The
// head's Shell line does name read_file, write_file and exec, in advice about
// PowerShell that stays true of the caller's shell; that is accepted rather
// than trimmed, and it is the only place a desktop-only name survives.
//
// What is sent: the head, the caller's prompt verbatim, then the sections of
// the capture that prescribe no tool of the desktop's — in the capture's order,
// separated the way the capture separates them. tools and the other messages
// are not touched here at all: they are the agent's tool table and its
// conversation, and a body that looked right while dropping a tool would be a
// prettier failure (client-body.mjs says the same about the body).

import { CLIENT_SYSTEM_HEAD, CLIENT_SYSTEM_SECTIONS } from "./client-system-data.mjs"

// CLIENT_OPENING is how the desktop's prompt opens. A prompt that already
// opens this way has been aligned (by this module, or by a caller that asked
// the desktop's own client): aligning it again would be the second copy of a
// prefix, so it is left alone.
export const CLIENT_OPENING = "You are an AI agent running on the Codar runtime."

// RUNTIME_TAIL is the capture's next two lines, with the session's own facts
// taken out: the working directory is whatever the tools report, and the clock
// is whatever they answer. The desktop names its `now` tool, which this caller
// may not have.
const RUNTIME_TAIL = [
  "Working directory: see the environment your tools report; every relative path resolves against it.",
  "Current time: use whatever clock the environment reports when a time is needed.",
].join("\n")

// CLIENT_SYSTEM_PREFIX is the client's opening block: the capture's head, whole,
// then the two lines above. Its first 400 characters are the capture's.
export const CLIENT_SYSTEM_PREFIX = `${CLIENT_SYSTEM_HEAD}\n${RUNTIME_TAIL}`

// DIVIDER is how the capture separates its sections.
const DIVIDER = "\n\n---\n\n"

// compose builds the prompt with the first `keep` tail sections. The caller's
// own text is never shortened: it is the prompt doing the work, and a cut
// sentence in it would be a worse failure than a long request.
const compose = (body, keep) => {
  const parts = [CLIENT_SYSTEM_PREFIX]
  if (body) parts.push(body)
  for (const section of CLIENT_SYSTEM_SECTIONS.slice(0, keep)) parts.push(section.text)
  return parts.join(DIVIDER)
}

// alignSystemPrompt answers messages with its system prompt wrapped in the
// client's, or messages itself when there is nothing to do.
//
// It returns messages unchanged — the same array — when:
//   - messages is not an array (no conversation, a body that never parsed);
//   - the system prompt is already the client's (idempotent: a second call is
//     the first one);
//   - the system prompt's content is not a string (a parts array, null): that is
//     a shape this module does not know how to wrap, and guessing at it would
//     reorder what the caller built;
//   - anything at all goes wrong, which in practice means the two cases above.
//
// Otherwise it answers a new array: the system message (inserted first when the
// caller had none) carrying the composed prompt, and every other message the
// same object, in the same order. The input is not edited.
//
// maxChars bounds the composed system prompt. It is a ceiling for callers with
// a budget, not a target: the tail sections are dropped from the end, one at a
// time, until the prompt fits, and the head and the caller's own text are never
// dropped. No cap by default — the client's own prompt is not capped either.
export function alignSystemPrompt(messages, options = {}) {
  try {
    if (!Array.isArray(messages)) return messages
    const at = messages.findIndex((m) => m && typeof m === "object" && m.role === "system")
    const current = at >= 0 ? messages[at] : null
    if (current) {
      if (typeof current.content !== "string") return messages
      if (current.content.startsWith(CLIENT_OPENING)) return messages
    }

    const body = current ? current.content : ""
    const asked = Number(options?.maxChars)
    const limit = Number.isFinite(asked) && asked > 0 ? asked : Infinity

    let keep = CLIENT_SYSTEM_SECTIONS.length
    let content = compose(body, keep)
    while (keep > 0 && content.length > limit) {
      keep -= 1
      content = compose(body, keep)
    }

    const aligned = current ? { ...current, content } : { role: "system", content }
    if (at < 0) return [aligned, ...messages]
    const out = messages.slice()
    out[at] = aligned
    return out
  } catch {
    return messages
  }
}
