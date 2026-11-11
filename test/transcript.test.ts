import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { interpretAuthStatus } from '../src/auth.js'
import { DEFAULT_DEADLINES } from '../src/deadlines.js'
import { retentionProofAccepted } from '../src/evidence.js'
import type { NativeEvent } from '../src/sdk-runtime.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { inputText, textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { SYNTHETIC_AUTH_STATUS, makeAdapter } from './support.js'

const NOW = new Date('2026-11-10T00:00:00.000Z')
const ECHO_TOOL = [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }]

function proof(binding: string): SpendProof {
  return {
    policyId: 'proof-1',
    identityBinding: binding,
    scope: 'claude-code-session',
    expiresAt: '2026-11-10T01:00:00.000Z',
    validFor: 'pt1h',
  }
}

function gate() {
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  return new EvidenceSpendGate(proof(accepted.identityBinding), NOW)
}

async function collect(model: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }, request: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of model.stream(request)) chunks.push(chunk)
  return chunks
}

function assistantMessage(chunks: readonly StreamChunk[], id: string) {
  const finish = chunks.at(-1)
  const replayState = finish?.type === 'finish' ? finish.replayState : undefined
  return {
    role: 'assistant' as const,
    id,
    content: chunks.flatMap((chunk) => chunk.type === 'block-end' ? [chunk.block] : []),
    source: {
      kind: 'model' as const,
      provider: 'claude-code-session',
      model: 'claude-haiku-5-5',
      ...(replayState === undefined ? {} : { replayState }),
    },
  }
}

function continueRequest(sessionId: string, firstText: string, chunks: readonly StreamChunk[], nextText: string): GenerateOptions {
  return {
    ...textRequest(nextText, sessionId),
    messages: [
      { role: 'user', content: [{ type: 'text', text: firstText }] },
      assistantMessage(chunks, 'assistant-1'),
      { role: 'user', content: [{ type: 'text', text: nextText }] },
    ] as GenerateOptions['messages'],
  }
}

function replayResponse(chunks: readonly StreamChunk[]): Record<string, unknown> {
  const finish = chunks.at(-1)
  if (finish?.type !== 'finish' || finish.replayState === undefined) {
    throw new Error('The finish chunk has no replay envelope.')
  }
  const response = finish.replayState.response
  if (typeof response !== 'object' || response === null) {
    throw new Error('The replay envelope has no response.')
  }
  return response as Record<string, unknown>
}

test('cache token counts reach the usage chunk', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      { type: 'block-start', messageId: 'm1', index: 0, blockType: 'text' },
      { type: 'text-delta', messageId: 'm1', index: 0, text: 'answer' },
      { type: 'block-stop', messageId: 'm1', index: 0 },
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 900,
        cacheWriteTokens: 50,
      },
      { type: 'message-stop', messageId: 'm1', stopReason: 'end_turn' },
    ],
  })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const chunks = await collect(model, textRequest())
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.deepEqual(usage, {
    type: 'usage',
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
    },
  })
})

test('one text response stores one finish and replay data', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer'))
  runtime.enqueue(textTurn('next', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, textRequest())
  const text = first.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.type === 'text-delta' ? chunk.text : '')
  assert.deepEqual(text, ['answer'])
  const finish = first.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(replayResponse(first)['format'], 'claude-session-v1')
  assert.equal('blocks' in (finish.replayState ?? {}), false)
  const second = await collect(model, continueRequest('session-1', 'hello', first, 'next'))
  assert.equal(second.at(-1)?.type, 'finish')
  assert.deepEqual(runtime.inputs.map(inputText), ['hello', 'next'])
  assert.equal(runtime.starts.length, 1)
  assert.equal(runtime.closeCount, 0)
})

test('empty thinking text and its signature stay in the replay', async () => {
  const signature = 'sig-empty-thinking'
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      { type: 'block-start', messageId: 'm1', index: 0, blockType: 'reasoning', signature },
      { type: 'block-stop', messageId: 'm1', index: 0 },
      { type: 'block-start', messageId: 'm1', index: 1, blockType: 'text' },
      { type: 'text-delta', messageId: 'm1', index: 1, text: 'answer' },
      { type: 'block-stop', messageId: 'm1', index: 1 },
      { type: 'usage', inputTokens: 2, outputTokens: 1 },
      { type: 'message-stop', messageId: 'm1', stopReason: 'end_turn' },
    ],
  })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const chunks = await collect(model, textRequest())
  const reasoning = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(reasoning?.type, 'block-end')
  if (reasoning?.type !== 'block-end' || reasoning.block.type !== 'reasoning') return
  assert.equal(reasoning.block.text, '')
  const blocks = replayResponse(chunks)['nativeResponseBlocks']
  assert.equal(JSON.stringify(blocks).includes(signature), true)
  assert.equal(JSON.stringify(blocks).includes('"text":""'), true)
})

test('redacted thinking stays opaque and adds no display text', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      { type: 'block-start', messageId: 'm1', index: 0, blockType: 'redacted-thinking', redactedData: 'opaque-blob' },
      { type: 'block-stop', messageId: 'm1', index: 0 },
      { type: 'block-start', messageId: 'm1', index: 1, blockType: 'text' },
      { type: 'text-delta', messageId: 'm1', index: 1, text: 'answer' },
      { type: 'block-stop', messageId: 'm1', index: 1 },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'message-stop', messageId: 'm1', stopReason: 'end_turn' },
    ],
  })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const chunks = await collect(model, textRequest())
  assert.equal(chunks.some((chunk) => chunk.type === 'reasoning-delta'), false)
  const display = chunks.flatMap((chunk) => chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ? [chunk.text] : [])
  assert.equal(display.includes('opaque-blob'), false)
  assert.equal(JSON.stringify(replayResponse(chunks)['nativeResponseBlocks']).includes('opaque-blob'), true)
})

test('a partial event and its completed snapshot publish one block', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      { type: 'block-start', messageId: 'm1', index: 0, blockType: 'text' },
      { type: 'text-delta', messageId: 'm1', index: 0, text: 'Hello' },
      { type: 'block-snapshot', messageId: 'm1', index: 0, blockType: 'text', text: 'Hello' },
      { type: 'block-start', messageId: 'm1', index: 0, blockType: 'text' },
      { type: 'block-stop', messageId: 'm1', index: 0 },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'message-stop', messageId: 'm1', stopReason: 'end_turn' },
    ],
  })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const chunks = await collect(model, textRequest())
  const text = chunks.filter((chunk) => chunk.type === 'text-delta')
  assert.equal(text.length, 1)
  assert.equal(text[0]?.type === 'text-delta' ? text[0].text : '', 'Hello')
  const nativeBlocks = replayResponse(chunks)['nativeResponseBlocks']
  assert.equal(Array.isArray(nativeBlocks) ? nativeBlocks.length : 0, 1)
})

test('two leading user messages merge into one native prompt', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const request: GenerateOptions = {
    ...textRequest('second', 'multi-user'),
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ] as GenerateOptions['messages'],
  }
  const chunks = await collect(model, request)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.deepEqual(runtime.inputs[0]?.content, [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ])
})

test('a changed earlier message requires a new generation before another prompt', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, textRequest())
  const changed = continueRequest('session-1', 'changed', first, 'next')
  await assert.rejects(collect(model, changed), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'REBASE_REQUIRED')
    return true
  })
  assert.deepEqual(runtime.inputs.map(inputText), ['hello'])
  assert.equal(runtime.starts.length, 1)
})

test('the assistant id binds once and a changed publication is refused', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer'))
  runtime.enqueue(textTurn('next', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, textRequest())
  const edited = continueRequest('session-1', 'hello', first, 'later')
  const editedAssistant = edited.messages[1]
  if (editedAssistant?.role === 'assistant') {
    edited.messages[1] = {
      ...editedAssistant,
      content: [{ type: 'text', text: 'different' }],
    } as typeof editedAssistant
  }
  await assert.rejects(collect(model, edited), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'REPLAY_STATE_INVALID')
    return true
  })
  const second = await collect(model, continueRequest('session-1', 'hello', first, 'next'))
  assert.equal(second.at(-1)?.type, 'finish')
  const moved = continueRequest('session-1', 'hello', first, 'next')
  const assistant = moved.messages[1]
  if (assistant?.role === 'assistant') {
    moved.messages[1] = { ...assistant, id: 'assistant-2' } as typeof assistant
  }
  await assert.rejects(collect(model, moved), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'REBASE_REQUIRED')
    return true
  })
  assert.equal(runtime.starts.length, 1)
  assert.deepEqual(runtime.inputs.map(inputText), ['hello', 'next'])
})

test('missing or changed replay data is refused', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, textRequest())
  const missing = continueRequest('session-1', 'hello', first, 'next')
  const bare = missing.messages[1]
  if (bare?.role === 'assistant') {
    missing.messages[1] = {
      role: 'assistant',
      id: bare.id,
      content: bare.content,
      source: { kind: 'model', provider: 'claude-code-session', model: 'claude-haiku-5-5' },
    } as typeof bare
  }
  await assert.rejects(collect(model, missing), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'REPLAY_STATE_INVALID')
    return true
  })
  const changed = continueRequest('session-1', 'hello', first, 'next')
  const clone = JSON.parse(JSON.stringify(changed.messages[1])) as {
    source?: { replayState?: { response?: { nativeResponseBlocks?: { text?: string }[] } } }
  }
  const block = clone.source?.replayState?.response?.nativeResponseBlocks?.[0]
  if (block !== undefined) block.text = 'tampered'
  changed.messages[1] = clone as typeof changed.messages[1]
  await assert.rejects(collect(model, changed), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'REPLAY_STATE_INVALID')
    return true
  })
  assert.deepEqual(runtime.inputs.map(inputText), ['hello'])
})

test('a live configuration change rolls over with a recorded change', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer', 'm1'))
  runtime.enqueue(textTurn('answer after change', 'm2'))
  runtime.enqueue(textTurn('answer after continuation', 'm3'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const firstRequest: GenerateOptions = textRequest('hello', 'session-a')
  const first = await collect(model, firstRequest)
  assert.equal(first.at(-1)?.type, 'finish')
  const changedRequest: GenerateOptions = {
    ...textRequest('next', 'session-a'),
    system: 'Other prompt.',
    messages: [
      ...firstRequest.messages,
      assistantMessage(first, 'assistant-1'),
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ] as GenerateOptions['messages'],
  }
  const changed = await collect(model, changedRequest)
  assert.equal(changed.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.systemPrompt, 'Other prompt.')
  const finish = changed.at(-1)
  const response = finish?.type === 'finish' ? finish.replayState?.response : undefined
  const recorded = typeof response === 'object' && response !== null
    ? (response as Record<string, unknown>)['generationChange'] as Record<string, unknown> | undefined
    : undefined
  assert.equal(recorded?.['reason'], 'configuration-change')
  assert.deepEqual(recorded?.['changedFields'], ['systemPrompt'])
  const continued = await collect(model, {
    ...changedRequest,
    messages: [
      ...changedRequest.messages,
      assistantMessage(changed, 'assistant-2'),
      { role: 'user', content: [{ type: 'text', text: 'later' }] },
    ] as GenerateOptions['messages'],
  })
  assert.equal(continued.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.sessions[1]?.inputs.length, 2)
})

test('abort closes the native session and invents no tool result', async () => {
  const runtime = new ScriptedNativeRuntime()
  let delivered = false
  runtime.enqueue({
    events: [
      { type: 'block-start', messageId: 'm1', index: 0, blockType: 'tool-call' },
      { type: 'tool-delta', messageId: 'm1', index: 0, id: 'call-1', name: 'echo', argumentsDelta: '{}' },
      { type: 'block-stop', messageId: 'm1', index: 0 },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'message-stop', messageId: 'm1', stopReason: 'tool_use' },
    ],
    invokeHandlers: async (call) => {
      await call('call-1')
      delivered = true
    },
  })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  await collect(model, { ...textRequest('hello', 'session-abort'), tools: ECHO_TOOL })
  const aborted = new AbortController()
  aborted.abort()
  const chunks = await collect(model, { ...textRequest('hello', 'session-abort'), tools: ECHO_TOOL, signal: aborted.signal })
  assert.equal(chunks.at(-1)?.type, 'finish')
  const finish = chunks.at(-1)
  if (finish?.type === 'finish') assert.equal(finish.reason.kind, 'aborted')
  assert.equal(delivered, false)
  assert.equal(runtime.closeCount, 1)
})

test('a timeout after dispatch is not retried', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, generationMs: 20 },
  })
  await assert.rejects(collect(model, textRequest('hello', 'session-timeout')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'NATIVE_OUTCOME_UNKNOWN')
    return true
  })
  await assert.rejects(collect(model, textRequest('hello', 'session-timeout')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'NATIVE_OUTCOME_UNKNOWN')
    return true
  })
  assert.equal(runtime.starts.length, 1)
  assert.deepEqual(runtime.inputs.map(inputText), ['hello'])
})

test('a repeated dispatched request does not send a second prompt', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  await collect(model, textRequest())
  await assert.rejects(collect(model, textRequest()), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'NATIVE_OUTCOME_UNKNOWN')
    return true
  })
  assert.deepEqual(runtime.inputs.map(inputText), ['hello'])
  assert.equal(runtime.starts.length, 1)
})

test('an executable native tool outside the dsh list invalidates the generation', async () => {
  const events: NativeEvent[] = [
    { type: 'native-tool-list', names: ['advisor'] },
    { type: 'block-start', messageId: 'm1', index: 0, blockType: 'text' },
    { type: 'text-delta', messageId: 'm1', index: 0, text: 'answer' },
    { type: 'block-stop', messageId: 'm1', index: 0 },
    { type: 'usage', inputTokens: 1, outputTokens: 1 },
    { type: 'message-stop', messageId: 'm1', stopReason: 'end_turn' },
  ]
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({ events })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  await assert.rejects(collect(model, textRequest('hello', 'session-tools')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'NATIVE_CONTEXT_MISMATCH')
    return true
  })
  await assert.rejects(collect(model, textRequest('hello', 'session-tools')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'NATIVE_OUTCOME_UNKNOWN')
    return true
  })
  assert.equal(runtime.starts.length, 1)
})

test('saved replay without a live process starts a recorded new generation', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer'))
  const firstAdapter = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(firstAdapter.model, textRequest())
  const restored = new ScriptedNativeRuntime()
  restored.enqueue(textTurn('restored answer', 'm2'))
  const { model } = makeAdapter({ runtime: restored, spendGate: gate() })
  const next = await collect(model, continueRequest('session-1', 'hello', first, 'next'))
  assert.equal(next.at(-1)?.type, 'finish')
  assert.equal(restored.starts.length, 1)
  const finish = next.at(-1)
  const response = finish?.type === 'finish' ? finish.replayState?.response : undefined
  const change = typeof response === 'object' && response !== null
    ? (response as Record<string, unknown>)['generationChange']
    : undefined
  assert.equal(typeof change, 'object')
  assert.equal((change as Record<string, unknown>)['reason'], 'restore')
  assert.equal(restored.inputs[0]?.content.some(
    (block) => block.type === 'text' && block.text.includes('Historical context for a new Claude session.'),
  ), true)
})

test('incomplete native request evidence is not an audit success', async () => {
  assert.equal(retentionProofAccepted({ nativeRequestRecord: 'present' }), false)
  assert.equal(retentionProofAccepted({ status: 'complete', redacted: true, truncated: false, body: { messages: [{ role: 'user' }] } }), false)
  assert.equal(retentionProofAccepted({ status: 'complete', redacted: false, truncated: true, body: { messages: [{ role: 'user' }] } }), false)
  const complete = {
    status: 'complete',
    redacted: false,
    truncated: false,
    body: { messages: [{ role: 'user', text: 'hello' }] },
  }
  assert.equal(retentionProofAccepted(complete), true)
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      { type: 'request-evidence', record: { status: 'complete', redacted: true, truncated: false, body: { messages: [{ role: 'user' }] } } },
      ...textTurn('answer').events,
    ],
  })
  runtime.enqueue({
    events: [
      { type: 'request-evidence', record: complete },
      ...textTurn('answer', 'm2').events,
    ],
  })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const redacted = await collect(model, textRequest('hello', 'session-evidence'))
  assert.equal(replayResponse(redacted)['retentionAudit'], 'unavailable')
  assert.equal(replayResponse(redacted)['nativeRequestRecord'], null)
  const accepted = await collect(model, continueRequest('session-evidence', 'hello', redacted, 'next'))
  assert.equal(replayResponse(accepted)['retentionAudit'], 'accepted')
  assert.deepEqual(replayResponse(accepted)['nativeRequestRecord'], complete.body)
})
