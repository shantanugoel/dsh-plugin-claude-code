# dsh-plugin-claude-code

Use your Claude subscription in DeepSeek Harness (dsh). The plugin runs the
official Claude Code CLI through the official Agent SDK. It keeps one native
Claude session for each dsh session. This preserves Claude's signed thinking
across tool calls. If the native session ends, the plugin starts a new one with
a recorded text import of the conversation. dsh keeps control of the tools, the
sandbox, and the approvals.

## Requirements

- DeepSeek Harness 0.2.2-rc.1, the tested version. The plugin installs and
  activates only with this version.
- The official Claude Code CLI on `PATH`, signed in with a claude.ai
  subscription.
- For an install from GitHub: Node.js 24.9 or later, and npm on `PATH`. The
  package builds during installation.

The plugin declares the exact tested dsh version in `engines.dsh`. The dsh
plugin manager refuses another dsh version until a compatibility check. It
prints the plugin name and version, the failed requirement, the running dsh
version, and the exemption command. The exemption records one exact plugin
version for one exact dsh version:

```sh
dsh plugin --profile <profile> allow-version dsh-plugin-claude-code@0.2.0 --dsh-version <running-version> --accept-risk
```

Use the exemption only after you accept the risk. A new dsh release needs a
compatibility test and a new plugin version.

The plugin accepts only a first-party Claude subscription login. It refuses an
API key, a Claude Console login, and a custom billing endpoint.

## Install

The repository does not contain `dist/`. The `prepare` script builds it from the
locked dependencies when a package manager installs the repository as a Git
dependency. Do not add a separate build step for a GitHub install.

In the Desktop app, enter `github:shantanugoel/dsh-plugin-claude-code` as the
plugin URL. The app builds the package during installation. If the app asks to
allow the build scripts, approve them and retry the installation.

On the CLI, run:

```sh
dsh plugin --profile web add github:shantanugoel/dsh-plugin-claude-code
```

Replace `web` with another profile name for other profiles. pnpm blocks the
build script of a Git package until the profile allows it. The first run fails
with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and prints the exact `allowBuilds`
key. Add that key to `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml`. The
default `DSH_HOME` is `~/.dsh`. Example:

```yaml
allowBuilds:
  "<key from the command>": true
```

Run the same command again. The second run builds `dist/` and installs the
plugin. The desktop app records the same build approval and offers to retry.

For a local copy, run:

```sh
git clone https://github.com/shantanugoel/dsh-plugin-claude-code.git
cd dsh-plugin-claude-code
npm ci
```

`npm ci` installs the locked dependencies and runs the `prepare` build. From
that directory, run `dsh plugin add "$PWD"`. In the desktop app, use
**Settings → Plugins → Add plugin** and enter the absolute path. Restart dsh
when it asks, and enable the plugin in **Settings → Plugins** if it is not
already on. Installation does not select a model or send a prompt.

## Use

Start a new session. Select **Claude Code session** as the provider, then select
a model. The model list comes from the installed Claude Code CLI. A main session
and a subagent session can each use a model on this route.

The plugin disables Claude Code's built-in tools. dsh provides the tools and
runs each call with its own sandbox and approvals.

## Content support

- **Text and images.** The route declares text and image input for each model.
  A user message can contain PNG, JPEG, WebP, and GIF images. The plugin sends
  each image as one request version with a longest edge of 1568 pixels and a
  target of 4 MiB. A short text line before each image names the attachment and
  its request size.
- **Image tool results.** A tool result can contain text blocks and image
  blocks. The plugin sends both as MCP tool-result content. A model can read a
  screenshot or a rendered image from a dsh tool.
- **File attachments.** dsh replaces each file block with a text handle that
  names the read-only saved path. The model reads that path with the dsh file
  tools. The plugin never receives file bytes.
- **Image offload.** An image-offload event changes an old image to placeholder
  text. The plugin reads no bytes for that occurrence. A request above the
  route image budget fails with `IMAGE_OFFLOAD_REQUIRED` and the number of
  oldest images that must be offloaded. dsh records the offload and retries
  the step.
- **Image limits.** The plugin refuses a conversation request with more than
  80 retained image occurrences or 20 MiB of encoded image bytes. A native
  generation can hold the same amounts. Before the next turn would pass the
  generation limit, the plugin starts a recorded new Claude session with a text
  import that holds image placeholders and no image bytes. These values are
  conservative adaptations of the provider documentation. They are not a
  measured provider limit.
- **Output cap.** A dsh `maxTokens` control maps to the official
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` environment control for that native session.
- **Messages while a tool runs.** If you send a message while a tool is running,
  or if dsh adds a reminder after tool results, the plugin delivers it inside
  the same Claude turn. The text stays a separate message. The plugin never
  moves it into the tool result.
- **Recovery and configuration changes.** If the Claude session stops, or if
  the prompt, tools, model, effort, output cap, or workspace change, the plugin
  starts a new Claude session and sends a recorded text import of the earlier
  conversation plus your new input with the new configuration. This applies
  after Stop, a generation timeout, a lost Claude process, a dsh restore or
  reload, a forked subagent, a plan-mode toggle, and an MCP tool change. The dsh
  session continues. The import does not keep the old signed thinking.
- **Context capacity.** The route reports a context window of 200000 tokens to
  dsh before the first native result message. That value is a documented
  fallback and not a measurement. After the first result message the plugin
  keeps the model's reported `contextWindow`. The plugin does not declare a
  default output cap.
- **Compaction summary.** A compaction or summary call replays the conversation
  prefix as recorded text in a separate Claude session. The text keeps no signed
  thinking, no tool-call IDs, and no image bytes. dsh records the replacement
  surface.
- **Truncated answers.** A turn that stops at the output-token limit gets a
  `max-tokens` finish. The answer is incomplete. The plugin never reports this
  turn as a normal stop.

## Errors

The route reports stable error codes. dsh selects recovery behavior from the
code. It does not parse the message text.

| Code | Meaning |
| --- | --- |
| `CONTEXT_WINDOW_EXCEEDED` | The request is larger than the model context window. dsh context compaction can act on this code. |
| `RATE_LIMIT` | The account reached a request-rate limit. |
| `QUOTA` | The plan usage or the provider quota is exhausted. |
| `ACCOUNT_QUOTA` | The first-party account balance or billing state needs an action. |
| `AUTH` | The login is absent, refused, or not first-party. |
| `SERVER` | The provider reported an overload or a server error. |
| `MALFORMED_RESPONSE` | A native turn ended with output or a limit that dsh cannot use as a complete answer. |
| `NATIVE_OUTCOME_UNKNOWN` | A native turn failed with an unknown outcome. dsh does not retry it. |

The messages keep the native text. The plugin removes tokens, authentication
headers, account identities, email addresses, and long opaque values from each
message.

## Limits

- A live native session keeps every image that it receives. The plugin starts a
  recorded new generation before the retained images reach its conservative
  limit. The new session receives a text import with image placeholders and no
  image bytes. A direct official-SDK probe sent 100 and 101 synthetic images and
  both turns succeeded. The probe did not reach the provider image limit, so the
  exact provider limit is not measured.
- A prompt, tool, model, effort, output-cap, or workspace change starts a new
  Claude session with the new configuration and a recorded text import. The dsh
  session continues.
- A change to earlier messages also starts a new Claude session with a recorded
  text import. The dsh session continues. Examples are a dsh tool-result prune
  under context pressure, a compaction replacement, and an edit. The prompt
  cache of the old Claude session is not used after this change.
- A mid-turn message can contain text. An image in a message that arrives while
  a tool runs returns an error until a measurement covers that path.
- Recovery starts a new Claude session. It does not keep the earlier signed
  thinking, because the new session starts a new thinking chain. The earlier
  events stay in the dsh log.
- A truncated turn can carry only text. The plugin does not execute a tool call
  from a turn that stops at the output-token limit.
- A session-title call works. A compaction or summary call works as a recorded
  textual import in a separate Claude session. The import keeps no signed
  history, and the plugin does not report signed-prefix retention for it. A
  request after dsh replaces the conversation surface starts a recorded new
  generation.
  Automatic compaction, `/compact`, and a high-pressure model switch are not
  verified in a live dsh profile.
- The plugin reports the context window that the Claude CLI states for each
  model. It reads the value with no model request. On 2026-11-11 the CLI stated
  1000000 tokens for the alias `sonnet` and 200000 tokens for
  `claude-sonnet-4-6`. A result message that reports a window replaces the read
  value. If the read fails, the plugin uses a 200000-token fallback.
- dsh starts its context-pressure work at the smaller of 80% of the context
  window and the window minus the `headroomTokens` value of its
  `compaction-basic` plugin. The default headroom is 65536 tokens. A
  1000000-token window has a threshold of 800000 tokens. A 200000-token window
  has a threshold of 134464 tokens. A large session uses more of your Claude
  plan limit for each request. To start the pressure work earlier, set
  `thresholdRatio` or a `modelPolicies` entry for this route in the dsh
  profile. The dsh token meter with these values has not been verified in a live
  dsh profile.
- A recovery import has a limit of 120000 characters of quoted messages. A
  longer history keeps its first message and its latest messages. The messages
  between them are omitted with one mark.
- Your Claude plan limits apply. Extra usage charges are possible. The plugin
  does not block them.

- The retention audit reads the official CLI raw-body diagnostic from a private
  directory. It reports `accepted` only when the recorded request matches the
  launched prompt, the dsh tool list, the served model, and the earlier signed
  prefix. The CLI may add one inert `DeferredToolPlaceholder`; the audit keeps
  its complete definition. If a record is missing or differs, the audit reports
  `unavailable` and the turn still completes.

- Live acceptance in an isolated dsh profile measured one real `read_image`
  tool result and one subagent image reaching the model (PANGOLIN7). A user-image
  turn is unverified because the headless app has no attachment input. Signed
  thinking retention after a tool result is unverified: the request audit stored
  `unavailable` for that request. The output-cap mapping and many-image dsh
  behavior are offline-tested or measured with the direct SDK only. See
  [docs/evidence/live-dsh-acceptance-2026-11-11.json](docs/evidence/live-dsh-acceptance-2026-11-11.json).

## Troubleshooting

If the model list is empty, run `claude auth status`. The output must show
`loggedIn: true`, `authMethod: "claude.ai"`, and `apiProvider: "firstParty"`.

If the plugin reports that the Claude executable is not on `PATH`, install the
official Claude Code CLI or add its directory to `PATH`. Restart dsh.

If an image is refused, confirm that the dsh profile mounts the attachment
service. A profile without that service still works for text.

For design and test details, see [docs/design.md](docs/design.md).
