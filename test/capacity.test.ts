import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { LlmError, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import {
  measuredModelCapacity,
  resetModelCapacityCache,
  STATIC_CONTEXT_WINDOW_FALLBACK,
} from '../src/capacity.js'
import { interpretAuthStatus } from '../src/auth.js'
import { CLAUDE_CODE_SESSION_ROUTE } from '../src/route.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { inputText, textRequest, textTurn } from './request.js'
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

test('the static fallback is a documented unmeasured value', () => {
  resetModelCapacityCache()
  assert.equal(STATIC_CONTEXT_WINDOW_FALLBACK, 200_000)
})

test('resolveModel returns the fallback context before a measurement', async () => {
  resetModelCapacityCache()
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const resolved = await model.resolveModel(CLAUDE_CODE_SESSION_ROUTE, MODEL)
  assert.deepEqual(resolved.context, { contextWindow: STATIC_CONTEXT_WINDOW_FALLBACK })
  // No default output cap is materialized. The compaction reservation uses the
  // request maxTokens, or zero when the request declares none.
  assert.equal(resolved.defaultMaxTokens, undefined)
  assert.equal(measuredModelCapacity(MODEL), undefined)
})

test('a native model-usage event replaces the fallback for that model', async () => {
  resetModelCapacityCache()
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      {
        type: 'model-usage',
        model: MODEL,
        nativeModel: `${MODEL}[alias]`,
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
      },
      ...textTurn('ok').events,
    ],
  })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const chunks = await collect(model, textRequest('hello', 'capacity-1'))
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.deepEqual(measuredModelCapacity(MODEL), {
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    nativeModel: `${MODEL}[alias]`,
  })
  const resolved = await model.resolveModel(CLAUDE_CODE_SESSION_ROUTE, MODEL)
  assert.deepEqual(resolved.context, { contextWindow: 1_000_000 })
  // A different model keeps the fallback. The measurement is per model id.
  const other = await model.resolveModel(CLAUDE_CODE_SESSION_ROUTE, 'claude-opus-5')
  assert.deepEqual(other.context, { contextWindow: STATIC_CONTEXT_WINDOW_FALLBACK })
})

test('the real dsh LLM service accepts the resolved context capacity', async () => {
  resetModelCapacityCache()
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      {
        type: 'model-usage',
        model: MODEL,
        nativeModel: MODEL,
        contextWindow: 500_000,
        maxOutputTokens: 32_000,
      },
      ...textTurn('ok').events,
    ],
  })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([CLAUDE_CODE_SESSION_ROUTE], model)
  const before = await ctx.llm.resolveModelInfo(CLAUDE_CODE_SESSION_ROUTE, MODEL)
  assert.deepEqual(before.context, { contextWindow: STATIC_CONTEXT_WINDOW_FALLBACK })
  await collect(model, textRequest('hello', 'capacity-service'))
  const after = await ctx.llm.resolveModelInfo(CLAUDE_CODE_SESSION_ROUTE, MODEL)
  assert.deepEqual(after.context, { contextWindow: 500_000 })
})

test('a model-usage event with invalid values is refused', async () => {
  resetModelCapacityCache()
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      {
        type: 'model-usage',
        model: MODEL,
        nativeModel: MODEL,
        contextWindow: 0,
        maxOutputTokens: 1_024,
      },
      ...textTurn('ok').events,
    ],
  })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  await assert.rejects(collect(model, textRequest('hello', 'capacity-bad')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'MALFORMED_RESPONSE')
    return true
  })
  assert.equal(measuredModelCapacity(MODEL), undefined)
})

test('a model switch keeps the live generation and returns capacity metadata', async () => {
  resetModelCapacityCache()
  const runtime = new ScriptedNativeRuntime()
  const firstTurn = textTurn('first')
  const secondTurn = textTurn('second', 'm2')
  runtime.enqueue(firstTurn)
  runtime.enqueue(secondTurn)
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const request = textRequest('hello', 'switch-1')
  const first = await collect(model, request)
  assert.equal(first.at(-1)?.type, 'finish')

  // The new model now has a context window, so a pressure or switch check can
  // price it. Before this fix the lookup had no capacity and the switch failed.
  const switched = await model.resolveModel(CLAUDE_CODE_SESSION_ROUTE, 'claude-sonnet-5')
  assert.deepEqual(switched.context, { contextWindow: STATIC_CONTEXT_WINDOW_FALLBACK })

  const continuation: GenerateOptions = {
    ...request,
    messages: [
      ...request.messages,
      assistantMessage(first),
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ] as GenerateOptions['messages'],
  }
  // A model change on a live generation starts one recorded new generation
  // with the new model. It no longer returns REBASE_REQUIRED.
  const switchedTurn = await collect(model, { ...continuation, model: 'claude-sonnet-5' })
  assert.equal(switchedTurn.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.model, 'claude-sonnet-5')
  const switchedInput = runtime.sessions[1]?.inputs[0]
  assert.ok(switchedInput !== undefined)
  const switchedText = inputText(switchedInput)
  assert.match(switchedText, /hello/)
  assert.match(switchedText, /again/)
  assert.equal(switchedText.includes('sig-'), false)
  const switchedFinish = switchedTurn.at(-1)
  const switchedReplay = switchedFinish?.type === 'finish'
    ? switchedFinish.replayState as { response?: { generationChange?: { reason?: string; changedFields?: readonly string[] } } } | undefined
    : undefined
  assert.equal(switchedReplay?.response?.generationChange?.reason, 'configuration-change')
  assert.deepEqual(switchedReplay?.response?.generationChange?.changedFields, ['model'])

  // The new generation serves the next request without another native start.
  runtime.enqueue(textTurn('third', 'm3'))
  const next = await collect(model, {
    ...continuation,
    model: 'claude-sonnet-5',
    messages: [
      ...continuation.messages,
      assistantMessage(switchedTurn),
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ] as GenerateOptions['messages'],
  })
  assert.equal(next.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
})
