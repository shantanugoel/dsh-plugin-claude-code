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
a model. The model list comes from the installed Claude Code CLI.

The plugin disables Claude Code's built-in tools. dsh provides the tools and
runs each call with its own sandbox and approvals.

## Limits

- The plugin accepts text input and text tool results only. It refuses images,
  file attachments, and structured tool results.
- An edit to earlier messages, a model or effort change, a tool change, a
  workspace change, or a lost Claude process requires a new Claude session.
- Your Claude plan limits apply. Extra usage charges are possible. The plugin
  does not block them.

## Troubleshooting

If the model list is empty, run `claude auth status`. The output must show
`loggedIn: true`, `authMethod: "claude.ai"`, and `apiProvider: "firstParty"`.

If the plugin reports that the Claude executable is not on `PATH`, install the
official Claude Code CLI or add its directory to `PATH`. Restart dsh.

For design and test details, see [docs/design.md](docs/design.md).
