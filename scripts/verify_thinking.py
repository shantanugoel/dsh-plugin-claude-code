#!/usr/bin/env python3
"""Check saved Claude request records. Do not start a process or use the network."""

import argparse
import copy
import hashlib
import json
from pathlib import Path


def digest(value):
    data = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()


def read_records(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def check(records, output):
    # This check supports the two-request probe from the design.
    requests = [r for r in records if r.get("type") == "api-request" and r.get("querySource") == "sdk"]
    assert len(requests) == 2, "Expected two SDK request records"
    first, second = requests
    shapes = {r["shapeHash"]: r["shape"] for r in records if r.get("type") == "api-request-shape"}
    blobs = {}
    for r in records:
        if r.get("type") == "api-request-blob":
            assert digest(r["message"]) == r["hash"], "Request blob hash differs"
            blobs[r["hash"]] = r["message"]
        elif r.get("type") in ("user", "assistant"):
            m = r["message"]
            native = {k: m[k] for k in ("role", "content")}
            blobs[digest(native)] = native

    resolved = {}
    for r in requests:
        base = resolved[r["base"]] if "base" in r else []
        keep = r.get("keep", 0)
        assert 0 <= keep <= len(base), "Invalid request prefix length"
        resolved[r["id"]] = base[:keep] + [blobs[h] for h in r["tail"]]
    before, after = resolved[first["id"]], resolved[second["id"]]
    assert first["params"]["model"] == second["params"]["model"], "Model changed"
    assert shapes[first["shapeHash"]] == shapes[second["shapeHash"]], "System or tools changed"
    assert after[:len(before)] == before, "Earlier messages changed"

    # The original output is an independent source for the expected blocks.
    source = [r["message"] for r in output if r.get("type") == "assistant"]
    assert source, "Assistant output is absent"
    response_id = source[0]["id"]
    expected = copy.deepcopy([b for m in source if m["id"] == response_id for b in m["content"]])
    for b in expected:
        if b.get("type") == "tool_use" and "caller" in b:
            assert b["caller"] == {"type": "direct"}, "Unsupported tool caller"
            del b["caller"]
    thinking = [b for b in expected if b.get("type") == "thinking"]
    assert thinking and all(b.get("signature") for b in thinking), "Signed thinking is absent from the source"
    assert any(b.get("type") == "tool_use" for b in expected), "Source tool call is absent"
    appended = after[len(before):]
    assert appended and appended[0]["role"] == "assistant", "Assistant request message is absent"
    assert appended[0]["content"] == expected, "Thinking or tool blocks differ from the original response"
    calls = [b["id"] for b in expected if b.get("type") == "tool_use"]
    results = [b["tool_use_id"] for m in appended for b in m["content"] if b.get("type") == "tool_result"]
    assert calls == results, "Tool results do not match the calls"
    assert any(r.get("type") == "assistant" and r.get("requestRef") == second["id"] for r in records), "No response is linked to the second request"
    return {
        "cli_version": next(r["version"] for r in records if r.get("type") == "api-request"),
        "model": first["params"]["model"],
        "requests": len(requests),
        "thinking_text_lengths": [len(b["thinking"]) for b in thinking],
        "signature_lengths": [len(b["signature"]) for b in thinking],
        "signature_sha256": [hashlib.sha256(b["signature"].encode()).hexdigest() for b in thinking],
        "recorded_native_tools": [t["name"] for t in shapes[first["shapeHash"]]["tools"]],
        "same_recorded_system_tools_and_prefix": True,
        "same_recorded_thinking_and_tool_blocks": True,
    }


def mutate_request(records, change):
    altered = copy.deepcopy(records)
    blob = next(r for r in altered if r.get("type") == "api-request-blob" and any(b.get("type") == "thinking" for b in r["message"]["content"]))
    old_hash = blob["hash"]
    change(blob["message"]["content"])
    blob["hash"] = digest(blob["message"])
    # Keep the altered request record valid. A stale hash must not cause the failure.
    for r in altered:
        if r.get("type") == "api-request":
            r["tail"] = [blob["hash"] if h == old_hash else h for h in r["tail"]]
    return altered


def self_test(records, output):
    def drop(blocks):
        blocks[:] = [b for b in blocks if b.get("type") != "thinking"]

    def change_signature(blocks):
        b = next(b for b in blocks if b.get("type") == "thinking")
        b["signature"] = ("A" if b["signature"][0] != "A" else "B") + b["signature"][1:]

    def change_text(blocks):
        next(b for b in blocks if b.get("type") == "thinking")["thinking"] += "x"

    results = {}
    for name, change in (("drop_thinking", drop), ("change_signature", change_signature), ("change_thinking_text", change_text)):
        try:
            check(mutate_request(records, change), output)
        except AssertionError as error:
            assert str(error) == "Thinking or tool blocks differ from the original response", str(error)
            results[name] = "rejected"
        else:
            raise AssertionError(f"Tamper case passed: {name}")
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session_log")
    parser.add_argument("stream_output")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if not __debug__:
        parser.error("Do not use Python optimization flags; this checker requires assertions")
    records, output = read_records(args.session_log), read_records(args.stream_output)
    result = check(records, output)
    if args.self_test:
        result["offline_tamper_cases"] = self_test(records, output)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
