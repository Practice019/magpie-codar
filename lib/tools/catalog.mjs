// The registry: what the client sends, and which of it this plugin answers.
//
// Two sets matter, and they are different.
//
//   TOOL_DEFINITIONS  all 44, byte-identical to the capture. They are what the
//                     conversation forwards to the vendor, because the vendor
//                     compares the shape it receives; the generated file holds
//                     them and test/tools.test.mjs pins its sha256.
//
//   IMPLEMENTED       the nine this cut answers: read_file, write_file,
//                     edit_file, list_dir, apply_patch, now, exec, web_fetch,
//                     web_search. Everything else is a client-side capability —
//                     a marketplace, a literature library, a document
//                     converter, the researcher service — that this plugin has
//                     no endpoint for.
//
// An unimplemented call is answered, never thrown. The model sees
//   "<name>：本环境未实现（需要科搭客户端）"
// with is_error:false and goes on with what it has. Throwing, or answering with
// is_error:true, makes the model treat a missing capability as a broken call
// and retry it — which is how a turn burns itself out on a tool that will never
// work here.

import { TOOL_DEFINITIONS, TOOL_DEFINITIONS_SHA256 } from "./definitions.generated.mjs"
import { fileTool } from "./fs.mjs"
import { netTool } from "./net.mjs"
import { toolError, toolOk } from "./result.mjs"
import { execTool } from "./shell.mjs"

export { TOOL_DEFINITIONS, TOOL_DEFINITIONS_SHA256 }

// IMPLEMENTED is derived from the handlers, not listed twice: a name in it that
// has no handler would pass isImplemented and then crash in runTool.
const HANDLERS = { ...fileTool, ...netTool, exec: execTool }

export const IMPLEMENTED = new Set(Object.keys(HANDLERS))

const NAMES = new Set(TOOL_DEFINITIONS.map((entry) => entry.function.name))

// toolDefinitions answers the OpenAI tools array. only, when given, selects by
// name and keeps the capture's order — not the caller's — so two requests that
// select the same set are byte-identical and a response cannot be keyed on
// argument order.
export const toolDefinitions = ({ only } = {}) => {
  if (only === undefined) return TOOL_DEFINITIONS.map((entry) => structuredClone(entry))
  const wanted = new Set(Array.isArray(only) ? only : [only])
  return TOOL_DEFINITIONS.filter((entry) => wanted.has(entry.function.name)).map((entry) => structuredClone(entry))
}

export const isImplemented = (name) => IMPLEMENTED.has(name)

// unimplemented is the answer every un-implemented name gets.
export const unimplemented = (name) => toolOk(`${name}：本环境未实现（需要科搭客户端）`)

// runTool is the one entry the conversation loop calls. It never rejects: a
// handler that throws is a bug in this plugin, and a rejected promise there
// would end the turn instead of telling the model what happened.
export const runTool = async (name, args, ctx) => {
  const tool = String(name ?? "")
  if (!HANDLERS[tool]) {
    // A name outside the 44 as well as one inside: answering both the same way
    // means a mistyped tool name reads as "not here" rather than as a crash.
    return NAMES.has(tool) ? unimplemented(tool) : toolOk(`${tool}：本环境未实现（需要科搭客户端）`)
  }
  try {
    const result = await HANDLERS[tool](ctx ?? {}, args ?? {})
    if (!result || typeof result.content !== "string") {
      return toolError(`${tool}：内部错误——没有返回内容`)
    }
    return result
  } catch (error) {
    const message = error?.message ?? String(error)
    return toolError(`${tool}：执行出错（${error?.code ? `${error.code} ` : ""}${message}）`)
  }
}
