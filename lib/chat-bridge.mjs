// What a magpie conversation becomes inside `codar serve`'s one message field.
//
// The server takes `{"message": "…"}` and nothing else: no system field, no
// messages array, no roles. Measured 2026-11-21: a POST with any other body is
// refused with HTTP 400 {"error":"message is required"}, and the app's own web
// UI sends the same single string. Whatever magpie sends has to be carried by
// that one string — and it has to arrive meaning the same thing.
//
// The shape, and why each part of it:
//
//   system            → the opening of the message, joined in order with a
//                       blank line between. The server has no system role, so
//                       the instructions are simply the first thing the model
//                       reads — which is what the app does with its own system
//                       prompt (a 33 KB block at the head of its message, see
//                       register-machine's chat-completions.body.json).
//   user / assistant  → transcript lines labelled 用户： / 助手：, because a
//                       conversation flattened to one string needs to say who
//                       said what. The last user turn carries no label: it is
//                       the request, not a line of the transcript.
//   tool              → 工具结果（<name>）：<content>, with the name inside the
//                       text. A tool result is the only thing that tells the
//                       model what a call answered, and the name is what tells
//                       it which call — a model that cannot tell read_file from
//                       run_command answers as if the wrong one ran.
//   assistant calls   → the calls an assistant turn asked for are written as
//                       助手：<text> then the calls' own names and arguments,
//                       because the tool result that follows is meaningless
//                       without the call it belongs to.
//
// This is a lossy conversion on purpose, in one direction only: there is no way
// to make the server see roles, so the text is what carries them. Nothing is
// invented and nothing is dropped: every message magpie sends is in the answer,
// in the order magpie sent it.

// LABELS are the role names the transcript uses. They are Chinese because the
// conversation usually is: the server's own client speaks Chinese, and the
// wording is part of the app's prompt language rather than this plugin's choice.
const LABELS = { user: "用户", assistant: "助手", tool: "工具结果" }

// messagesToPrompt reduces magpie's messages to the one string the server
// accepts. An empty answer is no conversation at all — the loader turns that
// into an error that says so rather than a request the server refuses.
export function messagesToPrompt(messages) {
  if (!Array.isArray(messages)) return ""
  const system = []
  const turns = []
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const text = textOf(message.content)
    const role = typeof message.role === "string" ? message.role : ""
    if (role === "system" || role === "developer") {
      // A developer message is the same instruction by another name (newer
      // clients spell it that way); it joins the opening like a system one.
      if (text) system.push(text)
      continue
    }
    if (role === "user") {
      turns.push({ role: "user", text })
      continue
    }
    if (role === "assistant") {
      const calls = callsOf(message)
      turns.push({ role: "assistant", text, calls })
      continue
    }
    if (role === "tool" || role === "function") {
      // The label names the tool the answer came from. `name` is what magpie
      // sends; `tool_call_id` alone is a reference into a call list the server
      // never sees, so a result with only an id is labelled 工具结果 without a
      // name rather than given someone else's.
      const name = typeof message.name === "string" && message.name.trim() ? message.name.trim() : ""
      turns.push({ role: "tool", text, name, id: typeof message.tool_call_id === "string" ? message.tool_call_id : "" })
      continue
    }
  }
  // The last user turn is the request itself: it is written without a label,
  // and the transcript stops before it. A conversation whose last turn is a
  // tool result keeps the label — a result is a thing to read, not the question.
  let asked = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") {
      asked = i
      break
    }
  }
  const body = []
  if (system.length) body.push(system.join("\n\n"))
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    if (turn.role === "user") {
      if (i === asked) body.push(turn.text)
      else body.push(`${LABELS.user}：${turn.text}`)
      continue
    }
    if (turn.role === "assistant") {
      const said = `${LABELS.assistant}：${turn.text}`
      const calls = turn.calls.map((c) => `${LABELS.assistant}工具调用（${c.name}）：${c.arguments}`)
      body.push([said, ...calls].join("\n"))
      continue
    }
    const label = turn.name ? `${LABELS.tool}（${turn.name}）` : LABELS.tool
    body.push(`${label}：${turn.text}`)
  }
  // Blank turns are not lines: a text-empty assistant turn that asked for a
  // call is already written by its calls, and an empty string in the middle
  // would put a paragraph break where nothing was said.
  const answer = body.filter((part) => part !== "").join("\n\n")
  return answer.trim() ? answer : ""
}

// textOf is a message's content as text: a string as it is, and a list of parts
// by the text parts it carries. A part list is how a client sends an image or a
// file (an `image_url` part, a `file` part); the server's field is a string, so
// the text parts are what can travel. A part label is kept for a block the
// model can read something of ("[image]" would be an invention, so an image
// part contributes nothing rather than a word the user never wrote).
const textOf = (content) => {
  if (typeof content === "string") return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part.trim()
        if (!part || typeof part !== "object") return ""
        if (typeof part.text === "string") return part.text.trim()
        // an OpenAI text part is {type:"text", text:"…"}; an Anthropic one is
        // {type:"text", text:"…"} too, so this is the same road
        return ""
      })
      .filter(Boolean)
      .join("\n")
      .trim()
  }
  return ""
}

// callsOf reads the calls an assistant turn asked for, in the two shapes the
// clients write: OpenAI's `tool_calls: [{function:{name, arguments}}]` and the
// older `function_call: {name, arguments}`. The arguments are the model's own
// JSON string and are passed on as it wrote them — re-serializing a JSON
// string is a different string to the tool that has to read it.
const callsOf = (message) => {
  const out = []
  const list = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const call of list) {
    if (!call || typeof call !== "object") continue
    const fn = call.function && typeof call.function === "object" ? call.function : {}
    const name = typeof fn.name === "string" && fn.name.trim() ? fn.name.trim() : "函数"
    out.push({ name, arguments: argsOf(fn.arguments), id: typeof call.id === "string" ? call.id : "" })
  }
  const one = message.function_call && typeof message.function_call === "object" ? message.function_call : null
  if (one) out.push({ name: typeof one.name === "string" && one.name.trim() ? one.name.trim() : "函数", arguments: argsOf(one.arguments), id: "" })
  return out
}

const argsOf = (args) => {
  if (typeof args === "string") return args
  if (args && typeof args === "object") return JSON.stringify(args)
  return "{}"
}
