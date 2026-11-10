# Synthetic fixtures

`thinking-roundtrip/session.jsonl` and `thinking-roundtrip/output.ndjson` describe
one synthetic response with empty thinking, a fake signature, and one tool call.
The next synthetic request retains those blocks and pairs the tool result.

These files contain no copied account data, private paths, or valid signatures.
All IDs, model names, tool data, and answers are synthetic. The request-record
format matches the subset read by `scripts/verify_thinking.py`.

The session records use SHA-256 of UTF-8 JSON with sorted object keys, preserved
array order, and no optional whitespace. The second request inherits the first
request's prefix with `base` and `keep`, then adds message-hash references.

The output file is an independent expected source. It includes a successful final
answer. The checker changes only the second request for each tamper case and
updates its hashes. This prevents a stale hash or an absent answer from becoming
the reason for rejection.

Run the checker command in the repository README. Never use this fixture as proof
of real Claude thinking, signature validity, subscription acceptance, or billing.
