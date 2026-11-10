# dsh-plugin-claude-code

A DeepSeek Harness model plugin for the user's Claude subscription. It will use
the official Claude Agent SDK and the installed official Claude binary.

Status: the package can install, type-check, test, build, and pack without
Claude credentials. The offline launch plan describes one persistent native
session. Production requests fail with `BILLING_GUARD_UNAVAILABLE`.
The minimum target is dsh 0.2.2-rc.1. No later dsh release was published on
2026-11-10. Later releases need their own compatibility checks. The plugin is
not installed in a dsh profile.

The plugin will keep one native Claude session for each dsh session generation.
An MCP handler will wait while dsh runs each tool. The same native session will
continue with the result. This preserves native thinking without importing it
into a fresh worker at each step.

dsh will own the tools, sandbox, approvals, and durable session. The plugin will
check that dsh's frozen transcript agrees with the native session before each
continuation. A change to earlier input will require a recorded new generation.

Read these files in order:

1. [PLAN.md](docs/PLAN.md): work sequence, outputs, and completion criteria.
2. [Design](docs/design.md): behavior, constraints, and known limits.
3. [Compatibility](docs/compatibility.md): pinned packages and public imports.
4. [Contracts](docs/contracts.md): modules, data, state machine, and errors.
5. [Test plan](docs/test-plan.md): offline and live acceptance tests.
6. [Decisions](docs/decisions.md): selected approach and open questions.
7. [Evidence](docs/evidence/README.md): results and their limits.
8. [Sources](docs/sources.md): package and documentation references.

Current files:

```text
AGENTS.md                  Instructions for implementation agents
docs/PLAN.md               Implementation work sequence
docs/                      Design, contracts, tests, decisions, and evidence
src/                       Plugin source
test/                      Offline tests and the scripted runtime
scripts/                   Package checks, the thinking checker, and the live-test refusal
cordis.patch.yml           Bundle patch for route claude-code-session
```

Install locked dependencies, then run the offline checks. These commands do not
need Claude credentials. They do not start a Claude process.

```sh
npm ci
npm test
npm run check
npm run build
npm run pack:check
```

`npm run test:live` is a separate command. It refuses and exits with code 2.
Do not add it to `test`, installation, or a build hook.

Run the thinking checker alone with Python 3.10 or later:

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
