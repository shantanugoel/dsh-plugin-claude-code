# Compatibility record

Review date: 2026-11-10.

This record lists published package identities and the imports this plugin uses.
A declaration check is not a live session test. Do not treat it as proof that a
flag changes a native request.

## dsh baseline

The minimum version is dsh 0.2.2-rc.1. On this date, the npm version list for
`@deepseek-ai/dsh` and `@deepseek-ai/dsh-llm` ends at `0.2.2-rc.1`. No later
advertised release was available to check.

The plugin `engines.dsh` value is the exact version `0.2.2-rc.1`. A later dsh
release needs its own check before this plugin claims support for it.

These integrity values come from the npm registry and from `package-lock.json`
for packages this repository installs.

| Package | Version | Integrity |
| --- | --- | --- |
| `@deepseek-ai/dsh` | 0.2.2-rc.1 | `sha512-ijR9UEVYkG15Q/Q79JzvzLBzQOQfc63VLr9n6flpwHPhr5IKn2UxthnSoto/P9l7qGd7pPvI1Ra6TW7LH3oKpg==` |
| `@deepseek-ai/dsh-llm` | 0.2.2-rc.1 | `sha512-XeEvH+6bpkjx0E2P1B5ZE+WWa+VHp4DimQaJDKNUZEFouqHMuN1B61TIz6IzUquRxa/6X4yJy+qXQ9WwAeMw5w==` |
| `@deepseek-ai/dsh-agent-loop` | 0.2.2-rc.1 | `sha512-LsmoSB/wckh2bNVMIKan+6G3QlAYM9Uhthh+9ti6N5AXqFqR7m7gWdEbQ/MWks9DgjWw/EP6x943UBga+TADCA==` |
| `@deepseek-ai/dsh-session` | 0.2.2-rc.1 | `sha512-e0zx9HFNn8EyqrymGQS85SjKOyr61//ChTgIVDlCBSZvBB723fuXyi9LiHIIuPTlkgmWJl3gm5J51ebEXew7PQ==` |
| `@deepseek-ai/dsh-compaction` | 0.2.2-rc.1 | `sha512-KWn/GpZ5adrSkS4O6U25gvVdtNG4D8tZ/xdUCsIEftveCJvT4R0s38PPcmIALS92jxHjrrCa6msVanW3lh1S1Q==` |
| `@deepseek-ai/dsh-system-prompt` | 0.2.2-rc.1 | `sha512-1p9imdrenPnJTkLb6Coq+ELBDjngblM/YGP1Pa/xf1oisjLHcCoK2n9kkOUTIfgvoFtqWfxZJNZeKef71ZmlrA==` |
| `@deepseek-ai/dsh-package-manifest` | 0.2.2-rc.1 | `sha512-/Dz9+N+iMLu4QaXC28Miy1ClgZpHcWEq+B7+BQVwekdWwEPyFrPPjcl6slTXtq2ZlhOh/lNhXousZzyg7TsyKA==` |
| `@deepseek-ai/dsh-attachment` | 0.2.2-rc.1 | `sha512-iXw72OnKY95NYN9a6nHse/b4LbTbpgINRV38zk1Q+7K0Qlm1qiMZ2NwGfW9Hz+ch6SBxI6L8NZiFeMnBjSR86A==` |
| `@deepseek-ai/cordis` | 4.1.0 | `sha512-CJrjNyBkKn1SfvBQUcgFYKFnLjS+uKrhdMsbHU60xabvi12d+xQ+IQSNlME5Z+B+4Zi6n4BDknKY94tEPeo47w==` |
| `@deepseek-ai/schemastery` | 3.19.0 | `sha512-bDXoYQa7ghAhmdYD5VPlzKxEzJV/aKkz5l4V5h1u06z8GAPN1ROewSjvR9WiXhpa52E9fng8lpH5QdCRIQgnyQ==` |

`@deepseek-ai/dsh-llm` and `@deepseek-ai/cordis` are peer dependencies. The host
must supply those copies. `@deepseek-ai/schemastery` is a direct dependency at
the same major range the host uses for settings. `@deepseek-ai/dsh-attachment`
and `@deepseek-ai/dsh-package-manifest` are development dependencies. The
published `dsh-llm` declarations import them. This plugin does not call them
at runtime.

`@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-compaction` are peer
dependencies at `0.2.2-rc.1`. The plugin reads `Session.header.cwd`. That field
is immutable creation metadata. The filesystem service `cwd` is a process-wide
base for relative paths. It is not the session workspace. No published method
in this version changes `header.cwd` after `sessions.create()`. A missing header
path fails. A different filesystem base fails with `REBASE_REQUIRED`.

The context import uses `session.append` with `surfaceOp: replace`,
`toolPairingBalancedBefore`, `toolPairingBalancedAfter`, and
`sessions.flush`. Flush must return true, which requires a `session/flush`
listener. The raw log keeps the replaced events. The agent inbox is private in
this version. A user message inside a tool-result suffix is refused. The
plugin does not move that message.

## Public imports

The plugin source imports these public names:

| Module | Names |
| --- | --- |
| `@deepseek-ai/dsh-llm` | `LlmAdapter`, `LlmError`, `resolveRetryPolicy`, `GenerateOptions`, `LlmModelInfo`, `LlmProviderInfo`, `LlmResolvedModelInfo`, `ResolvedRetryPolicy`, `StreamChunk`, `createUserMessage`, `ToolCallId` |
| `@deepseek-ai/dsh-session` | `SessionId`, `SessionStore`, `Session` |
| `@deepseek-ai/dsh-compaction` | `toolPairingBalancedBefore`, `toolPairingBalancedAfter` |
| `@deepseek-ai/cordis` | `Context` |
| `@deepseek-ai/schemastery` | default schema constructor |

`Context.llm` comes from the `dsh-llm` module augmentation. The plugin calls
`registerAdapter` with the route `claude-code-session`. The settings schema is
an empty schemastery object. It has no paid-usage switch.

The bundle patch is `cordis.patch.yml`. It inserts the package
`dsh-plugin-claude-code` with entry id `claude-code-session`.
`listedByDefault` is false. The route does not advertise a usable model.

## Agent SDK

Selected package: `@anthropic-ai/claude-agent-sdk` version `0.3.322`.

Integrity: `sha512-r88ij7R3SPV2j3BtFuavgrbWZNE8SVVS42AOQ1KxlS+QnSwNNnUhmVXV3Es2dniZySBYX8ENebL43ffhiB0azw==`.

This is the newest published version on the review date. The SDK version is
not the Claude CLI version. The saved measurement used Claude Code 2.1.319.
That pair is not certified here.

`scripts/verify-sdk-surface.mjs` reads `sdk.d.ts`. It does not import the SDK
program and it does not start a process. The file declares these names:

- `Options.pathToClaudeCodeExecutable` for the executable path.
- `query` `prompt` as a string or `AsyncIterable<SDKUserMessage>` for the input queue.
- `Query` as an async generator, plus `streamInput`, for the event stream.
- `createSdkMcpServer` and `Options.mcpServers` for MCP.
- `Query.close` for close.
- `Query.supportedModels` for model discovery.
- `includePartialMessages`, `settingSources`, and `strictMcpConfig`.

The presence of a name in the declaration file does not prove the running CLI
applies that option. `src/official-session.ts` imports this package when
`SdkNativeRuntime.start` runs. The offline suite does not call `start`.

`src/sdk-plan.ts` builds the offline launch plan for one query, one event
consumer, and one streaming input queue. A tool-call finish leaves that query
open. The plan sets the session workspace, the dsh prompt as a custom system
prompt, the exact model, an empty built-in tool list, an empty settings-source
list, partial messages, and only the `dsh` MCP server. It also sets the
declared advisor, compaction, background-task, connector, skill, workflow, and
prompt-suggestion controls. The plan omits a fallback model and omits resume.
`scripts/verify-sdk-surface.mjs` checks that the pinned declaration file still
contains the option names this plan uses. That check does not start a process.

npm also installed the SDK peer packages `zod@4.6.7`,
`@anthropic-ai/sdk@1.7.0`, and `@modelcontextprotocol/sdk@1.32.2`. The plugin
source does not import them.

## Admission

The plugin checks the request, an absolute workspace, settings files, and an
allowlisted child environment before `claude auth status`. It accepts
`loggedIn: true`, `authMethod: "claude.ai"`, and `apiProvider: "firstParty"`.
It stores only a hash of `orgId` or `accountId`. It refuses `apiKeyHelper`,
`awsAuthRefresh`, `gcpAuthRefresh`, and billing variables in a settings `env`
block. The checked files are the user settings, `~/.claude.json`, the workspace
project and local settings, and the platform managed settings file.

Production registration reads `Session.header.cwd` through `ctx.sessions`.
A missing path fails with `UNSUPPORTED_INPUT` before the auth command. Offline
tests use a temporary workspace or a real in-memory session store, and a fake
command runner. They do not execute the installed Claude binary. A valid test
proof cannot change `ProductionSpendGate`. That gate allows a prompt and
records policy `subscription-login` with `validFor` `no-spend-lock`.

The scripted transcript check compares the canonical earlier prefix, binds one
dsh assistant id to the pending publication, and requires the stored replay
envelope. Empty thinking text remains in the replay with its signature.
Redacted thinking stays in `nativeResponseBlocks` and has no display text.
A native request record is an audit success only when `status` is `complete`,
`redacted` is false, `truncated` is false, and `body.messages` is a non-empty
array that fits the storage bound. The scripted runtime supplies that record.
This is not a live diagnostic capture.

## Commands

The engine range is Node.js `>=24.9.0`. The checks below ran on Node.js
`v26.13.0` and npm `11.20.0`. This run does not certify Node.js 24.9.0.

Passed on 2026-11-10:

- `npm ci` in a clean directory that contained only `package.json` and `package-lock.json`
- `npm test`
- `npm run check`
- `npm run build`
- `npm run pack:check`

The same `npm test`, `npm run check`, `npm run build`, and `npm run pack:check`
commands passed again after the transcript, session-import, and catalog work.
`pack:check` accepted 43 files. No license is selected. The suite does not read
Claude credentials and does not contact a model. `supportedModels()` is not
called. A supplied catalog row uses its exact id. `prepareCall` keeps one
configuration generation for the later stream. Production supplies no catalog.

`npm run test:live` exits with code 2. It starts no Claude process. `test`,
`check`, `build`, and `pack:check` do not call it. The package has no
`postinstall`, `prepare`, or `prepack` script.

The package inspection accepted the compiled files, `cordis.patch.yml`, the
README, and `package.json`. No license is selected. The packed file list does
not include tests, fixtures, source, credentials, or private logs.
