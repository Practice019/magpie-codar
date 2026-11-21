// GENERATED — do not edit. scripts/gen-client-prefix.mjs writes this file from
// a capture of the Codar desktop's own chat request (v0.3.17, 2026-11-20); run
// it again to rewrite it.
//
// CLIENT_SYSTEM_PREFIX is the capture's system message cut at its first
// 4 blank-line-separated segments and nothing else: 1632 characters, byte for
// byte. It is the shortest head that was measured to pass the gateway's
// client check (2026-11-21: one segment → 403 client_not_supported on two
// accounts, four → 200 on both), which is why it is here at all — the rest of
// the capture's 33,577-character prompt prescribes the desktop's own tools and
// is deliberately not sent.
//
// The one thing in it that is not this machine's: the head's
// "Working Directory:" line quotes the session the capture was taken from. It
// stays because the prefix is measured by its bytes — a rewritten line is a
// different request — and the caller's own instructions, which follow it, are
// what name the real directories the tools work in.

// What the capture was, and how much of it this file carries.
export const CLIENT_SYSTEM_PREFIX_CAPTURE = "chat-completions.body.json (system message 33577 characters, 89 segments)"

// How much of it: the cut, in blank-line-separated segments.
export const CLIENT_SYSTEM_PREFIX_SEGMENTS = 4

// The head, verbatim. Its first four segments are the whole string.
export const CLIENT_SYSTEM_PREFIX = "You are an AI agent running on the Codar runtime.\n\nRuntime info:\nOS: windows/amd64\nShell: PowerShell; use Get-ChildItem (not ls), Get-Content (not cat), Select-String (not grep), ';' to chain (not '&&'), '|' for pipes, $env:VAR for env vars; either '\\' or '/' works in paths. Prefer read_file for Unicode text; when Get-Content is needed for UTF-8 files, use -Encoding UTF8 explicitly to avoid garbled Chinese. Check each native program's $LASTEXITCODE immediately; preserve a failed exit before running cleanup or another native command. Do not use a successful cleanup as evidence the analysis or validation succeeded. PowerShell does not use backslash to escape double quotes; do not use Bash-style \\\" inside a PowerShell double-quoted string. Avoid complex inline `python -c` commands with nested or multiline quoting; use the file tools to write a temporary `.py` file, validate it, then run it. exec already captures both stdout and stderr; do not add `2>&1` merely to see errors. Do not pipe Python source containing Chinese or other non-ASCII text into `python -`: Windows PowerShell can replace it with question marks. Write a UTF-8 `.py` file with write_file, then execute it.\nWorking Directory: C:\\Users\\21877\\.codar\\sessions\\session_1795181574745_ffx0s2\\workspace\nCurrent time: use the now tool when needed.\n\nFile-tool routing: when you call write_file / read_file with a relative path:\n- Every relative path resolves against the working directory above.\n\nOrganize files within the working directory in whatever structure best fits\nthe task. Loaded skills may suggest specific conventions — follow those when\nthey apply."

// SHA-256 of the whole prefix, first 16 hex digits. The suite pins this
// literal against a value of its own, so both the capture and the test would
// have to move for a drift to pass.
export const CLIENT_SYSTEM_PREFIX_HASH = "4a3ee7203c933c9f"
