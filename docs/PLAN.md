# Implementation plan

Goal: build one dsh model plugin that uses a persistent official Claude Agent SDK
session, preserves native signed thinking across unchanged tool steps, and leaves
all tool execution, sandbox rules, and approvals with dsh.

Status: the scripted session can park tool calls and return dsh results by call
id. The native launch plan is built and tested offline. The official SDK query
is not started. Production inference remains refused. Continue with M4.
Do not mark later tasks complete from the direct-CLI measurement.

## Fixed requirements

- Minimum target: dsh 0.2.2-rc.1. Check each advertised later version.
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

- [ ] Add canonical input comparison and immutable request snapshots.
- [ ] Implement the pending-publication rule for the dsh-assigned assistant ID.
- [ ] Check the complete earlier prefix and exact tool-result suffix before release.
- [ ] Translate partial and completed events once, keyed by message ID and block
  index. Detect the complete native response independently of the SDK query result.
- [ ] Preserve empty thinking, signatures, opaque redacted thinking, and block order.
  Store the response-level replay envelope on successful finishes.
- [ ] Capture complete native request evidence through supported diagnostics.
  Reject truncated or redacted evidence as a retention proof.
- [ ] Emit correct dsh text, reasoning, tool-call, usage, and terminal chunks.
  Reject malformed arguments before tool publication.
- [ ] Disable retries once input or results have crossed the native boundary.
  Invalidate a generation after cancellation or uncertain delivery.

Completion: the offline suite rejects dropped thinking, changed signatures,
changed earlier input, altered replay data, duplicate events, and uncertain
outcomes. A complete synthetic dsh loop performs two steps on one fake session.

## M5. Integrate dsh lifecycle, workspace, and context replacement

- [ ] Find the authoritative current workspace service and test it with two
  sessions. Do not infer it from the dsh server's process directory.
- [ ] Gate workspace, model, prompt, and tool changes before continuation.
  Return `REBASE_REQUIRED` until the recorded reset operation is implemented.
- [ ] Find the supported dsh session replacement, compaction, and flush APIs.
  Confirm their persistence lifecycle; do not invent a hook name.
- [ ] Implement a plugin service/command that records a full context import at
  a balanced boundary before a new generation starts.
- [ ] Keep completed historical tool outcomes as quoted context. Remove active
  call IDs and old thinking from the new context, while retaining the original log.
- [ ] Reject partial compaction that leaves a signed tail bound to a changed prefix.
- [ ] Queue user input through dsh's supported inbox behavior. Reject an unexpected
  mid-tool context insertion instead of moving it inside `stream()`.
- [ ] On restore, reject an old generation with no live native process. Offer the
  recorded context-import operation. Native resume is outside this milestone.
- [ ] Dispose only owned sessions/processes on abort, agent disposal, or plugin unload.

Completion: minimum-version dsh tests cover edit, compaction, workspace change,
model change, tool change, plugin unload, export/restore, and missing replay state.

## M6. Add model catalog, settings, and installation checks

- [ ] Obtain model information through the supported official SDK interface.
  Bind catalog and model preparation to the same configuration generation.
- [ ] Use exact IDs consistently in the request, dsh prompt, native identity,
  and UI metadata. Do not quietly substitute a different model.
- [ ] Register the route without advertising usable models until the runtime
  and spend requirements pass. Return a clear diagnostic for a blocked route.
- [ ] Use host retry and error conventions without hiding plugin failure codes.
- [ ] Test local installation from a built artifact on minimum-version dsh.
  Confirm that installing a plugin alone neither selects it nor spends quota.
- [ ] Check the packed file list. Include compiled code, bundle patch, README,
  and the selected license. Exclude credentials, private logs, tests with real
  data, caches, and development artifacts.

Completion: package installation, discovery, configuration changes, and removal
work in an isolated dsh profile. A failed preflight cannot cause fallback to a
different provider.

## M7. Finish offline and minimum-version acceptance

- [ ] Complete every required offline row in `docs/test-plan.md`.
- [ ] Run integration tests with actual dsh 0.2.2-rc.1 packages and a scripted
  native runtime. Repeat on the selected current supported dsh release.
- [ ] Confirm no offline command reads real credentials or contacts a model.
- [ ] Run locked install, type-check, tests, build, and package inspection.
- [ ] Update design and compatibility records to describe the implemented behavior.

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
  the user's authorized deployment scope.

Completion: all required release tests pass and the spend requirement is met.
If it remains unmet, deliver the offline-tested plugin with inference disabled
and a precise blocker report. Do not label it production-ready.

## Working rules

Complete milestones in order unless independent offline work can proceed safely.
Update checked tasks only after their completion criteria pass. Keep evidence
dates and versions with each claim. Run only tests needed for the changed area,
then the milestone's required checks. Keep this plan consistent with the code.
