// The two shapes every tool result takes.
//
// runTool answers {content, is_error} — the shape the conversation loop
// forwards to the model. Whether a tool call succeeded is a property of the
// answer, not an exception: the model reads is_error and corrects itself, so
// a missing file, a patch that would not apply, or a non-zero exit code are
// all outcomes, not throws. Nothing in lib/tools/ throws at the caller.

export const toolOk = (content) => ({ content: String(content ?? ""), is_error: false })

export const toolError = (content) => ({ content: String(content ?? ""), is_error: true })
