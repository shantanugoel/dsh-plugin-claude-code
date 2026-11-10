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

Open: no accepted pre-inference guard has been measured. This blocks live release,
not independent offline implementation. Do not replace this requirement with
an `allowPaidUsage` option unless the user explicitly changes the requirement.

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
  M2 on 2026-11-10 can bind a proof to an identity, scope, expiry, and interval.
  Production still returns `BILLING_GUARD_UNAVAILABLE`. Auth status is not that
  proof. The offline tests use synthetic status and do not run the installed
  Claude binary.
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

Decision: `listModels` returns an empty list while `ProductionSpendGate`
refuses. `prepareCall` captures the configuration generation and refuses
dispatch after that generation changes. The plugin does not call
`supportedModels()`.

Reason: that SDK method can start a process. A process start is not allowed
before the spend guard. A supplied catalog row uses the official model value
as the dsh id. The blocked route records `BILLING_GUARD_UNAVAILABLE` on the
configurable-provider entry. Loading the plugin does not select a model.
