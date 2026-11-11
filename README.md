# dsh-plugin-claude-code

Use your Claude subscription in DeepSeek Harness (dsh). The plugin runs the
official Claude Code CLI through the official Agent SDK. It keeps one native
Claude session for each dsh session. This preserves Claude's signed thinking
across tool calls. dsh keeps control of the tools, the sandbox, and the
approvals.

## Requirements

- DeepSeek Harness 0.2.2-rc.1. Later versions are untested but may work.
- The official Claude Code CLI on `PATH`, signed in with a claude.ai
  subscription.

The plugin accepts only a first-party Claude subscription login. It refuses an
API key, a Claude Console login, and a custom billing endpoint.

## Install

In Desktop app, you can install it with `github:shantanugoel/dsh-plugin-claude-code` as the plugin url.

On CLI, you can install it with `dsh plugin --profile web add github:shantanugoel/dsh-plugin-claude-code` (Replace `web` with another profile name for other profiles)

For modifying/installing from a local copy, you can do the below.

```sh
git clone https://github.com/shantanugoel/dsh-plugin-claude-code.git
cd dsh-plugin-claude-code
npm ci
npm run build
```

From that directory, run `dsh plugin add "$PWD"`. In the desktop app, use
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

## Limits

- The plugin does not remove old images from the live native session. A session
  with a very large number of retained images can reach the provider image
  limit. Start a recorded new generation in that case.
- An edit to earlier messages, a model or effort change, a tool change, a
  workspace change, or a lost Claude process requires a new Claude session.
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
