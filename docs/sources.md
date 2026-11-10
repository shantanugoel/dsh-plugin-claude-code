# Sources

Review date: 2026-11-10. Documentation and package behavior can change. Verify the
installed declarations before a code change. A source claim is not a local test.

## dsh

- [Repository](https://github.com/deepseek-ai/deepseek-harness).
- [Adapter cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-an-llm-adapter.md).
- Published npm packages inspected at `0.2.2-rc.1`:
  `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-agent-loop`,
  `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-compaction`,
  `@deepseek-ai/dsh-system-prompt`, and `@deepseek-ai/dsh-package-manifest`.
- Important package files: `dsh-llm/lib/types/index.d.ts`, `types.d.ts`,
  `message.d.ts`, and `assembler.js`; `dsh-agent-loop/lib/index.js`;
  `dsh-session/lib/types/index.d.ts`; and each package README.

Use the published minimum-version package as the compatibility baseline. Do not
assume the repository's default branch has the same interface. Record the package
integrity values when dependencies are added.

## Official Claude interfaces

- [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript).
- [Session management](https://code.claude.com/docs/en/agent-sdk/sessions).
- [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools).
- [Partial output events](https://code.claude.com/docs/en/agent-sdk/streaming-output).
- [System prompts and added context](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts).
- [Settings sources](https://code.claude.com/docs/en/agent-sdk/claude-code-features).
- [Environment controls](https://code.claude.com/docs/en/env-vars).
- [CLI and auth-status command](https://code.claude.com/docs/en/cli-reference).
- [Request-body diagnostics](https://code.claude.com/docs/en/monitoring-usage).
- [Subscription use](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- [Paid usage-credit controls](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans).

## Related implementations

- [Manoj's measured comparison](https://stacktoheap.com/blog/2026/11/09/claude-subscription-deepseek-harness/).
  The article tests imported thinking and a persistent OpenCode session. It also
  identifies workspace, model-name, attribution, and billing limitations.
- [manojlds/dsh-claude-code](https://github.com/manojlds/dsh-claude-code), article
  version `v0.1.0`.
- [earendil-works/pi-claude-code](https://github.com/earendil-works/pi-claude-code),
  article commit `d5b5e04c314d3452d357174d16d10dda34daa2d2`.
- [pi-claude-directsdk](https://github.com/joaomj/pi-claude-directsdk) and its
  [test notes](https://github.com/joaomj/pi-claude-directsdk/blob/main/docs/testing.md).
  Its current documentation describes a persistent SDK session and waiting MCP
  handlers. This is an implementation reference, not a dependency decision or
  evidence that it meets this project's spend and signature requirements.
- [pi-claude-cli](https://github.com/rchern/pi-claude-cli) describes native resume
  between workers. Native resume remains a separate test candidate.
- [ACP tool ownership](https://agentclientprotocol.com/protocol/v1/tool-calls).
  ACP alone does not transfer every tool operation to dsh.

Do not copy another integration's prompt identity, auth implementation, or billing
headers. Inspect its license before code reuse. Choose a project license before
publication; this preparation task does not select a license.
