# Implementation contracts

This file specifies planned interfaces. They are not implemented exports. Verify
the installed dsh and SDK declarations before writing integration code. The
design controls behavior when a type example omits a detail.

## Package and module layout

Use TypeScript with ESM. Target Node 24.9 or later and dsh 0.2.2-rc.1. Pin the
selected SDK and development dependencies in a lockfile. Keep dsh runtime
packages as peers so the plugin and host use the same service classes.

Use package name `dsh-plugin-claude-code` and provider route
`claude-code-session`. This avoids the existing provider's `claude-code` route.
Refuse duplicate registration. Start with a host plugin and a bundle patch;
custom client UI is outside the first release.

Planned source files:

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Cordis registration, settings, and ordered disposal |
| `src/adapter.ts` | `LlmAdapter`, preparation, catalog, stream entry |
| `src/sdk-runtime.ts` | Official SDK process and input queue |
| `src/session-manager.ts` | Session map, generation locks, and state |
| `src/capacity.ts` | Measured context capacity cache and the documented fallback |
| `src/transcript.ts` | Frozen input validation, projection, and hashes |
| `src/replay.ts` | Versioned replay data, generation-change records, and consistency checks |
| `src/rollover.ts` | Deterministic bounded textual import and recovery boundary split |
| `src/mcp-bridge.ts` | Tool definitions, waiting handlers, result mapping |
| `src/stream.ts` | Partial events, completed blocks, usage, and finish |
| `src/native-failure.ts` | Pure native result mapping, message cleanup, and dsh error conversion |
| `src/context.ts` | dsh workspace and prompt integration |
| `src/rebase.ts` | Recorded context replacement and generation reset |
| `src/summary-import.ts` | Deterministic textual import for a summary auxiliary call |
| `src/auth.ts` | Environment filtering and official auth-status check |
| `src/spend-gate.ts` | Evidence-based pre-inference spending decision |
| `src/evidence.ts` | Native request audit and private diagnostic files |
| `src/errors.ts` | Stable failure codes and dsh failure conversion |
| `test/` | Node test-runner tests and scripted SDK transport |
| `scripts/` | Packaging checks and explicit live-test entry points |

Use `dist/` for build output. Do not commit it. The `prepare` script
(`npm run build`) builds it when a package manager installs the repository as a
Git dependency and before `npm pack`. A packed archive carries the compiled
files. The Git tree does not.

## dsh adapter

Register with `ctx.llm.registerAdapter([route], adapter)`. Implement `stream`,
`listModels`, `resolveModel`, and a provider retry policy. Inspect `prepareCall`
to keep model/configuration resolution in one captured adapter generation.
Use the public package exports, not another adapter's private functions.

Read `GenerateOptions.sessionId`, `messages`, `system`, `tools`, model,
reasoning controls, limits, and abort signal. Reject an unsupported control
before dispatch. Do not silently ignore sampling fields or stop sequences.
A model that reports effort support offers that model's levels. The selected
level is fixed for the native generation. A later change starts one new
generation with the new level and a recorded `configuration-change`. A closed or
absent generation recovers with a new generation and one recorded textual
import. An earlier-prefix edit returns `REBASE_REQUIRED`.

`resolveModel` uses the catalog display name for `name` when the discovered row
exists. It keeps the exact requested id for `id`. An uncatalogued id uses the raw
id as its name. The SDK 0.3.322 `ModelInfo` declares `supportsEffort` and
`supportedEffortLevels` and no `defaultEffort`. Do not return
`reasoning.defaultEffort`: absence keeps the provider default. Do not project
other discovered fields, such as `resolvedModel`, until a dsh model field uses
them.

Resolve every model with `inputModalities: ['text', 'image']`. The catalog entry
uses the same value. An image-capable route receives ImageBlock values. A
text-only route receives stable placeholder text from the runtime. Implement
`imageRequestTarget` and `imageRequestPricing` for the exact request projection.
The target caps the longest edge at 1568 pixels and the encoded bytes at 4 MiB.
The price uses about one visual token for each 750 pixels.

Map `maxTokens` to the official `CLAUDE_CODE_MAX_OUTPUT_TOKENS` child
environment control. The exact value is part of the generation identity. A
change starts one new generation with a recorded `configuration-change`. The
value is not a sampling field and must not be dropped. Reject a non-positive or non-integer value before dispatch.

`resolveModel` returns `context: { contextWindow }` for every model. The first
value is the documented static fallback of 200000 tokens. It is not measured.
Each native result message reports `modelUsage`. The adapter records that entry
in a process-wide cache, keyed by the requested model id, and later calls use
the measured `contextWindow`. Do not return `defaultMaxTokens` unless a measured
consumer needs it. The compaction reservation uses the request `maxTokens`, or
zero when the request declares none. See decisions D20 and D21.

Accept every auxiliary `purpose` value that the harness declares. Each
auxiliary call uses a separate native session with the same admission checks. A
title request that carries one user message is supported. The summary purposes
`compaction` and `summary` are supported through a recorded textual import. The
new native session receives the conversation system prompt and one user text
block with the flattened rows and the final instruction last. The import
excludes signed thinking, signature text, live tool-call IDs, and image bytes.
The summary session declares no dsh tools. Any other auxiliary purpose that
replays conversation history returns `UNSUPPORTED_INPUT`.

Do not declare `systemPromptUpdate` or `toolUpdate` for the first release.
The generation uses one fixed prompt and the current tool list. The agent loop
always sends `toolHistory`. The runtime removes developer tool updates before
dispatch. The adapter ignores `toolHistory`. A `developer` message still returns
`UNSUPPORTED_INPUT`.

Map finishes to the minimum version's actual union:

```ts
{ type: 'finish', reason: { kind: 'tool-calls' }, replayState }
{ type: 'finish', reason: { kind: 'stop' }, replayState }
{ type: 'finish', reason: { kind: 'max-tokens' }, replayState }
{ type: 'finish', reason: { kind: 'error', failure: { code, message } } }
{ type: 'finish', reason: { kind: 'aborted', failure: { code, message } } }
```

A `max-tokens` finish reports a truncated turn. It keeps the replay state. It
is never a `stop` finish, because the answer can be incomplete. A native turn
that hits the output-token limit and also carries a tool call is not safe: the
plugin refuses it with `MALFORMED_RESPONSE` and does not execute the call.

Emit exactly one finish and no later chunks for a dsh stream. Tool arguments are
raw JSON strings in dsh. Reject malformed completed arguments before tool
publication. A generation error invalidates any incomplete native response.
Emit the usage chunk before the finish. Keep the cache read and cache write
token counts when the native message reports them.

## SDK boundary

Hide the SDK behind an internal `NativeRuntime` interface. Tests inject a
scripted implementation through code, not a user configuration option.

```ts
interface NativeRuntime {
  start(config: NativeSessionConfig): Promise<NativeSession>;
}
interface NativeSession {
  readonly events: AsyncIterable<NativeEvent>;
  sendUser(input: NativeUserInput): Promise<void>;
  close(): Promise<void>;
}
```

This interface is illustrative. Include the MCP bridge in `NativeSessionConfig`.
Use one SDK event consumer for the process lifetime. Per-stream output queues
subscribe to that consumer. Ending a dsh stream at a tool call must not call
`return()` on, dispose, or close the native SDK query.

`NativeUserInput` carries an ordered content list, not only a string. A text
block maps to a Messages text block. An image block maps to a base64 image block
with the media type of the request version. When the list holds text only, send
one string. The tool handler returns MCP content items in the same way: text
items keep their text, image items keep their base64 data and media type.

Use a streaming input queue that remains open between dsh streams. Start its
consumer before supplying input. Do not create a second SDK query for a tool
continuation. The bridge returns the tool result inside the existing query.

The native event stream also carries informational events that are not response
blocks. `native-tool-list` reports the tool names of the initialization event.
`request-evidence` carries the diagnostic request record. `model-usage` carries
the requested model id, the SDK model key, and the `contextWindow` and
`maxOutputTokens` values of one `modelUsage` entry. The adapter records
`model-usage` in the capacity cache and the turn translation ignores it. The
result message is the only producer of that event.

Select the user's installed official executable through the SDK's supported
executable-path option. Verify its reported version. Do not silently select a
different bundled binary. Pin and test the SDK/CLI pair; a newly installed CLI
needs a new compatibility result before production inference.

SDK configuration must set the session workspace, the exact dsh custom prompt,
empty built-in tools, explicit empty settings sources, partial events, the sole
`dsh` MCP server, and the exact model. Disable Claude compaction, background tools,
advisor, unneeded context discovery, and automatic model fallback through
supported controls. A full allowlisted environment replaces inherited values.

Use normal subscription login. Do not use bare mode, an injected OAuth token, an
API-key login, an alternate model endpoint, or a changed client identity. Managed
and global settings need separate inspection; empty settings sources do not
prove isolation. The initialization event is not the complete native tool list.

SDK method names and semantics are version-dependent. Implement and test this
mapping before relying on it. Do not claim a flag was applied because it was
present in an options object.

One SDK message is the turn result. It reports the turn outcome. Translate one
result into native events with a pure function. The function reads the result
subtype, `is_error`, `errors`, `api_error_status`, `stop_reason`, the result
text, and the latest assistant message error. It does not import the SDK.

Use these native events for a turn:

```ts
{ type: 'message-stop'; messageId; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }
{ type: 'turn-error'; failure: { code, message, status? } }
```

A result that reports a turn error produces one `turn-error` event. Do not
produce that event when a `message-stop` already published a complete assistant
response: the response is usable and the error is not reported twice. Stop the
read at a `message-stop` or at a `turn-error`. A `turn-error` before a stop
makes the adapter throw one `LlmError` with the stable code. The dsh LLM runtime
turns that throw into a terminal `error` finish. The agent
`agent/request-error` listeners then receive the code. For example,
`dsh-compaction-basic` runs its context-overflow recovery only for
`CONTEXT_WINDOW_EXCEEDED`.

## Session identity and state

Key each live session by the dsh session ID and plugin generation ID. The map
also binds its absolute workspace path. A workspace is not a session identity.
An auxiliary request uses a separate key with its request purpose and unique
call ID; it can never release a conversation's pending tool results.

An auxiliary stream always releases its key after the bounded close or the
invalidation. The release refuses a conversation generation. A later call with
the same auxiliary key starts a new native session.

Listen for the dsh `session/disposed` event. Close the conversation generations
of the disposed session through the bounded `closeKey` path. Do not close an
auxiliary call or a different session. A disposal with no live generation is a
no-op. The plugin-unload effect closes every owned process.

| State | Accepted operation | Next state |
| --- | --- | --- |
| `NEW` | Validate configuration, auth, and spend policy | `STARTING` or `INVALID` |
| `STARTING` | SDK initialization without a model prompt | `READY` or `INVALID` |
| `READY` | Admit a new, validated user input | `GENERATING` |
| `READY` or `WAITING_FOR_RESULTS` | Current fixed configuration differs from the live generation | `CLOSED`, then a new `STARTING` generation |
| `GENERATING` | Receive a complete tool-call response | `WAITING_FOR_RESULTS` |
| `GENERATING` | Receive a completed final response | `READY` |
| `WAITING_FOR_RESULTS` | Validate the full dsh result batch and release it | `GENERATING` |
| Any live state | Abort, divergence, timeout, unknown outcome, or process loss | `INVALID` |
| Any live state | dsh disposes the owning session | `CLOSED` |
| `INVALID` | A conversation request with new content recovers one new generation | `CLOSED`, then `STARTING` |
| `INVALID` | Plugin unload or no further request | `CLOSED` |

Serialize admission for each key. Reject a concurrent stream with `SESSION_BUSY`;
do not serialize a tool continuation behind an unresolved earlier stream. The
earlier dsh stream has already finished at the tool boundary.

Record when input crosses the native boundary. A timeout after that point has
an unknown inference outcome. Do not retry it as a fresh request. A generation
that enters `INVALID` never returns to `READY`.

A recovery admission has kind `recovered`. It writes the complete frozen request
to `committed`, so the next request compares equal and its publication binds.
The new generation starts a new publication. It does not bind the pending
publication of the replaced generation. A configuration change uses the same
admission and closes the old generation. A parked MCP handler is cancelled, not
released.

An exact repeat of a request that the failed generation already dispatched
returns `NATIVE_OUTCOME_UNKNOWN`. The adapter sends no second copy of that input.

## Transcript and replay data

Use deterministic JSON encoding with sorted object keys and preserved array
order. Do not trim text, normalize Unicode, reorder tools, or simplify schemas.
Bind model-visible content and all mapping controls. Compare durable IDs for
messages that already have IDs. Keep the snapshot detached from frozen inputs.

There is one special identity rule: the adapter does not allocate dsh's next
assistant message ID. At finish, keep a `pendingPublication` with the complete
emitted content, replay data, native message IDs, and request-prefix hash. On the
next call, require the newly stored assistant message to match that publication
exactly, then bind its dsh ID once. A missing, duplicated, edited, or relocated
publication is an error. Never guess a future dsh message ID.

Validate in this order before releasing a result:

1. Session key, generation, workspace, and controls agree.
2. Every committed earlier message, including its ID, agrees.
3. The pending publication has the exact content and valid replay data.
4. The suffix contains exactly one result for each pending call, in dsh's stored
   order, with no unknown, duplicated, or missing call ID.
5. No queued user/developer/context update has entered the tool-result suffix.

Record the request before `stream()` in dsh when a transformation changes the
model-visible input. `stream()` cannot replace frozen messages. Ordinary role
conversion must be documented and deterministic. Reject a role or content form
that cannot be represented faithfully through the SDK.

The successful response-level replay envelope contains:

```ts
interface ReplayV1 {
  format: 'claude-session-v1';
  generationId: string;
  cliSessionId: string;
  cliVersion: string;
  sdkVersion: string;
  model: string;
  workspace: string;
  requestPrefixHash: string;
  projectedContentHash: string;
  nativeRequestRecord: unknown;
  nativeResponseBlocks: readonly unknown[];
  toolNameMap: Readonly<Record<string, string>>;
  generationChange?: GenerationChangeV1;
}
// Store as { response: replayV1 }; omit ReplayEnvelope.blocks.
```

The recovery record in the replay envelope has this shape:

```ts
interface GenerationChangeV1 {
  reason: 'abort' | 'timeout' | 'process-loss' | 'restore' | 'fork'
    | 'configuration-change' | 'image-budget' | 'invalid';
  fromGenerationId: string | null;
  fromCliSessionId: string | null;
  importedMessageCount: number;
  importedPrefixHash: string;
  createdAt: string; // ISO time
  changedFields?: readonly string[];
}
```

The recorded import has these rules:

- Split the frozen request at the last assistant message. A tool batch after
  that message is a complete outcome. The rest is the current user input.
- Quote user and assistant text verbatim. Quote tool names, arguments, and
  completed outcomes. Omit reasoning text and tool-call ids.
- Replace each historical image with its attachment id. Read no image bytes.
- State that the text is historical context from a new Claude session with no
  previous thinking and no live tool calls.
- Bound the text with a documented maximum and an explicit omission mark. The
  same projected history returns the same text.
- Do not send old native blocks as the import. The dsh log keeps them.
- The successful turn stores one record. The import, not a saved signature, is
  the recovery evidence.
- A `configuration-change` record has a non-empty `changedFields` list. The
  order is model, effort, output cap, workspace, system prompt, and tools.

Use runtime validation for this data. Add response grouping and ordering fields
as needed; they must remain lossless JSON. Do not recursively embed earlier
dsh replay envelopes in the native request record. For the first version, a
complete native request can be stored at each finish. Bound its size and fail
before dispatch if the full required audit cannot fit. Never truncate signed
content to fit a storage limit. Later deduplication needs durable references
that survive dsh export and restore.

Do not put opaque native data into visible text. Treat redacted thinking as an
opaque native block. Zero-length thinking plus a signature is present thinking.
The display projection can be empty; the original native data must remain.

A summary auxiliary finish always stores `retentionAudit: 'unavailable'` and a
null `nativeRequestRecord`, even when its own turn carries complete request
evidence. The flattened textual import is not a signed native prefix. Store the
normal response blocks and usage only.

## MCP calls and response boundaries

Create a stable reversible tool-name map. Detect collisions after encoding and
check native name limits. Keep tool descriptions and full JSON Schema intact.
The SDK's convenience schema conversion is not permission to drop keywords.
Use a lower-level supported MCP server if the selected helper cannot preserve
the schema. That is a bridge detail, not a transport change.

Collect a response's blocks from partial events and final SDK blocks without
double publication. Use the native message ID plus block index as the key.
`message_stop` with its final stop reason determines the complete batch. Do not
wait for the final SDK query result while a tool handler is parked; that would
deadlock. Confirm the ordering with the selected SDK.

Preserve the provider tool-use ID as the dsh call ID. Do not correlate only by
tool name or argument equality. If tool IDs are absent from the handler API,
measure a supported way to correlate them. Do not match two identical parallel
calls by arrival order.

All results must be validated and staged before any handler receives a reply.
Handlers may arrive one at a time, after the full batch was published. Deliver
each staged result once when its exact handler arrives. Keep duplicate delivery
and unknown IDs as errors. Returning an error result is permitted only when
dsh has recorded that outcome.

Content mapping for this route:

| dsh block | Native mapping | Notes |
| --- | --- | --- |
| text | text block or text MCP item | Exact text, no trimming |
| image | base64 image block or image MCP item | Request version with at most 1568 px on the longest edge and 4 MiB target |
| file | none | The dsh runtime replaces it with a read-only path handle before dispatch |
| reasoning, tool-call | assistant output only | Not valid user or tool-result content |

An image is valid in a user message and in a tool-result message. It is not
valid in a system or assistant message. The adapter writes one stable text line
before each image. That line names the attachment and its request dimensions.
An offloaded image becomes placeholder text and its bytes are not read. A
missing attachment service returns `UNSUPPORTED_INPUT` before dispatch. Any
other block type returns `UNSUPPORTED_INPUT` before dispatch or result release.
The request snapshot keeps the durable attachment reference, not the request
bytes. The `offloaded` flag is not part of the snapshot, because it changes
projection text and not logged message identity.

## Workspace, prompts, and rebase

Resolve the current absolute workspace from dsh's session/agent services. The
minimum version's session header includes workspace metadata, but a current
working-directory service can change it. Find and test the authoritative path
before implementation. Refuse a missing or inconsistent path; never fall back
to `process.cwd()`. Do not change the shared process directory.

Resolve one leading dsh system prompt. Reject conflicting `options.system` and
system messages. Do not silently fold a later system or developer update into
a user message. A change requires rebase unless its exact native mapping has
been implemented and accepted for a later release.

At a balanced tool boundary, the companion dsh integration records one complete
new user-context import that replaces the prior active conversational surface.
Preserve the leading prompt as required by dsh. The exact import states that
it is historical context, includes completed tool outcomes, and includes no old
signed thinking or active tool IDs. Preserve the old events in the raw log.

The adapter also recovers a closed or absent generation without a user command.
It starts a new native session and sends the bounded textual import plus the
current pending content. It records the change in the replay data of the
successful turn. This path does not change the frozen dsh request.

Use public session and compaction APIs. Verify replacement coordinates and flush
durability through the agent-owned persistence lifecycle. A detached
`ctx.sessions.create()` does not itself prove persistence. Do not invent an
`agent/rebase` hook or mutate the agent's current frozen request.

A fixed-configuration change on a live generation starts one new generation
with the current configuration and a recorded `configuration-change`. An
earlier-prefix edit still returns `REBASE_REQUIRED`. Do not mark edits and
compaction as supported until their integration tests pass.

## Authentication and spend checks

`AuthGuard` returns an accepted official subscription identity or a refusal.
Filter the environment and reject credential helpers before running an auth
command that could execute one. Use only the official CLI for login status.
Account IDs are private; store a local identity binding, not credentials.

`AuthGuard` caches one accepted result for a short interval. The default is 60
seconds. The cache scope contains the executable, the home, the workspace, each
settings file's modification time and size, and the allowlisted child
environment values. The settings safety check runs on every call. A refusal is
not cached. A caller can supply an expected account binding: a cache hit is used
only for that binding, and a different result returns `AUTH_ROUTE_REFUSED`. The
first-party subscription check runs when the cache is cold or its scope changed.

`SpendGate` returns one of:

```ts
type SpendDecision =
  | { allowed: true; policyId: string; validFor: string }
  | { allowed: false; code: 'BILLING_GUARD_UNAVAILABLE' | 'PAID_USAGE_REFUSED' };
```

`allowed: true` requires an official atomic no-paid-usage request control or
verified account enforcement that cannot change during execution. Define the
scope, expiry, and invalidation of that proof. A percentage below a quota limit
is not proof. The current production implementation must return unavailable
until accepted evidence exists. A scripted gate can allow offline tests only.

Guard every inference path: conversation, title, compaction summary, catalog
fallback probe, and any SDK background request that uses a model. A nonbillable
SDK initialization is not permission to release a model prompt. Never use a
real model call to test whether a billing guard works.

## Failures and cleanup

Use stable plugin failure codes. Map them to dsh `LlmFailure.code` without losing
their names. They are non-retryable unless the failure is proven pre-dispatch.

| Code | Meaning |
| --- | --- |
| `INCOMPATIBLE_RUNTIME` | Required dsh, SDK, CLI, or diagnostic feature is absent |
| `AUTH_ROUTE_REFUSED` | Authentication could use a disallowed billing route |
| `BILLING_GUARD_UNAVAILABLE` | No accepted proof prevents a paid request |
| `PAID_USAGE_REFUSED` | A paid route or paid-only model is known |
| `REBASE_REQUIRED` | An earlier message prefix or identity changed, or a reset has no balanced boundary |
| `SESSION_BUSY` | Another stream owns admission for this native session |
| `REPLAY_STATE_INVALID` | Replay data is missing or inconsistent |
| `NATIVE_CONTEXT_MISMATCH` | Native prompt, tools, or context differ |
| `UNSUPPORTED_INPUT` | A content type, schema, role, or control cannot be preserved |
| `TOOL_RESULT_MISMATCH` | Result IDs, counts, order, or data disagree |
| `MALFORMED_RESPONSE` | Completed model output cannot be used safely |
| `NATIVE_OUTCOME_UNKNOWN` | Dispatch or result delivery may have occurred, or the request repeats a dispatched request after a failed generation |

A native turn result maps to a dsh provider-neutral code. These codes are not
plugin codes, but they are stable and dsh routes on them.

| Native result fact | dsh code |
| --- | --- |
| Context-overflow wording, including the Claude "prompt is too long" form | `CONTEXT_WINDOW_EXCEEDED` |
| Quota or usage-limit wording | `QUOTA` |
| First-party credit, balance, or billing wording | `ACCOUNT_QUOTA` |
| HTTP 429, rate-limit wording, or assistant error `rate_limit` | `RATE_LIMIT` |
| HTTP 401 or 403, auth wording, or an auth assistant error | `AUTH` |
| HTTP 5xx, overload wording, or assistant error `overloaded` or `server_error` | `SERVER` |
| Result subtype `error_max_turns`, `error_max_budget_usd`, or `error_max_structured_output_retries` | `MALFORMED_RESPONSE` |
| Result subtype `error_during_execution` | `NATIVE_OUTCOME_UNKNOWN` |
| Any other unreadable turn error | `MALFORMED_RESPONSE` |
| A `max_tokens` stop reason | No failure. Use a `max-tokens` finish. |

Keep the native message text in the failure message. Remove credentials,
authentication headers, account identities, email addresses, and long opaque
values before the message leaves the plugin. Bound the message length. Put a
usable HTTP status on the failure when the native result reports one. An
unreadable turn error is non-retryable.

An abort yields dsh's `aborted` finish and closes the native generation. Do not
send a fabricated tool result to make the SDK stop. Close gracefully, then end
only owned child processes after a bounded deadline. A watchdog must reap the
process even if the async event iterator is blocked. Plugin unload waits for
cleanup, disposes the registration, and leaves dsh's durable outcomes intact.
One dsh session disposal closes only its matching conversation generation. A
close that exceeds its deadline returns `NATIVE_OUTCOME_UNKNOWN`. The dsh event
dispatcher contains and logs a listener rejection.

Do not expose account IDs, signatures, request bodies, or auth output in ordinary
logs. Native signatures belong in protected session replay data. Private audit
files need restrictive permissions and must not enter the published package.
