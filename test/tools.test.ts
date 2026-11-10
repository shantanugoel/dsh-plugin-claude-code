import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { DEFAULT_DEADLINES } from '../src/deadlines.js'
import { mapToolNames } from '../src/mcp-bridge.js'
import type { NativeEvent, NativeToolResult } from '../src/sdk-runtime.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime, type ScriptedTurn } from './scripted-runtime.js'
import { interpretAuthStatus } from '../src/auth.js'
import { SYNTHETIC_AUTH_STATUS, makeAdapter } from './support.js'

const NOW = new Date('2026-11-10T00:00:00.000Z')

function proof(binding: string): SpendProof {
  return {
    policyId: 'proof-1',
    identityBinding: binding,
    scope: 'claude-code-session',
    expiresAt: '2026-11-10T01:00:00.000Z',
    validFor: 'pt1h',
  }
}

function toolEvents(calls: readonly { id: string; name: string; arguments: string }[]): NativeEvent[] {
  const events: NativeEvent[] = []
  calls.forEach((call, index) => {
    events.push(
      { type: 'block-start', messageId: 'm1', index, blockType: 'tool-call' },
      {
        type: 'tool-delta',
        messageId: 'm1',
        index,
        id: call.id,
        name: call.name,
        argumentsDelta: call.arguments,
      },
      { type: 'block-stop', messageId: 'm1', index },
    )
  })
  events.push(
    { type: 'usage', inputTokens: 3, outputTokens: 2 },
    { type: 'message-stop', messageId: 'm1', stopReason: 'tool_use' },
  )
  return events
}

function publishedAssistant(chunks: readonly StreamChunk[], id = 'assistant-1') {
  const finish = chunks.at(-1)
  const replayState = finish?.type === 'finish' ? finish.replayState : undefined
  const content = chunks.flatMap((chunk) => chunk.type === 'block-end' ? [chunk.block] : [])
  return {
    role: 'assistant' as const,
    id,
    content,
    source: {
      kind: 'model' as const,
      provider: 'claude-code-session',
      model: 'claude-haiku-5-5',
      ...(replayState === undefined ? {} : { replayState }),
    },
  }
}

function resultRequest(
  chunks: readonly StreamChunk[],
  results: readonly { id: string; text: string; isError?: boolean }[],
  sessionId = 'session-1',
): GenerateOptions {
  const base = textRequest('hello', sessionId)
  return {
    ...base,
    tools: [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }],
    messages: [
      ...base.messages,
      publishedAssistant(chunks),
      ...results.map((result) => ({
        role: 'tool' as const,
        toolCallId: result.id,
        isError: result.isError === true,
        content: [{ type: 'text' as const, text: result.text }],
        source: { kind: 'tool' as const, callId: result.id },
        id: `result-${result.id}`,
      })),
    ] as GenerateOptions['messages'],
  }
}

async function collect(model: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }, request: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of model.stream(request)) chunks.push(chunk)
  return chunks
}

function toolIds(chunks: readonly StreamChunk[]): string[] {
  return chunks.flatMap((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block.id] : [])
}

test('tool calls stay on one scripted session and dsh supplies the only result', async () => {
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const runtime = new ScriptedNativeRuntime()
  const seen: string[] = []
  const turn: ScriptedTurn = {
    events: toolEvents([
      { id: 'call-1', name: 'echo', arguments: '{"value":"one"}' },
      { id: 'call-2', name: 'echo', arguments: '{"value":"one"}' },
    ]),
    invokeHandlers: async (call) => {
      seen.push('start-1')
      const first = await call('call-1')
      seen.push(`got-1:${first.text}:${String(first.isError)}`)
      const second = await call('call-2')
      seen.push(`got-2:${second.text}:${String(second.isError)}`)
    },
  }
  runtime.enqueue(turn)
  runtime.enqueue(textTurn('done', 'm2'))
  const { model } = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate(proof(accepted.identityBinding), NOW),
    deadlines: { ...DEFAULT_DEADLINES, generationMs: 30, resultWaitMs: 5_000 },
  })
  const firstRequest = {
    ...textRequest(),
    tools: [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' as const } }],
  }
  const first = await collect(model, firstRequest)
  assert.deepEqual(toolIds(first), ['call-1', 'call-2'])
  const firstFinish = first.at(-1)
  assert.equal(firstFinish?.type, 'finish')
  if (firstFinish?.type === 'finish') assert.equal(firstFinish.reason.kind, 'tool-calls')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(seen, ['start-1'])
  assert.equal(runtime.sessions.length, 1)
  const second = await collect(model, resultRequest(first, [
    { id: 'call-1', text: 'alpha' },
    { id: 'call-2', text: 'beta', isError: true },
  ]))
  const secondFinish = second.at(-1)
  assert.equal(secondFinish?.type, 'finish')
  if (secondFinish?.type === 'finish') assert.equal(secondFinish.reason.kind, 'stop')
  assert.deepEqual(seen, ['start-1', 'got-1:alpha:false', 'got-2:beta:true'])
  assert.equal(runtime.starts.length, 1)
})

test('a bad tool-result suffix releases nothing', async () => {
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const runtime = new ScriptedNativeRuntime()
  let delivered = false
  runtime.enqueue({
    events: toolEvents([{ id: 'call-1', name: 'echo', arguments: '{"value":"one"}' }]),
    invokeHandlers: async (call) => {
      await call('call-1')
      delivered = true
    },
  })
  const { model } = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate(proof(accepted.identityBinding), NOW),
  })
  const first = await collect(model, {
    ...textRequest('hello', 'session-2'),
    tools: [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }],
  })
  await assert.rejects(
    collect(model, resultRequest(first, [{ id: 'call-2', text: 'nope' }], 'session-2')),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'TOOL_RESULT_MISMATCH')
      return true
    },
  )
  assert.equal(delivered, false)
})

test('a user message cannot enter a tool-result suffix', async () => {
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: toolEvents([{ id: 'call-1', name: 'echo', arguments: '{}' }]),
  })
  const { model } = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate(proof(accepted.identityBinding), NOW),
  })
  const firstRequest = {
    ...textRequest('hello', 'session-3'),
    tools: [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }],
  }
  const first = await collect(model, firstRequest)
  const request = resultRequest(first, [], 'session-3')
  request.messages = [
    ...firstRequest.messages,
    publishedAssistant(first),
    { role: 'user', content: [{ type: 'text', text: 'later' }] },
  ] as GenerateOptions['messages']
  await assert.rejects(collect(model, request), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
})

test('tool schemas stay lossless and collisions are refused', () => {
  const mapped = mapToolNames([{
    name: 'echo',
    description: 'Echo text.',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  }])
  assert.equal(mapped.nativeToDsh.get(mapped.dshToNative.get('echo') ?? ''), 'echo')
  assert.equal(mapped.tools[0]?.parameters['type'], 'object')
  assert.throws(() => mapToolNames([
    { name: 'echo', description: 'One.', parameters: { type: 'object' } },
    { name: 'echo', description: 'Two.', parameters: { type: 'object' } },
  ]), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.throws(() => mapToolNames([{
    name: 'echo',
    description: 'Echo text.',
    parameters: { type: 'string' },
  }]), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
})

test('malformed tool arguments are not published', async () => {
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: toolEvents([{ id: 'call-1', name: 'echo', arguments: '{' }]),
  })
  const { model } = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate(proof(accepted.identityBinding), NOW),
  })
  await assert.rejects(collect(model, {
    ...textRequest('hello', 'session-4'),
    tools: [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }],
  }), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'MALFORMED_RESPONSE')
    return true
  })
  assert.equal(runtime.closeCount, 1)
})
