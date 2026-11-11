# Implementation plan

Goal: build one dsh model plugin that uses a persistent official Claude Agent SDK
session, preserves native signed thinking across unchanged tool steps, and leaves
all tool execution, sandbox rules, and approvals with dsh.

Status: on 2026-11-10 the extra-usage lock became optional. A first-party
subscription login may send a prompt. The official SDK query starts only when
`SdkNativeRuntime.start` runs. The offline suite does not call it.
`supportedModels()` is not called. No license is selected. The agent loop was
not driven. Do not mark later tasks complete from the direct-CLI measurement.

Status, 2026-11-11: M9 adds text and image content support. The offline suite
had 76 tests at that point. A direct official-SDK probe read a synthetic image
through a user message and through an MCP tool result. The plugin did not run
inside a dsh profile for this change.

Status, 2026-11-11: M10 maps native turn errors to stable dsh codes and reports
a `max_tokens` stop as a truncated finish. The offline suite has 117 tests after
this change merged. No live provider error was measured.

Status, 2026-11-11: M11 closes the native process of a disposed dsh session and
caches one accepted auth check for 60 seconds. The offline suite has 146 tests
after this change. The tests use the real dsh session store and a fake auth
runner. No live Claude process or live auth command was measured.

Status, 2026-11-11: M12 releases the auxiliary session key on every exit. The
offline suite has 150 tests after this change. No live auxiliary call was
measured.

Status, 2026-11-11 (issue #1): the Git install distribution builds `dist/` at
install time through the `prepare` script (D20). An isolated dsh profile
installed the plugin from a local Git spec, and `--dump-config` listed the
`claude-code-session` entry. The documented GitHub spec install passed on
2026-11-11 in a fresh isolated DSH_HOME profile.

Status, 2026-11-11 (issue #2): M5 adds generation rollover recovery. The offline
suite has 90 tests. A closed or absent native generation recovers with one
recorded textual import (D21), and the replay data holds the change record. No
live model request measured the rollover. Signed-thinking retention across a
rollover is not claimed.

Status, 2026-11-11 (issue #5): M5 adds configuration-change rollover. The
offline suite has 126 tests after this change merged. A prompt, tool, model,
effort, output-cap, or workspace change starts one new generation with the
current configuration and a recorded `configuration-change` (D23). No live model
request measured this change.

Status, 2026-11-11 (context capacity and compaction, D24 and D25): `resolveModel`
reports a context window, first as a documented 200000 fallback and then from a
process-wide measured cache. The adapter supports the `compaction` and `summary`
auxiliary purposes through a deterministic flat-text import in a separate native
session. The offline suite has 135 tests after this change merged. No live dsh
token meter, no live compaction, and no live model switch were measured.

Status, 2026-11-11 (issue #12): no dsh release later than 0.2.2-rc.1 exists. The
plugin keeps the exact `engines.dsh` pin (D26), the README agrees, and the
plugin manager refuses an untested engine requirement with a clear message.

## Fixed requirements

- Minimum target: dsh 0.2.2-rc.1, the only published release. Keep the exact
  engine pin until a later release passes a compatibility test (D26).
- Use the user's installed official Claude binary through the official SDK.
- Use the user's existing subscription login. No Console key or OAuth replay.
- Keep the true dsh identity. Do not change client or billing headers.
- Keep signed thinking unchanged, including a block with empty text.
- Never reuse a signature after a changed bound input.
- Admit a model prompt only after a strict pre-inference spend check.
- Do not weaken these requirements to make a smoke test pass.
- Write documents and specifications in ASD-STE100 Simplified Technical English.

Read `docs/design.md`, `docs/contracts.md`, `docs/test-plan.md`, and
`docs/decisions.md` before coding. Use their stated error and state contracts.

## M0. Repository preparation

- [x] Put the design and evidence under `docs/`.
- [x] Put the offline checker under `scripts/`.
- [x] Add a synthetic fixture that works without private logs.
- [x] Define the SDK transport, tool bridge, transcript checks, and reset behavior.
- [x] Add agent instructions, source references, and a Git ignore file.
- [x] Preserve the limits of the original measurement.

## M1. Verify interfaces and create the package

- [x] Read the exact published minimum-version dsh declarations. Record package
  integrity values and public imports in `docs/compatibility.md`.
- [x] Select and pin an official TypeScript Agent SDK version. Verify its
  executable-path, input queue, event stream, MCP, close, and model-discovery APIs.
- [x] Add `package.json`, a lockfile, TypeScript configuration, and source modules
  from the contracts file. Use ESM and Node 24.9 or later.
- [x] Keep dsh runtime modules as peers. Use the same copies as the host.
- [x] Add `check`, `test`, `build`, and `pack:check` scripts. Keep live tests in a
  separate command that never runs from `test`, installation, or a build hook.
- [x] Add the Cordis entry and bundle patch for route `claude-code-session`.
  Define settings with the host's supported schema package.
- [x] Add a scripted `NativeRuntime` that makes no network requests.

Completion: a fresh checkout can install locked dependencies, type-check, run
offline tests, build, and inspect a package without Claude credentials. No
production inference is possible while the spend guard is unavailable.

## M2. Implement request admission and the spend gate

- [x] Validate absolute session workspace and all supported request controls.
- [x] Build an explicit child environment allowlist. Reject auth, provider,
  endpoint, and header overrides. Inspect effective credential-helper settings
  before running a command that could execute a helper.
- [x] Call the official auth-status command with the isolated configuration.
  Require a first-party subscription login. Keep tokens and account data private.
- [x] Implement `SpendGate`. Until verified enforcement exists, production returns
  `BILLING_GUARD_UNAVAILABLE`. Test the zero-prompt refusal path.
- [x] Bind accepted policy evidence to the identity, scope, expiry, and execution
  interval. Reject a changed account or invalid proof.
- [x] Apply admission to every inference purpose, including session titles and
  summaries. Reject a purpose that has no supported isolated request mapping.
- [x] Keep real preflight failures non-retryable. Do not expose a paid-usage override.

Completion: fake auth and spend combinations prove that no input reaches the
native transport on a refusal. Record the remaining billing question and continue
M3 through M7 offline. Do not stop all implementation work at this blocker.

## M3. Implement persistent native sessions and the MCP bridge

- [x] Create one SDK query, one event consumer, and one input queue for each
  session generation. A tool-call finish leaves them alive.
- [x] Configure exact workspace, custom dsh prompt, exact model, empty native
  tools, explicit settings sources, partial events, and only the dsh MCP server.
- [x] Apply supported controls for advisor, compaction, background operations,
  connectors, extra instructions, and unwanted context discovery.
- [x] Build a reversible tool-name map and a lossless JSON Schema mapping.
  Detect collisions and refuse unsupported schema forms.
- [x] Return waiting promises from tool handlers. Publish the complete response
  batch before any result is delivered, independently of handler arrival order.
- [x] Stage all validated dsh results and deliver each by exact native tool ID.
- [x] Support text results, tool errors, and approval denials. Refuse unsupported
  content before it can be silently changed or partly delivered.
- [x] Add bounded initialization, generation, result-wait, and close deadlines.
  The approval wait must not use the ordinary token-idle timeout.

Completion: offline tests cover one call, parallel calls, identical calls,
sequential handler arrival, delayed approval, denial, and a missing result. dsh
is the only component that performs the test operation.

## M4. Implement transcript checks, streaming, and replay state

- [x] Add canonical input comparison and immutable request snapshots.
- [x] Implement the pending-publication rule for the dsh-assigned assistant ID.
- [x] Check the complete earlier prefix and exact tool-result suffix before release.
- [x] Translate partial and completed events once, keyed by message ID and block
  index. Detect the complete native response independently of the SDK query result.
- [x] Preserve empty thinking, signatures, opaque redacted thinking, and block order.
  Store the response-level replay envelope on successful finishes.
- [x] Capture complete native request evidence through supported diagnostics.
  Reject truncated or redacted evidence as a retention proof.
- [x] Emit correct dsh text, reasoning, tool-call, usage, and terminal chunks.
  Reject malformed arguments before tool publication.
- [x] Disable retries once input or results have crossed the native boundary.
  Invalidate a generation after cancellation or uncertain delivery.

Completion: the offline suite rejects dropped thinking, changed signatures,
changed earlier input, altered replay data, duplicate events, and uncertain
outcomes. A complete synthetic dsh loop performs two steps on one fake session.

## M5. Integrate dsh lifecycle, workspace, and context replacement

- [x] Find the authoritative current workspace service and test it with two
  sessions. Do not infer it from the dsh server's process directory.
- [x] Gate workspace, model, prompt, and tool changes on a live generation
  before continuation.
- [x] Recover a fixed-configuration change with one new generation: new prompt,
  tools, model, effort, output cap, or workspace, the recorded textual import,
  and `generationChange` reason `configuration-change` with the changed fields.
  Keep `REBASE_REQUIRED` for an earlier-prefix edit.
- [x] Add offline tests O58 to O61: plan-mode prompt change on and off, tool
  addition and removal, and model, effort, output-cap, and workspace changes.
- [x] Find the supported dsh session replacement, compaction, and flush APIs.
  Confirm their persistence lifecycle; do not invent a hook name.
- [x] Implement a plugin service/command that records a full context import at
  a balanced boundary before a new generation starts.
- [x] Keep completed historical tool outcomes as quoted context. Remove active
  call IDs and old thinking from the new context, while retaining the original log.
- [x] Reject partial compaction that leaves a signed tail bound to a changed prefix.
- [x] Queue user input through dsh's supported inbox behavior. Reject an unexpected
  mid-tool context insertion instead of moving it inside `stream()`.
- [x] Recover an invalid, closed, or absent generation with one recorded
  textual import: abort, timeout, process loss, restore, plugin reload, and a
  forked subagent. Split the frozen request into history and pending content for
  a new user turn, a tool-result continuation, and a first request with replay.
- [x] Quote completed tool outcomes and omit reasoning text, signatures, image
  bytes, and tool-call ids. Bound the import and keep it deterministic. Send the
  import and the pending content as one user turn on a new native session with
  the current configuration.
- [x] Record `generationChange` in the successful replay data with the reason,
  the replaced ids, the imported count, the prefix hash, and the time. Validate
  the record on read.
- [x] Add offline tests O43 to O52. Native resume is outside this milestone.
- [x] Dispose only owned sessions/processes on abort, agent disposal, or plugin unload.
- [x] Report `context.contextWindow` on every resolved model. Learn the value
  from the native result message `modelUsage` and keep it in a process-wide
  cache. Use the documented 200000 fallback before the first measurement. Do not
  report `defaultMaxTokens`.
- [x] Support the harness summary purposes in a separate native session with a
  deterministic flat-text import. Keep no signed thinking, tool-call ID, or
  image bytes in the import. Mark that auxiliary replay audit `unavailable`.
- [ ] Run a live dsh profile compaction and model switch, and show the context
  meter. The offline suite cannot show the live token meter or the live
  compaction result.

Completion: minimum-version dsh tests cover edit, compaction, workspace change,
model change, tool change, plugin unload, export/restore, missing replay state,
generation recovery after abort, timeout, process loss, restore, reload, and
fork, and fixed-configuration changes with a recorded change.

## M6. Add model catalog, settings, and installation checks

- [ ] Obtain model information through the supported official SDK interface.
  Bind catalog and model preparation to the same configuration generation.
  The preparation binding is tested. `supportedModels()` is not called while
  the spend guard is unavailable, because that call can start a process.
- [x] Use exact IDs consistently in the request, dsh prompt, native identity,
  and UI metadata. Do not quietly substitute a different model.
- [x] Register the route without advertising usable models until the runtime
  and spend requirements pass. Return a clear diagnostic for a blocked route.
- [x] Use host retry and error conventions without hiding plugin failure codes.
- [ ] Test local installation from a built artifact on minimum-version dsh.
  Confirm that installing a plugin alone neither selects it nor spends quota.
  An in-memory load on the published LLM and session services passes. A dsh
  profile install was not run.
- [x] Make the Git-dependency distribution build the package at install time.
  `prepare` runs `npm run build`; the Git tree stays without `dist/`. Tested on
  2026-11-11 with an npm Git dependency install, a packed archive, an isolated
  dsh profile install from a local Git spec, and the documented GitHub spec in a
  fresh isolated DSH_HOME profile.
- [x] Declare the exact tested dsh version as the engine requirement and state
  the refusal behavior in the README. Tested on 2026-11-11: the tested version
  accepted the plugin; a changed requirement was rejected at install and skipped
  at startup (D26).
- [ ] Check the packed file list. Include compiled code, bundle patch, README,
  and the selected license. Exclude credentials, private logs, tests with real
  data, caches, and development artifacts. `pack:check` passed on 2026-11-10.
  No license is selected, so this item stays open.

Completion: package installation, discovery, configuration changes, and removal
work in an isolated dsh profile. A failed preflight cannot cause fallback to a
different provider.

## M7. Finish offline and minimum-version acceptance

- [x] Complete every required offline row in `docs/test-plan.md`.
- [ ] Run integration tests with actual dsh 0.2.2-rc.1 packages and a scripted
  native runtime. Repeat on the selected current supported dsh release.
  The LLM service, session store, and compaction balance checks ran on
  0.2.2-rc.1. No later dsh release was published. The agent loop was not driven.
- [x] Confirm no offline command reads real credentials or contacts a model.
- [x] Run locked install, type-check, tests, build, and package inspection.
- [x] Update design and compatibility records to describe the implemented behavior.

Completion: the plugin is ready for a live acceptance attempt. Describe it as
offline-tested until M8 passes. Do not claim signed thinking reached Anthropic
from a synthetic fixture or successful tool answer.

## M8. Live acceptance and release

Prerequisite: an accepted spend guard must exist before the first model prompt.
Current project state does not meet this prerequisite. Do not bypass it to run a
small test. If the user changes that requirement, record the new scope first.

- [ ] Verify the official binary and selected SDK versions, effective workspace,
  truthful system prompt, complete native tools, and permitted auth route.
- [ ] Exercise a real dsh tool step through the SDK and inspect the next native
  request for exact thinking, signature, prompt, tools, and prefix retention.
- [ ] Repeat with empty thinking text, multiple calls, delayed approval, denial,
  and the actual dsh prompt. A greeting is not enough.
- [ ] Run the safe live tamper test if the official interface supports it. Report
  any unavailable negative test as unverified; do not forge model requests.
- [ ] Verify context resets and cleanup on the installed SDK/CLI pair.
- [ ] Store a reviewed evidence summary and retain private raw captures locally.
  Record versions, test commands, failures, and unverified claims.
- [ ] Choose the release license, version, supported runtime range, and built
  distribution method. Publish or install into a personal profile only within
  the user's authorized deployment scope. Distribution method, 2026-11-11: a Git
  dependency with an install-time `prepare` build (D20). Runtime range,
  2026-11-11: the exact tested dsh version only (D26). The license and version
  stay open.

Completion: all required release tests pass and the spend requirement is met.
If it remains unmet, deliver the offline-tested plugin with inference disabled
and a precise blocker report. Do not label it production-ready.

Scope change, 2026-11-10: the user removed the mandatory extra-usage lock.
Production may send a prompt after a first-party subscription login. Live
acceptance has not run. The package has no selected license. The agent loop
integration and a profile install remain open. A successful offline test does
not show that signed thinking reached Anthropic.

## M9. Multimodal content support

Status on 2026-11-11: offline work is complete. The live SDK probe passed. A
dsh profile acceptance run is not done.

- [x] Declare text and image input for catalog rows and resolved models.
- [x] Send a user image as one exact request version with descriptor text, a
  1568-pixel longest edge, and a 4 MiB target.
- [x] Send text and image blocks from tool results as MCP result content.
- [x] Replace an offloaded image with placeholder text and read no bytes.
- [x] Refuse an image without the attachment service, an image in a system or
  assistant message, and an unsupported result block before dispatch.
- [x] Report the exact image target and image price on the adapter.
- [x] Keep file bytes outside the adapter and test the dsh runtime projection.
- [x] Map `maxTokens` to `CLAUDE_CODE_MAX_OUTPUT_TOKENS` and include the cap in
  the generation identity.
- [x] Accept the harness auxiliary purposes; support a session-title call.
- [x] Add offline tests O33 to O40 and a real-dsh-runtime projection test.
- [x] Run the official SDK probe with one user image and one tool-result image.
- [ ] Run an image turn through an installed dsh profile and inspect the native
  request record. This needs the deployment scope from the user.
- [ ] Measure many retained images, image offload on a long session, image
  retention with signed thinking, and image delivery to a subagent.
- [x] Support the compaction summary as a recorded flat-text import without
  signed history. The offline suite covers the import, the fresh native session,
  and the unavailable audit. This is not a live measurement.
- [ ] Run a live dsh profile compaction and observe the replacement surface.
  Confirm that no signed-history retention is claimed for the summary.
- [ ] Show the context capacity and token pressure of this route in the dsh UI.
  Confirm the measured value replaces the fallback in a live session.

## M10. Native turn errors and truncated answers

Status on 2026-11-11: offline work is complete. No live provider error was
measured.

- [x] Add a pure native result mapping module. Keep the mapping independent of
  the SDK.
- [x] Map context overflow, quota, first-party credit, rate limit, auth, and
  server errors to stable dsh codes.
- [x] Normalize the two Claude wordings that the dsh classifiers do not read.
- [x] Keep the native message text and remove tokens, headers, account
  identities, email addresses, and long opaque values.
- [x] Emit one `turn-error` native event and one thrown `LlmError` with the
  stable code.
- [x] Do not report an error after a complete assistant response.
- [x] Translate an assistant or result `max_tokens` stop to a `max-tokens`
  finish. Keep the replay state.
- [x] Refuse a truncated turn that carries a tool call.
- [x] Add offline tests O53 to O57.
- [ ] Measure the real error finishes with the provider. This needs a live
  request that the current release policy does not allow.

Completion: dsh receives the correct stable code for each measured native
result, and a truncated answer is never a `stop` finish.

## Working rules

Complete milestones in order unless independent offline work can proceed safely.
Update checked tasks only after their completion criteria pass. Keep evidence
dates and versions with each claim. Run only tests needed for the changed area,
then the milestone's required checks. Keep this plan consistent with the code.

## M11. Session disposal cleanup and auth-check cache

Status on 2026-11-11: offline work is complete. No live process cleanup and no
live auth command was measured.

- [x] Listen for the dsh `session/disposed` event in the plugin entry.
- [x] Close only the conversation generation of the disposed session through
  the bounded close.
- [x] Keep the plugin-unload path that closes every owned process.
- [x] Keep an auxiliary call and a different session open.
- [x] Add the accepted-auth cache with the documented scope and short interval.
- [x] Keep the settings safety check and the first-party subscription check on a
  cold cache or a changed scope.
- [x] Do not cache a refusal.
- [x] Add offline tests O67 to O69.
- [ ] Measure a live session disposal and a live auth cache hit through an
  installed dsh profile.

Completion: one dsh session disposal releases exactly its native process, plugin
unload releases every owned process, and one accepted auth check covers a short
interval without a new command.

## M12. Auxiliary session release

Status on 2026-11-11: offline work is complete. No live auxiliary call was
measured.

- [x] Release the auxiliary key in the `finally` path after a bounded close or
  an invalidation.
- [x] Refuse a conversation generation in the release path.
- [x] Keep `conversation()` separate from the auxiliary map.
- [x] Add offline tests O70 and O71.
- [ ] Measure an aborted auxiliary call through an installed dsh profile.

Completion: every aborted or failed auxiliary call leaves no session entry, and
a later call with the same content starts a new native session.
