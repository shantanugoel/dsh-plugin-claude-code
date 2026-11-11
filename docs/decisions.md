# Design decisions

## D1. Use a persistent official Agent SDK session

Decision: use the TypeScript SDK to run the installed official Claude binary.
Keep one process for each dsh session generation. Use an MCP handler that waits
for dsh's result. Do not use a fresh imported transcript for each model step.

Reason: the saved direct-CLI test retained native signed thinking at a tool
boundary. The article found imported thinking was removed. The ownership model
is supported by these measurements. The SDK implementation still needs its own
test. Direct `claude -p` was useful for measurement; it was not shown to be a
better production transport.

If the SDK lacks a necessary control, first record the exact limitation and a
minimal test. Direct CLI control can then be considered without changing session
ownership. Do not silently switch transports after a failed live request.

## D2. Preserve the signed session or refuse continuation

Decision: an earlier input change invalidates the generation. Use a recorded new
context at a balanced tool boundary. Do not strip thinking and report success.

Reason: signatures are bound to the earlier input under the project requirement.
A local content hash only detects a difference. It cannot repair the signature.

## D3. Keep dsh in control of tools and context

Decision: dsh alone executes tools and approves their operations. Pass its prompt
and exact tool schemas through the supported SDK/MCP interfaces. Set a separate
workspace for each native session. Record required Claude-added context.

Reason: a model adapter must not create a second tool or approval pipeline.

## D4. Keep strict spend checks mandatory

Decision: reject paid billing routes before model input. Require a guard that
prevents paid overflow. With no such guard, return `BILLING_GUARD_UNAVAILABLE`.

Reason: a response event that reports overage can arrive after a charge. A user
assertion, a prompt identity change, or a zero cost estimate is not a spend guard.

Revision on 2026-11-10: the user changed this requirement. A lock that keeps
extra usage off for the whole session is useful. It is not required. Production
may send a prompt after a first-party subscription login. The absence of the
lock is not `BILLING_GUARD_UNAVAILABLE`. There is no `allowPaidUsage` switch.
An API key, a console login, and a changed billing endpoint stay refused.

## D5. Separate evidence from fixtures

Decision: commit a summary of the private live capture and a synthetic fixture
for the offline checker. Keep raw captures and machine-specific paths out of Git.

Reason: another agent must be able to run the checker without access to the
original account, private log, or temporary directory. A synthetic fixture does
not become live evidence when the checker passes.

## Open questions and required measurements

- Which exact SDK version works with the selected official CLI and minimum dsh?
- Can that SDK publish the complete response and every parallel call before any
  MCP result is released, including handlers that arrive one at a time?
- Which supported diagnostics preserve complete thinking and signatures? Do not
  treat redacted, missing, or truncated data as a successful audit.
- Which launch controls remove executable hidden tools and unwanted reminders?
- Which dsh integration can log a full context replacement and gate a workspace
  change before the model request? Do not invent a lifecycle hook.
- Is there an official, nonbillable way to establish a binding no-overage policy?
  On 2026-11-10 the user made that lock optional. It no longer blocks a prompt.
  Auth status is still not that proof. The offline tests use synthetic status
  and do not run the installed Claude binary.
- Can native resume preserve an interrupted tool turn without rewriting its
  bound input? This is outside the first release until measured.

Fresh-worker replay, relay insertion, native resume, and ACP are not marked
impossible. This plan selects one path. Record evidence before closing another.

## D6. Pin the Agent SDK from its published declarations

Decision: pin `@anthropic-ai/claude-agent-sdk` at `0.3.322`. On 2026-11-10 this
is the newest published version. Its `sdk.d.ts` file declares the executable
path, a streaming input queue, event iteration, MCP server setup, `close`, and
`supportedModels`.

Reason: the plugin needs one pinned SDK before the session loop exists. The
check reads the declaration file. It does not start the SDK. The SDK package
version is not the Claude CLI version. Production code does not import the SDK
while the spend guard is unavailable.

Evidence: [compatibility.md](compatibility.md), reviewed 2026-11-10. The saved
CLI measurement remains Claude Code 2.1.319. That pair is not certified.

## D7. Build the SDK launch plan without starting the SDK

Decision: the offline launch plan describes one query, one event consumer, and
one streaming input queue. Production `start` still returns
`BILLING_GUARD_UNAVAILABLE` before it imports the SDK.

Reason: M3 needs the session configuration on record. The spend guard is still
absent, so a live query would be a model request without a pre-inference block.
The scripted runtime checks the plan and keeps the session open after a tool
finish. A declaration check confirms the pinned SDK still names the options.
That check is not a measurement that the CLI applies those options.

## D8. Bind the dsh assistant id after publication

Decision: the adapter stores the emitted blocks and the response replay
envelope. The next request must contain that publication before a tool result
is released. The dsh message id is bound from that request. A changed prefix
returns `REBASE_REQUIRED`. A changed publication returns `REPLAY_STATE_INVALID`.

Reason: the adapter does not allocate the next dsh assistant id. A local hash
detects a difference. It does not repair a signature. The scripted tests use
synthetic signatures. They do not show that Anthropic accepted a signature.

## D9. Use the session header as the workspace

Decision: the native session workspace is `Session.header.cwd` from dsh
0.2.2-rc.1. A context import uses `surfaceOp: replace` on the conversation
after the leading system message, then `sessions.flush`. An open tool call
returns `REBASE_REQUIRED` before the log changes.

Reason: the header field is the session's absolute creation workspace. The
filesystem `cwd` is a shared relative-path base. The agent inbox is private,
so a mid-tool user message is refused. `sessions.flush` reports whether a
durability listener ran. A true result is required before the native
generation closes. This measurement uses the published packages. It does not
show a live Claude process.

## D10. Hide the catalog until the spend guard exists

Decision: `prepareCall` captures the configuration generation and refuses
dispatch after that generation changes. `listModels` calls the official SDK
`supportedModels()` once, without sending a user prompt, and keeps that list.
Each row uses the official `value` as the dsh model id. The same list is the
main-model list and the subagent-model list.

Reason: dsh shows a model only when the route lists it. A subagent session
uses that same route and its own dsh session. The discovery process starts
Claude and closes it before a user message is sent. A failed read leaves the
list empty until a short retry interval passes.

## D11. Keep compiled output out of git

Decision: do not commit `dist/`. Do not add a `prepare` or `postinstall` script.

Reason: the user installed `github:shantanugoel/dsh-plugin-claude-code` and
asked to remove the compiled tree. The desktop lock resolved commit `3a48335`,
which contained `dist/`. Later commits leave that directory out of git.

Status: replaced by D20 on 2026-11-11. The Git tree still does not contain
`dist/`. D20 changes when the build runs.

## D12. Ignore folded tool history

Decision: do not refuse `GenerateOptions.toolHistory`. Do not declare
`toolUpdate`.

Reason: the desktop agent loop sends `Session.toolHistory()` on every request.
This route leaves `toolUpdate` unset, so the runtime sends the current tool
list and removes developer update messages before dispatch. Refusing the field
stopped the first turn with `UNSUPPORTED_INPUT` before Claude started. A
`developer` message is still refused.

## D13. Accept the harness tool schema form

Decision: `fromJSONSchema` must keep the declared fields. An omitted
`additionalProperties`, `true`, and an empty schema are the same open object.
An integer with no bounds is the safe integer range. A schema Zod cannot read
returns `UNSUPPORTED_INPUT`.

Reason: the desktop turn sent one tool, `run_code`. Its schema omits
`additionalProperties`. Wrapping the shape in `z.object` adds
`additionalProperties: false`, so the exact compare refused the turn before
Claude started. The same compare accepts the 33 tool schemas recorded in local
harness sessions on 2026-11-10. Those session files stay outside git.

## D14. Offer each model's reported effort levels

Decision: `resolveModel` returns the effort levels reported by
`supportedModels()`. The selected level is `query` option `effort`. It stays
fixed for that native generation.

Reason: the desktop selector reads `reasoning.efforts`. This route returned
no efforts, so only the model could be selected. A live read on 2026-11-10
showed Haiku 5.5 offers low, medium, high, xhigh, and max. Opus 4.6 and
Sonnet 4.6 omit xhigh. Haiku 4.5 reports no effort support. A level outside
that model's list is refused. A change after the session starts returns
`REBASE_REQUIRED`.

## D15. Accept images through exact request versions

Decision: declare `inputModalities: ['text', 'image']` in the catalog and in
`resolveModel`. Read one request version for each retained image through the dsh
attachment service. Send it as a base64 image block in the user message or in
the MCP tool result. Write one stable descriptor line before it. Use a longest
edge of 1568 pixels and a 4 MiB encoded-byte target. Report the same target and
price through `imageRequestTarget` and `imageRequestPricing`.

Reason: the Claude vision documentation says the API scales an image longer
than 1568 pixels down and applies a 5 MB encoded-byte limit. A request version
that follows those limits is deterministic and does not send more bytes than the
model uses. The real dsh LLM runtime keeps image blocks for a route that
declares the image modality and replaces them with placeholder text otherwise.
The image block snapshot keeps the durable attachment reference, not the bytes.
The `offloaded` flag stays out of the snapshot because it changes projection
text and not message identity.

Evidence: offline rows O33 to O38. The live SDK probe on 2026-11-11 read a
synthetic word from one user image and one tool-result image. It did not test a
dsh profile, many images, or image retention with signed thinking.

## D16. Support several blocks in one tool result

Decision: a tool result carries an ordered content list. Map text blocks and
image blocks to MCP `CallToolResult` content items. Refuse every other block
before the batch is released. Do not join the blocks into one text value.

Reason: the dsh tool pipeline stores a tool result as a content block list. A
tool such as `read_image` returns one text envelope and one image block. Joining
the list would lose the image. The CLI maps MCP text and image items into the
tool-result content for the model. The SDK declaration permits this content
shape, and the 2026-11-11 probe measured it.

## D17. Map maxTokens to the official output-cap control

Decision: map a dsh `maxTokens` value to the official
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` environment variable for that native session.
Keep the value in the generation identity. Reject a non-positive or non-integer
value before dispatch.

Reason: the Claude Code environment reference documents this control. The Agent
SDK has no output-token option. Without the mapping, a title or summary request
that carries `maxTokens` is refused. A change to the cap changes the process
environment, so it requires a new native generation. The mapping uses a
supported official control and does not change billing or client identity.

## D18. Accept harness auxiliary purposes

Decision: accept every auxiliary `purpose` value that the harness sends. Run a
title request as a separate native session with the usual admission checks. A
summary or compaction request that replays assistant history returns
`UNSUPPORTED_INPUT` with a recorded-import message.

Reason: dsh 0.2.2-rc.1 sends the purposes `session-title` and `compaction`, not
the earlier `title` and `summary` names. A title request has one user message and
can use a fresh session. A compaction summary replays the conversation prefix
and needs the signed native prefix. A fresh process cannot import that prefix,
so a correct refusal is better than a false success. Compaction stays an open
gap until a recorded import path exists.

## D19. Keep file bytes outside the adapter

Decision: do not read or send file bytes. The dsh runtime projects every
`FileBlock` to deterministic handle text with a read-only path. Keep that
behavior. Refuse a file block that reaches the adapter directly.

Reason: the dsh LLM runtime owns file projection for every route. A second
projection in the adapter would duplicate the code and could disagree with the
runtime. The model reads the saved file with the dsh file tools. This makes
file attachments work without a new content mapping.

## D20. Build the package when it installs from Git

Decision: add the script `"prepare": "npm run build"` to `package.json`. Keep
`dist/` out of the Git tree. A Git install runs the build. A packed archive
contains `dist/`. This decision replaces D11.

Reason: `package.json` names `./dist/index.js` as `main`, and the Git tree does
not contain `dist/`. A fresh install from
`github:shantanugoel/dsh-plugin-claude-code` could not import the plugin. A
package manager runs the `prepare` script for a Git dependency. The desktop app
and the CLI thus get a built package without a manual build step.

pnpm 11 blocks the build script of a Git dependency until the profile allows
it. The CLI prints the exact `allowBuilds` key and the profile file to change.
The desktop app records the pending build and asks the user to approve it. The
build needs Node.js and npm on `PATH`, because pnpm runs `npm install` in the
fetched copy to run the `prepare` script.

Evidence: [install-2026-11-11.json](evidence/install-2026-11-11.json). On
2026-11-11, an npm Git dependency install ran the build and created
`dist/index.js`. The package entry imported. A packed archive contained 55
files, including `dist/`, and no private files. An isolated dsh profile refused
the first install with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and the exact
`allowBuilds` key. The second run built and installed the plugin, and
`--dump-config` listed the `claude-code-session` entry. The documented `github:`
spec install then passed on 2026-11-11 in a fresh isolated DSH_HOME profile.

## D21. Recover a closed native generation with a recorded textual import

Decision: when the next dsh request continues earlier conversation but the live
native generation is invalid, closed, or absent, start a new native generation.
Send one deterministic bounded text import of the projected dsh history plus the
current pending content as the first user turn of the new native session. Record
the import in the response replay data of the successful turn as
`generationChange`. Do not send old signatures, reasoning text, image bytes, or
tool-call ids. Do not claim signed-thinking retention across the change.

Reason: Stop, generation timeout, process loss, dsh restore, plugin reload, and a
forked subagent all end the live native process. The earlier behavior returned
`REBASE_REQUIRED` and made the dsh session unusable. The import keeps the dsh
session, the dsh log, the tools, and the approvals. The replay data is stored in
the dsh log, so the import is recorded and measurable.

Native resume is not implemented. The pinned SDK 0.3.322 declares `options.resume`
and `forkSession`. This project has no measurement that a resumed CLI transcript
matches the dsh prefix, or that old signatures stay valid after the dsh request
changed. Keep native resume as an open alternative. Do not close it without a
measurement. Do not claim that it works.

The import has these limits:

- It holds no old signed thinking. A new native session starts a new thinking
  chain.
- It is text. The old native block data stays in the dsh log only.
- It is bounded. A long history can be omitted with an explicit mark.
- It is user content. The frozen dsh request does not change.
- It replaces each image with its attachment id. It reads no image bytes.

The recovery record uses reason `abort`, `timeout`, `process-loss`, `restore`,
`fork`, or `invalid`. A later change adds `configuration-change` and
`image-budget`.

Evidence: offline rows O43 to O52. No live model request was made for this
change. The import uses the same streaming input path as an ordinary user turn.
## D22. Map native result errors to stable dsh codes

Decision: map each official SDK result message to a stable dsh code in the pure
module `src/native-failure.ts`. The module does not import the SDK. A native
error becomes one `turn-error` native event. The adapter throws one `LlmError`
with the mapped code. The dsh LLM runtime converts that throw into a terminal
`error` finish, so `agent/request-error` listeners can act on the code.

The mapping is:

| Native fact | dsh code |
| --- | --- |
| Context-overflow wording | `CONTEXT_WINDOW_EXCEEDED` |
| Quota or usage-limit wording | `QUOTA` |
| First-party credit, balance, or billing wording | `ACCOUNT_QUOTA` |
| HTTP 429, rate-limit wording | `RATE_LIMIT` |
| HTTP 401 or 403, auth wording, auth assistant error | `AUTH` |
| HTTP 5xx, overload or server wording | `SERVER` |
| Turn-limit subtypes `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries` | `MALFORMED_RESPONSE` |
| `error_during_execution` | `NATIVE_OUTCOME_UNKNOWN` |
| Any other unreadable turn | `MALFORMED_RESPONSE` |
| A `max_tokens` stop | No failure. The finish is `max-tokens`. |

The dsh classifier `isContextWindowExceededError` does not match the Claude
"prompt is too long: N tokens > M maximum" form. The classifier
`isQuotaExceededError` does not match the Claude "credit balance is too low"
form. The mapper tests both Claude forms and keeps the same two stable codes.
The copy of the native message text keeps the diagnosis. It removes tokens,
authentication headers, account identities, email addresses, and long opaque
values. It bounds the length and it keeps a usable HTTP status.

An error result that follows a complete `message-stop` is not reported again.
A `max_tokens` stop is a truncation: the finish is `max-tokens` with replay
state, never `stop`. A truncated turn that carries a tool call returns
`MALFORMED_RESPONSE`, because the plugin must not execute a call from a
truncated turn and must not continue a native transcript that holds an
unmatched call.

Reason: dsh routes recovery and retry on codes, never on message text.
`dsh-compaction-basic` starts context-overflow recovery only for
`CONTEXT_WINDOW_EXCEEDED`. `dsh-agent-loop` sends the failure to the
`agent/request-error` waterfall. The earlier code collapsed every native error
into `MALFORMED_RESPONSE`, so no dsh recovery could act. A `max_tokens` stop
looked like a complete answer.

Evidence: offline rows O53 to O57. The tests use synthetic SDK result objects
and the real dsh 0.2.2-rc.1 `LlmRuntime` with the scripted native runtime. No
live provider error was produced. The dsh recovery path also needs the
compaction summary support from the open capacity work and the recorded new
generation from D21. The offline tests do not drive the full dsh compaction
recovery, so this change does not claim that a retry after a context overflow
succeeds.
