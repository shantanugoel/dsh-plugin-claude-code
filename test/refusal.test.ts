import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { LlmError } from '@deepseek-ai/dsh-llm'

import { buildChildEnvironment } from '../src/auth.js'
import { requireAbsoluteWorkspace } from '../src/context.js'
import { retentionProofAccepted } from '../src/evidence.js'
import { rejectBlockReplay } from '../src/replay.js'
import { ProductionSpendGate, ScriptedSpendGate, type SpendGate } from '../src/spend-gate.js'
import { blockKey } from '../src/stream.js'
import { inputText, textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { makeAdapter } from './support.js'

function adapter(runtime: ScriptedNativeRuntime, gate: SpendGate) {
  return makeAdapter({ runtime, spendGate: gate }).model
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

test('production spend gate allows the scripted runtime to receive the prompt', async () => {
  await withFetchCounter(async (calls) => {
    const runtime = new ScriptedNativeRuntime()
    runtime.enqueue(textTurn('ok'))
    const model = adapter(runtime, new ProductionSpendGate())
    const chunks = []
    for await (const chunk of model.stream(textRequest())) chunks.push(chunk)
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.equal(runtime.starts.length, 1)
    assert.deepEqual(runtime.inputs.map(inputText), ['hello'])
    assert.equal(calls.length, 0)
    assert.deepEqual(await model.listModels('claude-code-session'), [])
    const policy = model.providerRetryPolicy('claude-code-session')
    assert.equal(policy.mode, 'normal')
    if (policy.mode !== 'normal') return
    assert.equal(policy.maxRetries, 0)
    assert.equal(policy.retryableCodes.includes('BILLING_GUARD_UNAVAILABLE'), false)
    assert.equal(policy.retryableCodes.includes('AUTH_ROUTE_REFUSED'), false)
    assert.equal(policy.retryableCodes.includes('NATIVE_OUTCOME_UNKNOWN'), false)
  })
})

test('an allowed test gate sends the user text only to the scripted runtime', async () => {
  await withFetchCounter(async (calls) => {
    const runtime = new ScriptedNativeRuntime()
    runtime.enqueue(textTurn('ok'))
    const model = adapter(runtime, new ScriptedSpendGate({
      allowed: true,
      policyId: 'test-only',
      validFor: 'test',
    }))
    const chunks = []
    for await (const chunk of model.stream(textRequest())) chunks.push(chunk)
    const finish = chunks.at(-1)
    assert.equal(finish?.type, 'finish')
    if (finish?.type !== 'finish') return
    assert.equal(finish.reason.kind, 'stop')
    assert.deepEqual(runtime.inputs.map(inputText), ['hello'])
    assert.equal(runtime.closeCount, 0)
    assert.equal(calls.length, 0)
  })
})

test('folded tool history does not block the prompt', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('ok'))
  const model = adapter(runtime, new ProductionSpendGate())
  const request = textRequest()
  request.toolHistory = {
    tools: [{ name: 'old', description: 'old tool', parameters: { type: 'object' } }],
    updates: [],
  }
  const chunks = []
  for await (const chunk of model.stream(request)) chunks.push(chunk)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  assert.deepEqual(runtime.inputs.map(inputText), ['hello'])
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
  const withFile = textRequest()
  withFile.messages = [{
    role: 'user',
    content: [{
      type: 'file',
      attachment: {
        attachmentId: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        name: 'notes.txt',
        bytes: 5,
      },
    }],
  }] as unknown as typeof withFile.messages
  await assert.rejects(model.stream(withFile)[Symbol.asyncIterator]().next(), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    assert.equal(error.message.includes('projects file attachments'), true)
    return true
  })
  const unknownRole = textRequest()
  unknownRole.messages = [{ role: 'developer', content: [{ type: 'text', text: 'note' }] }] as unknown as typeof unknownRole.messages
  await assert.rejects(model.stream(unknownRole)[Symbol.asyncIterator]().next(), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.equal(runtime.starts.length, 0)
})

test('the offline suite does not start the official runtime', () => {
  const source = readFileSync(new URL('../src/sdk-runtime.js', import.meta.url), 'utf8')
  assert.equal(source.includes('startOfficialSession'), true)
  assert.equal(source.includes('@anthropic-ai/claude-agent-sdk'), false)
})

test('the scripted runtime records calls and does not use the network', async () => {
  await withFetchCounter(async (calls) => {
    const runtime = new ScriptedNativeRuntime()
    const session = await runtime.start({
      workspace: '/tmp/workspace-a',
      model: 'claude-haiku-5-5',
      systemPrompt: 'prompt',
    })
    await session.sendUser({ content: [{ type: 'text', text: 'hello' }] })
    session.emit({ type: 'message-stop', messageId: 'm1', stopReason: 'end_turn' })
    const iterator = session.events[Symbol.asyncIterator]()
    const event = await iterator.next()
    assert.equal(event.done, false)
    assert.deepEqual(event.value, { type: 'message-stop', messageId: 'm1', stopReason: 'end_turn' })
    await session.close()
    const end = await iterator.next()
    assert.equal(end.done, true)
    assert.equal(runtime.starts.length, 1)
    assert.deepEqual(runtime.inputs.map(inputText), ['hello'])
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
  const child = buildChildEnvironment({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'secret-token',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
  }, '/tmp/isolated-home')
  assert.equal(child['PATH'], '/usr/bin')
  assert.equal(child['HOME'], '/tmp/isolated-home')
  assert.equal(child['ANTHROPIC_API_KEY'], undefined)
  assert.equal(child['ANTHROPIC_BASE_URL'], undefined)
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
