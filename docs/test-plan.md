# Test and release plan

Use three test layers. Keep the result of each layer separate.

Offline status on 2026-11-11: the Node suite covers rows O01 through O88 with
synthetic data and the scripted runtime, and 188 tests pass. The dsh 0.2.2-rc.1
LLM service, session store, and compaction balance functions are loaded in that
suite. The real dsh LLM runtime is mounted for file and image projection tests
and for the native error finish test. The agent loop is not driven. No offline
command starts the installed Claude binary. The distribution checks I01 to I06
also passed on 2026-11-11.

Rows O43 to O52 cover generation recovery with a recorded textual import. Rows
O53 to O57 cover native turn-error mapping and truncated answers. Rows O58 to
O61 cover a fixed-configuration change with the recorded-import mechanism. Rows
O62 to O66 cover the context-capacity cache and the flat-text compaction summary
import. Rows O67 to O69 cover session-disposal cleanup and the auth acceptance
cache. Rows O70 and O71 cover the auxiliary session release. Rows O72 and O73
cover the resolved model display name and the absent default effort. Rows O74 to
O78 cover trailing user content inside a waiting tool turn. Rows O79 to O81 cover
the live-shaped tool-turn transport shapes. Rows O82 to O88 cover the request
image budget, the offload retry, and the retained-image generation threshold.
They are offline tests. No live model request measured the rollover, a provider
error, a configuration change, a live token meter, a live dsh compaction, or the
provider image limit, and the tests claim no signed-thinking retention across any
rollover or import.

Two separate live probes on 2026-11-11 used the official SDK 0.3.322 and Claude
Code 2.1.319. The first probe read one synthetic image from a user message and
one synthetic image from an MCP tool result. See
[the image probe summary](evidence/sdk-image-probe-2026-11-11.json). The second
probe sent 100 and 101 synthetic images. See
[the many-image probe summary](evidence/many-image-probe-2026-11-11.json). Neither
probe ran the plugin in dsh.

1. Offline unit tests use synthetic data and a scripted SDK transport.
2. Offline dsh integration tests use real dsh packages and the scripted transport.
3. Live acceptance tests use the official SDK, official binary, and the user's
   permitted subscription route. They require the strict spend guard first.

The existing Python checker covers saved request records. It does not test a
working plugin, the SDK process lifecycle, or server signature validation.

## Available check

From the repository root:

```sh
python3 scripts/verify_thinking.py \
  tests/fixtures/thinking-roundtrip/session.jsonl \
  tests/fixtures/thinking-roundtrip/output.ndjson \
  --self-test
```

Expected: baseline succeeds; `drop_thinking`, `change_signature`, and
`change_thinking_text` each report `rejected`. A mutated message gets a new valid
hash and an updated reference, so a stale hash is not the rejection cause.

Do not use Python optimization flags for a checker that uses assertions. The
entry point refuses optimized mode. A failing baseline must return a nonzero
exit code; catching its failure and reporting a pass is not acceptable.

The fixture signature is deliberately invalid cryptographic data. It exercises
comparison and parsing only. See the [fixture notes](../tests/fixtures/README.md).

## Required offline cases

Implement these with the Node test runner and the injected `NativeRuntime`.
Use temporary directories for all writes. A fake runtime records every input,
result delivery, opened session, close request, and remaining child handle.

| ID | Setup or change | Required result |
| --- | --- | --- |
| O01 | API key, token, endpoint, provider override, or credential helper | Refuse before any model prompt or helper execution |
| O02 | Missing, stale, mutable, or wrong-account spend proof | The optional proof checker returns `BILLING_GUARD_UNAVAILABLE`. Production does not require that proof. |
| O03 | SDK initialization with no prompt | No model request; no automatic selection of a provider |
| O04 | One text response | One final dsh finish, no duplicate text, replay data stored |
| O05 | Thinking with empty text and a signature | Native data preserved; no truthiness filter |
| O06 | Redacted thinking | Opaque native data retained without invented display text |
| O07 | One tool call and one result | Same native session; exactly one dsh tool operation |
| O08 | Several parallel calls, including equal names and arguments | Correct result delivered by each exact call ID |
| O09 | Native handlers arrive one at a time | Full batch published without waiting for later handlers |
| O10 | One missing, extra, duplicate, or reordered result | Refuse the whole suffix before releasing any result |
| O11 | Approval held beyond token-idle timeout | Native session remains parked; no new model request |
| O12 | dsh denial or recorded tool error | Exact recorded error returned; no fabricated success |
| O13 | Partial and completed SDK events repeat the same block | One dsh block and one replay block in the correct order |
| O14 | Malformed tool arguments or truncated tool output | No tool dispatch; invalidate generation |
| O15 | Schema keyword loss, tool-name collision, or unsupported content | `UNSUPPORTED_INPUT` before dispatch or result release |
| O16 | Earlier message content, identity, or order changes | `REBASE_REQUIRED` before continuation |
| O17 | New dsh assistant ID after finish | Bind once only when the expected publication matches |
| O18 | Missing or changed replay state | `REPLAY_STATE_INVALID`; no silent thinking removal |
| O19 | Prompt, tools, model, reasoning control, or workspace changes on a live generation | One new generation with the current configuration and a recorded `configuration-change`; an earlier-prefix edit still returns `REBASE_REQUIRED` |
| O20 | User message after a tool-result batch, or a developer/system message at that boundary | Deliver the user message inside the same native turn before the result release; refuse the developer or system message |
| O21 | Two sessions in different workspaces | Separate processes, prompts, maps, and results |
| O22 | Title or summary call during a parked tool | Separate auxiliary session; original call stays parked |
| O23 | Abort during generation or result wait | Aborted finish; no fabricated result; native process closed |
| O24 | Input delivered, then timeout or process exit | Unknown outcome; no automatic replay or retry; a later new request recovers with a recorded import |
| O25 | Retry wrapper repeats a previously dispatched request | Session guard prevents a second dispatch |
| O26 | CLI-added executable tool or changed context | Reject certification or invalidate the generation |
| O27 | Compaction or context import with an open tool pair | Refuse the reset until a balanced boundary |
| O28 | Recorded full reset and subsequent request | New generation; no reused signatures or repeated tool actions |
| O29 | Restore with saved replay state and no native process | One new generation with reason `restore`; no false native resume; the next request continues it |
| O30 | Plugin unload, stalled iterator, and concurrent stream | Owned processes reaped; stable busy/error outcome |
| O31 | Unknown finish, control, role, or model | Explicit error; no fallback and no ignored field |
| O32 | Native request evidence missing, redacted, or truncated | Retention proof unavailable; do not report audit success |
| O33 | One user image with a text block before and after it | One request version with the target dimensions; descriptor text before the image; base64 bytes in order |
| O34 | One tool result with text and image blocks | MCP result content keeps the text, descriptor, and image order; the parked handler receives the batch |
| O35 | An image block with `offloaded: true` | Placeholder text only; the attachment service is not read |
| O36 | An image in a system or assistant message, a file block in an adapter request, or an image without an attachment service | `UNSUPPORTED_INPUT` before native dispatch |
| O37 | One file block through the real dsh LLM runtime | The runtime replaces the file with its read-only handle text; the adapter never receives the bytes |
| O38 | One image through the real dsh LLM runtime | The runtime keeps the image because the route declares image input; the adapter receives the block |
| O39 | A session-title call with `maxTokens`, an invalid output cap, or a changed cap | The cap reaches `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; an invalid or changed cap is refused before dispatch |
| O40 | An auxiliary purpose with assistant history and no summary mapping | `UNSUPPORTED_INPUT` with no native session start |
| O41 | Two leading user messages | One native prompt with both content lists in order |
| O42 | Assistant usage that reports cache read and write tokens | The usage chunk keeps both cache counts |
| O43 | Abort mid-turn, then one new user message | One dsh stream finishes on one new native session; the import has the earlier user text and the new input; replay records reason `abort`; the next request uses the same new session |
| O44 | Abort before dispatch, then one new user message | The pending input from the aborted request is in the import; replay records reason `abort` |
| O45 | Generation deadline, then one new user message | Replay records reason `timeout`; the old process is closed; the next request continues the new session |
| O46 | Native process ends between turns | Replay records reason `process-loss`; one new native session; no duplicate prompt; one dsh session |
| O47 | Native process ends during a tool wait | The completed tool outcome is quoted in the import; the adapter invents no tool result; replay records reason `process-loss` |
| O48 | Restore or plugin reload with saved replay state | One new generation with reason `restore`; no false native resume; the next request continues it |
| O49 | Forked subagent first request with parent replay state | One answer on one new generation with reason `fork`; the parent process is not reused |
| O50 | Restored tool-result continuation with no live process | The import holds the completed outcome; one dsh stream; no old MCP handler is released |
| O51 | Two consecutive recoveries | Each turn stores one `generationChange`; the generation ids increase; one dsh session |
| O52 | Import content and bounds | No signature, thinking text, image bytes, or tool-call ids; the text is deterministic and bounded; an exact repeat of a dispatched request is refused with `NATIVE_OUTCOME_UNKNOWN` |
| O53 | Native result with the Claude context-overflow wording | One failure with `CONTEXT_WINDOW_EXCEEDED` and its HTTP status; a terminal dsh `error` finish; no complete answer |
| O54 | Native result with HTTP 429, quota wording, first-party credit wording, and auth wording | `RATE_LIMIT`, `QUOTA`, `ACCOUNT_QUOTA`, and `AUTH`; no token, header, or account text in the messages |
| O55 | Assistant message or result with `stop_reason` `max_tokens` | Exactly one `max-tokens` finish, no `stop` finish, replay state present |
| O56 | Error result after a complete assistant stop | No second report and no `turn-error` event; the complete response stays usable |
| O57 | Execution error, unknown result subtype, and a truncated turn with a tool call | `NATIVE_OUTCOME_UNKNOWN` for `error_during_execution`; `MALFORMED_RESPONSE` for an unknown subtype; the truncated call is not executed |
| O58 | Plan-mode prompt section on then off | Each change starts one new generation with the new prompt and reason `configuration-change`; the same dsh session continues; the next request uses the new session |
| O59 | Tool addition then tool removal | New generation each time with the complete current tool list and `changedFields` equal `['tools']`; the new generation releases a tool result through its own bridge |
| O60 | Model, effort, output cap, or workspace change | One new generation with the new value and `changedFields` in stable order; no `REBASE_REQUIRED`; a prompt change during a tool wait imports the completed outcome |
| O61 | A configuration change with an earlier-prefix edit or an exact repeat | Refuse before any new native start; keep the edit and repeat rules |
| O62 | `resolveModel` before a measurement, then after a scripted result `modelUsage` event, then for a different model | The documented 200000 fallback first; the measured `contextWindow` after; the other model keeps the fallback; no `defaultMaxTokens` |
| O63 | The real dsh LLM service resolves the route before and after a measurement; a model switch on a live generation | The service accepts `context.contextWindow`; the switch request returns `REBASE_REQUIRED` and the original native generation still serves the next turn |
| O64 | A `compaction` auxiliary call with system, user, assistant thinking, tool-call, tool-result, and image history | One fresh native session; flat text rows; no thinking text, signature, tool-call ID, or image bytes; instruction last; no dsh tools; `maxTokens` maps to the output cap; the live conversation session is untouched |
| O65 | A conversation turn after a compaction auxiliary call | The original native session takes the next turn; no second native start |
| O66 | Accepted-looking request evidence on a compaction auxiliary turn | `retentionAudit` is `unavailable` and `nativeRequestRecord` is null |
| O67 | Two dsh sessions with live native processes; dispose one session | Only the disposed session's process closes; the other process stays live; plugin unload closes all owned processes |
| O68 | A session disposal while a session-title auxiliary call is pending | The conversation process closes; the auxiliary process stays live until its own stream settles |
| O69 | Two accepted auth checks in one scope, a refusal, and a changed scope or interval | One auth command for the accepted pair; a changed settings file state, home, workspace, executable, environment, binding, or interval runs it again; a refusal is not cached |
| O70 | An aborted auxiliary call | No session entry remains and the native process is closed; a later auxiliary call with the same content starts a new native session |
| O71 | An aborted auxiliary call while a conversation generation is live | The conversation entry and process stay live and the next conversation request continues the same native session; an auxiliary release of a conversation key removes nothing |
| O72 | A model id in the discovered catalog | `resolveModel` name equals the catalog display name; the id stays exact; the effort levels are only the reported ones; `reasoning` has no `defaultEffort` |
| O73 | A model id with no catalog row | `resolveModel` name equals the raw id and the reasoning block is absent; the real dsh LLM service accepts the result |
| O74 | Tool-result batch followed by one user reminder | One native turn and one dsh stream; the reminder is queued before the result release; same native session; the next request continues it |
| O75 | Two trailing user messages after a tool-result batch | Both messages keep their order and reach the same native turn; nothing moves into the tool result |
| O76 | Developer or system message after the tool-result batch | `UNSUPPORTED_INPUT` before any native send; the parked result is not released |
| O77 | Image in a trailing mid-turn user message | `UNSUPPORTED_INPUT` before dispatch; no result release and no byte read |
| O78 | Trailing user content with a configuration change or a restored generation | The recorded rollover imports the completed outcome and sends the trailing content as pending input; one dsh stream |
| O79 | An assistant message with a tool block, usage, and `stop_reason: null`, then the result message | One usage event, then one synthetic `tool_use` stop; one dsh stream finishes `tool-calls`; the result usage is a fallback only when no assistant message had usage |
| O80 | A native response tool name qualified as `mcp__dsh__dsh__<name>` | The published dsh tool name is `<name>`; the call id is preserved; the stream finishes `tool-calls` |
| O81 | One API message split into several assistant messages with the same id (thinking, text, tool_use) | Block indexes continue across the split; one usage event; one tool stop; the stream finishes `tool-calls` with reasoning, text, and tool-call blocks |
| O82 | A conversation request with 81 retained image occurrences | `IMAGE_OFFLOAD_REQUIRED` before dispatch with `offloadImages` 1; no native start; the retry after one offload sends 80 image blocks and one placeholder, and reads no bytes for the offloaded occurrence |
| O83 | A request with four 5 MiB images (about 28 MiB encoded) | `IMAGE_OFFLOAD_REQUIRED` with the byte-driven `offloadImages` count before dispatch; no native start |
| O84 | An over-budget request on a live generation, then the offload retry | The failure keeps the native session open; the retry continues the same native session with the placeholder text |
| O85 | A generation at 50 retained images plus a 50-image user turn | One new generation with reason `image-budget` and no changed fields; the import holds placeholders and no image bytes; the same dsh session continues; the next request uses the new session |
| O86 | A tool-result continuation whose 40 result images would pass the generation limit | One new generation with reason `image-budget`; the import holds the completed outcome and image placeholders; the new native input holds no image block; the old tool wait is cancelled |
| O87 | A generation at 40 retained images plus a 40-image user turn | One native generation; no generation change; the second native input holds 40 image blocks |
| O88 | A summary auxiliary call whose history holds more than 80 images | The flat-text summary import sends no image bytes, reads no attachment version, and is not subject to the request budget |
| O89 | One complete raw-body SDK request record with a matching launched prompt, tool list, and served model | One `request-evidence` event; the finish stores `retentionAudit: accepted` and a request body with model, system, tools, and messages |
| O90 | A thread-delta second request after a complete first request | The complete message list is reconstructed from the last complete request, the last response, and the delta; the audit is accepted and the earlier signed blocks match |
| O91 | A missing, partial, oversize, redacted, truncated, or non-streaming request record | No `request-evidence` event; audit `unavailable`; the turn still finishes; no signed content is shortened |
| O92 | An extra executable native tool in the recorded request | No `request-evidence` event; audit `unavailable` |
| O93 | One documented inert placeholder with its complete definition, then an unknown or changed placeholder definition | The documented placeholder is accepted and kept in the record; the unknown definition reports `unavailable` |
| O94 | A changed system prompt block, a changed served model, a moved user text, a changed earlier signature, or a missing tool result | No `request-evidence` event; audit `unavailable` |
| O95 | Generation close or a native start failure with the raw-body diagnostic enabled | The private directory is removed; no raw request body reaches git or the package |

O89 to O95 passed offline on 2026-11-11. The live probe summary is
[request-evidence-probe-2026-11-11.json](evidence/request-evidence-probe-2026-11-11.json).
It measured two turns through the official SDK with audit accepted, the dsh MCP
tool plus one inert placeholder in the recorded list, and a reconstructed
thread-delta second request. It did not produce a signed thinking block, so live
signature retention is not measured. A live turn in an installed dsh profile is
not measured; issue #13 covers it.

Use independent expected response data for thinking tests. A comparison that
derives both expected and actual data from the altered request cannot detect a
drop. Keep the successful answer in the tampered fixture to prove that answer
success does not determine retention success.

## Installation distribution checks

The Git tree does not contain `dist/`. The `prepare` script builds it when a
package manager installs the repository as a Git dependency. D20 records the
decision.

| ID | Setup or change | Required result |
| --- | --- | --- |
| I01 | `npm install` of the repository as a Git dependency in an empty temporary directory | `prepare` runs `npm run build`; `dist/index.js` exists; the package entry imports |
| I02 | `npm pack` of the repository | The archive contains `dist/`, `cordis.patch.yml`, `README.md`, and `package.json`; it contains no source, test, evidence, credential, or private file |
| I03 | Isolated dsh profile, first `dsh plugin add <git spec>` | The command fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and the exact `allowBuilds` key; the profile package.json does not add the dependency |
| I04 | Add the printed `allowBuilds` key to the profile and repeat the add | The build runs, the plugin installs, and the profile lists the bundle |
| I05 | `dsh --profile <isolated> --dump-config` | The composed tree contains the `dsh-plugin-claude-code` layer and the enabled `claude-code-session` entry |
| I06 | Clean `dsh plugin --profile <isolated> add github:shantanugoel/dsh-plugin-claude-code` after the push | The result is the same as I03 to I05 with the documented GitHub spec |

I01 to I06 passed on 2026-11-11. The reviewed summary is
[install-2026-11-11.json](evidence/install-2026-11-11.json). These checks sent
no model prompt and did not use the user's desktop profile.

## dsh integration tests

Load the actual minimum-version LLM service, session services, and agent loop.
Inject the scripted runtime through the plugin's internal constructor. Do not
add a user-selectable fake model endpoint.

Required checks:

- dsh passes frozen inputs and the plugin does not change them.
- The real assembler stores an empty reasoning block and response replay data.
- A completed tool-call batch passes through the actual guarded tool pipeline.
- dsh logs the response and complete outcomes before the next stream releases them.
- Export and restore preserve replay JSON exactly. A missing live process starts
  one recorded new generation, and the import record stays in the replay data.
- Context replacement uses real surface coordinates and persistence flushes.
  The old events remain available in the raw log.
- Session disposal closes the exact owned native session; plugin removal closes
  every owned process; an auxiliary call and another session stay open.
- A native turn error becomes a terminal dsh `error` finish with its mapped
  code, so the real `agent/request-error` waterfall receives the code.
- `LlmRuntime.resolveModelInfo` accepts the reported context capacity before and
  after a scripted measurement.
- A model catalog blocked by the spend guard cannot be selected as a usable route.
- The packaged plugin resolves the host's service classes and does not register
  duplicate providers after reload.

Record exact dsh, Node, SDK, and CLI versions in `docs/compatibility.md` when this
file is created. A passing test on a newer release does not verify 0.2.2-rc.1.

## Live image test

On 2026-11-11 the official SDK probe read a synthetic word from one user image
and from one MCP tool-result image. The probe used the first-party subscription
login and made two inference requests. The evidence summary records the model,
versions, fixture, answers, and gaps. This is not a plugin-in-dsh test and not a
retention test. Repeat it on the plugin's actual dsh path before a release claim.

## Live many-image test

On 2026-11-11 a direct official-SDK probe sent one streaming user message with
100 synthetic 1x1 images and one with 101 images. Both turns completed with
subtype `success` and the answer `MANY-IMAGES-OK`. The selected model reported
`contextWindow` 1000000 and `maxOutputTokens` 128000. The probe made two
inference requests. It did not reach the documented request image limit, so the
exact provider image limit is unmeasured. See
[the many-image probe summary](evidence/many-image-probe-2026-11-11.json). This
is not a plugin-in-dsh test. The plugin image budget and the retained-image
generation threshold need their own live dsh profile test. Do not claim a
measured provider image limit, an image byte limit, or 600-image behavior until
a probe reaches them.

## Live capacity and compaction test

This test needs a dsh profile and a permitted live inference run. It has not run.
A dsh profile must show a context meter for this route. The first turn uses the
200000 fallback. A later resolve must use the measured value from the native
result message. Then a manual `/compact` and an automatic pressure compaction
must record a replacement surface. A model switch at high pressure must either
compact or return a clear refusal. The summary native session must receive the
flat text import and no signed history. Record the exact dsh, SDK, CLI, and model
versions. Keep raw captures in `.local/evidence/`. Do not claim a token meter,
an automatic compaction, or a live model switch until this test passes.

## Live trailing-context probe

On 2026-11-11 an official SDK probe measured where the CLI puts a user message
that arrives while an MCP tool handler is parked. It used SDK 0.3.322, Claude
Code 2.1.319, and the subscription login. The probe queued the message before
the result release and got one native turn: the CLI put the text in a
CLI-generated system-role mid-turn message after the `tool_result`, and the
model answered once. When the probe released the result first, the CLI made a
second native turn. See
[the probe summary](evidence/trailing-context-probe-2026-11-11.json). The probe
did not run the plugin in dsh, did not measure an image, and did not measure
signed-thinking retention. It also could not read the CLI session transcript
because this session denied the transcript write; it used the official
`OTEL_LOG_RAW_API_BODIES` file diagnostic instead.

## Live retention test

Run only after the spend prerequisite is met. Use the real dsh prompt and a
deterministic host tool that returns a unique token. The tool performs no external
operation. The model must call it and then use the returned token.

1. Save the actual native system, tools, ordered messages, and returned response
   blocks through a supported official diagnostic interface. Keep captures private.
2. Require a signed thinking block and a tool call in response one. If no thinking
   appears, report the test as inconclusive and do not claim retention.
3. Hold the host result, then supply it through dsh's actual tool pipeline.
4. Inspect the next outgoing native request. Compare the complete thinking block,
   including signature, byte for byte with the original response. Also compare
   bound earlier content and the effective prompt, tools, and model.
5. Check that the original tool ID is paired with the recorded result and that
   the response is linked to that next request.
6. Repeat with empty thinking text, parallel calls, denial, and delayed approval.

A correct answer, successful request, cache hit, or stored replay envelope alone
does not pass this test. A packet capture or an official native request record
must distinguish what was returned from what was sent back. Document the source
and any redaction or omission. Do not describe a client log as a server trace.

## Live negative test

Use a separate disposable test session. If the official interface permits a
safe test-copy change, change one signature byte at the pending tool boundary.
The original response remains the independent expected value.

An acceptable result is a verified local refusal before submission, or a request
that demonstrably retains the altered block followed by a server rejection.
A successful continuation with the block removed fails. Repeat for a removed
thinking block and empty-text thinking.

Do not patch the binary, extract credentials, send a direct model request, or
spoof a client to run this test. If no supported mutation path exists, mark the
live negative test unverified. Keep the offline negative test and outgoing-content
test mandatory. Do not call the complete live tamper requirement satisfied.

## Workspace and system test

Start two dsh sessions in distinct temporary workspaces with different canary
instructions. Check the native environment record and the actual system prompt
for each. Neither session may see the other's path, canary, tools, or results.
Then request a workspace change, a prompt edit, and a model change. Each must
refuse the old generation or record a correct reset before continuing.

Inspect the complete native tool list for advisor and any other executable native
tool. Check unwanted file instructions, git guidance, plugins, and reminders.
Verify that managed policy is either compatible or causes a clear refusal.

## Engine gate checks

The plugin declares the exact tested dsh version in `engines.dsh`. The dsh
plugin manager enforces it alone. D26 records the decision.

| ID | Setup or change | Required result |
| --- | --- | --- |
| G01 | `dsh plugin add` of the package on tested dsh 0.2.2-rc.1 in an isolated profile | The requirement is accepted; the profile adds the plugin bundle; `--dump-config` lists the enabled route |
| G02 | Install a temporary copy under `/tmp` with `engines.dsh` set to an untested version | Rejection before installation with the plugin, requirement, running version, risk, and exemption command; `nothing was installed`; profile manifest unchanged |
| G03 | Run a profile whose installed plugin declares an untested `engines.dsh` | Startup skips that bundle with a clear message; the route is not composed; unrelated plugins still boot |
| G04 | Read the published dsh version list from npm | The list ends at the tested version; no later release exists |

G01 to G04 passed on 2026-11-11. The reviewed summary is
[engine-check-2026-11-11.json](evidence/engine-check-2026-11-11.json). The
rejection cases changed the package requirement, not the runtime version, because
no later dsh release exists. The exemption flow was not exercised.

## Release gate

Release requires the offline suite, real dsh integration, accepted strict spend
proof, and live content/retention tests on the advertised runtime pair. Report
the live negative-test status explicitly. If it is unavailable, do not advertise
full live tamper certification. Do not spend money to test a no-spend assertion.

Offline rows O43 to O66 cover generation recovery, configuration changes, and
trailing mid-turn content. The trailing-content order comes from a direct SDK
probe; the plugin-in-dsh path has no live measurement. The imports and the
mid-turn messages are ordinary user content, and they are not proof of
signed-thinking retention. Keep native resume, binary protocol changes, image
offload on long sessions, document input, and additional content types outside
the compatibility claim until their own measurements pass. The 2026-11-11 image probe measured one image
in a user message and one image in a tool result. It did not measure many images,
image retention with signed thinking, or subagent image delivery.
