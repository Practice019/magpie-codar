// T-50 acceptance: which TLS stack a chat leaves on, and what the proxy carries.
//
// Runs in its own process, so nothing it does touches a running magpie: it
// imports the plugin, asks the loader for the transport it would hand the host,
// and makes two requests — one chat (a credential that is currently refused,
// which is a 403 the vendor states, not a transport failure) and the catalog
// (which must come back 200 through the proxy, byte for byte in size).
//
//   node scripts/acceptance-transport.mjs
//
// What it prints is the report: the header both roads write, the status each
// request answered, and the size of the catalog the proxy carried.

import { TRANSPORT_HEADER, carriedBy } from "../lib/direct.mjs"
import { binaryPath, chatFetch, closeProxy, disabled, proxy } from "../lib/native.mjs"
import { CodarPlugin } from "../index.mjs"
import { MAX_ANSWER_BYTES } from "../lib/internal.mjs"

// TOKEN is whatever the account's credential is at the time of the run, passed
// in the environment so no credential is written down in the tree.
const TOKEN = String(process.env.CODAR_TEST_TOKEN ?? "").trim()
const API = "https://api.claw.speedai.com"
const CHAT = `${API}/v1/chat/completions`

const line = (k, v) => console.log(`${k}: ${v}`)

const say = (label, answer) => {
  line(`${label}.status`, answer?.status)
  line(`${label}.${TRANSPORT_HEADER}`, answer?.headers?.get?.(TRANSPORT_HEADER) ?? "(absent)")
  line(`${label}.content-type`, answer?.headers?.get?.("content-type") ?? "(absent)")
}

line("node", process.version)
line("CODAR_PLUGIN_DISABLE_NATIVE", disabled() ? "1 (proxy off)" : "0")
line("binaryPath", binaryPath())

// ── 1. the proxy itself ─────────────────────────────────────────────────────

let running = null
try {
  running = await proxy()
} catch (e) {
  line("proxy.start", `threw: ${e?.message}`)
}
line("proxy.address", running?.info?.address ?? "(none)")
line("proxy.transport", running?.info?.transport ?? "(none)")
line("proxy.token", running?.info?.token ? "(present)" : "(none)")

// ── 2. the catalog through the proxy (a 200 is the point) ────────────────────

try {
  const catalog = await chatFetch(`${API}/v1/codar/models`, { method: "GET", stream: false, maxBytes: MAX_ANSWER_BYTES })
  say("catalog", catalog)
  line("catalog.carriedBy", carriedBy(catalog))
  const text = await catalog.text()
  line("catalog.bytes", Buffer.byteLength(text, "utf8"))
} catch (e) {
  line("catalog.error", `${e?.name}: ${e?.message}`)
}

// ── 3. a chat through the loader's own transport ─────────────────────────────

// chatBody is one non-streamed conversation: a 403 or a 401 is the vendor
// answering, which is the point — the transport still has to say which stack
// carried it, and a refusal is where that is easiest to read.
const chatBody = JSON.stringify({
  model: "deepseek-v4.1-flash",
  messages: [
    { role: "system", content: "T-50 验收：transport 头检查。" },
    { role: "user", content: "ping" },
  ],
  stream: false,
})

if (!TOKEN) {
  line("chat(loader)", "skipped: CODAR_TEST_TOKEN is not set")
} else {
  const plugin = await CodarPlugin({})
  const key = (await plugin.auth.loader(async () => ({ type: "api", key: TOKEN })))?.fetch
  try {
    const answer = await key(CHAT, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: chatBody })
    say("chat(loader)", answer)
    line("chat(loader).carriedBy", carriedBy(answer))
    const said = await answer.text()
    line("chat(loader).bytes", Buffer.byteLength(said, "utf8"))
    line("chat(loader).said", said.slice(0, 240).replace(/\s+/g, " "))
  } catch (e) {
    line("chat(loader).error", `${e?.name}: ${e?.message}`)
  }
  // The same conversation asked of the transport directly, which is where the
  // stream flag and the stamp are decided.
  try {
    const answer = await chatFetch(CHAT, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: chatBody,
      stream: false,
    })
    say("chat(chatFetch)", answer)
    line("chat(chatFetch).carriedBy", carriedBy(answer))
    const said = await answer.text()
    line("chat(chatFetch).bytes", Buffer.byteLength(said, "utf8"))
    line("chat(chatFetch).said", said.slice(0, 240).replace(/\s+/g, " "))
  } catch (e) {
    line("chat(chatFetch).error", `${e?.name}: ${e?.message}`)
  }
}

await closeProxy()
line("done", "proxy closed")
