# Claude subscription adapter design

Status: on 2026-11-11 the plugin supports text and image input, image-bearing
tool results, and file attachments through dsh projection. The offline suite
covers these paths, the native turn-error mapping, session disposal cleanup, and
the auth acceptance cache. A direct official-SDK probe read a synthetic word
through a user image and an MCP tool-result image.
That probe did not run the plugin in a dsh profile. No plugin was installed in a
dsh profile for this change. Production inference is refused. The complete
plugin has not passed a live dsh integration test.

On 2026-11-11 the adapter also reports a context window for each resolved model
and supports the harness compaction summary call. A process-wide cache replaces
the static context fallback with the value from the native result message. The
summary call is a deterministic textual import in a separate native session.
The offline suite covers both paths. No live dsh token meter and no live
compaction summary were measured.

On 2026-11-11 the adapter also bounds the images of one request and the images
of one native generation. A request above the route image budget fails with
`IMAGE_OFFLOAD_REQUIRED` before dispatch, so dsh can offload the oldest
occurrences and retry. A generation that would pass its retained-image
threshold starts one recorded new generation with reason `image-budget`. The
recorded import holds image placeholders only. A direct official-SDK probe sent
100 and 101 synthetic images and both turns succeeded. It did not reach the
provider limit. The offline suite covers both bounds.

Use one stateful `LlmAdapter` with one persistent official Claude Agent SDK
session for each dsh session generation. The SDK must run the user's installed,
unmodified official Claude binary. Use an MCP bridge to stop Claude at each tool
boundary. Let dsh execute every tool. Do not build an Anthropic HTTP client.
Do not read, copy, or replay OAuth credentials. The direct `claude -p` process
was the measurement transport. The SDK is the planned production transport.

Read [contracts.md](contracts.md) for module interfaces and edge cases,
[test-plan.md](test-plan.md) for acceptance tests, and [PLAN.md](PLAN.md)
for the implementation sequence. Later decisions in this file supersede the
original direct-CLI proposal.

The design has two release conditions. First, the selected CLI build must keep
the signed blocks and expose only the approved tools. Second, the account must
prevent paid usage before the first model request. If either condition has no
proof, refuse the request. The existing evidence does not satisfy both conditions.

**1. Measured facts**

The earlier test used official Claude Code 2.1.319 with subscription login and
the model `claude-haiku-5-5`. It held one MCP call open for 20 seconds. The CLI
emitted no further output during that interval. After the tool result arrived,
the CLI returned the requested answer.

The saved session log contains native request records. The second request has:

- The same recorded system prompt and tool definitions as the first request.
- The complete earlier message prefix, without a content change.
- The original thinking block: zero text characters and 912 signature characters.
- The original tool call and its corresponding result.

The signature is equal in the original output and the second recorded request.
See [the measurement summary](evidence/cli-2.1.319.json). This is evidence from the CLI request
record and a subsequent server response. It is not an independent packet capture
or a server signature-validation trace.

On 2026-11-11 a direct official-SDK probe measured the image paths. It used SDK
0.3.322 and Claude Code 2.1.319 with the subscription login. One probe sent a
synthetic PNG in the streaming user message. A second probe returned the same
PNG from an in-process MCP tool. The model read the word in both cases. See
[the image probe summary](evidence/sdk-image-probe-2026-11-11.json). The probe
did not run the plugin inside dsh and did not test image retention with thinking.

On 2026-11-11 a second direct official-SDK probe measured a many-image turn. It
used the same SDK and CLI versions. Two streaming user messages carried 100 and
101 synthetic 1x1 PNG images. Both turns completed with subtype `success` and
the model answered. The result message reported `contextWindow` 1000000 and
`maxOutputTokens` 128000 for the selected model `claude-opus-5-5`. The probe did
not reach the documented request image limits, so it does not measure the exact
provider limit. See [the many-image probe
summary](evidence/many-image-probe-2026-11-11.json).

On 2026-11-11 the capacity path used no new inference. A declaration review of
SDK 0.3.322 found `ModelUsage.contextWindow` and `ModelUsage.maxOutputTokens` on
the result message. The host `dsh-compaction-basic` source shows that the
pressure check needs `context.contextWindow` from the resolved model. Its
`reservedCompletionTokens` function uses the request `maxTokens`, then
`defaultMaxTokens`, then zero. The offline suite exercises these paths with the
scripted runtime. The real model values, the static fallback, and the dsh token
meter remain unverified in a live dsh profile.

On 2026-11-11 a third direct SDK probe measured a trailing user message after a
parked tool result. With the trailing message queued before the result release,
the CLI sent it in the same native request as a CLI-generated system-role
mid-turn context message after the `tool_result`, and the model answered once.
With the opposite order, the trailing message became a second native turn. See
[the trailing-context probe](evidence/trailing-context-probe-2026-11-11.json).
This probe did not run the plugin inside dsh.

A live isolated-dsh headless run on 2026-11-11 exposed three transport shapes
that the native event fold must handle. The CLI can split one API message into
several assistant messages with the same id and one content block each, so the
block indexes continue across that split. It attaches usage to those streamed
messages while the stop reason is null, so usage is emitted independent of the
stop reason and folded to one event for each native turn. The MCP request extra
names the tool-use id as `_meta['claudecode/toolUseId']`; the id reader accepts
that spelling. With these shapes handled, one live tool turn completed through
dsh: the model called the dsh tool, dsh executed it, the result returned, and the
model replied. This is one tool turn, not a retention measurement.

The request also includes `DeferredToolPlaceholder` and `advisor`, although the
startup event lists only `mcp__dsh__probe`. Thus, the startup tool list alone is
insufficient evidence of the native tool list. This measurement prevents release
of that exact launch configuration under the requirement that dsh runs all tools.

Inspection of the published `@deepseek-ai/dsh-llm@0.2.2-rc.1` package found
`ReplayEnvelope`, `GenerateOptions.sessionId`, and
`AssistantProviderMetadata.replayState`. Inspection of the matching agent-loop
package found that it stores replay state in the assistant message source.
The content block has no signature field, but the source can hold opaque JSON.
The source can store signatures without changing the content-block type.
The SDK implementation and dsh persistence cycle have not yet passed these tests.

The plugin does not read the CLI session transcript. A dsh profile denies the
CLI write of its transcript under the user home, so this path is not available
in production. The plugin instead sets the official raw-body diagnostic
`OTEL_LOG_RAW_API_BODIES=file:<private directory>` for each native generation.
The CLI writes one complete `/v1/messages` request body and one response body
for each call. The plugin reads the newest SDK request after each response,
reconstructs the thread delta when the CLI uses `message-threads-2026-08-12`,
and compares the complete request with the launch plan and the observed native
A live isolated-dsh profile run on 2026-11-11 stored `retentionAudit:
"accepted"` for every turn of a tool turn. The capture accepts the CLI inert
placeholder at any tool-list position, ignores the two JSON-Schema annotations
that the SDK conversion removes on both sides, and records the joined user text.
The complete recorded request keeps the actual native tool definitions. An
image-bearing request reports `unavailable`, because the capture refuses image
content; that path is unmeasured.

blocks. It stores the existing `nativeRequestRecord` and sets `retentionAudit`
to `accepted` only when that comparison passes. A missing, partial, oversize,
redacted, or changed record leaves the audit `unavailable`; it is not a turn
failure. The diagnostic directory is private, holds only the current
generation, and is removed on close. See decision D33.

**2. Session and transcript ownership**

dsh owns its durable session, edits, model selection, tools, sandbox, and approvals.
The official Claude process, managed by the SDK, owns the native model transcript
and its signed thinking.
The plugin owns the process, the MCP bridge, and a record that connects the two
transcripts. A dsh stream is one model response, even when the CLI process remains
alive across many streams.

Identify a process with `(dsh session ID, generation ID)`. Allow only one active
stream for that pair. Do not use a workspace path or the last active session as
the identity. Keep auxiliary calls in separate processes and separate records.

Listen for the dsh `session/disposed` event. Close the conversation generations
of that exact session with the bounded close. A different session stays open.
An auxiliary call also stays open: it has its own key and its own stream close.
Plugin unload closes every owned process. The session ID and the generation ID
in the key prevent a wrong process close.

An auxiliary stream always releases its key in its `finally` path. An entry that
is already invalid needs no second close, because the invalidation closed its
native process. The release only removes that entry. A release refuses a
conversation generation. A later auxiliary call with the same purpose, output
cap, and content starts a new native session.

Before each continuation, compare the complete frozen request with the stored
expected dsh transcript. Check the system text, ordered tools and schemas, exact
model ID, controls, message content, message identity, and tool-call mapping.
Do not compare only the last user message or tool IDs. Do not change the frozen
request. A local hash detects differences; it does not validate an Anthropic
signature.

Support a new session with a recorded initial input and later user turns. While
a native tool call is pending, accept the complete dsh tool-result batch. dsh
can put user messages after the results in the same request. Deliver those
messages inside the same native turn: queue them on the native input queue
before the result release, as the measurement shows. Never move content into a
tool result and never drop it. Refuse a developer or system message at that
boundary. The dsh companion integration must keep other queued user input out of
the current frozen request. If it cannot, refuse that continuation.

The adapter does not know dsh's next assistant message ID when it emits chunks.
Keep an expected publication record. Bind the new durable ID only after the next
request contains the exact published content and replay data. All previously
bound IDs must continue to match. See the transcript contract.

**3. Signature storage**

Keep the live signed blocks in the CLI transcript. Also store their complete
native JSON in the successful dsh finish chunk:

```ts
replayState: {
  response: {
    format: "claude-session-v1",
    generationId,
    cliSessionId,
    cliVersion,
    sdkVersion,
    model,
    workspace,
    requestPrefixHash,
    nativeRequestRecord,
    nativeResponseBlocks,
    toolNameMap,
    projectedContentHash
  }
}
```

Use response-level metadata, with no `blocks` field. Preserve native block order,
message grouping, thinking text, signatures, and redacted-thinking data. Store
the native request shape and CLI-added context so the dsh log can explain the
model input. Keep secrets and authentication headers out of these records.

Emit dsh reasoning blocks for display, including an empty reasoning block when
the native thinking text is empty. Never use text truthiness to decide whether
signed thinking exists. Check the native metadata and the display projection
together on the next call. Missing replay state is an error for an existing
generation. It is not permission to continue without thinking.

The stored JSON is evidence and recovery state. It is not a prompt to paste into
a fresh CLI process. The live CLI supplies its own original blocks to the next
request. No component converts a signature to ordinary text. A rollover import
uses the projected dsh text only. It never copies a stored signature or
reasoning text into the new conversation.

**4. Tool boundary**

Expose each frozen dsh tool through one MCP server named `dsh`. Use a fixed,
reversible name map. Preserve descriptions and argument schemas through a tested
conversion. Refuse a schema that the conversion cannot preserve.

The MCP handler performs no tool operation. It waits for the corresponding dsh
result. This wait includes the full dsh approval interval.

At the completed native model-response boundary:

1. Collect all native blocks and tool calls. Use partial stream events to identify
   the response boundary. Do not treat the first MCP callback as the full batch.
2. Check and save the request/response records. Emit dsh text, reasoning, and
   tool calls. End this dsh stream with a successful tool-call finish.
3. Keep the CLI and MCP replies waiting. dsh records the response and executes
   the batch through its existing tool pipeline.
4. At the next `stream()`, validate the frozen prefix and every result. Set up
   its output collector before releasing the MCP replies.
5. Supply the exact results, including errors and approval denials. The CLI can
   then make its next model request.

If user messages follow the result batch in the same frozen request, send them
on the native input queue before step 5 releases the results. The measured CLI
puts them in the same native request, after the `tool_result`, as a
CLI-generated system-role mid-turn message. This keeps one dsh stream and the
same native session. A developer or system message at that boundary is refused.
A non-offloaded image is refused until a measurement covers it. The committed
dsh transcript keeps every trailing message.

Stage results by native tool-use ID, independently of MCP callback arrival order.
This avoids a deadlock if the CLI invokes handlers one at a time. Release the
complete validated batch only after dsh has recorded it. The bridge maps text
blocks and image blocks to MCP result content in their original order. It
refuses any other result block before release. A tool result can hold several
blocks, so a text summary and its image stay in one result.

A measured arrival order limits this rule. The CLI invokes the MCP handler for a
tool call as soon as it emits that call. dsh publishes the call ids of the turn
only after the complete native turn ends. Thus the handler of every call after
the first call of a generation can arrive while the bridge still holds the
released state of the previous batch. Do not refuse that handler. Park it, and
deliver its result when `stage()` receives its batch. `expect()` refuses a
parked handler whose id is not in the newly published call list, so a stale or
unknown id fails there and not at the long result deadline. See decision D34 and
[the race record](evidence/bridge-tool-handler-race-2026-11-11.json).

For a user image, the adapter reads one exact request version from the
attachment service and sends it as a base64 image block. It writes one stable
text line before that block with the attachment identity and the request size.
The request version uses a longest edge of 1568 pixels and a target of 4 MiB.
These values match the provider vision guidance. A dsh file block never reaches
the adapter: the runtime replaces it with a read-only path handle. An offloaded
image becomes placeholder text and no bytes are read.

Bound the images of the complete dsh request before the native boundary. Count
every retained image occurrence and its exact base64 request-version bytes. The
process remembers each version size after its first read. Until then it uses
the durable file byte size as a deterministic estimate. The budget is 80
occurrences and 20 MiB of encoded bytes. These values are conservative
adaptations of the provider documentation: about 100 images for a
200000-token-context model, 5 MB for one image, and stricter resizing above 20
images. They are not a measured provider limit. When the request is above the
budget, throw `LlmError` with code `IMAGE_OFFLOAD_REQUIRED` and
`failure.offloadImages` set to the number of oldest retained occurrences that
must be offloaded. The count excess is exact before any attachment version is
read. The byte excess is checked after the version sizes are known. The dsh
image-offload plugin records one `image/offload` event and retries the step.
The live native generation stays open. The retry sends placeholder text for each
offloaded occurrence and reads no bytes for it. The request budget does not
apply to a summary import, because that import sends no image bytes and no image
blocks.

Bound the images that one native generation receives. Track the count and the
encoded bytes of every image block sent into the live generation. Before a
dispatch, add the current images. If the sum is above 80 occurrences or 20 MiB
of encoded bytes, start one new native generation with reason `image-budget`
(see section 6). The new generation receives the recorded text import, which
holds an attachment-id placeholder for every historical image, and then the
current user images. Its counters start at the current image count. The dsh
request does not change.

Use a sufficient MCP timeout. Disable background tool handling. A timeout,
interruption, truncated response, or uncertain delivery invalidates the live
generation. Do not fabricate a tool result or execute an uncertain tool again.
Disable automatic adapter retries after input or a result has reached the CLI.

**5. System prompt and available tools**

Pass dsh's assembled prompt as the SDK's custom `systemPrompt` string. Set
`cwd` to the current absolute dsh session workspace, `tools` to an empty list,
`settingSources` to an explicit empty list, and `includePartialMessages` to true.
Configure only the `dsh` MCP server. Check the selected SDK's method for strict
MCP isolation; an empty settings-source list alone is insufficient.

Use one streaming input queue and one SDK event consumer for the native session
lifetime. A dsh tool-call finish must not dispose the SDK query. Set an exact
model ID and do not permit an automatic fallback model. Obtain catalog entries
from the official SDK where supported and verify the effective model. Catalog
membership does not establish an account's current model entitlement.

Use the discovered catalog display name as the resolved model name. Keep the
exact requested id as the model id. An id with no catalog row uses the raw id as
its name. Report only the effort levels that the catalog row reports. The SDK
0.3.322 `ModelInfo` type has `supportsEffort` and `supportedEffortLevels`. It has
no `defaultEffort` field, so the plugin does not report a default effort.
Absence keeps the provider default. Do not project other discovered fields such
as `resolvedModel` or the thinking, fast-mode, and auto-mode support flags until
a dsh model field consumes them.

Keep the prompt, native tool definitions, conversion rules, and model fixed for
the generation. Record the CLI's own prompt prefix and reminders. The measurement
shows that `--system-prompt` does not remove every CLI-added input.

Resolve the model with `inputModalities: ['text', 'image']`. This makes the dsh
runtime keep image blocks for this route, and it lets the prompt admission and
the subagent admission accept images. Report the exact image target and image
price through `imageRequestTarget` and `imageRequestPricing`. The route does not
declare an image offload in the model catalog; the adapter reads the `offloaded`
flag on each occurrence.

Map a dsh `maxTokens` control to the official `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
environment control for the new native session. The value stays fixed for that
generation, as the model and effort do. A change requires a new generation.
Report a context window with `resolveModel`. The first value is a static
fallback of 200000 tokens. This value is not measured. Each native result
message reports `modelUsage`. The adapter records that entry in a process-wide
cache, keyed by the requested model id. Later `resolveModel` calls use the
measured `contextWindow`. The result message arrives after the turn's last
assistant message, so the fallback can stay in use until a later request reads
the event. Do not report `defaultMaxTokens`: the compaction reservation uses the
request `maxTokens`, or zero when the request has no cap. A materialized default
output cap would shrink the message budget with no measured benefit. See
decision D20.

Support the harness summary purposes `compaction` and `summary`. Start a
separate native session with the conversation system prompt. Send one
deterministic user text block: a header, the replayed rows as flattened text, a
separator, and the final instruction text verbatim at the end. Each row is
`[user]`, `[assistant]`, `[tool result]`, or `[tool error]`. The text excludes
signed thinking, signature text, live tool-call IDs, and image bytes. An image
becomes one metadata placeholder. The summary session has no dsh tools, so it
must produce text. The adapter returns the normal chunks. This is a recorded
textual import: the finish replay envelope reports `retentionAudit`
`unavailable` and stores no native request record, even when the summary turn
carries request evidence. See decision D21.

Accept the harness auxiliary purposes. A title call is an isolated native
session with one user message. An auxiliary purpose that replays conversation
history and has no summary mapping returns `UNSUPPORTED_INPUT`.


Do not use the host process directory as a workspace fallback or change its
shared working directory. Two dsh sessions in different workspaces must have
different native sessions with the correct `cwd`. A workspace change ends the
generation. Ensure the prompt, model identity, and environment notes agree.

The next configuration must also set `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`, disable
unneeded customizations and connectors, and prevent background operations. Set
`DISABLE_COMPACT=1`. The official environment-variable reference documents these
advisor and compaction controls. Their combined behavior in this plugin still
needs a test. [Environment variables](https://code.claude.com/docs/en/env-vars)

Disable duplicate file instructions and git guidance through supported SDK
settings and environment controls. Let dsh supply its own instructions and
skills. Inspect managed policy and global settings separately. They can apply
even with empty settings sources. Keep dsh's identity truthful. Do not alter a
prompt identity or client header to evade a billing refusal.

Do not use `--bare` as the subscription-isolation mechanism. The installed
binary's help says that this mode does not read OAuth or the keychain.

Certify an exact CLI build and effective settings. Compare its recorded native
request with the expected prompt and tools. Permit a fixed inert placeholder
only if its full definition is recorded and cannot perform an operation.
Reject any other added tool. The `advisor` measurement shows why checking only
the CLI initialization event is insufficient.

A recorded request is an audit after dispatch. It is not a synchronous guard
before dispatch. Do not enable an unknown CLI build or an uncontrolled settings
configuration on the assumption that this audit will stop an unwanted operation.

**6. Edits, compaction, model changes, and process loss**

Any earlier-message edit, deletion, replacement, or tool-result pruning ends the
generation and is refused. Never reuse the old signatures with the changed
input. A prompt, tool-list, model, effort, workspace, or output-cap change on a
live generation also ends it. The adapter recovers that change with one new
native generation and a recorded configuration change. It does not declare
`systemPromptUpdate` or `toolUpdate`, because the native launch is fixed.

If a tool call is pending and the generation cannot continue, stop the native
process without supplying invented results. Let dsh settle its existing tool
records.

When the live generation is invalid, closed, or absent and the next dsh request
continues earlier conversation, recover the session automatically:

1. Split the frozen dsh request at the last assistant message. Completed tool
   results after that message are complete outcomes. The content after them is
   the current user input.
2. Build one deterministic bounded text import of the earlier history. Quote
   user and assistant text verbatim. Quote tool names, arguments, and completed
   outcomes. Replace each image with its attachment id. State that the text is
   historical context from a new Claude session, with no previous thinking and
   no live tool calls.
3. Close the old generation with a bounded close. Start one new native session
   with the current model, effort, output cap, workspace, system prompt, and
   tools.
4. Send the import and the current pending content as one user turn. The dsh
   request does not change. For a tool-result continuation, the import holds the
   completed outcomes and the model answers as a normal user turn. The adapter
   releases no old MCP handler.
5. Store a `generationChange` record in the replay data of the successful turn.
   The record holds the reason (`abort`, `timeout`, `process-loss`, `restore`,
   `fork`, `configuration-change`, `image-budget`, or `invalid`), the replaced
   generation and CLI session ids when known, the imported message count, the
   imported prefix hash, and the timestamp. The dsh log keeps this record.
6. A configuration change also records the changed fields in a stable order:
   model, effort, output cap, workspace, system prompt, and tools. The new
   native session receives the new values. An earlier-prefix edit still returns
   `REBASE_REQUIRED` before any new generation starts.
7. An image-budget change records reason `image-budget` with no changed fields.
   It does not change the configuration. The adapter starts it when the next
   native turn would put the live generation above its conservative retained
   image limit. The import has image placeholders only, and the new generation
   receives the current user images. The dsh session continues. For a
   tool-result continuation, the completed outcomes are quoted in the import.
   A tool-result image becomes a placeholder and does not reach the new
   generation.

The compaction service records the replacement surface. The adapter only
produces the summary text, as a recorded textual import (see section 5). The next
request after the replacement surface must use a recorded new generation. If none
exists, the adapter returns `REBASE_REQUIRED` and keeps the old generation
intact. Ordinary partial compaction, which keeps a signed recent tail after
changing its prefix, must return `REBASE_REQUIRED`. Do not flatten the frozen
transcript inside the adapter for a live turn.

A model change continues with a recorded configuration change (step 6). The
switch check can price the proposed model because `resolveModel` reports a
context capacity. A pressure compaction at the switch boundary can run its
summary call. A live dsh profile run of the token meter and the model switch is
not measured.

The replay data is the recorded import. This is a new model conversation. It
does not keep the old signed thinking, and it does not claim to. The dsh session,
the dsh log, the tools, and the approvals continue.

A forked subagent uses the same rule on its first request. Its request carries
the parent assistant replay state and no live process. The session header marks
the fork origin, so the record uses reason `fork` instead of `restore`.

An exact new user message that equals a request that was already dispatched is
refused with `NATIVE_OUTCOME_UNKNOWN`. The adapter does not send it a second
time.

Native resume remains a test candidate. Saved signatures alone do not establish
that a new process resumes the same native request.

**7. Refuse API billing and extra usage before inference**

Construct an environment from an explicit allowlist. Exclude API keys, auth-token
overrides, alternate endpoints, provider selectors, and custom headers. Ignore
user and project credential helpers. Reject any effective managed helper or
alternate provider. The plugin must not run a helper to obtain an API key.

Run the official `claude auth status` with the same environment and settings
before sending model input. Require `loggedIn: true`, `authMethod: "claude.ai"`,
and `apiProvider: "firstParty"`. Refuse unknown fields or values that prevent a
clear decision. Never accept Console login or an environment token as a fallback.
The official CLI documents this status command.
[CLI reference](https://code.claude.com/docs/en/cli-reference)

Cache one accepted auth result for 60 seconds. The cache scope contains the
executable, the home, the workspace, each settings file's modification time and
size, and the allowlisted environment values. Run the settings safety check on
every call, also on a cache hit. Do not cache a refusal. The plugin cannot read
the current account binding without the auth command. The short interval bounds
an unnoticed login change. A caller can give the account binding that it
requires. A cache hit is valid only for that binding, and a different result
returns `AUTH_ROUTE_REFUSED`.

The account must also have paid usage credits disabled before the first request,
and they must remain disabled throughout the session. Anthropic states that
disabled usage credits limit access to the plan's included usage.
[Usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)

The saved probe reported `overageEnabled: false` and `isUsingOverage: false`.
That event followed inference. It cannot authorize the first request, and it
does not prove the account setting remains unchanged.

The inspected CLI has no measured request-level subscription-only spend control.
An auth-status check does not establish the usage-credit setting. Neither
`--max-budget-usd`, a cost estimate, nor hiding the usage-credit purchase command
proves that a request cannot incur a charge.

On 2026-11-10 the user changed this requirement. A lock that keeps extra usage
off for the whole session is useful. It is not required. A first-party
subscription login may send a prompt. The absence of the lock does not return
`BILLING_GUARD_UNAVAILABLE`. An API key, a console login, and a changed billing
endpoint stay refused. A usage reading can still report `extra_usage.is_enabled`.
That reading does not block the prompt.

Anthropic currently states that subscription login for the SDK and `claude -p`
uses subscription limits. That statement supports the login choice; it does not
disable paid overflow. [Subscription use](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

**8. Tamper test and release test**

Run the offline checker against the original CLI session log and stream output:

```sh
python3 scripts/verify_thinking.py SESSION.jsonl OUTPUT.ndjson --self-test
```

The checker reconstructs the two recorded requests from their message references.
It compares the second request's thinking with the independent original output.
It also checks the model, system, tools, earlier message prefix, and paired tool
IDs. For tool calls only, it removes the response-only `caller: {type: "direct"}`
field before comparison. It does not normalize thinking text or signatures.

The baseline passed. Three modified request records failed: a removed thinking
block, a changed signature character, and a changed thinking character. Each
modified record has a new valid message hash and an updated request reference.
Thus, a stale message hash is not the reason for failure. The saved successful
answer remains present in these tests; answer success cannot hide dropped
thinking. The checker makes no model call and has no network code.

These are mutations of saved evidence. They do not measure the server response
to a damaged signature. Before release, run an additional controlled test through
the official CLI: preserve a valid signed tool turn, then alter a test copy at
that tool boundary and observe the next native request. Require either a local
refusal before submission or the unchanged damaged block in the request followed
by a server rejection. A successful continuation that drops the block fails the
test. Repeat with zero-length thinking. Use no direct API request or OAuth replay.

Any SDK test that cannot safely introduce a changed native block must report that
server-negative test as unverified. Do not modify the official executable or
forge a request to complete it. The exact outgoing-content check remains
mandatory, even if a server-negative test is not available.

Also test parallel tools, delayed approvals, denial results, cancellation,
context overflow, restart, the dsh persistence cycle, and all change boundaries.
Run these tests on dsh 0.2.2-rc.1 and each supported later release. Check required
capabilities at load time; do not promise compatibility with an untested future
release. Keep the provider out of the selectable catalog until its release
conditions pass.

**9. Native turn failures and truncated answers**

The official SDK sends one result message for each turn. The result reports the
outcome of that turn. Map the result to native events with one pure function.
The function reads these facts and does not import the SDK:

- The result subtype.
- The `is_error`, `errors`, and `api_error_status` fields.
- The result `stop_reason` and text.
- The error value of the latest assistant message.

Map the facts to stable dsh codes, because dsh routes recovery on the code and
not on the message text. `dsh-compaction-basic` starts its context-overflow
recovery only for `CONTEXT_WINDOW_EXCEEDED`. The retry policy uses
`RATE_LIMIT`, `QUOTA`, and `AUTH`. The old behavior collapsed every native error
into `MALFORMED_RESPONSE`, and dsh could not tell the failures apart.

The dsh classifiers `isContextWindowExceededError` and `isQuotaExceededError`
read the generic provider wording. The Claude API reports an oversized request
as "prompt is too long: N tokens > M maximum", and it reports a low balance as
"credit balance is too low". The first form does not match the generic
context-overflow pattern. The second form does not match the generic quota
pattern. The mapper recognizes these two Claude forms and then uses the same
stable codes. Record these additions in the decision file.

A native error does not pass through as a normal response. The native session
emits one `turn-error` event with the mapped failure. The adapter throws one
`LlmError` with that code. The dsh LLM runtime converts the throw into a
terminal `error` finish, and the agent `agent/request-error` listeners then
receive the code. A complete assistant response is never reported twice: an
error result that follows its `message-stop` is ignored. A `turn-error` event
before any stop fails the turn. The generation then becomes invalid, as for
every other adapter error.

Keep the native message text in the failure. Remove tokens, authentication
headers, account identities, email addresses, and long opaque values. Bound the
message length. Carry a usable HTTP status when the native result reports one.

A `stop_reason` of `max_tokens` is a truncation, not a complete answer. The
assistant message stop and the result stop can both carry it. Translate it to
the native stop `max_tokens` and then to the dsh finish
`{ kind: 'max-tokens' }`. Keep the replay state. Never emit a `stop` finish for
it. A turn that hits the output-token limit and also carries a tool call is not
safe: the plugin refuses the turn with `MALFORMED_RESPONSE` and does not execute
the call. The answer text of a truncated turn can be incomplete.

The SDK can attach usage to a streamed assistant message whose `stop_reason` is
null. The adapter emits usage from that message when it is present, independent
of the stop reason. It keeps at most one usage event for a native turn, because
the dsh translation refuses a repeated usage. A tool-call block with no explicit
stop adds the synthetic `tool_use` stop after the usage. The result message
supplies usage when no assistant message had it.

The evidence for this section is offline. It uses synthetic SDK result objects
and the scripted native runtime. No live provider error was produced.

**10. Limits of this design**

This design does not make the CLI a stateless transcript API. It does not allow
arbitrary transcript import, silent mid-tool context updates, or signature reuse
after a changed prefix. Its recorded textual import does not preserve signed
thinking. It does not remove subscription limits, establish a subscription-only
billing switch, or prove crash-safe native resume.

The context window is a fallback until the native runtime reports one. The
summary call, the continuation after a replacement surface, the dsh token meter,
and a model switch after compaction are offline paths only. They need a live dsh
profile test. The summary path is a textual import with no signed history. It
does not keep the native signed prefix across the compaction.

The image request budget and the retained-image generation threshold are
offline-tested only. The many-image probe did not reach the provider image
limit. The exact provider limit, the behavior at 600 or more images, and the
image byte limit remain unmeasured. The 80-image and 20 MiB values are
conservative adapter constants, not a provider boundary.

It does not establish that fresh-process replay or a relay can never work.
Those paths are outside this design. The existing measurements support one

It does not establish a measured image path for a trailing mid-turn message, and
it does not claim signed-thinking retention across such a message. It does not
establish that fresh-process replay or a relay can never work. Those paths are
outside this design. The existing measurements support one
persistent CLI tool turn, an offline preservation check, and two synthetic
image paths through the official SDK. They do not close other paths or establish
a production-ready plugin.

The plugin cannot guarantee Anthropic's acceptance of a truthful dsh prompt or
the account's future billing classification. It cannot promise custom dsh HTTP
attribution headers through the SDK unless an official supported interface is
found and tested. Keep local attribution in dsh. The content mapping, the image
limits, the native error mapping, and the explicit refusals are specified in
[contracts.md](contracts.md).

The native error codes and the `max-tokens` finish are offline-tested only. The
plugin has no live measurement of a provider error and no live measurement of
the dsh recovery path. Context-overflow recovery also needs the recorded new
generation from section 6. Until that path exists, the dsh retry of the step
returns `REBASE_REQUIRED`.
