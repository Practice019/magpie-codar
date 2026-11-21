// The incident's acceptance run, in its own process: three conversations in a
// row through the plugin's real bridge (lib/serve.mjs, not a fixture), against
// the app's own server on 127.0.0.1:8080 — the server the person has running.
//
// What it has to show, and what it printed on 2026-11-21:
//
//   1. three different session_ids, all mw-… — before this, every request landed
//      in the server's fixed `web-ui`;
//   2. context_usage.input_tokens that does NOT grow turn after turn — the
//      517961 prompt tokens measured on the same machine were the pile of every
//      conversation in one session plus the bridge re-sending magpie's history.
//
// It is a script, not a test: the suite must never reach the network (AGENTS.md
// §二), while this run is only meaningful against the real server.
import { chatStream } from "../lib/serve.mjs"

const PORT = Number(process.env.CODAR_SERVE_PORT ?? 8080)
const ASK = ["只回答两个字：收到", "只回答两个字：好的", "只回答两个字：明白"]

const rows = []
for (const message of ASK) {
  const events = []
  try {
    for await (const event of chatStream({ port: PORT, message, timeoutMs: 120_000 })) events.push(event)
  } catch (e) {
    console.error(`失败：${e.code ?? ""} ${e.message}`)
    process.exitCode = 1
    continue
  }
  const session = events.find((e) => typeof e.session_id === "string")?.session_id ?? "(事件里没有 session_id)"
  const usage = events.find((e) => e.event === "context_usage")?.data ?? events.find((e) => e.event === "result")?.data ?? {}
  const text = events.filter((e) => e.event === "text_delta").map((e) => e.data?.text ?? "").join("")
  rows.push({ session, input: usage.input_tokens, output: usage.output_tokens, total: usage.total_tokens, text })
}

console.log(JSON.stringify(rows, null, 2))
const sessions = rows.map((r) => r.session)
const distinct = new Set(sessions).size === sessions.length
const inputs = rows.map((r) => r.input).filter((n) => Number.isFinite(n))
const notGrowing = inputs.length < 2 || inputs.every((n, i) => i === 0 || n <= inputs[0] * 3)
console.log(`sessions distinct: ${distinct}  |  input_tokens not growing: ${notGrowing}`)
if (!distinct || !notGrowing) process.exitCode = 1
