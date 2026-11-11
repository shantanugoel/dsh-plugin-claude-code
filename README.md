# dsh-plugin-claude-code

Use your Claude subscription in DeepSeek Harness (dsh). The plugin runs the
official Claude Code CLI through the official Agent SDK. It keeps one native
Claude session for each dsh session. This preserves Claude's signed thinking
across tool calls. If the native session ends, the plugin starts a new one with
a recorded text import of the conversation. dsh keeps control of the tools, the
sandbox, and the approvals.

## Requirements

- DeepSeek Harness 0.2.2-rc.1. Later versions are untested but may work.
- The official Claude Code CLI on `PATH`, signed in with a claude.ai
  subscription.
- For an install from GitHub: Node.js 24.9 or later, and npm on `PATH`. The
  package builds during installation.

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
  text. The plugin reads no bytes for that occurrence.
- **Output cap.** A dsh `maxTokens` control maps to the official
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` environment control for that native session.
- **Recovery and configuration changes.** If the Claude session stops, or if
  the prompt, tools, model, effort, output cap, or workspace change, the plugin
  starts a new Claude session and sends a recorded text import of the earlier
  conversation plus your new input with the new configuration. This applies
  after Stop, a generation timeout, a lost Claude process, a dsh restore or
  reload, a forked subagent, a plan-mode toggle, and an MCP tool change. The dsh
  session continues. The import does not keep the old signed thinking.
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

- The plugin does not remove old images from the live native session. A session
  with a very large number of retained images can reach the provider image
  limit. Start a recorded new generation in that case.
- A prompt, tool, model, effort, output-cap, or workspace change starts a new
  Claude session with the new configuration and a recorded text import. The dsh
  session continues.
- An edit to earlier messages still returns `REBASE_REQUIRED`. Start a new dsh
  session for an edit.
- Recovery starts a new Claude session. It does not keep the earlier signed
  thinking, because the new session starts a new thinking chain. The earlier
  events stay in the dsh log.
- A truncated turn can carry only text. The plugin does not execute a tool call
  from a turn that stops at the output-token limit.
- A session-title call works. A compaction or summary call that replays
  conversation history returns `UNSUPPORTED_INPUT`, because a new native session
  cannot import signed history. Record a context import to start a new
  generation.
- Your Claude plan limits apply. Extra usage charges are possible. The plugin
  does not block them.

## Troubleshooting

If the model list is empty, run `claude auth status`. The output must show
`loggedIn: true`, `authMethod: "claude.ai"`, and `apiProvider: "firstParty"`.

If the plugin reports that the Claude executable is not on `PATH`, install the
official Claude Code CLI or add its directory to `PATH`. Restart dsh.

If an image is refused, confirm that the dsh profile mounts the attachment
service. A profile without that service still works for text.

For design and test details, see [docs/design.md](docs/design.md).
