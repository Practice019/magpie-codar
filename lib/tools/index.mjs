// The local tool layer as one import.
//
// lib/tools/ answers tool calls without the client: the 44 definitions the
// conversation must forward byte-for-byte, and local implementations for the
// nine that need nothing more than this machine. Wiring it into a turn is the
// next cut (lib/serve.mjs still bridges to codar.exe serve); until then this
// module is only imported by its tests.
//
//   import { runTool } from "../lib/tools/index.mjs"
//   await runTool("list_dir", { path: "." }, { workspace, signal, timeoutMs, sessionId })

export { IMPLEMENTED, TOOL_DEFINITIONS, TOOL_DEFINITIONS_SHA256, isImplemented, runTool, toolDefinitions, unimplemented } from "./catalog.mjs"
export { nowSentence, stampFor, cstFields } from "./clock.mjs"
export { htmlToText, decodeEntities } from "./net.mjs"
export { containsDotDot, resolvePath } from "./paths.mjs"
export { toolError, toolOk } from "./result.mjs"
