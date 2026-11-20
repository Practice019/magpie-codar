// The model list, read from the app's own server and nothing else.
//
// What the server states (measured 2026-11-21, codar.exe serve on 8080):
//
//   GET /api/desktop/settings  → provider.speedai.model ("auto"), and the same
//                                field inside provider.provider_profiles.speedai
//   GET /api/health            → {"model":"auto","provider_configured":true,…}
//   GET /api/models, /api/desktop/models, /api/provider/models,
//        /api/runtime/status  → 405 Method Not Allowed (measured for both GET
//                                and POST): there is no model-list route at all
//
// So this is what the provider lists: the account's embedded catalog
// (lib/catalog.mjs — the vendor's own answer to GET /v1/codar/models, kept by
// scripts/catalog.mjs), plus the one model the server itself names when the
// catalog does not carry it (a vendor adds a model before this plugin is
// regenerated). The server's fields are the live statement about the account;
// the catalog is the list of what the account can pick.
//
// An unreachable server is not an error here: the embedded catalog is exactly
// what the plugin serves at start-up, and replacing a list that came from the
// last good answer with nothing over one silent port would empty the picker. The
// answer says which of the two it is (`reached`), so the caller can mark it.
//
// The records are built with internal.mjs's modelOf, not a second copy of it: the
// shape a model has to reach magpie in (provider.npm per protocol, api.url, the
// capability fields both hooks read) is that function's contract, and a list
// built beside it would drift from the one the live refresh returns.

import { MAX_MODELS, modelOf, modelsOf, noMagicKeys } from "./internal.mjs"
import { CATALOG } from "./catalog.mjs"
import { serveBase } from "./serve.mjs"

// modelsFromServe answers the model table for the server at `port`, with `api`
// as the provider's own address (a user's own base is kept). `reached` is false
// when the server did not answer, in which case the table is the catalog alone.
export async function modelsFromServe({ port, api, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 1500 } = {}) {
  const model = await servedModel(port, { fetchImpl, timeoutMs })
  // The catalog through the same road the live refresh uses (modelsOf over the
  // catalog, with the provider's address), then the server's own model added
  // when the catalog does not carry it.
  const table = modelsOf(CATALOG.slice(0, MAX_MODELS), api)
  if (model && !table[model]) {
    // A model the catalog does not carry: the account is set to it, so it is a
    // model the person can pick. The server states nothing about it beyond its
    // name — no context window, no protocol — so it is listed with what is
    // certain and nothing invented: a chat-completions model that takes text
    // and images, as `auto` does. The protocol is the app's own default for a
    // model it routes itself (provider.api_type is "openai" in the same
    // settings payload), which is why this is a reading rather than a guess.
    table[model] = modelOf({ id: model, name: model, context: 0, maxOutput: 0, input: ["text", "image"], output: ["text"], protocol: "openai_chat_completions", reasoning: true }, api)
  }
  return { models: noMagicKeys(table), model: model ?? "", reached: Boolean(model) }
}

// servedModel asks the server which model it is set to, from the two routes that
// state one. `null` is "no server" — a refusal, a timeout, and a body with no
// model field are one answer here, because the caller's fallback is the embedded
// catalog either way. The settings route is asked first: it is the one the
// readiness probe already reads, so on a warm server it is the answer that is
// already in hand.
export async function servedModel(port, { fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 1500 } = {}) {
  const base = serveBase(port)
  const get = async (path) => {
    const res = await fetchImpl(`${base}${path}`, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res?.ok) return null
    return await res.json()
  }
  try {
    const settings = await get("/api/desktop/settings")
    const provider = settings?.provider && typeof settings.provider === "object" ? settings.provider : {}
    // The profile is named when the payload names one; otherwise the account's
    // own (speedai) is where the app keeps its model today.
    const profile = provider.provider_profiles && typeof provider.provider_profiles === "object" ? provider.provider_profiles[provider.active_profile ?? "speedai"] : null
    const said = [provider.model, profile?.model, settings?.settings?.default_model].find((v) => typeof v === "string" && v.trim())
    if (said) return said.trim()
    const health = await get("/api/health")
    return typeof health?.model === "string" && health.model.trim() ? health.model.trim() : null
  } catch {
    return null
  }
}
