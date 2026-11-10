# dsh-plugin-claude-code

A planned DeepSeek Harness model plugin that uses the user's Claude subscription
through the official Claude Agent SDK and the installed official Claude binary.

Status: design and offline verification files only. There is no installable
plugin yet. The minimum target is dsh 0.2.2-rc.1. Later releases need their own
compatibility checks.

The plugin will keep one native Claude session for each dsh session generation.
An MCP handler will wait while dsh runs each tool. The same native session will
continue with the result. This preserves native thinking without importing it
into a fresh worker at each step.

dsh will own the tools, sandbox, approvals, and durable session. The plugin will
check that dsh's frozen transcript agrees with the native session before each
continuation. A change to earlier input will require a recorded new generation.

Read these files in order:

1. [PLAN.md](PLAN.md): work sequence, outputs, and completion criteria.
2. [Design](docs/design.md): behavior, constraints, and known limits.
3. [Contracts](docs/contracts.md): modules, data, state machine, and errors.
4. [Test plan](docs/test-plan.md): offline and live acceptance tests.
5. [Decisions](docs/decisions.md): selected approach and open questions.
6. [Evidence](docs/evidence/README.md): results and their limits.
7. [Sources](docs/sources.md): package and documentation references.

Current files:

```text
AGENTS.md                  Instructions for implementation agents
PLAN.md                    Implementation work sequence
docs/                      Design, contracts, tests, decisions, and evidence
scripts/verify_thinking.py  Checker for saved CLI request records
tests/fixtures/            Synthetic checker inputs
```

Run the available offline check with Python 3.10 or later:

```sh
python3 scripts/verify_thinking.py \
  tests/fixtures/thinking-roundtrip/session.jsonl \
  tests/fixtures/thinking-roundtrip/output.ndjson \
  --self-test
```

This command checks the fixture and rejects three changes to its thinking block.
It starts no Claude process and makes no network request. The synthetic signature
has no cryptographic validity. The original live measurement is described in
[the evidence record](docs/evidence/README.md).

The strict spend guard is unresolved. Until an official control or a verified
account restriction prevents paid usage before inference, production requests
must fail with `BILLING_GUARD_UNAVAILABLE`. Offline implementation and integration
tests can proceed with a test transport. There is no public paid-usage override.

No Console key, OAuth replay, client spoofing, or direct Anthropic model client is
part of this project. Do not install a different provider as an automatic fallback.
