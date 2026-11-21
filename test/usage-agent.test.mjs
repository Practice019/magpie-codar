// The Agent pool is its own window.
//
// The vendor keeps two balances (measured 2026-11-21): /v1/gettoken answers
// {token: 500, agent_token: 1974} and /v1/agent/balance answers
// {data: {agent_balance: 1974}}. The points one pays for the web and document
// side; the agent one pays for the model calls this provider actually serves.
// Drawn only as text on the top line, the agent figure was no window — magpie
// read the account as "remaining allowance unknown", and the points figure (or
// a 0) was the only number on the card.
//
// Window naming follows magpie-plugins/UNIFIED-PLAN.md §1.1: `额度 · ` takes
// part in routing (a wallet: balance + unit, never used/limit), `停用 · ` is
// the only thing that makes the router skip an account, `说明 · ` is an aside
// that only explains.

import { test } from "node:test"
import assert from "node:assert/strict"

import { CodarPlugin } from "../index.mjs"
import { testables } from "../lib/internal.mjs"

// No test here may reach the vendor: the native transport is off, so a request
// that escapes withFetch meets this file's stub or fails, never the network.
testables.nativeFetch = null
testables.chatFetch = null
testables.switches.announceSignIn = false

const mkToken = (claims) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`
}
const TOKEN = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
const auth = async () => ({ type: "api", key: TOKEN })

// withFetch answers by path, as plugin.test.mjs's does: a route that is not
// named 404s, which is how "the second read never answered" is said here.
async function withFetch(routes, fn) {
  const real = globalThis.fetch
  assert.equal(testables.nativeFetch, null, "withFetch ran with the native transport enabled")
  const routesAt = Object.entries(routes).map(([key, answer]) => {
    const cut = key.indexOf(" ")
    const named = cut > 0 && /^[A-Z]+$/.test(key.slice(0, cut))
    return { method: named ? key.slice(0, cut) : "", url: named ? key.slice(cut + 1) : key, answer }
  })
  globalThis.fetch = async (url, init) => {
    const u = String(url instanceof Request ? url.url : url)
    const parsed = new URL(u)
    const method = String(init?.method ?? "GET").toUpperCase()
    for (const r of routesAt) {
      if (r.method && r.method !== method) continue
      const hit = r.url.startsWith("http") ? u === r.url : parsed.pathname === r.url
      if (!hit) continue
      if (typeof r.answer === "function") return r.answer(u, init)
      if (r.answer instanceof Response) return r.answer
      return new Response(JSON.stringify(r.answer.body ?? r.answer), { status: r.answer.status ?? 200, headers: { "Content-Type": "application/json" } })
    }
    return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 })
  }
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

// The vendor's live answers, as measured: two pools, the agent one feeding the
// models. Status and activities are named in most of these so the card is read
// whole rather than as a balance-only stub.
const live = (extra = {}) => ({
  "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 1974 } },
  "/v1/agent/balance": { body: { code: 200, message: "Success", data: { username: "user_1", agent_balance: 1974 } } },
  "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 3600 } } },
  "/api/codar/activities/mine": { body: { code: 200, data: [] } },
  ...extra,
})

const usage = (routes) => withFetch(routes, async () => (await CodarPlugin()).auth.usage(auth))
const named = (card, name) => (card.windows ?? []).find((w) => w.name === name)

test("1) agent_balance 1974 is its own 额度 · Agent 余额 window, as a number", async () => {
  const u = await usage(live())
  const win = named(u, "额度 · Agent 余额")
  assert.ok(win, `the agent pool has a window: ${JSON.stringify(u.windows?.map((w) => w.name))}`)
  assert.equal(win.balance, 1974, "the figure the vendor answered")
  assert.equal(typeof win.balance, "number", "a wallet reading is a number, not a string")
  assert.equal(win.unit, "点", "with its unit")
})

test("2) the agent window is a wallet: no used, no limit, and it is not aside", async () => {
  const u = await usage(live())
  const win = named(u, "额度 · Agent 余额")
  assert.equal("used" in win, false, "a wallet has no share to state")
  assert.equal("limit" in win, false, "and no total to take one of")
  assert.equal(win.aside, undefined, "it takes part in routing, so it cannot be set aside")
  assert.equal(typeof win.display, "string", "and it still has a line to draw")
})

test("3) the agent window is drawn before the points one", async () => {
  const u = await usage(live())
  const names = u.windows.map((w) => w.name)
  const agent = names.indexOf("额度 · Agent 余额")
  const points = names.indexOf("额度 · 点数余额")
  assert.ok(agent >= 0 && points >= 0, `both pools are drawn: ${JSON.stringify(names)}`)
  assert.ok(agent < points, `the pool the model calls spend comes first: ${JSON.stringify(names)}`)
})

test("4) the points window carries the 额度 · prefix", async () => {
  const u = await usage(live())
  assert.equal(named(u, "额度 · 点数余额").balance, 500, "the general figure is still its own window")
  assert.equal(named(u, "点数余额"), undefined, "and no bare window name is left")
})

test("5) the check-in row is 说明 · 每日签到, aside, with no used", async () => {
  const u = await usage(live())
  const row = named(u, "说明 · 每日签到")
  assert.ok(row, "the check-in row is drawn")
  assert.equal(row.aside, true, "aside: it explains, it does not route")
  assert.equal("used" in row, false, "a check-in is not a share of an allowance")
})

test("6) the top line names the agent pool when the account has one", async () => {
  const u = await usage(live())
  assert.equal(u.balance, "Agent 1974 点 可用", "one figure, and it is the pool the models spend")
})

test("7) an account without an agent figure says the points one, and draws only that window", async () => {
  const u = await usage({
    "/v1/gettoken": { body: { code: 200, token: 500 } },
    "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 3600 } } },
    "/api/codar/activities/mine": { body: { code: 200, data: [] } },
  })
  assert.equal(named(u, "额度 · Agent 余额"), undefined, "no agent figure, no agent window")
  assert.equal(named(u, "额度 · 点数余额").balance, 500, "the points window is the one drawn")
  assert.equal(u.balance, "500 点 可用", "and the top line is the points figure")
})

test("8) agent_balance 0 is still a window, and adds no 停用 · row", async () => {
  // A zero ranks the account last; it does not refuse it. `used: 100` is the
  // only thing that makes magpie skip an account (AGENTS.md §3).
  const u = await usage(live({
    "/v1/gettoken": { body: { code: 200, token: 0, agent_token: 0 } },
    "/v1/agent/balance": { body: { code: 200, data: { agent_balance: 0 } } },
  }))
  const win = named(u, "额度 · Agent 余额")
  assert.ok(win, "the window is there at zero")
  assert.equal(win.balance, 0, "with the zero the vendor answered")
  assert.equal(win.used, undefined, "and no full bar")
  assert.equal(u.windows.filter((w) => String(w.name).startsWith("停用 · ")).length, 0, "nothing is stopped")
})

test("9) every window name starts with 额度 · / 停用 · / 说明 ·", async () => {
  const u = await usage(live())
  const PREFIXES = ["额度 · ", "停用 · ", "说明 · "]
  assert.ok(u.windows.length >= 3, `the card has its rows: ${JSON.stringify(u.windows.map((w) => w.name))}`)
  for (const w of u.windows) {
    assert.ok(PREFIXES.some((p) => String(w.name).startsWith(p)), `a bare window name: ${JSON.stringify(w.name)}`)
  }
})

test("10) gettoken's agent_token still makes the window when the second read fails", async () => {
  const u = await usage(live({
    "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 1974 } },
    "/v1/agent/balance": { status: 500, body: { detail: "boom" } },
  }))
  assert.equal(u.error, undefined, "the first read answered, so the card is not an error")
  assert.equal(named(u, "额度 · Agent 余额").balance, 1974, "the figure the first read gave")
  assert.equal(named(u, "额度 · 点数余额").balance, 500)
})

test("11) both balance reads failing is one 说明 · 额度不可读 row, never a top-level error", async () => {
  // A top-level error replaces the whole window area on magpie's card
  // (AGENTS.md, costliest pit #3), so the rows that did read would be lost.
  const u = await usage({
    "/v1/gettoken": { status: 500, body: { detail: "boom" } },
    "/v1/agent/balance": { status: 500, body: { detail: "also boom" } },
  })
  assert.equal(u.error, undefined, "no top-level error")
  assert.deepEqual(u.windows.map((w) => w.name), ["说明 · 额度不可读"], "one row, and it says what happened")
  assert.equal(u.windows[0].aside, true, "aside: it explains, it does not route")
  assert.match(u.windows[0].display, /boom/, "with the vendor's own words")
  assert.equal(u.balance, "", "and no figure is invented")
})

test("12) a numeric string from the vendor still reads as the number it says", async () => {
  const u = await usage(live({
    "/v1/gettoken": { body: { code: 200, token: "500", agent_token: "1974" } },
  }))
  assert.equal(named(u, "额度 · Agent 余额").balance, 1974)
  assert.equal(named(u, "额度 · 点数余额").balance, 500)
})
