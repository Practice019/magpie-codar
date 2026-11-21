// The name map: which of the client's 44 names is a host's name for the same
// capability, and back again.
//
// The map is the whole crossing between the two tool tables, so it is tested for
// what it decides: the first name the host offered wins, an unmapped codar name
// has no host name at all, and the reverse map answers a name that the forward
// map can only resolve. The map's own coverage is pinned too — a name the client
// sends but the map does not name would be a capability the host is never told
// about, and one of the nine the map names but the client does not send would be
// a mapping nothing can ever match.

import assert from "node:assert/strict"
import { test } from "node:test"

import { CODAR_TO_CALLER, callerNameOf, codarNameOf } from "../lib/tool-map.mjs"
import { IMPLEMENTED, TOOL_DEFINITIONS } from "../lib/tools/index.mjs"

const NAMES = new Set(TOOL_DEFINITIONS.map((entry) => entry.function.name))

test("callerNameOf answers the host's name for read_file", () => {
  assert.equal(callerNameOf("read_file", new Set(["read"])), "read")
})

test("callerNameOf answers the host's name for exec", () => {
  assert.equal(callerNameOf("exec", new Set(["pwsh"])), "pwsh")
})

test("callerNameOf answers the only host name there is, even when the list is longer", () => {
  // The list's own order decides when the host offers several; here it offers one.
  assert.equal(callerNameOf("exec", new Set(["bash"])), "bash")
})

test("callerNameOf takes the first candidate the host actually offered", () => {
  // `pwsh` is listed before `bash`: a host that declares both gets `pwsh`.
  assert.equal(callerNameOf("exec", new Set(["bash", "pwsh"])), "pwsh")
  // The same name elsewhere in the list is not a second match.
  assert.equal(callerNameOf("now", new Set(["now"])), "now")
})

test("an unmapped codar name has no host name", () => {
  assert.equal(callerNameOf("literature_get_paper", new Set(["read", "pwsh", "search", "literature_get_paper"])), "")
})

test("codarNameOf answers the codar name behind a host name", () => {
  assert.equal(codarNameOf("read"), "read_file")
  assert.equal(codarNameOf("glob"), "list_dir")
  assert.equal(codarNameOf("search"), "web_search")
  assert.equal(codarNameOf("pwsh"), "exec")
})

test("codarNameOf answers nothing for a name that is not one of the nine", () => {
  assert.equal(codarNameOf("unknown_tool"), "")
  assert.equal(codarNameOf(""), "")
})

test("an ambiguous host name answers the first codar tool that claims it", () => {
  // `edit` is a name for both edit_file and apply_patch. The forward map is
  // unambiguous (the host is asked which of the nine it offered); the reverse is
  // the fallback for a name the ledger cannot recover, and the table's order is
  // what it resolves to.
  assert.equal(codarNameOf("edit"), "edit_file")
  assert.equal(codarNameOf("patch"), "edit_file")
})

test("both codar names that share a host name resolve to that one name", () => {
  // edit_file lists `edit` first and apply_patch lists it first too: a host with a
  // single `edit` is sent both of the client's editing tools under that name.
  assert.equal(callerNameOf("edit_file", new Set(["edit"])), "edit")
  assert.equal(callerNameOf("apply_patch", new Set(["edit"])), "edit")
})

test("callerNameOf accepts the caller's list in its array shape as well", () => {
  assert.equal(callerNameOf("write_file", ["write", "read"]), "write")
  assert.equal(callerNameOf("write_file", []), "")
})

test("every mapping names tools the client sends", () => {
  const mapped = Object.keys(CODAR_TO_CALLER)
  assert.ok(mapped.length >= 9, `the map covers ${mapped.length} of the nine`)
  for (const name of mapped) {
    assert.ok(NAMES.has(name), `${name} is not one of the 44 the client sends`)
    assert.ok(Array.isArray(CODAR_TO_CALLER[name]) && CODAR_TO_CALLER[name].length > 0, `${name} has no candidates`)
    for (const candidate of CODAR_TO_CALLER[name]) assert.equal(typeof candidate, "string", `${name}'s candidate is not a string`)
  }
})

test("every implemented tool has a mapping, and nothing is mapped that was not sent", () => {
  const missing = [...IMPLEMENTED].filter((name) => !Object.prototype.hasOwnProperty.call(CODAR_TO_CALLER, name))
  assert.deepEqual(missing, [], "an implemented tool the map does not name can never be renamed")
  // Every mapped name is one of the client's 44, not a name this plugin invented.
  assert.equal(Object.keys(CODAR_TO_CALLER).every((name) => NAMES.has(name)), true)
})
