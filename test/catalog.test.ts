import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { LlmError, LlmRuntime } from '@deepseek-ai/dsh-llm'
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
    { value: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Main and subagent model.' },
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
  } finally {
    officialModelDiscovery.list = original
  }
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
