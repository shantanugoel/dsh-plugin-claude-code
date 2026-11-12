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
- Do the measured `contextWindow` values, the 200000 fallback, and the dsh token
  meter work in a live dsh profile? The offline suite cannot show them.
- Does a live compaction record a replacement surface and run the summary
  import without a false retention claim? The offline suite cannot show it.

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

Revision on 2026-11-11: D21 replaces the refusal for the summary purposes. The
title path and the refusal for an unmapped purpose stay unchanged.

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

## D23. Recover a fixed-configuration change with a generation change

Decision: do not declare `systemPromptUpdate` or `toolUpdate`. When the current
request changes the system prompt, the tool list, the model, the effort, the
output cap, or the workspace, start one new native generation with the current
configuration. Use the recorded textual import from D21 for the history and the
current pending content. Record `generationChange` with reason
`configuration-change` and the changed fields in a stable order. Keep the
existing refusals for an earlier-prefix edit, a developer message, unsupported
content, and an exact repeat of a dispatched request.

Reason: dsh sends the complete current prompt and tool list because this route
declares no update capability. The plugin cannot send a mid-session prompt or
tool update to a fixed native launch. A new generation is the supported path. A
refusal made the plan-mode toggle, an MCP server change, and a model change end
the dsh session.

The new generation receives the new prompt and the complete current tool list.
The old generation closes with a bounded close. A parked MCP handler is
cancelled, not released with an invented result. The recorded import has no
signed thinking. Do not claim signed-thinking retention across the change.

Evidence: offline rows O58 to O61. No live model request measured this change.

## D24. Report a measured context window with a documented fallback

Decision: `resolveModel` returns `context: { contextWindow }` for each model. A
process-wide cache is keyed by the requested model id. The adapter records the
`contextWindow` and `maxOutputTokens` of one SDK result message `modelUsage`
entry at turn end. Before the first measurement, `resolveModel` returns the
static fallback 200000. Do not return `defaultMaxTokens`.

Reason: `dsh-compaction-basic` throws `no context capacity` when the resolved
model has no `context`. Its pressure check runs at each step boundary, so this
route had no automatic compaction and could not start a pressure model switch.
The SDK 0.3.322 declaration reports both values on the result message. The host
`reservedCompletionTokens` function uses the request `maxTokens`, then
`defaultMaxTokens`, then zero. A declared default cap is not necessary, and it
would change the message budget with no measurement. The 200000 fallback matches
the current Claude context size, but this project did not measure it. The result
message follows the turn's assistant messages. The fallback can stay in use
until a later request reads the event. A first-turn measurement is therefore not
guaranteed.

Evidence: offline rows O62 and O63, and the real dsh LLM service normalization.
No live dsh token meter and no live measured value exist.

## D25. Import a compaction prefix as flat text for a fresh native session

Decision: accept the summary purposes `compaction` and `summary`. Start a
separate native session. Send one deterministic user text block: a header, the
replayed rows as flat text, a separator, and the final instruction text verbatim
at the end. Rows are `[user]`, `[assistant]`, `[tool result]`, and
`[tool error]`. The import keeps no signed thinking, no signature text, no live
tool-call IDs, and no image bytes. An image becomes a metadata placeholder. The
summary session declares no dsh tools. Store `retentionAudit: 'unavailable'` and
a null native request record on the auxiliary finish, even when the summary turn
carries request evidence. Keep the parked conversation generation open.

Reason: a fresh native process cannot continue a signed prefix. A recorded
textual import gives the compaction service a summary without a false retention
claim. The dsh compaction service records the replacement surface. The adapter
does not write the conversation session. The summary call uses the same spend,
auth, workspace, output-cap, and deadline controls as a title call. Removal of
the dsh tool list prevents a summary from starting a tool wait that no
conversation can answer.

Evidence: offline rows O40 and O64 to O66. No live dsh compaction ran.

## D26. Declare the exact tested dsh version as the engine requirement

Decision: keep the exact `engines.dsh` value `0.2.2-rc.1` in `package.json`. Do
not widen it to a range. The README states that the plugin installs and
activates only with the tested dsh version, and that the plugin manager refuses
another version until a compatibility check.

Reason: no dsh release later than 0.2.2-rc.1 exists. The npm registry version
list on 2026-11-11 ended at 0.2.2-rc.1, and the `latest` and `next` dist-tags
named it. A range such as `>=0.2.2-rc.1 <0.3` would assert support for a later
release that no compatibility test covers. The plugin depends on host services
and lifecycle details that can change between releases. The dsh plugin manager
enforces `engines.dsh` alone. It refuses an install and skips the bundle at
startup with a clear diagnostic. It also prints the exact-version exemption
command. A user who accepts the risk can record that exemption. A later dsh
release needs a compatibility test and a new plugin release before this
requirement changes.

Evidence: [engine-check-2026-11-11.json](evidence/engine-check-2026-11-11.json).
On 2026-11-11 the tested version accepted the plugin in an isolated profile. A
temporary copy with `engines.dsh` set to `0.2.3` was rejected before
installation with a clear message and `nothing was installed`. The same changed
requirement on an installed copy caused `dsh: skipping profile bundle
"dsh-plugin-claude-code"` at startup. A real later dsh release was not run
because none exists.

## D27. Close the native process when dsh disposes a session

Decision: listen for the dsh `session/disposed` event in `src/index.ts`. Close
only the conversation generations of the disposed session through the existing
bounded `closeKey` path. Do not close an auxiliary call. Keep the plugin-unload
effect that closes every owned process.

Reason: before this change, a deleted dsh session left its Claude CLI process
and its MCP handlers open. Many deleted sessions grew the process count. The
session map is keyed by dsh session ID and generation ID, so the listener selects
the exact generation. An auxiliary call has its own key and its own stream close.
A different session keeps its process.

Evidence: offline row O67 and O68. The tests use the real dsh 0.2.2-rc.1
`SessionStore` with two sessions in separate owner fibers and the scripted
native runtime. Disposing one session closes only its process; the other process
stays live; plugin unload then closes it. No live Claude process was measured.

## D28. Cache one accepted auth check for a short interval

Decision: `AuthGuard` caches one accepted auth result for 60 seconds. The cache
scope contains the executable, the home, the workspace, each settings file's
modification time and size, and the allowlisted child environment values. Run
the settings safety check on every call, also on a cache hit. Never cache a
refusal. A caller can supply the account binding that it requires. A cache hit
is valid only for that binding, and a different result returns
`AUTH_ROUTE_REFUSED`.

Reason: before this change, every `stream()` call started one `claude auth
status` process. The command is local, but it adds a delay to each turn. The
scope facts change when the login home, the workspace, the settings files, the
executable, or the child environment changes. The settings safety check stays
mandatory, so a new helper or billing override cannot hide behind a cache hit.
The plugin cannot read the current account binding without the auth command.
The 60-second interval bounds an unnoticed login change. A caller that must bind
inference to one account passes the expected binding.

Evidence: offline row O69. The tests use a fake runner and a controlled clock.
Two accepted checks in one scope run one command. A changed home, workspace,
settings file state, environment value, or interval runs the command again. A
refusal runs the command again. This is an offline behavior. No live auth
command was measured after this change.

## D29. Release an auxiliary session key after its bounded close or invalidation

Decision: release the auxiliary key in the `finally` path of `runAuxiliary` on
every exit. An invalid entry was already closed by `invalidate()`, so the
release only removes the entry. A valid entry closes through the bounded
`closeKey` path first. Add `SessionManager.releaseAuxiliary(key)`. It refuses a
conversation generation: it returns without a change when the entry is not
auxiliary. Keep `conversation()` separate.

Reason: the old `finally` skipped the close when the phase was `INVALID`. An
aborted or failed title or summary call therefore left its entry in the session
map. The memory grew with each aborted call, and a later call with the same key
found a stale entry. The release is safe because the entry is keyed by the exact
auxiliary request. A conversation generation must never be removed by this path,
because a later turn would then hide or delete it.

Evidence: offline rows O70 and O71 with the scripted native runtime. An aborted
auxiliary call leaves no entry. The next auxiliary call with the same purpose,
output cap, and content starts a new native session. A live conversation keeps
its entry and process, and the next conversation request continues the same
native session. No live Claude process was measured.

## D30. Use the catalog display name and invent no default effort

Decision: `resolveModel` returns the discovered catalog `displayName` as `name`
when the catalog has the row. It keeps the exact requested id as `id`. An
uncatalogued id uses the raw id as its `name`. Report only the effort levels that
the catalog row reports. Do not return `reasoning.defaultEffort`. Do not project
other discovered fields until a dsh model field consumes them.

Reason: the older code returned the raw model id as the name, so some dsh UI
paths showed an id instead of the provider's display name. The SDK 0.3.322
`ModelInfo` type declares `supportsEffort` and `supportedEffortLevels`. It has no
`defaultEffort` field, and the CLI reports no default effort value. A
`defaultEffort` would materialize an effort into every request that omits one.
That changes the native request with no measurement. Absence keeps the
provider's own default. The type also declares `resolvedModel`,
`supportsAdaptiveThinking`, `supportsFastMode`, and `supportsAutoMode`. No dsh
model field consumes them, so the adapter stays smaller and does not project
them.

Evidence: the installed SDK 0.3.322 declaration file `sdk.d.ts`, read on
2026-11-11. Offline rows O72 and O73. The tests use synthetic catalog rows and
the real dsh 0.2.2-rc.1 LLM service. No live `supportedModels()` read was made
for this change.

## D31. Deliver trailing user content inside the waiting tool turn

Decision: when a dsh request has a tool-result batch followed by user messages,
split the suffix. Validate and stage the result batch. Send each trailing user
message on the native streaming input queue, then release the result batch.
Continue the same dsh stream and the same native session. The committed dsh
transcript keeps the complete frozen request. Refuse a developer message or a
system message at that boundary. Refuse a non-offloaded image in a trailing
mid-turn message until a measurement covers it. (D40 replaces this image
refusal.)

Reason: the live measurement on 2026-11-11 used official Agent SDK 0.3.322,
Claude Code 2.1.319, and the first-party subscription login. One in-process MCP
tool handler parked. The probe then pushed one trailing user message:

- Trailing input before the result release: one native turn, one model request
  after the tool result. The CLI put the trailing text in a CLI-generated
  system-role mid-turn message after the `tool_result` block, not inside it. The
  model received the tool token and the trailing word and answered once.
- Trailing input after the result release: two native turns and two requests.
  The first answer had only the tool token. The trailing text became a new user
  turn with its own request and answer. One dsh stream cannot represent that
  second turn.

Thus the delivery order is load-bearing. Do not release the results first.

The CLI session request records were not available: this agent session has a
workspace-write file sandbox, and the CLI transcript write under
`~/.claude/projects` failed with EPERM. The probe captured the same request data
through the official `OTEL_LOG_RAW_API_BODIES` file diagnostic. The reviewed
summary is [trailing-context-probe-2026-11-11.json](evidence/trailing-context-probe-2026-11-11.json).
Raw captures stay private in `.local/evidence/`.

This does not prove plugin-in-dsh behavior, image support in a mid-turn message,
or several trailing message boundaries. It also does not prove signed-thinking
retention across a mid-turn message. Evidence: offline rows O74 to O78.

## D32. Bound request images and start a recorded generation before the retained limit

Decision: apply an image budget to every conversation request before the native
boundary. Count the retained image occurrences in the complete dsh request and
their exact base64 request-version bytes. Use `requiredImageOffload` from
`@deepseek-ai/dsh-llm` with `representation: 'base64'`, 80 occurrences, and
20 MiB. When the count is positive, throw `LlmError` with code
`IMAGE_OFFLOAD_REQUIRED` and `failure.offloadImages` set to that count. Do not
close the live generation and do not stage the tool-result batch. Track the
image occurrences and encoded bytes that each live native generation receives.
When the next dispatch would pass 80 occurrences or 20 MiB, start one recorded
new generation with reason `image-budget`. Its import holds an attachment-id
placeholder for each historical image. Send the current images to it. The
`image-budget` record has no changed fields. These numbers are conservative
adaptations of the provider documentation: about 100 images for a
200000-token-context model, 5 MB for one image, and stricter resizing above 20
images. They are not a measured provider limit. For a tool-result continuation,
the completed outcomes are quoted in the import and a result image stays a
placeholder. It does not reach the new generation.

Reason: the native transcript keeps every image sent to a generation, while the
adapter sends only new content. A dsh `image/offload` event changes projection
text for a later request, but it cannot remove an image from the live native
transcript. Without the request budget, one very image-heavy request can reach
the provider limit with an opaque error. Without the generation threshold, a
long session accumulates images until the provider rejects a request. The
offload path already exists in dsh: a route throws the code,
`dsh-compaction-image-offload` records the selection, and the step retries with
placeholder text. The generation change reuses the recorded textual import from
D21.

Evidence: offline rows O82 to O88. The many-image probe on 2026-11-11 sent 100
and 101 synthetic 1x1 images in two direct official-SDK turns. Both turns
completed with subtype `success` and the answer `MANY-IMAGES-OK`. The selected
model `claude-opus-5-5` reported `contextWindow` 1000000 and `maxOutputTokens`
128000. The probe did not reach the documented limits: the about-100-image limit
is for a 200000-token-context model, and the other-model limit is about 600.
The probe used two inference requests. See
[the many-image probe summary](evidence/many-image-probe-2026-11-11.json). No
live dsh profile ran this budget or this generation change.

## D33. Capture request evidence from the CLI raw-body diagnostic

Decision: set the official Claude Code diagnostic `OTEL_LOG_RAW_API_BODIES` to
`file:<private directory>` in the native child environment. Use one private
directory for each conversation generation (mode 0700, removed on close or
start failure). After each native response, read the newest `query_source:
"sdk"` request and response bodies, reconstruct a thread-delta request, and
compare the complete request with the launch plan and the observed native
prefix. Emit the existing `request-evidence` event only when every check
passes. Otherwise emit nothing, so the dsh turn stores `retentionAudit:
"unavailable"`. A missing audit is not a turn failure.

The comparison checks:

- The record parses whole, has `stream: true`, a model id, system, tools, and a
  non-empty message list, and is at most 1 MiB. The evidence record is at most
  1 MiB. No signed content is truncated.
- The recorded system prompt holds the replaced dsh prompt byte for byte as one
  block. Only the CLI billing header block and the CLI agent prompt block are
  accepted as additions. Any other system block fails the audit.
- The recorded tool list contains exactly the dsh MCP tools in launch order.
  The CLI may add one documented inert `DeferredToolPlaceholder`; its complete
  definition must match, and the evidence record keeps it. Any other tool
  fails the audit.
- The recorded model equals the native served model from the response body.
- Every earlier assistant response reappears byte for byte, including thinking
  signatures, text, and tool-call ids. Every user text reappears in order. Every
  earlier tool call has its recorded result. CLI context blocks and CLI
  environment messages are not user content and are ignored.

Reason: the dsh profile sandbox denies the CLI write of its session transcript
under the user home. A live tool turn in an isolated headless profile produced
no transcript file, so the earlier session-log plan cannot work in production.
The raw-body diagnostic is an official CLI interface that writes complete
request and response bodies to a directory that the plugin chooses and controls.
On CLI 2.1.319 it also records the beta `message-threads-2026-08-12` delta: the
first request is complete and each later request holds only the delta plus a
thread reference. The plugin keeps the last complete request and the last
response, so it reconstructs the exact native message list and compares it.

Evidence: offline rows O89 to O95 and
[request-evidence-probe-2026-11-11.json](evidence/request-evidence-probe-2026-11-11.json).
Two live SDK probe turns with SDK 0.3.322 and CLI 2.1.319 stored complete
evidence. The second request was reconstructed from a thread delta to five
messages. The tool list held the dsh MCP tool and the one inert placeholder;
the advisor tool was absent. The probe did not produce a signed thinking block,
so the live signature-retention comparison is not measured. A live turn through
an installed dsh profile is not measured; issue #13 covers it.

Revision on 2026-11-11 after a live isolated-dsh profile run: the first in-profile
capture reported `unavailable` for three shapes that the SDK and CLI apply. The
inert placeholder can appear at any position of the tool list, not only first.
The SDK converts each declared JSON Schema to a Zod shape and back, which removes
the object-level `description` and `additionalProperties` annotations. A
text-only user input is sent as one joined string, not one block for each text
block. The comparison now accepts the placeholder at any position, ignores the
two annotations the SDK removes on both sides, and records the joined user text.
The complete recorded request keeps the actual tool definitions. A live
isolated-dsh tool turn then stored `retentionAudit: "accepted"` for every turn.
The recorded tool list holds the 23 dsh MCP tools and the inert placeholder, so
the literal "only dsh MCP tools" acceptance item is not met; the design permits
the inert placeholder only with its complete definition recorded, which this
capture does. An image-bearing request still reports `unavailable` because the
capture refuses image content; that item stays unmeasured.

Final state on 2026-11-11: the in-profile audit stores `accepted` for simple
tool turns. It still stores `unavailable` for a thinking tool-turn continuation
with the reason "earlier message prefix differs", so signed-thinking retention
through the in-profile audit stays unmeasured and is not claimed. The direct
evidence for thinking retention remains the saved direct-CLI measurement
(cli-2.1.319.json); the in-profile path needs its own measurement.

## D34. Park a tool handler that arrives before its call ids are published

A desktop dsh session on 2026-11-11 failed every tool call after the first call
of one native generation. The model received "The tool handler does not match a
staged result." for each later call. The dsh session recorded every call and
every dsh result, so dsh executed the tools. The error reached only the native
Claude turn. The first of nine `run_code` calls succeeded and the next eight
failed.

Measured cause: the CLI invokes the MCP handler as soon as it emits a tool call.
dsh publishes the call ids of that turn to the bridge only after the complete
native turn ends. After the first released batch, the bridge was still in the
released state with the previous batch in its staged map. The next handler
arrived in that state and was refused at once.

Decision: `wait()` parks a handler that is not in the released batch. The next
`stage()` delivers its result to the exact call id. `expect()` refuses a parked
handler whose id is not in the newly published call list, so a stale or unknown
id fails there and not at the long result deadline. The whole-batch order check
in `stage()` and the duplicate-delivery refusal do not change. Do not restore
the immediate refusal in `wait()`: it fails the normal arrival order of every
generation with more than one tool call.

Evidence: [bridge-tool-handler-race-2026-11-11.json](evidence/bridge-tool-handler-race-2026-11-11.json).
Offline rows O97 and O98 and `test/mcp-bridge.test.ts`. The live reproduction
and the fixed reruns used the standard preset with the `bash` tool. The desktop
defect used the `ptc` preset with `run_code`. Both paths use one MCP bridge and
one handler for each tool call.

## D35. Recover a changed earlier prefix with a recorded new generation

A desktop dsh session on 2026-11-11 stopped with `REBASE_REQUIRED` in turn 6.
Each later request failed with the same code, so the user could not continue the
session.

Measured cause, from the dsh session log:

- The last successful step reported 133906 cache-read tokens, 2621 cache-write
  tokens, and 4 input tokens. The total is 136531 tokens.
- The plugin reported a 200000-token context window and no `defaultMaxTokens`.
  The request header had no `maxTokens`.
- The dsh `compaction-basic` plugin sets its threshold to the smaller of 80% of
  the window and the window minus the reserved completion tokens minus
  `headroomTokens`. The default headroom is 65536. The threshold was 134464
  tokens.
- dsh then wrote nine `compaction/prune` events. Each event replaced one
  earlier tool result with a shorter copy. The events removed an estimated
  41607 tokens.
- The next request had a different earlier prefix. `admitTranscript` returned
  `REBASE_REQUIRED`. The adapter kept the live generation and its committed
  prefix, so each later request failed the same comparison.

Decision: a request prefix that does not agree with the committed prefix of a
healthy live generation starts one new generation. The adapter closes the old
generation and sends the recorded text import of the current request. The record
has reason `history-change`. It holds the changed fields when the configuration
changed in the same request. When a recovery request has no assistant message
and no recorded boundary agrees, the last message is the current input.

Reason: the user cannot repair a prune, a compaction replacement, or an edit
from the error message. The live native session cannot change its prefix.
Native compaction is off, so the dsh pressure policy is the only control of the
native context size. A prune has an effect on the native session only through a
new generation. The import is plain text. It sends no old signature, so a saved
signature is not used after an earlier input changed.

Cost: the new native session does not use the prompt cache of the old session,
and it does not keep the old signed thinking. This occurs one time for each dsh
pressure event, not one time for each step.

Checked and not changed:

- The threshold. The plugin reports no reserved completion tokens, so it cannot
  decrease the reservation. `headroomTokens` and `modelPolicies` are dsh
  profile settings. A larger reported context window would be a false value.
- The pruner. The dsh presets mount `dsh-compaction-tool-result-pruner` with
  the id `tool-result-pruner`. Its bundled README and its configuration schema
  have three settings only: `thresholdChars` (default 8192), `headChars`
  (default 4096), and `tailChars` (default 1024). An unknown setting stops the
  plugin load. No setting applies to one provider or one model. The README
  states that a replaced earlier result invalidates cache reuse from the first
  changed token. The pruner runs only after a compaction trigger qualifies. A
  profile patch entry with `disabled: true` for that id is a possible control
  for all providers. This project did not test it.
- `REPLAY_STATE_INVALID` for a changed last assistant publication. That rule
  is unchanged.
- `recordContextImport` still returns `REBASE_REQUIRED` for an open tool
  boundary. No production path calls it.

The bounded import omitted the latest messages when the history was longer than
its limit. D36 changes that rule.

Evidence: offline rows O16, O61, and O99 to O101. The measured values come from
the private dsh session log. That log is not in Git. No live prune was measured
after the change.

## D36. Keep the first message and the latest messages in a long import

Decision: when the quoted messages of an import are longer than 120000
characters, keep the first message, then keep the latest messages that fit. Put
one mark with the number of omitted messages between them. The limit, the
per-block limits, and the deterministic result do not change.

Reason: the earlier rule kept the oldest messages and omitted the latest ones.
The latest messages hold the current work. The first message holds the task, or
the summary after a dsh compaction. With D35, a recovery import can occur in a
long session without a user action, so the earlier rule removed the context
that the model needs most.

Evidence: offline row O105. No live session measured the effect of the limit.
The limit is 120000 characters for each model. It does not use the context
window.

## D37. Read the context window from the CLI before a result measurement

Measured on 2026-11-11: a desktop session with the alias `sonnet` used the
200000 fallback for all its turns. dsh started its pressure work at 134464
tokens (D35). A no-prompt SDK probe on the same day read 1000000 tokens for
`sonnet`, which the CLI resolves to `claude-sonnet-5-5`. Eleven models of the
model list reported 1000000 tokens and three reported 200000 tokens.

The cause of the missing result measurement in that session was not
determined. The session log has no result message. A possible cause is in
`modelUsageEvent`: it attributed an entry only when its key or canonical id was
the requested id, or when the result had one entry. An alias request with two
entries had no attributed entry.

Decision:

- `resolveModel` reads the window from the CLI when no result measurement
  exists. It starts one SDK query with the model and no user prompt, calls
  `getContextUsage({ detail: 'summary' })`, uses the smaller valid value of
  `maxTokens` and `rawMaxTokens`, and closes the query. The reader keeps a
  successful value for the process lifetime, tries a failed read again after 30
  seconds, and runs one read at a time.
- A result measurement stays first in the order. The static 200000 fallback
  stays last.
- `modelUsageEvent` also accepts an entry whose key or canonical id is the
  served model id of the initialization message.
- The reader does not call `setModel`. A `setModel` control request for an
  explicit model id took 0.7 to 2.2 seconds in the probe, and this project has
  no measurement of the requests that it sends. A read with the model as a
  query option took about 0.25 seconds.

Reason: the fallback was a false value for most models of this account. A
window that is too small starts the dsh pressure work early, and each pressure
event starts a new native session (D35). The SDK `ModelInfo` type has no
window field, so the model list cannot supply the value.

Effect: with the default dsh policy, a 1000000-token window has a pressure
threshold of 800000 tokens. A session can become much larger before dsh
compacts it. Each request of a large session uses more of the plan limit. The
dsh `thresholdRatio` and `modelPolicies` settings control this.

Limits: the value is the window that the CLI states. It is not a provider
acceptance test at that size. No network capture recorded the probe. The
values were not measured inside dsh.

Evidence: [context-window-probe-2026-11-11.json](evidence/context-window-probe-2026-11-11.json)
and offline rows O102 to O104.

## D38. Publish a call to an unknown tool, do not fail the turn

Problem (issue #15): a native response named a tool outside the dsh tool list.
`publishedToolName()` returned `NATIVE_CONTEXT_MISMATCH` and the user turn
ended. dsh itself answers an unknown tool name with an error result and
continues. The rejected name of the reported session was not recorded, so its
cause is not proven. The probable cause is a direct call to a hidden tool in a
session that offers `run_code` only.

Measured on 2026-11-11 with the production launch plan and the production
native session (Agent SDK 0.3.322, CLI 2.1.319, model `haiku`, one dsh tool
`run_code`, a prompt that asks for a call to `bash`):

- The model called `bash`. The native tool list had the dsh tool only.
- The CLI answered the call itself. The next request had a `tool_result` with
  `is_error: true` and the text
  `<tool_use_error>Error: No such tool available: bash</tool_use_error>`. No
  MCP handler was called for that id.
- The CLI sent the next request in the same query with no input from the
  plugin. The next response arrived 2.1 and 2.7 seconds after the first stop in
  two recorded runs.
- The handler of the next response (`run_code`) was called before a 3-second
  simulated dsh step returned the result of the unknown call.
- One `sdk` index entry was written for each API request (3 requests, 3
  entries, plus one title entry).
- A response with `run_code` and `bash` in one API message arrived as
  separate assistant messages. The CLI ran the `run_code` handler, and the
  second request had both results in one user message.
- Before this change, the request audit of the second and third request
  failed with "earlier message prefix differs". The cause was not the unknown
  tool: the thinking block arrived in an assistant message with no stop, and
  the expected blocks did not include it. A second stop of one API message
  also waited 3 seconds for a request record that cannot exist.

Decision:

- Publish the unknown call to dsh with its sanitized name and its call id. Do
  not drop the message and do not make a tool result in the plugin. This
  follows the design review in the issue. A dropped message needs segment
  logic in the reader and the translator, loses its text and thinking for the
  user, and hides a real request from the dsh log.
- Keep the stop-reason checks. Use `{}` for unknown-tool arguments that are not
  an object. Refuse a sanitized name that equals a dsh tool name.
- Record the sanitized names in `unknownToolNames` of the replay envelope and
  in the message of a failure that still occurs.
- The bridge keeps a parked handler through a turn that has no handled call.
- Trailing user input after a batch with no handled call starts one recorded
  new generation with reason `invalid`. In that state the native turn can be
  complete, and a mid-turn message would start a native turn that no dsh step
  reads. This case was not measured live.
- The request audit records each block of one API message and reads one
  request record for each API message.

Measured after the change, through the production adapter with a script in
the place of the dsh agent loop: the single case had three steps (`bash`,
`run_code`, `DONE`) on one generation, each with `retentionAudit`
`accepted`. The mixed case had three steps (`run_code`, `bash`, `DONE`) on one
generation. Its second step had `unavailable`, because it has no new request,
and it started with no 3-second wait.

Known effects:

- dsh shows a step for a tool that did not run natively.
- The model saw the CLI error text. The dsh log has the dsh error text. A
  later import quotes the dsh text.
- If dsh runs a call that the plugin published as unknown, the model does not
  see that result. dsh keeps control of that decision. No such case was
  measured.
- Usage of each request is reported on its own dsh step. Nothing is summed.

Limits: the script used a synthetic dsh error text. No run used an installed
dsh profile, so the dsh result for an unknown tool name is taken from the issue
report and is not measured here. The `mcp__dsh__<unknown>` name form and a
model other than `haiku` were not measured live.

Evidence: [unknown-tool-probe-2026-11-11.json](evidence/unknown-tool-probe-2026-11-11.json)
and offline rows O106 to O113.

## D39. Keep subagent model selection a dsh setting

Problem (issue #16): a session on `claude-code-session/sonnet` could not start
a subagent on another Claude model. `list_subagent_models` showed one model.

Cause, read from `@deepseek-ai/dsh-tool-subagent` 0.2.2-rc.1:

- The `subagent` tool and `list_subagent_models` read a route list from the
  session event `subagent/model-selection-policy`.
- With no such event, an explicit child route is permitted only when it is the
  parent route. The catalog of the adapter is not read for other models.
- The Host service `@deepseek-ai/dsh-tool-subagent/model-selection-settings`
  writes the event when a new top-level session starts and its `enabled` field
  is true. A child session inherits the event. The default is off.
- The plugin has no input to this decision. Its catalog (D10) already lists
  each model from `supportedModels()`.

Decision: change no plugin code. Do not add a profile patch that enables the
setting, because the list of permitted child routes is a user decision in dsh.
Record the setting and the new-session rule in the README.

Rules check: a child on another model uses the same route, the same official
executable, and the same first-party subscription check. It has its own dsh
session and its own native session, so signed thinking stays in one native
session. No header changes.

Measured on 2026-11-11 in an isolated `DSH_HOME` headless profile (dsh
0.2.2-rc.1, plugin source at commit `22db620`, parent model `haiku`):

- Setting off: `list_subagent_models` showed `haiku` only, and a child on
  `sonnet` was refused with the message of the issue.
- Setting on with the routes `haiku` and `sonnet`: the list showed both
  models, the child started, and the child answered. The session logs show the
  served models `claude-haiku-5-5` for the parent and `claude-sonnet-5-5` for
  the child.

Limits: the measurement set the service fields through a patch overlay. The
settings page was not operated. A child on `claude-fable-5-2` or `opus` and
an explicit route on `subagent_fork` were not run.

Evidence: [subagent-model-selection-2026-11-11.json](evidence/subagent-model-selection-2026-11-11.json)
and live rows L08 and L09.

## D40. Deliver an image in a trailing mid-turn user message

Problem: in a dsh session with the `ptc` preset, `run_code` returns text only.
When the program loads an image, dsh adds a user message with
`source.kind: "ptc-mode"` after the tool result. D31 refused a non-offloaded
image at that boundary. Three subagents on `claude-code-session` ended with
`UNSUPPORTED_INPUT` after they loaded an image in `run_code`.

dsh does not move that image into the tool result for its own routes. The
`@deepseek-ai/dsh-llm-pi-ai` 0.2.2-rc.1 adapter sends the tool result and the
user image message as two messages.

Decision: remove the D31 image refusal. Prepare a trailing image the same way
as an image in a user message (D15). Send it in the same mid-turn input as its
message, before the result release. Do not move it into the tool result. Count
the prepared trailing images in the retained generation image total. When that
total is above its threshold, start the recorded `image-budget` generation
(D32) and send nothing mid-turn. An offloaded trailing image stays placeholder
text and reads no bytes.

Reason: a live measurement on 2026-11-12 used official Agent SDK 0.3.322,
Claude Code 2.1.322, the first-party subscription login, and the model `haiku`.
One MCP tool handler parked. The probe queued one trailing user message with a
text block and a synthetic PNG with the word `QUOKKA58`, then released the
result:

- One native turn and one result. The answer held the tool token and
  `QUOKKA58`.
- The raw request after the tool result had one user message with three blocks
  in this order: the `tool_result` with the tool text only, a CLI-generated
  `<system-reminder>` text block with the trailing text, and the complete image.

With CLI 2.1.319, D31 recorded the trailing text in a separate system-role
message. With CLI 2.1.322 the text and the image are blocks of the user message
that holds the `tool_result`. The delivery order of D31 does not change.

Limits: the probe used the SDK directly, not the plugin in a dsh profile. It did
not measure `sonnet`, `opus`, several trailing images, or signed-thinking
retention across the mid-turn message.

Evidence: [trailing-image-probe-2026-11-12.json](evidence/trailing-image-probe-2026-11-12.json)
and offline rows O77, O114, and O115.
