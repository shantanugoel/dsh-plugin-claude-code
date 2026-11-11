# Evidence records

## Saved live probe

[cli-2.1.319.json](cli-2.1.319.json) summarizes the direct-CLI probe from
2026-11-10. It used the official installed Claude binary, subscription login,
and one MCP tool. The tool handler waited for 20 seconds before returning a
token. The CLI then returned the expected answer.

The native session log recorded two model requests. An offline checker rebuilt
their message references and compared the second request's thinking with the
independent original output. It found an empty thinking string and the same
912-character signature. The recorded system, tools, and earlier content also
agreed. A linked response followed the second request.

The native tool list contained `DeferredToolPlaceholder`, `mcp__dsh__probe`, and
`advisor`. This configuration is not certified for dsh-only tool execution.

Three changes to saved request data were rejected: removed thinking, a changed
signature character, and a changed thinking character. The message hashes and
references were updated in each changed case. The successful answer was retained.

## SDK image probe

[sdk-image-probe-2026-11-11.json](sdk-image-probe-2026-11-11.json) summarizes a
direct Agent SDK probe on 2026-11-11. It used SDK 0.3.322 and Claude Code
2.1.319 with the subscription login. One streaming user message carried a
synthetic 480x160 PNG with the word `PANGOLIN7`. One in-process MCP tool
returned the same PNG as a tool-result image item. The model read the word in
both cases. The probe made two inference requests. It used a private temporary
directory for the fixture and committed no account data. It did not run the
plugin inside dsh and did not measure signed thinking retention.

## Many-image probe

[many-image-probe-2026-11-11.json](many-image-probe-2026-11-11.json) summarizes a
direct Agent SDK probe on 2026-11-11 for issue #9. It used SDK 0.3.322 and Claude
Code 2.1.319 with the first-party subscription route. Two streaming user
messages carried 100 and 101 synthetic 1x1 PNG images. Both turns completed with
subtype success and the answer `MANY-IMAGES-OK`. The result message reported
`contextWindow` 1000000 and `maxOutputTokens` 128000 for the selected model
`claude-opus-5-5`. The probe made two inference requests. It did not reach the
documented request image limits. Thus, it does not measure the exact provider
image limit. The raw capture is private and is not committed.

## Install distribution check

[install-2026-11-11.json](install-2026-11-11.json) records the issue #1 checks on
2026-11-11. The Git tree does not contain `dist/`, so the package has a
`prepare` script that builds it at install time. The record covers an npm Git
dependency install, a packed archive, and an install into an isolated dsh
profile. The first profile install failed with the build-approval error. After
the profile allowed the exact key, the plugin installed and `--dump-config`
listed the route. The documented GitHub spec install then passed on 2026-11-11
in a fresh isolated DSH_HOME profile. The record contains no account data and no
raw capture.

## Engine check

[engine-check-2026-11-11.json](engine-check-2026-11-11.json) records the issue #12
checks on 2026-11-11. No dsh release later than 0.2.2-rc.1 exists. The tested
version accepted the plugin in an isolated profile. A temporary copy under
`/tmp` with a changed `engines.dsh` was rejected at install with a clear message,
and an installed copy with that changed requirement was skipped at startup. The
rejection cases changed the package requirement, not the runtime version. The
record contains no account data and no raw capture.

## Trailing-context probe

[trailing-context-probe-2026-11-11.json](trailing-context-probe-2026-11-11.json)
summarizes a direct Agent SDK probe on 2026-11-11 for issue #4. It used SDK
0.3.322 and Claude Code 2.1.319 with the subscription login. One in-process MCP
tool handler parked. The probe pushed a trailing user message, then released the
tool result. The model answered once and included both the tool token and the
trailing word. The raw API request has the trailing text in a CLI-generated
system-role mid-turn message after the `tool_result` block. In the opposite
order, the CLI ended the tool turn first and started a second native turn.

This session's file sandbox denied the CLI transcript write under
`~/.claude/projects` with EPERM. The probe captured the request through the
official `OTEL_LOG_RAW_API_BODIES` file diagnostic instead. The probe did not
run the plugin inside dsh, and it did not measure an image, several trailing
messages, signed-thinking retention, or another version pair.

## Limits

- This was a direct `claude -p` probe, not the planned SDK plugin.
- This was one tool turn, not a dsh integration or endurance test.
- Request records are client diagnostics, not independent server validation.
- The negative tests changed saved records. They did not obtain server rejection
  of a damaged signature.
- No pre-inference guard against paid overflow was established.
- No new inference request was made during the later offline verification.

Raw captures contain private account and context data. They are not committed.
The summary omits machine-specific file paths. The signature digest identifies
the observed signature without publishing it. If the original private files
are unavailable, the historical measurement cannot be rerun from this repository.

For new captures, use `.local/evidence/<run-name>/` with restrictive permissions.
Record versions, capture method, input mapping, results, and remaining gaps in
a reviewed summary under this directory. Do not publish raw credentials, headers,
thinking, or account identifiers.

## Synthetic fixture

The files under [tests/fixtures](../../tests/fixtures/README.md) are hand-built
synthetic data for the checker. They are independent of the private capture and
have no valid Anthropic signature. Their passing result is not live evidence.
