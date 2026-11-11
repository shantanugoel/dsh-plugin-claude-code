import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { interpretAuthStatus } from '../src/auth.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { CLAUDE_CODE_SESSION_ROUTE } from '../src/route.js'
import { textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { SYNTHETIC_AUTH_STATUS, makeAdapter } from './support.js'

const NOW = new Date('2026-11-10T00:00:00.000Z')
const MODEL = 'claude-haiku-5-5'

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

async function collect(
  model: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> },
  request: GenerateOptions,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of model.stream(request)) chunks.push(chunk)
  return chunks
}

function titleRequest(maxTokens = 64): GenerateOptions {
  return {
    ...textRequest('Name this session.', 'title-session'),
    purpose: 'session-title' as never,
    system: 'You write short session titles.',
    maxTokens,
  }
}

function assistantMessage(chunks: readonly StreamChunk[]) {
  const finish = chunks.at(-1)
  const replayState = finish?.type === 'finish' ? finish.replayState : undefined
  return {
    role: 'assistant' as const,
    id: 'assistant-1',
    content: chunks.flatMap((chunk) => chunk.type === 'block-end' ? [chunk.block] : []),
    source: {
      kind: 'model' as const,
      provider: CLAUDE_CODE_SESSION_ROUTE,
      model: MODEL,
      ...(replayState === undefined ? {} : { replayState }),
    },
  }
}

test('a session-title call sends its prompt on an isolated session and closes it', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('A title', 'm-title'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const chunks = await collect(model, titleRequest(64))
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  const start = runtime.starts[0]
  assert.equal(start?.launch?.maxOutputTokens, 64)
  assert.equal(start?.launch?.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], '64')
  assert.equal(start?.launch?.systemPrompt.prompt, 'You write short session titles.')
  assert.equal(runtime.inputs.length, 1)
  assert.deepEqual(runtime.inputs[0]?.content, [{ type: 'text', text: 'Name this session.' }])
  assert.equal(runtime.closeCount, 1)
})

test('a conversation request maps maxTokens to the documented output cap', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('ok'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const request = { ...textRequest('hello', 'output-cap'), maxTokens: 1_024 }
  const chunks = await collect(model, request)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts[0]?.launch?.maxOutputTokens, 1_024)
  assert.equal(runtime.starts[0]?.launch?.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], '1024')
})

test('a changed output cap starts a new generation with the recorded change', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('first'))
  runtime.enqueue(textTurn('second', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const firstRequest = { ...textRequest('hello', 'output-change'), maxTokens: 1_024 }
  const first = await collect(model, firstRequest)
  const second: GenerateOptions = {
    ...firstRequest,
    maxTokens: 2_048,
    messages: [
      ...firstRequest.messages,
      assistantMessage(first),
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ] as GenerateOptions['messages'],
  }
  const chunks = await collect(model, second)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.launch?.maxOutputTokens, 2_048)
  const finish = chunks.at(-1)
  const response = finish?.type === 'finish' ? finish.replayState?.response : undefined
  const change = typeof response === 'object' && response !== null
    ? (response as Record<string, unknown>)['generationChange'] as Record<string, unknown> | undefined
    : undefined
  assert.equal(change?.['reason'], 'configuration-change')
  assert.deepEqual(change?.['changedFields'], ['maxTokens'])
})

test('an invalid output cap is refused before native start', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  await assert.rejects(collect(model, {
    ...textRequest('hello', 'bad-cap'),
    maxTokens: 0,
  }), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.equal(runtime.starts.length, 0)
})

test('an auxiliary request with conversation history is refused clearly', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const request: GenerateOptions = {
    ...textRequest('Compact this.', 'compaction-session'),
    purpose: 'compaction' as never,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'System.' }] },
      { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
      assistantMessage([]),
      { role: 'user', content: [{ type: 'text', text: 'Compact this.' }] },
    ] as GenerateOptions['messages'],
  }
  await assert.rejects(collect(model, request), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    assert.equal(error.message.includes('recorded import'), true)
    return true
  })
  assert.equal(runtime.starts.length, 0)
})

test('a title call still requires the spend check first', async () => {
  const runtime = new ScriptedNativeRuntime()
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const { model } = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate({ ...proof(accepted.identityBinding), scope: 'other-scope' }, NOW),
  })
  await assert.rejects(collect(model, titleRequest()), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'BILLING_GUARD_UNAVAILABLE')
    return true
  })
  assert.equal(runtime.starts.length, 0)
})
