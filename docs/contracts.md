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
| `src/transcript.ts` | Frozen input validation, projection, and hashes |
| `src/replay.ts` | Versioned replay data and consistency checks |
| `src/mcp-bridge.ts` | Tool definitions, waiting handlers, result mapping |
| `src/stream.ts` | Partial events, completed blocks, usage, and finish |
| `src/context.ts` | dsh workspace and prompt integration |
| `src/rebase.ts` | Recorded context replacement and generation reset |
| `src/auth.ts` | Environment filtering and official auth-status check |
| `src/spend-gate.ts` | Evidence-based pre-inference spending decision |
| `src/evidence.ts` | Native request audit and private diagnostic files |
| `src/errors.ts` | Stable failure codes and dsh failure conversion |
| `test/` | Node test-runner tests and scripted SDK transport |
| `scripts/` | Packaging checks and explicit live-test entry points |

Use `dist/` for build output. Do not commit it. A packed archive carries the
compiled files. The git tree does not. Do not add a `prepare` script.

## dsh adapter

Register with `ctx.llm.registerAdapter([route], adapter)`. Implement `stream`,
`listModels`, `resolveModel`, and a provider retry policy. Inspect `prepareCall`
to keep model/configuration resolution in one captured adapter generation.
Use the public package exports, not another adapter's private functions.

Read `GenerateOptions.sessionId`, `messages`, `system`, `tools`, model,
reasoning controls, limits, and abort signal. Reject an unsupported control
before dispatch. Do not silently ignore sampling fields or stop sequences.
A model that reports effort support offers that model's levels. The selected
level is fixed for the native generation. A later change returns
`REBASE_REQUIRED`.

Resolve every model with `inputModalities: ['text', 'image']`. The catalog entry
uses the same value. An image-capable route receives ImageBlock values. A
text-only route receives stable placeholder text from the runtime. Implement
`imageRequestTarget` and `imageRequestPricing` for the exact request projection.
The target caps the longest edge at 1568 pixels and the encoded bytes at 4 MiB.
The price uses about one visual token for each 750 pixels.

Map `maxTokens` to the official `CLAUDE_CODE_MAX_OUTPUT_TOKENS` child
environment control. The exact value is part of the generation identity. A
change returns `REBASE_REQUIRED`. The value is not a sampling field and must
not be dropped. Reject a non-positive or non-integer value before dispatch.

Accept every auxiliary `purpose` value that the harness declares. Each
auxiliary call uses a separate native session with the same admission checks. A
title request that carries one user message is supported. A summary or
compaction request that carries assistant history returns `UNSUPPORTED_INPUT`
because a new native session has no signed prefix to continue.

Do not declare `systemPromptUpdate` or `toolUpdate` for the first release.
The generation uses one fixed prompt and the current tool list. The agent loop
always sends `toolHistory`. The runtime removes developer tool updates before
dispatch. The adapter ignores `toolHistory`. A `developer` message still returns
`UNSUPPORTED_INPUT`.

Map finishes to the minimum version's actual union:

```ts
{ type: 'finish', reason: { kind: 'tool-calls' }, replayState }
{ type: 'finish', reason: { kind: 'stop' }, replayState }
{ type: 'finish', reason: { kind: 'error', failure: { code, message } } }
{ type: 'finish', reason: { kind: 'aborted', failure: { code, message } } }
```

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

## Session identity and state

Key each live session by the dsh session ID and plugin generation ID. The map
also binds its absolute workspace path. A workspace is not a session identity.
An auxiliary request uses a separate key with its request purpose and unique
call ID; it can never release a conversation's pending tool results.

| State | Accepted operation | Next state |
| --- | --- | --- |
| `NEW` | Validate configuration, auth, and spend policy | `STARTING` or `INVALID` |
| `STARTING` | SDK initialization without a model prompt | `READY` or `INVALID` |
| `READY` | Admit a new, validated user input | `GENERATING` |
| `GENERATING` | Receive a complete tool-call response | `WAITING_FOR_RESULTS` |
| `GENERATING` | Receive a completed final response | `READY` |
| `WAITING_FOR_RESULTS` | Validate the full dsh result batch and release it | `GENERATING` |
| Any live state | Abort, divergence, timeout, unknown outcome, or process loss | `INVALID` |
| `INVALID` | Finish cleanup and log a reset requirement | `CLOSED` |

Serialize admission for each key. Reject a concurrent stream with `SESSION_BUSY`;
do not serialize a tool continuation behind an unresolved earlier stream. The
earlier dsh stream has already finished at the tool boundary.

Record when input crosses the native boundary. A timeout after that point has
an unknown inference outcome. Do not retry it as a fresh request. A generation
that enters `INVALID` never returns to `READY`.

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
}
// Store as { response: replayV1 }; omit ReplayEnvelope.blocks.
```

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

Use public session and compaction APIs. Verify replacement coordinates and flush
durability through the agent-owned persistence lifecycle. A detached
`ctx.sessions.create()` does not itself prove persistence. Do not invent an
`agent/rebase` hook or mutate the agent's current frozen request.

Ship `REBASE_REQUIRED` first if automatic integration is not complete. Later add
a command/service that records a complete import before another request. Do not
mark edits and compaction as supported until their integration tests pass.

## Authentication and spend checks

`AuthGuard` returns an accepted official subscription identity or a refusal.
Filter the environment and reject credential helpers before running an auth
command that could execute one. Use only the official CLI for login status.
Account IDs are private; store a local identity binding, not credentials.

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
| `REBASE_REQUIRED` | Prefix, workspace, model, effort, prompt, or tools changed |
| `SESSION_BUSY` | Another stream owns admission for this native session |
| `REPLAY_STATE_INVALID` | Replay data is missing or inconsistent |
| `NATIVE_CONTEXT_MISMATCH` | Native prompt, tools, or context differ |
| `UNSUPPORTED_INPUT` | A content type, schema, role, or control cannot be preserved |
| `TOOL_RESULT_MISMATCH` | Result IDs, counts, order, or data disagree |
| `MALFORMED_RESPONSE` | Completed model output cannot be used safely |
| `NATIVE_OUTCOME_UNKNOWN` | Dispatch or result delivery may have occurred |

An abort yields dsh's `aborted` finish and closes the native generation. Do not
send a fabricated tool result to make the SDK stop. Close gracefully, then end
only owned child processes after a bounded deadline. A watchdog must reap the
process even if the async event iterator is blocked. Plugin unload waits for
cleanup, disposes the registration, and leaves dsh's durable outcomes intact.

Do not expose account IDs, signatures, request bodies, or auth output in ordinary
logs. Native signatures belong in protected session replay data. Private audit
files need restrictive permissions and must not enter the published package.
