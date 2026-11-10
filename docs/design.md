# Claude subscription adapter design

Status: the repository has an offline package. The launch plan describes one
persistent native session and does not start it. Scripted tests check the
transcript, replay envelope, and tool-result suffix. No plugin was installed
in a dsh profile. Production inference is refused. The saved request test
passed. The complete plugin has not passed an integration test.

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

Before each continuation, compare the complete frozen request with the stored
expected dsh transcript. Check the system text, ordered tools and schemas, exact
model ID, controls, message content, message identity, and tool-call mapping.
Do not compare only the last user message or tool IDs. Do not change the frozen
request. A local hash detects differences; it does not validate an Anthropic
signature.

Support a new session with a recorded initial input and later user turns. While
a native tool call is pending, accept only its complete dsh tool-result batch.
Queue new user input until the tool turn ends. Refuse an unsupported developer
message or other context insertion at that boundary. Do not silently move it to
another position. The dsh companion integration must keep queued user input out
of the current frozen request. If it cannot, refuse that continuation.

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
request. No component converts a signature to ordinary text.

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

Stage results by native tool-use ID, independently of MCP callback arrival order.
This avoids a deadlock if the CLI invokes handlers one at a time. Release the
complete validated batch only after dsh has recorded it. The bridge must support
the content type or refuse it; do not silently flatten images or structured data.

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

Keep the prompt, native tool definitions, conversion rules, and model fixed for
the generation. Record the CLI's own prompt prefix and reminders. The measurement
shows that `--system-prompt` does not remove every CLI-added input.

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

Any earlier-message edit, deletion, replacement, tool-result pruning, prompt
change, tool-list change, or model change ends the generation. Returning to the
old model does not make an edited prefix valid. Never reuse the old signatures
with the changed input.

If a tool call is pending, stop the native process without supplying invented
results. Let dsh settle its existing tool records. Require a new generation
before another model request.

Start the new generation at a balanced tool boundary with an explicit context
import or summary. Record that exact input as a dsh user context message. Keep
historical actions as quoted context, with no live tool-call IDs and no old
thinking blocks. Keep the original events in the archive. This is a new model
conversation; it does not preserve the old signatures across the change.

Use the dsh session and compaction services to record this operation before
`stream()`. Do not flatten the frozen transcript inside the adapter. Ordinary
partial compaction, which keeps a signed recent tail after changing its prefix,
must return `REBASE_REQUIRED`. A plugin compaction integration must instead
replace all model-visible context for the new generation with its recorded
import. A summary model call uses a separate CLI session and the same billing
checks. It never reuses the live tool session.

For the first release, process loss also returns `REBASE_REQUIRED`. Saved
signatures alone do not establish that a new process resumes the same native
request. Native resume at a tool boundary remains a test candidate.

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

Therefore, the strict mode must require a verified account-side restriction
that cannot be lifted during execution, or an official atomic subscription-only
request control. Neither has been established for this personal account.
Until then, strict mode refuses startup with `BILLING_GUARD_UNAVAILABLE`, before
sending any model input. A manual assertion or an old rate-limit event does not
remove this refusal.

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

**9. Limits of this design**

This design does not make the CLI a stateless transcript API. It does not allow
arbitrary transcript import, silent mid-tool context updates, or signature reuse
after a changed prefix. It does not remove subscription limits, establish a
subscription-only billing switch, or prove crash-safe native resume.

It does not establish that fresh-process replay or a relay can never work.
Those paths are outside this design. The existing measurements support one
persistent CLI tool turn and an offline preservation check. They do not close
other paths or establish a production-ready plugin.

The plugin cannot guarantee Anthropic's acceptance of a truthful dsh prompt or
the account's future billing classification. It cannot promise custom dsh HTTP
attribution headers through the SDK unless an official supported interface is
found and tested. Keep local attribution in dsh. The first release's text-only
content scope and explicit refusals are specified in [contracts.md](contracts.md).
