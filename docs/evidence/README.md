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
