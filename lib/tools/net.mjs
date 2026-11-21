// The two network tools, and what this environment honestly has.
//
// In the client, both go through SpeedAI's researcher service: web_fetch
// returns a page as markdown, web_search returns structured hits with page
// content, and each call charges the signed-in user's points. Neither backend
// is reachable from this plugin — there is no researcher endpoint in the
// provider API, and inventing one would be the "make up the capability" failure
// the project's rules call out. So the split is:
//
//   web_fetch   a plain HTTP GET under the caller's own control, HTML reduced
//               to text. It answers for a URL that is readable, and when it is
//               not it says which stage failed (no transport configured, DNS,
//               TLS, non-2xx) instead of returning an empty page — an empty
//               body is exactly what a reader would misread as "the page is
//               empty". is_error stays false: no network is a property of the
//               environment, not a mistake in the call, and the model has to be
//               able to go on and say "this link could not be confirmed".
//
//   web_search  says "未配置搜索后端". Not "no results": those are different
//               facts, and the second one would make the model report that
//               nothing exists.

import { toolError, toolOk } from "./result.mjs"
import { clipWithNote, headAndTail, saveWhole } from "./truncate.mjs"

const DEFAULT_MAX_CHARS = 1000000
const SAVE_BYTES = 50000

// htmlToText reduces a page to its readable text: comments, script, style and
// head removed; block-level tags become line breaks; inline tags vanish; the
// five named entities and numeric references decoded. It is not a renderer —
// the client's markdown conversion stays in the client — but a page turned into
// text has to keep its line structure, or a table or a list becomes one run-on
// paragraph the model will quote incorrectly.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", middot: "·", times: "×" }

export const decodeEntities = (text) =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })

export const htmlToText = (html) => {
  if (typeof html !== "string" || html === "") return ""
  let text = html
  text = text.replace(/<!--[\s\S]*?-->/g, "")
  text = text.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
  text = text.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/header|\/footer|\/blockquote|\/pre|\/table)[^>]*>/gi, "\n")
  text = text.replace(/<li\b[^>]*>/gi, "\n• ")
  text = text.replace(/<h([1-6])\b[^>]*>/gi, "\n")
  text = text.replace(/<[^>]+>/g, "")
  text = decodeEntities(text)
  text = text.replace(/[ \t\f\v\u00a0]+/g, " ")
  text = text.split("\n").map((line) => line.trim()).join("\n")
  return text.replace(/\n{3,}/g, "\n\n").trim()
}

const contentType = (headers, url) => {
  const type = headers?.get?.("content-type") ?? ""
  if (/text\/html|application\/xhtml/i.test(type)) return "html"
  if (/text\/|xml|json|javascript/i.test(type)) return "text"
  if (type) return "other"
  return /\.html?($|\?)/i.test(url) ? "html" : "text"
}

// transport is the fetch this module will use: the caller's own when a
// conversation supplies one (fetchImpl in ctx), the global fetch otherwise.
// Tests inject theirs so that no test can reach the real network.
const transport = (ctx) => (typeof ctx?.fetchImpl === "function" ? ctx.fetchImpl : typeof fetch === "function" ? fetch : null)

export const webFetch = async (ctx, args) => {
  const url = typeof args?.url === "string" ? args.url.trim() : ""
  if (url === "") return toolError("缺少 url：web_fetch 需要 http:// 或 https:// 地址")
  if (!/^https?:\/\//i.test(url)) return toolError(`web_fetch 只接受 http/https 地址：${url}`)

  const send = transport(ctx)
  if (!send) {
    return toolOk("本环境未配置网络取用（没有可用的 fetch），web_fetch 取不到网页正文。请改用其它来源，或让用户提供页面内容。")
  }

  let response
  try {
    response = await send(url, { redirect: "follow", signal: ctx?.signal, headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" } })
  } catch (error) {
    const reason = error?.cause?.code ?? error?.code ?? error?.name ?? ""
    return toolOk(`web_fetch 取不到 ${url}（${reason || error?.message}）：这一步失败了，链接未确认可达。`)
  }

  if (!response || !response.ok) {
    return toolOk(`web_fetch 取不到 ${url}：HTTP ${response?.status ?? "无响应"}。链接未确认可达。`)
  }

  let raw
  try {
    raw = await response.text()
  } catch (error) {
    return toolOk(`web_fetch 取到响应但读不出正文：${url}（${error?.message ?? String(error)}）`)
  }

  const kind = contentType(response.headers, url)
  if (kind === "other") {
    const type = response.headers?.get?.("content-type") ?? "未知类型"
    return toolOk(`web_fetch 取到的是二进制内容（${type}），不当作正文显示：${url}`)
  }

  const body = kind === "html" ? htmlToText(raw) : raw.trim()
  if (body === "") return toolOk(`web_fetch 取到 ${url}，但正文为空。正文为空本身不能证明被反爬拦截。`)

  const pointer = Buffer.byteLength(raw, "utf8") > SAVE_BYTES ? saveWhole(ctx, "web-fetch", body) : null
  const shown = pointer ? headAndTail(body, { pointer }) : body
  const maxChars = Number(args?.max_chars)
  const clipped = Number.isFinite(maxChars) && maxChars > 0 ? clipWithNote(shown, Math.trunc(maxChars)) : shown

  const header = pointer
    ? `来源：${url}\n正文共 ${Buffer.byteLength(body, "utf8")} 字节、${body.split("\n").length} 行，已保存到 ${pointer.path}\n\n`
    : `来源：${url}\n\n`
  return toolOk(header + clipped)
}

const SEARCH_BACKEND_NOTE =
  "本环境未配置搜索后端：web_search 需要 SpeedAI 检索服务，本插件没有它的端点，也不能凭空造一份结果。" +
  "请改用 web_fetch 直接取已知地址，或让用户提供具体链接；不要因为这条说明就断定网上没有相关资料。"

export const webSearch = (ctx, args) => {
  const query = typeof args?.query === "string" ? args.query.trim() : ""
  const pages = Number(args?.num_pages ?? 1)
  const note = query === "" ? SEARCH_BACKEND_NOTE : `${SEARCH_BACKEND_NOTE}\n（本次查询词：${query}${Number.isFinite(pages) && pages > 1 ? `，请求了 ${pages} 页` : ""}）`
  return toolOk(note)
}

export const netTool = { web_fetch: webFetch, web_search: webSearch }
