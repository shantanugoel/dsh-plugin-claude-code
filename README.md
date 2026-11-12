# dsh-plugin-claude-code

[![npm](https://img.shields.io/npm/v/dsh-plugin-claude-code)](https://www.npmjs.com/package/dsh-plugin-claude-code)
[![license](https://img.shields.io/npm/l/dsh-plugin-claude-code)](LICENSE)

Use your Claude subscription in DeepSeek Harness (dsh). The plugin runs the
official Claude Code CLI. dsh keeps control of the tools, the sandbox, and the
approvals.

## Requirements

- DeepSeek Harness 0.2.2-rc.1.
- The official [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)
  on `PATH`, signed in with a claude.ai subscription. The plugin refuses an API
  key and a Claude Console login.

## Install

The plugin is on npm as
[`dsh-plugin-claude-code`](https://www.npmjs.com/package/dsh-plugin-claude-code).

**Desktop app**

1. Open **Settings → Plugins → Add plugin**.
2. Enter `dsh-plugin-claude-code`.
3. Restart dsh when it asks.
4. Make sure that the plugin is on in **Settings → Plugins**.

**CLI**

```sh
dsh plugin --profile web add dsh-plugin-claude-code
```

Replace `web` with the name of your profile. Restart dsh after the install.

## Use

1. Start a new session.
2. Select **Claude Code session** as the provider.
3. Select a model. The list comes from your Claude Code CLI.

To let a subagent use a different Claude model:

1. Open **Plugins → Subagent**.
2. In **Model selection**, set the switch to on.
3. Select each **Claude Code session** model that a subagent can use. Include
   the model of the main session.
4. Select **Save**, then start a new session.

## Troubleshooting

- **The model list is empty.** Run `claude auth status`. It must show
  `loggedIn: true`, `authMethod: "claude.ai"`, and `apiProvider: "firstParty"`.
- **The Claude executable is not on `PATH`.** Install the Claude Code CLI or
  add its directory to `PATH`. Then restart dsh.
- **dsh refuses the plugin version.** This plugin works only with the tested dsh
  version. See the [version check](https://github.com/shantanugoel/dsh-plugin-claude-code/blob/main/docs/reference.md#version-check).

Your Claude plan limits apply. Extra usage charges are possible.

## More information

The [reference](https://github.com/shantanugoel/dsh-plugin-claude-code/blob/main/docs/reference.md) describes content support, error codes, limits, and
installation from source.

## Author and links

Made by [Shantanu Goel](https://x.com/shantanugoel).

- Source: <https://github.com/shantanugoel/dsh-plugin-claude-code>
- Issues: <https://github.com/shantanugoel/dsh-plugin-claude-code/issues>

This is an unofficial community plugin. It is not affiliated with Anthropic or
DeepSeek.

## License

[MIT](LICENSE)
