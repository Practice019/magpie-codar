// The local tool layer as one import.
//
// lib/tools/ answers tool calls without the client: the 44 definitions the
// conversation forwards byte-for-byte, and local implementations for the nine
// that need nothing more than this machine. The conversation uses the
// definitions — they are the table the vendor accepts, and lib/tool-rename.mjs
// renames the calls that come back for the host to run. The handlers are the
// half of this layer a turn does not go through: the plugin executes nothing, so
// runTool is here for its own tests and for a caller that asks for it, and no
// transport path imports it.
//
//   import { runTool } from "../lib/tools/index.mjs"
//   await runTool("list_dir", { path: "." }, { workspace, signal, timeoutMs, sessionId })

export { IMPLEMENTED, TOOL_DEFINITIONS, TOOL_DEFINITIONS_SHA256, isImplemented, runTool, toolDefinitions, unimplemented } from "./catalog.mjs"
export { nowSentence, stampFor, cstFields } from "./clock.mjs"
export { htmlToText, decodeEntities } from "./net.mjs"
export { containsDotDot, resolvePath } from "./paths.mjs"
export { toolError, toolOk } from "./result.mjs"
