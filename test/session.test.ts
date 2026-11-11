import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  LlmError,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'

import { interpretAuthStatus } from '../src/auth.js'
import { assertWorkspaceAgreement, SessionHeaderWorkspace } from '../src/context.js'
import { DEFAULT_DEADLINES } from '../src/deadlines.js'
import type { NativeEvent, NativeRuntime, NativeSession, NativeSessionConfig, NativeUserInput } from '../src/sdk-runtime.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { inputText, textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { SYNTHETIC_AUTH_STATUS, makeAdapter } from './support.js'

const NOW = new Date('2026-11-10T00:00:00.000Z')
const SIGNATURE = 'sig-keep-thinking'

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

async function sessionContext(): Promise<{ ctx: Context; sessions: SessionStore }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  ctx.on('session/flush', () => undefined)
  return { ctx, sessions: ctx.sessions }
}

test('two sessions use their header workspaces', async () => {
  const { sessions } = await sessionContext()
  sessions.create(SessionId('s-a'), { meta: { cwd: '/tmp/ws-a' } })
  sessions.create(SessionId('s-b'), { meta: { cwd: '/tmp/ws-b' } })
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('alpha'))
  runtime.enqueue(textTurn('beta', 'm2'))
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    workspace: new SessionHeaderWorkspace(sessions),
  })
  await collect(model, { ...textRequest('from-a', 's-a'), system: 'Prompt A' })
  await collect(model, { ...textRequest('from-b', 's-b'), system: 'Prompt B' })
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[0]?.workspace, '/tmp/ws-a')
  assert.equal(runtime.starts[1]?.workspace, '/tmp/ws-b')
  assert.equal(runtime.starts[0]?.systemPrompt, 'Prompt A')
  assert.equal(runtime.starts[1]?.systemPrompt, 'Prompt B')
  assert.deepEqual(runtime.sessions[0]?.inputs.map(inputText), ['from-a'])
  assert.deepEqual(runtime.sessions[1]?.inputs.map(inputText), ['from-b'])
})

test('the session workspace wins over a different filesystem base', () => {
  assert.equal(assertWorkspaceAgreement('/tmp/ws-a'), '/tmp/ws-a')
  assert.throws(() => assertWorkspaceAgreement('/tmp/ws-a', '/tmp/other-base'), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'REBASE_REQUIRED')
    return true
  })
})

test('a recorded import starts a new generation and keeps the raw log', async () => {
  const { sessions } = await sessionContext()
  const session = sessions.create(SessionId('s-import'), { meta: { cwd: '/tmp/ws-import' } })
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer'))
  runtime.enqueue(textTurn('after', 'm2'))
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    workspace: new SessionHeaderWorkspace(sessions),
  })
  await collect(model, { ...textRequest('hello', 's-import'), system: 'Be brief.' })
  session.append('system/message', {
    turn: 0,
    step: 0,
    message: createSystemMessage('Be brief.'),
  }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'answer' }],
      source: {
        provider: 'claude-code-session',
        model: 'claude-haiku-5-5',
        replayState: { response: { signature: SIGNATURE, callId: 'call-keep' } },
      },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  const imported = await model.recordContextImport(session, sessions)
  assert.equal(imported.includes(SIGNATURE), false)
  assert.equal(imported.includes('call-keep'), false)
  assert.equal(imported.includes('Historical context'), true)
  assert.equal(JSON.stringify(session.snapshotEvents()).includes(SIGNATURE), true)
  assert.deepEqual(session.deriveMessages().map((message) => message.role), ['system', 'user'])
  const next = await collect(model, {
    ...textRequest('ignored', 's-import'),
    messages: session.deriveMessages(),
  })
  assert.equal(next.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(inputText(runtime.sessions[1]?.inputs[0] as NativeUserInput), imported)
  assert.equal(inputText(runtime.sessions[1]?.inputs[0] as NativeUserInput).includes(SIGNATURE), false)
  assert.equal(runtime.closeCount >= 1, true)
})

test('an open tool blocks the context import', async () => {
  const { sessions } = await sessionContext()
  const session = sessions.create(SessionId('s-open'), { meta: { cwd: '/tmp/ws-open' } })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'echo', arguments: '{}' }],
      source: { provider: 'claude-code-session', model: 'claude-haiku-5-5' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  const end = session.surface.nodes.at(-1)
  assert.equal(end === undefined ? true : toolPairingBalancedAfter(session, end), false)
  const before = session.snapshotEvents().length
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    workspace: new SessionHeaderWorkspace(sessions),
  })
  await assert.rejects(model.recordContextImport(session, sessions), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'REBASE_REQUIRED')
    return true
  })
  assert.equal(session.snapshotEvents().length, before)
  assert.equal(runtime.starts.length, 0)
})

test('a title call during a parked tool uses another native session', async () => {
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
  runtime.enqueue(textTurn('Title', 'm-title'))
  runtime.enqueue(textTurn('done', 'm-done'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const toolRequest = {
    ...textRequest('hello', 'parked'),
    tools: [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }],
  }
  const first = await collect(model, toolRequest)
  const title = await collect(model, { ...textRequest('name this', 'parked'), purpose: 'title' } as GenerateOptions)
  assert.equal(title.at(-1)?.type, 'finish')
  assert.equal(delivered, false)
  assert.equal(runtime.starts.length, 2)
  assert.deepEqual(runtime.sessions[1]?.inputs.map(inputText), ['name this'])
  const finish = first.at(-1)
  const replayState = finish?.type === 'finish' ? finish.replayState : undefined
  const continued = await collect(model, {
    ...toolRequest,
    messages: [
      ...toolRequest.messages,
      {
        role: 'assistant',
        id: 'assistant-1',
        content: first.flatMap((chunk) => chunk.type === 'block-end' ? [chunk.block] : []),
        source: {
          kind: 'model',
          provider: 'claude-code-session',
          model: 'claude-haiku-5-5',
          ...(replayState === undefined ? {} : { replayState }),
        },
      },
      {
        role: 'tool',
        id: 'result-call-1',
        toolCallId: 'call-1',
        isError: false,
        content: [{ type: 'text', text: 'park-token' }],
        source: { kind: 'tool', callId: 'call-1' },
      },
    ] as GenerateOptions['messages'],
  })
  assert.equal(continued.at(-1)?.type, 'finish')
  assert.equal(delivered, true)
  assert.equal(runtime.starts.length, 2)
  assert.deepEqual(runtime.sessions[0]?.inputs.map(inputText), ['hello'])
})

test('a second stream is busy while the first stream is open', async () => {
  const runtime = new ScriptedNativeRuntime()
  const controller = new AbortController()
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, generationMs: 500 },
  })
  const first = collect(model, { ...textRequest('hello', 'busy-1'), signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await assert.rejects(collect(model, textRequest('hello', 'busy-1')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'SESSION_BUSY')
    return true
  })
  controller.abort()
  const chunks = await first
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type === 'finish') assert.equal(finish.reason.kind, 'aborted')
  assert.equal(runtime.starts.length, 1)
})

test('plugin unload reaps a stalled native close', async () => {
  const runtime: NativeRuntime = {
    start(config: NativeSessionConfig): Promise<NativeSession> {
      const events: NativeEvent[] = [
        { type: 'block-start', messageId: 'm1', index: 0, blockType: 'text' },
        { type: 'text-delta', messageId: 'm1', index: 0, text: 'ok' },
        { type: 'block-stop', messageId: 'm1', index: 0 },
        { type: 'usage', inputTokens: 1, outputTokens: 1 },
        { type: 'message-stop', messageId: 'm1', stopReason: 'end_turn' },
      ]
      void config
      return Promise.resolve({
        identity: { cliSessionId: 'stalled', cliVersion: 'scripted', sdkVersion: 'scripted' },
        events: (async function* () { yield* events })(),
        sendUser: () => Promise.resolve(),
        continueAfterResults: () => Promise.resolve(),
        close: () => new Promise<void>(() => undefined),
      })
    },
  }
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, closeMs: 30 },
  })
  const chunks = await collect(model, textRequest('hello', 'unload-1'))
  assert.equal(chunks.at(-1)?.type, 'finish')
  await assert.rejects(model.closeOwnedSessions(), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'NATIVE_OUTCOME_UNKNOWN')
    return true
  })
})
