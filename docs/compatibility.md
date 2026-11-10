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

The agent-loop, session, compaction, and system-prompt packages were inspected.
They are not dependencies yet.

## Public imports

The plugin source imports these public names:

| Module | Names |
| --- | --- |
| `@deepseek-ai/dsh-llm` | `LlmAdapter`, `LlmError`, `resolveRetryPolicy`, `GenerateOptions`, `LlmModelInfo`, `LlmProviderInfo`, `LlmResolvedModelInfo`, `ResolvedRetryPolicy`, `StreamChunk` |
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
applies that option. Production source does not import this package. `start`
on the production runtime fails with `BILLING_GUARD_UNAVAILABLE` before a
process can start.

npm also installed the SDK peer packages `zod@4.6.7`,
`@anthropic-ai/sdk@1.7.0`, and `@modelcontextprotocol/sdk@1.32.2`. The plugin
source does not import them.

## Commands

The engine range is Node.js `>=24.9.0`. The checks below ran on Node.js
`v26.13.0` and npm `11.20.0`. This run does not certify Node.js 24.9.0.

Passed on 2026-11-10:

- `npm ci` in a clean directory that contained only `package.json` and `package-lock.json`
- `npm test`
- `npm run check`
- `npm run build`
- `npm run pack:check`

`npm run test:live` exits with code 2. It starts no Claude process. `test`,
`check`, `build`, and `pack:check` do not call it. The package has no
`postinstall`, `prepare`, or `prepack` script.

The package inspection accepted the compiled files, `cordis.patch.yml`, the
README, and `package.json`. No license is selected. The packed file list does
not include tests, fixtures, source, credentials, or private logs.
