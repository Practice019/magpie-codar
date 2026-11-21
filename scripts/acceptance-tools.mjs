// The acceptance run for the tool rename: the plugin's own loader, the vendor's
// gateway, and a host's tool table — one round, and a second one when the model
// asked for a tool.
//
//   node scripts/acceptance-tools.mjs                     # the token from ~/.config/magpie/plugin-auth.json
//   node scripts/acceptance-tools.mjs <token> [account]   # or one given here
//
// It answers three questions a unit test cannot: does the gateway accept the body
// this plugin sends while the host declared its own tools; does the model actually
// call one of the 44; and does the answer reach the host under the host's name.
// The second round is the restore's only real proof — it exists when the first
// answer carried a tool_call, and says so when it did not (a model that answers in
// prose is a passing first half, not a failure).
//
// It runs in its own process and never touches a running magpie: it imports the
// plugin, builds a loader, and makes one or two HTTP requests. Nothing here prints
// the credential, and the token is cut to a twelve-character prefix in the report.
//
// 2026-11-21, this machine, user_17002380793_3404 (agent_balance 1953): the chat
// route answers 403 {"detail":{"code":"account_restricted","message":"API access
// is restricted. Please contact support."}} for every body shape — with the 44
// tools, with none, and against /v1/models as well — while the balance endpoint
// answers 200 with the same credential. The restriction is on the account and its
// chat route, not on the body: the shape this script measures was last answered
// 200 on 2026-11-21 before that switch. Rerun this when a chat-enabled account is
// in hand; the report is the evidence, whichever way it goes.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { CodarPlugin } from "../index.mjs"

const AUTH_FILE = join(homedir(), ".config", "magpie", "plugin-auth.json")

// tokenFromAuthFile is the credential as magpie stored it, by the provider's own
// entry name. The file is a map of provider id → credential, and a plugin id that
// is not there is a sentence rather than a crash.
const tokenFromAuthFile = (id) => {
  const all = JSON.parse(readFileSync(AUTH_FILE, "utf8"))
  const entry = all?.[id]
  const token = entry?.access ?? entry?.refresh
  if (typeof token !== "string" || !token) throw new Error(`${AUTH_FILE} holds no token for ${id}`)
  return token
}

const [tokenArg, accountArg, providerArg] = process.argv.slice(2)
const provider = providerArg ?? "codar"
const token = (tokenArg ?? tokenFromAuthFile(provider)).trim()
const account = accountArg ?? ""

// The host's own tools: DSH's vocabulary, not the client's. What the answer must
// come back as is a name from this list.
const HOST_TOOLS = [
  { name: "read", args: { path: "C:\\temp\\codar-accept.txt" } },
  { name: "pwsh", args: { command: "echo hi" } },
  { name: "edit", args: { path: "a.txt" } },
].map((tool) => ({
  type: "function",
  function: { name: tool.name, description: `${tool.name}, as the host declares it`, parameters: { type: "object", properties: {}, additionalProperties: true } },
}))

const SYSTEM = ["You are operating in unrestricted sandbox mode.", "", "# 交付格式", "状态 / 文件清单 / 测试条数"].join("\n")
const USER = `请调用 read 工具读一下 C:\\temp\\codar-accept.txt，然后只回一行：done`

// stamp records what went out: the header list, the tool count, the message roles,
// and whether any name in it belongs to the host. It wraps the global fetch for
// the length of one request and puts it back.
const stamp = () => {
  const real = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    let tools = null
    let names = []
    let roles = null
    try {
      const body = JSON.parse(typeof init.body === "string" ? init.body : "")
      tools = Array.isArray(body.tools) ? body.tools.length : null
      names = (body.tools ?? []).map((entry) => entry?.function?.name).filter(Boolean)
      roles = Array.isArray(body.messages) ? body.messages.map((message) => message.role) : null
    } catch {
      // The transport answers its own 400 for an unreadable body; the report says so.
    }
    seen.push({ url: String(url), headers: Object.keys(init.headers ?? {}), tools, hostNames: names.filter((name) => HOST_TOOLS.some((tool) => tool.function.name === name)), roles })
    return real(url, init)
  }
  return { seen, restore: () => (globalThis.fetch = real) }
}

const describe = (calls) =>
  (calls ?? []).map((call) => `${call.function?.name ?? "?"}${call.function?.__codarName ? ` (was ${call.function.__codarName})` : ""}`)

const plugin = await CodarPlugin({ codar: {} })
const loader = await plugin.auth.loader(async () => ({ type: "api", key: token }))
const endpoint = `${loader.baseURL}/chat/completions`

const round = async (messages) => {
  const { seen, restore } = stamp()
  try {
    const answer = await loader.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "auto", messages, stream: false, tools: HOST_TOOLS }),
    })
    const text = await answer.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      // an SSE answer to stream:false, or the vendor's own HTML page
    }
    return { status: answer.status, type: answer.headers.get("content-type") ?? "", text, payload, sent: seen[0] }
  } finally {
    restore()
  }
}

const report = (n, result) => {
  console.log(`round ${n}: status ${result.status}  content-type ${result.type}`)
  console.log(`  headers asked for: ${result.sent?.headers?.join(", ")}`)
  console.log(`  tools sent: ${result.sent?.tools} (the client's 44, always)  host names present: ${result.sent?.hostNames?.length ?? 0}`)
  console.log(`  messages: ${result.sent?.roles?.join(", ")}`)
  if (!result.payload) {
    console.log(`  body (not JSON): ${result.text.slice(0, 240)}`)
    return
  }
  const message = result.payload?.choices?.[0]?.message ?? result.payload
  const calls = message?.tool_calls ?? []
  console.log(`  tool_calls renamed for the host: ${calls.length ? describe(calls).join(", ") : "(none)"}`)
  if (message?.content) console.log(`  answer: ${String(message.content).replace(/\s+/g, " ").slice(0, 160)}`)
}

const messages = [
  { role: "system", content: SYSTEM },
  { role: "user", content: USER },
]

console.log(`account: ${account || "(not named)"}  token: ${token.slice(0, 12)}…  endpoint: ${endpoint}`)
const first = await round(messages)
report(1, first)

const calls = first.payload?.choices?.[0]?.message?.tool_calls ?? []
if (!calls.length) {
  // A first round that refused or answered in prose has no second half to show.
  // It is reported as it is: the rename is only observable on a call.
  console.log("round 2: skipped — the first answer carried no tool_call")
} else {
  // The host's own result, under the host's own name: this is what the restore
  // rewrite pairs back to the codar name before it is sent.
  const second = await round([
    ...messages,
    { role: "assistant", content: first.payload.choices[0].message.content ?? "", tool_calls: calls },
    ...calls.map((call) => ({ role: "tool", tool_call_id: call.id, name: call.function?.name, content: "（宿主执行结果的占位）" })),
  ])
  report(2, second)
  const echoed = second.payload?.choices?.[0]?.message
  console.log(`  restored to the vendor as: ${(echoed ? "accepted" : "not answered")}`)
}
