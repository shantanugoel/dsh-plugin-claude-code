# Agent instructions

- Write all documents and specifications in ASD-STE100 Simplified Technical English.
- Read `README.md`, `docs/PLAN.md`, `docs/design.md`, and `docs/contracts.md` before implementation.
- Use `docs/test-plan.md` for acceptance criteria. Update the plan when a task is complete.
- Use the persistent official Claude Agent SDK as the production transport. The
  SDK must run the user's unmodified official Claude executable.
- Keep dsh in control of tool execution, its sandbox, and its approvals.
- Do not read or copy OAuth credentials. Do not send a model request directly.
  Do not change client identity or billing headers.
- Keep signed thinking unchanged inside the native session. A saved signature
  does not authorize its use after an earlier input changes.
- A lock that prevents extra usage during a session is optional. Do not refuse
  inference only because that lock is absent. Keep the first-party subscription
  check. Refuse an API key, a console login, and a changed billing endpoint.
- Distinguish a proposed behavior, an offline test, and a live measurement.
  Do not use a successful answer or a cache hit as proof of thinking retention.
- Do not close an alternative approach without a measurement.
- Keep raw captures, account details, and credentials out of Git. Use `.local/`
  for private test data. Fixtures in `tests/fixtures/` must contain synthetic data.
- Do not install this plugin in the user's dsh profile or publish it as part of
  a code-only task. Follow the user's current instruction for deployment scope.
- Choose ordinary implementation details without a new confirmation request.
  Record a material design change and its evidence in `docs/decisions.md`.
