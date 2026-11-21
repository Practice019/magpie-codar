// Which of the client's 44 tool names is, on a given host, the tool the model
// should have called instead.
//
// The problem this table answers. The gateway accepts one tool table and only
// one — its own client's 44, byte for byte, measured 2026-11-21 on a real
// account: a prefixed body with the 44 answers 200, the same body with a single
// tool of the host's own answers 403 client_not_supported, and so does a body
// with only one of the 44. So the table that leaves this plugin is always the
// client's. The names that come back, though, are the only names the model can
// say, and the host (DSH) can only execute its own tools: `read`, `pwsh`,
// `edit`, `glob`. A `read_file` handed to DSH is a missing tool, not a call.
//
// So the two sides are bridged by name and by nothing else. The plugin never
// runs a tool: it accepts the client's table going out, and it renames the calls
// coming back to whatever the host calls that capability — one name for one
// name, arguments and ids untouched.
//
// The right-hand lists are ordered by preference and written as alternatives
// because a host's vocabulary is not this plugin's to decide: DSH says `read`,
// an OpenAI-compatible client might say `read_file`, a Claude-shaped one
// `Read`. The first name the host actually offered wins (callerNameOf), and a
// codar name with no entry here (35 of the 44: the marketplace, the literature
// library, the document converter, image generation) is passed through
// unchanged. A call to one of those reaches a host that does not have it: the
// host refuses a tool it never declared, which is a visible failure at the turn
// that made the call, and that is the honest outcome — inventing a mapping for
// `literature_get_paper` would be inventing a tool.
export const CODAR_TO_CALLER = {
  read_file: ["read", "Read", "read_file", "readFile", "cat", "view"],
  write_file: ["write", "Write", "write_file", "writeFile", "create_file"],
  edit_file: ["edit", "Edit", "edit_file", "str_replace", "str_replace_editor", "patch"],
  apply_patch: ["edit", "Edit", "apply_patch", "patch", "str_replace"],
  list_dir: ["glob", "list_dir", "ls", "list", "List", "find_files"],
  exec: ["pwsh", "bash", "shell", "exec", "run", "terminal", "execute"],
  now: ["now", "date", "get_time", "current_time"],
  web_fetch: ["web_fetch", "fetch", "Fetch", "http_get"],
  web_search: ["web_search", "search", "Search", "websearch"],
}

// hasName reads the host's own tool list, whichever shape it arrived in. A Set
// is what the transport keeps (namesOf answers one); an array is what a test or
// a caller with one request in hand passes. Anything else has no names, and a
// name looked up in it is not found.
const hasName = (callerNames) => {
  if (callerNames instanceof Set) return (name) => callerNames.has(name)
  if (Array.isArray(callerNames)) {
    const offered = new Set(callerNames.filter((name) => typeof name === "string"))
    return (name) => offered.has(name)
  }
  return () => false
}

// callerNameOf is the host's name for a codar tool, or "" when there is none.
//
// "" is not "use the codar name": the caller decides that, and it does so by
// leaving the name alone. Returning the codar name here would make "mapped
// nothing" and "mapped to the same string" one answer, and the two need
// different handling in the response rewrite (one keeps the name, the other has
// nothing to keep).
export function callerNameOf(codarName, callerNames) {
  const name = typeof codarName === "string" ? codarName : ""
  const candidates = CODAR_TO_CALLER[name]
  if (!candidates) return ""
  const offered = hasName(callerNames)
  for (const candidate of candidates) if (offered(candidate)) return candidate
  return ""
}

// CALLER_TO_CODAR is callerNameOf read backwards. Where two codar tools answer
// to one host name — `edit` is both edit_file and apply_patch — the first entry
// in CODAR_TO_CALLER wins, and that is the one the reverse answers. It is only a
// fallback: the exact name is remembered per tool_call_id while the turn is in
// flight (lib/tool-rename.mjs), so the ambiguous case is resolved by what was
// actually sent rather than by this table's order.
const CALLER_TO_CODAR = new Map()
for (const [codar, callers] of Object.entries(CODAR_TO_CALLER)) {
  for (const caller of callers) if (!CALLER_TO_CODAR.has(caller)) CALLER_TO_CODAR.set(caller, codar)
}

// codarNameOf is the codar name a host name stands for, or "" when the name is
// not one of the nine. A tool message carrying an unknown name belongs to a tool
// this plugin never sent, and leaving it alone is the only answer that does not
// invent a second name for it.
export function codarNameOf(callerName) {
  const name = typeof callerName === "string" ? callerName : ""
  return CALLER_TO_CODAR.get(name) ?? ""
}
