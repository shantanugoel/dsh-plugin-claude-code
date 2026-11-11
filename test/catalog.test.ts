import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { LlmError, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'

import { blockedRouteDescriptor, projectCatalogModel } from '../src/catalog.js'
import { apply } from '../src/index.js'
import { officialModelDiscovery } from '../src/model-discovery.js'
import { ProductionSpendGate, ScriptedSpendGate } from '../src/spend-gate.js'
import { textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { makeAdapter } from './support.js'

const CATALOG = [{
  value: 'claude-haiku-5-5',
  displayName: 'Haiku',
  description: 'Exact catalog id.',
}]

test('a supplied catalog keeps the exact model id', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({
    runtime,
    spendGate: new ProductionSpendGate(),
    catalog: CATALOG,
  })
  const models = await model.listModels('claude-code-session')
  assert.equal(models[0]?.id, 'claude-haiku-5-5')
  const resolved = await model.resolveModel('claude-code-session', 'claude-haiku-5-5')
  assert.equal(resolved.id, 'claude-haiku-5-5')
  assert.equal(resolved.provider, 'claude-code-session')
  const descriptor = blockedRouteDescriptor()
  assert.equal(descriptor.provider, 'claude-code-session')
  assert.equal(descriptor.error, undefined)
})

test('an allowed test gate publishes the exact catalog id', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({
    runtime,
    spendGate: new ScriptedSpendGate({ allowed: true, policyId: 'test-only', validFor: 'test' }),
    catalog: CATALOG,
  })
  const models = await model.listModels('claude-code-session')
  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'claude-haiku-5-5')
  assert.equal(models[0]?.name, 'Haiku')
  const projected = projectCatalogModel('claude-code-session', { value: 'claude-sonnet-5', displayName: 'Sonnet' })
  assert.equal(projected.id, 'claude-sonnet-5')
})

test('loading the plugin advertises the discovered model ids', async () => {
  const original = officialModelDiscovery.list
  officialModelDiscovery.list = async () => [
    {
      value: 'claude-sonnet-5',
      displayName: 'Sonnet',
      description: 'Main and subagent model.',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
    },
    { value: 'claude-sonnet-5', displayName: 'Duplicate', description: 'Ignored.' },
  ]
  try {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(apply, {})
    const providers = ctx.llm.listProviders()
    assert.equal(providers.some((provider) => provider.id === 'claude-code-session'), true)
    const models = await ctx.llm.listModels('claude-code-session')
    assert.equal(models.length, 1)
    assert.equal(models[0]?.provider, 'claude-code-session')
    assert.equal(models[0]?.id, 'claude-sonnet-5')
    assert.equal(models[0]?.name, 'Sonnet')
    const blocked = ctx.llm.listConfigurableProviders().find((entry) => entry.provider === 'claude-code-session')
    assert.equal(blocked?.error, undefined)
    const resolvedModel = await ctx.llm.resolveModelInfo('claude-code-session', 'claude-sonnet-5')
    assert.equal(resolvedModel.id, 'claude-sonnet-5')
    assert.equal(resolvedModel.name, 'Sonnet')
    assert.deepEqual(resolvedModel.reasoning?.efforts.map((effort) => effort.id), ['low', 'medium', 'high'])
    assert.equal(Object.hasOwn(resolvedModel.reasoning ?? {}, 'defaultEffort'), false)
    const uncataloguedModel = await ctx.llm.resolveModelInfo('claude-code-session', 'claude-not-in-catalog')
    assert.equal(uncataloguedModel.name, 'claude-not-in-catalog')
    assert.equal(uncataloguedModel.id, 'claude-not-in-catalog')
  } finally {
    officialModelDiscovery.list = original
  }
})

test('a model reports only its own effort levels', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({
    runtime,
    spendGate: new ProductionSpendGate(),
    catalog: [
      {
        value: 'haiku',
        displayName: 'Haiku 5.5',
        supportsEffort: true,
        supportedEffortLevels: ['max', 'low', 'high', 'xhigh', 'medium'],
      },
      {
        value: 'claude-sonnet-4-6',
        displayName: 'Sonnet 4.6',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      },
      {
        value: 'claude-haiku-4-5-20251001',
        displayName: 'Haiku 4.5',
      },
    ],
  })
  const haiku = await model.resolveModel('claude-code-session', 'haiku')
  assert.deepEqual(haiku.reasoning?.efforts.map((effort) => effort.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  const sonnet = await model.resolveModel('claude-code-session', 'claude-sonnet-4-6')
  assert.equal(sonnet.reasoning?.efforts.some((effort) => effort.id === 'xhigh'), false)
  const older = await model.resolveModel('claude-code-session', 'claude-haiku-4-5-20251001')
  assert.equal(older.reasoning, undefined)
  runtime.enqueue(textTurn('ok'))
  runtime.enqueue(textTurn('ok', 'm2'))
  const firstRequest: GenerateOptions = {
    ...textRequest('hello', 'effort-1'),
    model: 'haiku',
    reasoningEffort: 'high' as never,
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of model.stream(firstRequest)) {
    chunks.push(chunk)
  }
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts[0]?.launch?.effort, 'high')
  const firstFinish = chunks.at(-1)
  const replayState = firstFinish?.type === 'finish' ? firstFinish.replayState : undefined
  const secondRequest: GenerateOptions = {
    ...firstRequest,
    reasoningEffort: 'max' as never,
    messages: [
      ...firstRequest.messages,
      {
        role: 'assistant',
        id: 'assistant-1',
        content: chunks.flatMap((chunk) => chunk.type === 'block-end' ? [chunk.block] : []),
        source: {
          kind: 'model',
          provider: 'claude-code-session',
          model: 'haiku',
          ...(replayState === undefined ? {} : { replayState }),
        },
      },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ] as GenerateOptions['messages'],
  }
  const secondChunks: StreamChunk[] = []
  for await (const chunk of model.stream(secondRequest)) {
    secondChunks.push(chunk)
  }
  assert.equal(secondChunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.launch?.effort, 'max')
  const secondFinish = secondChunks.at(-1)
  const secondResponse = secondFinish?.type === 'finish' ? secondFinish.replayState?.response : undefined
  const change = typeof secondResponse === 'object' && secondResponse !== null
    ? (secondResponse as Record<string, unknown>)['generationChange'] as Record<string, unknown> | undefined
    : undefined
  assert.deepEqual(change?.['changedFields'], ['reasoningEffort'])
  await assert.rejects(
    model.stream({ ...textRequest('hello', 'effort-2'), model: 'claude-sonnet-4-6', reasoningEffort: 'xhigh' as never })[Symbol.asyncIterator]().next(),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'UNSUPPORTED_INPUT')
      return true
    },
  )
  assert.equal(runtime.starts.length, 2)
})

test('a prepared call refuses a configuration change before dispatch', async () => {
  let generation = 1
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('ok'))
  const { model } = makeAdapter({
    runtime,
    spendGate: new ScriptedSpendGate({ allowed: true, policyId: 'test-only', validFor: 'test' }),
    configuration: { current: () => generation },
  })
  const prepared = await model.prepareCall('claude-code-session', 'claude-haiku-5-5')
  assert.equal(prepared.model.id, 'claude-haiku-5-5')
  generation = 2
  assert.throws(() => prepared.stream(textRequest()), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'INCOMPATIBLE_RUNTIME')
    return true
  })
  assert.equal(runtime.starts.length, 0)
})


test('the resolved model uses the discovered catalog display name', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({
    runtime,
    spendGate: new ProductionSpendGate(),
    catalog: [
      { value: 'claude-haiku-5-5', displayName: 'Haiku 5.5' },
      { value: 'claude-blank-name', displayName: '   ' },
    ],
  })
  const catalogued = await model.resolveModel('claude-code-session', 'claude-haiku-5-5')
  assert.equal(catalogued.id, 'claude-haiku-5-5')
  assert.equal(catalogued.name, 'Haiku 5.5')
  // A row without a usable display name keeps the raw id.
  const blank = await model.resolveModel('claude-code-session', 'claude-blank-name')
  assert.equal(blank.name, 'claude-blank-name')
})

test('a catalog row reports no invented default effort and an uncatalogued id keeps its raw id', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({
    runtime,
    spendGate: new ProductionSpendGate(),
    catalog: [{
      value: 'haiku',
      displayName: 'Haiku 5.5',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
    }],
  })
  const catalogued = await model.resolveModel('claude-code-session', 'haiku')
  assert.equal(catalogued.name, 'Haiku 5.5')
  assert.deepEqual(catalogued.reasoning?.efforts.map((effort) => effort.id), ['low', 'medium', 'high'])
  // The SDK reports no default effort, so the adapter invents none.
  assert.equal(Object.hasOwn(catalogued.reasoning ?? {}, 'defaultEffort'), false)
  assert.equal(Object.hasOwn(catalogued, 'defaultMaxTokens'), false)

  const uncatalogued = await model.resolveModel('claude-code-session', 'claude-unknown-id')
  assert.equal(uncatalogued.id, 'claude-unknown-id')
  assert.equal(uncatalogued.name, 'claude-unknown-id')
  assert.equal(uncatalogued.reasoning, undefined)
})
