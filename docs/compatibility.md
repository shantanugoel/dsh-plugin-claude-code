# Compatibility record

Review date: 2026-11-11.

This record lists published package identities and the imports this plugin uses.
A declaration check is not a live session test. Do not treat it as proof that a
flag changes a native request.

## dsh baseline

The tested version is dsh 0.2.2-rc.1. On 2026-11-11 the npm registry version
list for `@deepseek-ai/dsh` had 42 versions and ended at `0.2.2-rc.1`. The
`latest` and `next` dist-tags named `0.2.2-rc.1`, which was published on
2026-11-04. No later release exists. The plugin does not claim support for a
later dsh release until its own compatibility test passes.

The plugin `engines.dsh` value is the exact version `0.2.2-rc.1`. The dsh plugin
manager evaluates this field alone: a runtime version that does not satisfy the
exact value is incompatible. A later dsh release therefore disables the plugin
until the user grants the exact-version exemption or a new plugin version is
tested.

Engine gate checks on 2026-11-11 used the dsh 0.2.2-rc.1 CLI and an isolated
`DSH_HOME` profile from the shipped `headless` template. The desktop profile was
not used.

- The tested version accepted the plugin. A `dsh plugin add` of the checked-out
  package accepted the exact requirement, the profile added the plugin bundle,
  and `--dump-config` listed the enabled `claude-code-session` entry. The issue
  #1 GitHub spec install on the same tested version also installed the plugin.
- An install of a temporary copy under `/tmp` with `engines.dsh` set to `0.2.3`
  was rejected before installation. The message names the plugin, the running
  dsh version, the requirement, the risk, and the exemption command, and ends
  with `dsh: nothing was installed.` The profile manifest stayed unchanged.
- An installed copy with the same changed requirement was skipped at profile
  startup. The message was `dsh: skipping profile bundle
  "dsh-plugin-claude-code": Error: Plugin dsh-plugin-claude-code@0.2.0 is
  incompatible with dsh 0.2.2-rc.1: requirements {"engines.dsh":"0.2.3"}.` The
  plugin entry was absent from the composed profile. The boot continued and no
  unrelated plugin failed.
- The exemption flow was not exercised. The host printed the exact command
  `dsh plugin --profile <profile> allow-version dsh-plugin-claude-code@0.2.0
  --dsh-version 0.2.2-rc.1 --accept-risk`.

A later dsh release cannot be run because no later release exists. The rejection
cases changed the package requirement, not the runtime version. They exercise
the same compatibility check, but they are not a measurement of a real later dsh
release.

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

`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-attachment`, and `@deepseek-ai/cordis`
are peer dependencies. The host must supply those copies.
`@deepseek-ai/schemastery` is a direct dependency at the same major range the
host uses for settings. `@deepseek-ai/dsh-package-manifest` is a development
dependency. The published `dsh-llm` declarations import it.

The plugin source has type-only imports from `@deepseek-ai/dsh-attachment`.
The runtime reads the mounted attachment service through `ctx.get('attachments')`
and does not import the package module. An image request needs that service. A
profile without it accepts text and refuses an image before dispatch.

The plugin source reads image request versions through the attachment service
`readImageRequest` method. It does not read image bytes from the filesystem.

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
| `@deepseek-ai/dsh-llm` | `LlmAdapter`, `LlmError`, `resolveRetryPolicy`, `GenerateOptions`, `LlmModelInfo`, `LlmProviderInfo`, `LlmResolvedModelInfo`, `LlmImageRequestPricing`, `ResolvedRetryPolicy`, `StreamChunk`, `createUserMessage`, `ToolCallId`, `offloadedImageText`, `requestImageHandleText` |
| `@deepseek-ai/dsh-attachment` | `ImageAttachmentRef`, `ImageRequestTarget`, `RequestImageAttachment`, `AttachmentStore` (all type-only) |
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
- `SDKResultMessage.modelUsage` with `ModelUsage.contextWindow` and
  `ModelUsage.maxOutputTokens`, for the process-wide capacity cache.

The presence of a name in the declaration file does not prove the running CLI
applies that option. `src/official-session.ts` imports this package when
`SdkNativeRuntime.start` runs. The offline suite does not call `start`.

The image probe on 2026-11-11 started the installed CLI through the SDK. It used
SDK 0.3.322 and CLI 2.1.319 with the subscription login. One streaming user
message carried a synthetic PNG. One in-process MCP tool returned the same PNG.
The model read the word in both cases. The probe made two inference requests.
It used no dsh profile. See
[the probe summary](evidence/sdk-image-probe-2026-11-11.json). It does not
certify many images, image offload, image retention with thinking, or subagent
image delivery.

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

## Distribution and installation

Distribution method: a Git dependency. The package manager builds `dist/` at
install time through the `prepare` script (D20). The Git tree does not contain
`dist/`. The packed archive does.

Install checks on 2026-11-11 used macOS arm64, Node.js `v26.13.0`, npm
`11.20.0`, the dsh 0.2.2-rc.1 CLI, and the bundled pnpm `11.28.5`:

- `npm install git+file://<worktree>#issue-1-install` in an empty temporary
  directory ran `prepare`, created `dist/index.js`, and installed 125 packages.
  `import('dsh-plugin-claude-code')` resolved the package entry.
- `npm pack` produced a 55-file archive. The archive contained `dist/`,
  `cordis.patch.yml`, `README.md`, and `package.json`. It contained no source,
  test, evidence, credential, or private file.
- An isolated `DSH_HOME` profile (`acceptance`) initialized from the default
  bundle list. The first `dsh plugin --profile acceptance add <git spec>`
  failed with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and printed the exact
  `allowBuilds` key. The failed run left the profile `package.json` without the
  dependency.
- After the profile `pnpm-workspace.yaml` contained that key, the same command
  ran the build and installed the plugin. The profile `package.json` added the
  dependency and the bundle.
- `dsh --profile acceptance --dump-config` printed the
  `dsh-plugin-claude-code` layer and the `claude-code-session` entry. The entry
  is not disabled.

The documented `github:shantanugoel/dsh-plugin-claude-code` install check passed
on 2026-11-11 after the push of commit `dd952ad`. A fresh isolated `DSH_HOME`
profile from the shipped `headless` template fetched the GitHub archive. The
first run failed with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and printed the
exact `allowBuilds` key, pinned to the fetched commit. The second run, after the
profile added that key, built the package with `prepare` and installed it. The
profile dependency stays `github:shantanugoel/dsh-plugin-claude-code`.
`--dump-config` listed the `claude-code-session` entry. The installed package
contained `README.md`, `cordis.patch.yml`, `package.json`, and `dist/` only.

These checks sent no model prompt. They did not use the user's desktop profile.
The desktop app build-approval flow was not run. `--dump-config` composes the
route but does not run plugin JavaScript; the first task in issue #13 covers the
module import.

## Commands

The engine range is Node.js `>=24.9.0`. The checks below ran on Node.js
`v26.13.0` and npm `11.20.0`. This run does not certify Node.js 24.9.0.

Passed on 2026-11-10 and again on 2026-11-11 after the image work. These checks
ran before D20 added the `prepare` script:

- `npm ci` in a clean directory that contained only `package.json` and `package-lock.json`
- `npm test`
- `npm run check`
- `npm run build`
- `npm run pack:check`

The same `npm test`, `npm run check`, `npm run build`, and `npm run pack:check`
commands passed again after the transcript, session-import, and catalog work.
After the image work the suite had 76 tests and `pack:check` accepted 55
files. The suite passed again on 2026-11-11 after the distribution change,
with 76 tests. After the native-error work, which was merged after the rollover
work, the suite had 117 tests. After the context-capacity and compaction-summary
work the suite had 135 tests. The new tests use the scripted runtime. They do
not start the Claude binary and they do not measure a context window. After the
session-cleanup work the suite had 146 tests. After the auxiliary-release work
the suite had 150 tests. After the model-metadata work the suite has 152 tests.
The packed file list has 63 files.
The `npm pack --dry-run` check on 2026-11-11 used a temporary npm cache, because
the default npm cache in this environment has root-owned entries and `npm pack`
cannot write to it. The package version is 0.2.0. No license is selected. The
suite does not read Claude credentials and does not contact a model.
`supportedModels()` is not called. A supplied catalog row uses its exact id.
`prepareCall` keeps one configuration generation for the later stream.
Production supplies no catalog.

`npm run test:live` exits with code 2. It starts no Claude process. `test`,
`check`, `build`, and `pack:check` do not call it. The package has no
`postinstall` or `prepack` script. The `prepare` script runs `npm run build` at
install time and before `npm pack` (D20). The Git tree does not include `dist/`.
`npm ci` also runs `prepare`, so it needs the source tree. A dependency-only
install uses `npm ci --ignore-scripts`.

The package inspection accepted the compiled files, `cordis.patch.yml`, the
README, and `package.json`. No license is selected. The packed file list does
not include tests, fixtures, source, credentials, or private logs.
