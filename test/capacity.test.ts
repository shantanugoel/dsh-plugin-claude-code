import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { LlmError, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import {
  contextWindowFor,
  contextWindowFromUsage,
  measuredModelCapacity,
  resetModelCapacityCache,
  STATIC_CONTEXT_WINDOW_FALLBACK,
} from '../src/capacity.js'
import { createContextWindowReader } from '../src/model-discovery.js'
import { modelUsageEvent } from '../src/official-session.js'
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

test('resolveModel uses the discovered context window before a measurement', async () => {
  resetModelCapacityCache()
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      { type: 'model-usage', model: 'sonnet', nativeModel: 'claude-sonnet-5-5', contextWindow: 900_000, maxOutputTokens: 64_000 },
      ...textTurn('ok').events,
    ],
  })
  const windows: Record<string, number> = { sonnet: 1_000_000, 'claude-sonnet-4-6': 200_000 }
  const reads: string[] = []
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    catalog: [
      { value: 'sonnet', displayName: 'Sonnet' },
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
      { value: 'haiku', displayName: 'Haiku' },
    ],
    discoverContextWindow: async (id) => {
      reads.push(id)
      if (id === 'not-in-catalog') throw new Error('The CLI read failed.')
      return windows[id]
    },
  })
  const alias = await model.resolveModel(CLAUDE_CODE_SESSION_ROUTE, 'sonnet')
  assert.deepEqual(alias.context, { contextWindow: 1_000_000 })
  const older = await model.resolveModel(CLAUDE_CODE_SESSION_ROUTE, 'claude-sonnet-4-6')
  assert.deepEqual(older.context, { contextWindow: 200_000 })
  // A model with no reported window and a failed read keep the fallback.
  const unread = await model.resolveModel(CLAUDE_CODE_SESSION_ROUTE, 'haiku')
  assert.deepEqual(unread.context, { contextWindow: STATIC_CONTEXT_WINDOW_FALLBACK })
  const unknown = await model.resolveModel(CLAUDE_CODE_SESSION_ROUTE, 'not-in-catalog')
  assert.deepEqual(unknown.context, { contextWindow: STATIC_CONTEXT_WINDOW_FALLBACK })
  assert.equal(alias.defaultMaxTokens, undefined)
  // A result-message measurement replaces the discovered value.
  await collect(model, { ...textRequest('hello', 'capacity-discovered'), model: 'sonnet' })
  const readsBefore = reads.length
  const measured = await model.resolveModel(CLAUDE_CODE_SESSION_ROUTE, 'sonnet')
  assert.deepEqual(measured.context, { contextWindow: 900_000 })
  // A measured model needs no CLI read.
  assert.equal(reads.length, readsBefore)
  resetModelCapacityCache()
})

test('the context-usage report gives the smaller valid window', () => {
  assert.equal(contextWindowFromUsage({ maxTokens: 1_000_000, rawMaxTokens: 1_000_000 }), 1_000_000)
  assert.equal(contextWindowFromUsage({ maxTokens: 200_000, rawMaxTokens: 1_000_000 }), 200_000)
  assert.equal(contextWindowFromUsage({ rawMaxTokens: 200_000 }), 200_000)
  assert.equal(contextWindowFromUsage({ maxTokens: 0, rawMaxTokens: -1 }), undefined)
  assert.equal(contextWindowFromUsage({ maxTokens: '1000000' }), undefined)
  assert.equal(contextWindowFromUsage(undefined), undefined)
  assert.equal(contextWindowFor('no-measurement', 0), STATIC_CONTEXT_WINDOW_FALLBACK)
})

test('the window reader caches a value, runs one read at a time, and retries a failure', async () => {
  let clock = 1_000
  let active = 0
  let maxActive = 0
  const calls: string[] = []
  const answers: Record<string, (number | undefined | Error)[]> = {
    sonnet: [1_000_000],
    old: [200_000],
    flaky: [undefined, new Error('The CLI did not start.'), 500_000],
  }
  const reader = createContextWindowReader(async (id) => {
    calls.push(id)
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    const answer = answers[id]?.shift()
    if (answer instanceof Error) throw answer
    return answer
  }, () => clock)
  // Two reads of one model share one CLI read. Different models run in order.
  const results = await Promise.all([reader.read('sonnet'), reader.read('sonnet'), reader.read('old'), reader.read('flaky')])
  assert.deepEqual(results, [1_000_000, 1_000_000, 200_000, undefined])
  assert.deepEqual(calls, ['sonnet', 'old', 'flaky'])
  assert.equal(maxActive, 1)
  // A kept value needs no new read. A failed read is not repeated at once.
  assert.equal(await reader.read('sonnet'), 1_000_000)
  assert.equal(await reader.read('flaky'), undefined)
  assert.deepEqual(calls, ['sonnet', 'old', 'flaky'])
  // After the retry interval the read runs again. A thrown error is a failure.
  clock += 31_000
  assert.equal(await reader.read('flaky'), undefined)
  clock += 31_000
  assert.equal(await reader.read('flaky'), 500_000)
  assert.deepEqual(calls, ['sonnet', 'old', 'flaky', 'flaky', 'flaky'])
})

test('a result entry matches the served model of an alias request', () => {
  const usage = {
    'claude-sonnet-5-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    'claude-haiku-5-5': { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  }
  // Two entries and an alias request: the served model id selects the entry.
  assert.deepEqual(modelUsageEvent({ modelUsage: usage }, 'sonnet', 'claude-sonnet-5-5'), {
    type: 'model-usage',
    model: 'sonnet',
    nativeModel: 'claude-sonnet-5-5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  })
  // Without a served model id the two entries are not attributed.
  assert.equal(modelUsageEvent({ modelUsage: usage }, 'sonnet'), undefined)
  // The requested id wins when it is a key.
  const direct = modelUsageEvent({ modelUsage: usage }, 'claude-haiku-5-5', 'claude-sonnet-5-5')
  assert.equal(direct?.type === 'model-usage' ? direct.maxOutputTokens : undefined, 64_000)
  // A canonical id also matches.
  const canonical = modelUsageEvent({
    modelUsage: {
      'sonnet[1m]': { contextWindow: 1_000_000, maxOutputTokens: 128_000, canonicalModel: 'claude-sonnet-5-5' },
      other: { contextWindow: 200_000, maxOutputTokens: 32_000 },
    },
  }, 'sonnet', 'claude-sonnet-5-5')
  assert.equal(canonical?.type === 'model-usage' ? canonical.nativeModel : undefined, 'sonnet[1m]')
})
