# Test and release plan

Use three test layers. Keep the result of each layer separate.

Offline status on 2026-11-11: the Node suite covers rows O01 through O42 with
synthetic data and the scripted runtime, and 76 tests pass. The dsh 0.2.2-rc.1
LLM service, session store, and compaction balance functions are loaded in that
suite. The real dsh LLM runtime is mounted for file and image projection tests.
The agent loop is not driven. No offline command starts the installed Claude
binary.

A separate live probe on 2026-11-11 used the official SDK 0.3.322 and Claude
Code 2.1.319. It read one synthetic image from a user message and one synthetic
image from an MCP tool result. See
[the probe summary](evidence/sdk-image-probe-2026-11-11.json). It did not run
the plugin in dsh.

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
| O19 | Prompt, tools, model, reasoning control, or workspace changes | Refuse or record the required new generation |
| O20 | User/developer update appears inside a tool-result suffix | Refuse; do not silently relocate the update |
| O21 | Two sessions in different workspaces | Separate processes, prompts, maps, and results |
| O22 | Title or summary call during a parked tool | Separate auxiliary session; original call stays parked |
| O23 | Abort during generation or result wait | Aborted finish; no fabricated result; native process closed |
| O24 | Input delivered, then timeout or process exit | Unknown outcome; no automatic replay or retry |
| O25 | Retry wrapper repeats a previously dispatched request | Session guard prevents a second dispatch |
| O26 | CLI-added executable tool or changed context | Reject certification or invalidate the generation |
| O27 | Compaction or context import with an open tool pair | Refuse the reset until a balanced boundary |
| O28 | Recorded full reset and subsequent request | New generation; no reused signatures or repeated tool actions |
| O29 | Restore with saved replay state and no native process | `REBASE_REQUIRED`; no false native resume |
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
| O40 | A compaction-style auxiliary call with assistant history | `UNSUPPORTED_INPUT` with no native session start |
| O41 | Two leading user messages | One native prompt with both content lists in order |
| O42 | Assistant usage that reports cache read and write tokens | The usage chunk keeps both cache counts |

Use independent expected response data for thinking tests. A comparison that
derives both expected and actual data from the altered request cannot detect a
drop. Keep the successful answer in the tampered fixture to prove that answer
success does not determine retention success.

## dsh integration tests

Load the actual minimum-version LLM service, session services, and agent loop.
Inject the scripted runtime through the plugin's internal constructor. Do not
add a user-selectable fake model endpoint.

Required checks:

- dsh passes frozen inputs and the plugin does not change them.
- The real assembler stores an empty reasoning block and response replay data.
- A completed tool-call batch passes through the actual guarded tool pipeline.
- dsh logs the response and complete outcomes before the next stream releases them.
- Export and restore preserve replay JSON exactly. A missing live process still
  requires a new recorded generation.
- Context replacement uses real surface coordinates and persistence flushes.
  The old events remain available in the raw log.
- Session disposal and plugin removal close the exact owned native sessions.
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

## Release gate

Release requires the offline suite, real dsh integration, accepted strict spend
proof, and live content/retention tests on the advertised runtime pair. Report
the live negative-test status explicitly. If it is unavailable, do not advertise
full live tamper certification. Do not spend money to test a no-spend assertion.

Keep native resume, binary protocol changes, image offload on long sessions,
document input, and additional content types outside the compatibility claim
until their own measurements pass. The 2026-11-11 image probe measured one image
in a user message and one image in a tool result. It did not measure many images,
image retention with signed thinking, or subagent image delivery.
