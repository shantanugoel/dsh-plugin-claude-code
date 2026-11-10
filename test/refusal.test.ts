import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { LlmError } from '@deepseek-ai/dsh-llm'

import { ClaudeCodeAdapter } from '../src/adapter.js'
import { childEnvironment } from '../src/auth.js'
import { requireAbsoluteWorkspace } from '../src/context.js'
import { retentionProofAccepted } from '../src/evidence.js'
import { rejectBlockReplay } from '../src/replay.js'
import { SdkNativeRuntime } from '../src/sdk-runtime.js'
import { SessionManager } from '../src/session-manager.js'
import { ProductionSpendGate, ScriptedSpendGate } from '../src/spend-gate.js'
import { blockKey } from '../src/stream.js'
import { textRequest } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'

function adapter(runtime: ScriptedNativeRuntime, gate: ProductionSpendGate | ScriptedSpendGate): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    runtime,
    spendGate: gate,
    sessions: new SessionManager(),
  })
}

async function withFetchCounter(run: (calls: readonly string[]) => Promise<void>): Promise<void> {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input))
    throw new Error('A test tried to use the network.')
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('production stream refuses before the native runtime starts', async () => {
  await withFetchCounter(async (calls) => {
    const runtime = new ScriptedNativeRuntime()
    const model = adapter(runtime, new ProductionSpendGate())
    await assert.rejects(model.stream(textRequest())[Symbol.asyncIterator]().next(), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'BILLING_GUARD_UNAVAILABLE')
      return true
    })
    assert.equal(runtime.starts.length, 0)
    assert.equal(calls.length, 0)
    assert.deepEqual(await model.listModels('claude-code-session'), [])
    const policy = model.providerRetryPolicy('claude-code-session')
    assert.equal(policy.mode, 'normal')
    if (policy.mode !== 'normal') return
    assert.equal(policy.maxRetries, 0)
    assert.equal(policy.retryableCodes.includes('BILLING_GUARD_UNAVAILABLE'), false)
    assert.equal(policy.retryableCodes.includes('NATIVE_OUTCOME_UNKNOWN'), false)
  })
})

test('an allowed test gate still does not start a session', async () => {
  await withFetchCounter(async (calls) => {
    const runtime = new ScriptedNativeRuntime()
    const model = adapter(runtime, new ScriptedSpendGate({
      allowed: true,
      policyId: 'test-only',
      validFor: 'test',
    }))
    await assert.rejects(model.stream(textRequest())[Symbol.asyncIterator]().next(), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'INCOMPATIBLE_RUNTIME')
      return true
    })
    assert.equal(runtime.starts.length, 0)
    assert.equal(calls.length, 0)
  })
})

test('unsupported controls and content refuse before the runtime starts', async () => {
  const runtime = new ScriptedNativeRuntime()
  const model = adapter(runtime, new ProductionSpendGate())
  const withTemperature = { ...textRequest(), temperature: 0 }
  await assert.rejects(model.stream(withTemperature)[Symbol.asyncIterator]().next(), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  const withImage = textRequest()
  withImage.messages = [{
    role: 'user',
    content: [{ type: 'image', attachment: { id: 'img-1' } }],
  }] as unknown as typeof withImage.messages
  await assert.rejects(model.stream(withImage)[Symbol.asyncIterator]().next(), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.equal(runtime.starts.length, 0)
})

test('the production runtime refuses before a process can start', async () => {
  await withFetchCounter(async (calls) => {
    const runtime = new SdkNativeRuntime()
    await assert.rejects(runtime.start({
      workspace: '/tmp/workspace',
      model: 'claude-haiku-5-5',
      systemPrompt: 'prompt',
    }), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'BILLING_GUARD_UNAVAILABLE')
      return true
    })
    assert.equal(calls.length, 0)
  })
})

test('the scripted runtime records calls and does not use the network', async () => {
  await withFetchCounter(async (calls) => {
    const runtime = new ScriptedNativeRuntime()
    const session = await runtime.start({
      workspace: '/tmp/workspace-a',
      model: 'claude-haiku-5-5',
      systemPrompt: 'prompt',
    })
    await session.sendUser({ text: 'hello' })
    session.emit({ type: 'text', text: 'answer' })
    const iterator = session.events[Symbol.asyncIterator]()
    const event = await iterator.next()
    assert.equal(event.done, false)
    assert.deepEqual(event.value, { type: 'text', text: 'answer' })
    await session.close()
    const end = await iterator.next()
    assert.equal(end.done, true)
    assert.equal(runtime.starts.length, 1)
    assert.deepEqual(runtime.inputs, [{ text: 'hello' }])
    assert.equal(runtime.closeCount, 1)
    assert.equal(calls.length, 0)
  })
})

test('workspace, replay, evidence, and auth helpers stay local', () => {
  assert.equal(requireAbsoluteWorkspace('/tmp/workspace'), '/tmp/workspace')
  assert.throws(() => requireAbsoluteWorkspace('relative/workspace'), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.equal(retentionProofAccepted({ nativeRequestRecord: 'present' }), false)
  assert.throws(() => rejectBlockReplay({ response: {}, blocks: [] }), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'REPLAY_STATE_INVALID')
    return true
  })
  assert.doesNotThrow(() => rejectBlockReplay({ response: {} }))
  assert.equal(blockKey('msg-1', 0), 'msg-1:0')
  const key = process.env['ANTHROPIC_API_KEY']
  assert.throws(() => childEnvironment(), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'AUTH_ROUTE_REFUSED')
    return true
  })
  assert.equal(process.env['ANTHROPIC_API_KEY'], key)
})

test('compiled production files do not import the Agent SDK', () => {
  const sdkRuntime = readFileSync(new URL('../src/sdk-runtime.js', import.meta.url), 'utf8')
  const adapterSource = readFileSync(new URL('../src/adapter.js', import.meta.url), 'utf8')
  const entry = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  for (const source of [sdkRuntime, adapterSource, entry]) {
    assert.equal(source.includes('@anthropic-ai/claude-agent-sdk'), false)
    assert.equal(source.includes('pathToClaudeCodeExecutable'), false)
  }
})

test('package scripts keep live tests separate', () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
    scripts: Record<string, string>
    peerDependencies: Record<string, string>
    dsh: { bundle: { patch: string; listedByDefault: boolean } }
  }
  assert.equal(manifest.scripts['test']?.includes('test:live'), false)
  assert.equal(manifest.scripts['build']?.includes('test:live'), false)
  assert.equal(manifest.scripts['check']?.includes('test:live'), false)
  assert.equal(manifest.scripts['postinstall'], undefined)
  assert.equal(manifest.scripts['prepare'], undefined)
  assert.equal(manifest.scripts['prepack'], undefined)
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-llm'], '0.2.2-rc.1')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.bundle.listedByDefault, false)
  const patch = readFileSync(fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url)), 'utf8')
  assert.match(patch, /id: claude-code-session/)
  assert.match(patch, /name: dsh-plugin-claude-code/)
})
