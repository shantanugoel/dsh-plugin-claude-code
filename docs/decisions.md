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
- Can native resume preserve an interrupted tool turn without rewriting its
  bound input? This is outside the first release until measured.

Fresh-worker replay, relay insertion, native resume, and ACP are not marked
impossible. This plan selects one path. Record evidence before closing another.
