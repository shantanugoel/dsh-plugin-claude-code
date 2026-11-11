import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { interpretAuthStatus } from '../src/auth.js'
import { contentHash } from '../src/canonical.js'
import { DEFAULT_DEADLINES } from '../src/deadlines.js'
import {
  IMPORT_MAX_CHARS,
  planRollover,
  quoteBounded,
} from '../src/rollover.js'
import { parseReplay } from '../src/replay.js'
import { projectMessages } from '../src/transcript.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { inputText, textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { SYNTHETIC_AUTH_STATUS, makeAdapter } from './support.js'

const NOW = new Date('2026-11-11T00:00:00.000Z')
const MODEL = 'claude-haiku-5-5'

function proof(binding: string): SpendProof {
  return {
    policyId: 'proof-1',
    identityBinding: binding,
    scope: 'claude-code-session',
    expiresAt: '2026-11-11T01:00:00.000Z',
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

function tick(milliseconds = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function userMessage(text: string, id?: string) {
  return {
    role: 'user' as const,
    ...(id === undefined ? {} : { id }),
    content: [{ type: 'text' as const, text }],
  }
}

function toolMessage(callId: string, text: string, isError = false) {
  return {
    role: 'tool' as const,
    id: `result-${callId}`,
    toolCallId: callId,
    isError,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'tool' as const, callId },
  }
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
      model: MODEL,
      ...(replayState === undefined ? {} : { replayState }),
    },
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

function generationChange(chunks: readonly StreamChunk[]): Record<string, unknown> {
  const change = replayResponse(chunks)['generationChange']
  if (typeof change !== 'object' || change === null) {
    throw new Error('The replay has no recorded generation change.')
  }
  return change as Record<string, unknown>
}

function sessionInput(runtime: ScriptedNativeRuntime, sessionIndex: number, inputIndex = 0): string {
  const input = runtime.sessions[sessionIndex]?.inputs[inputIndex]
  if (input === undefined) throw new Error('The scripted session has no recorded input.')
  return inputText(input)
}

function fakeReplayEnvelope(): Record<string, unknown> {
  return {
    response: {
      format: 'claude-session-v1',
      generationId: '1',
      cliSessionId: 'saved-cli',
      cliVersion: 'cli',
      sdkVersion: 'sdk',
      model: MODEL,
      workspace: '/tmp/ws',
      requestPrefixHash: 'hash',
      projectedContentHash: 'hash',
      nativeRequestRecord: null,
      nativeResponseBlocks: [],
      toolNameMap: {},
      retentionAudit: 'unavailable',
    },
  }
}

function toolEvents(callIds: readonly string[]): {
  events: readonly import('../src/sdk-runtime.js').NativeEvent[]
} {
  const events: import('../src/sdk-runtime.js').NativeEvent[] = []
  callIds.forEach((callId, index) => {
    events.push(
      { type: 'block-start', messageId: 'm1', index, blockType: 'tool-call' },
      { type: 'tool-delta', messageId: 'm1', index, id: callId, name: 'echo', argumentsDelta: '{"value":"one"}' },
      { type: 'block-stop', messageId: 'm1', index },
    )
  })
  events.push(
    { type: 'usage', inputTokens: 3, outputTokens: 2 },
    { type: 'message-stop', messageId: 'm1', stopReason: 'tool_use' },
  )
  return { events }
}

const ECHO_TOOL = [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }]

test('an abort mid-turn continues the same dsh session in a recorded new generation', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({ events: [] })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const controller = new AbortController()
  const first = collect(model, { ...textRequest('hello', 'abort-mid'), signal: controller.signal })
  await tick()
  controller.abort()
  const aborted = await first
  const abortedFinish = aborted.at(-1)
  assert.equal(abortedFinish?.type, 'finish')
  if (abortedFinish?.type === 'finish') assert.equal(abortedFinish.reason.kind, 'aborted')
  assert.equal(runtime.closeCount, 1)
  assert.equal(runtime.starts.length, 1)

  runtime.enqueue(textTurn('recovered answer', 'm2'))
  const secondMessages = [
    userMessage('hello'),
    userMessage('again'),
  ] as unknown as GenerateOptions['messages']
  const second = await collect(model, { ...textRequest('ignored', 'abort-mid'), messages: secondMessages })
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  const recoveredInput = sessionInput(runtime, 1)
  assert.equal(recoveredInput.includes('Historical context for a new Claude session.'), true)
  assert.equal(recoveredInput.includes('"hello"'), true)
  assert.equal(recoveredInput.includes('again'), true)
  const change = generationChange(second)
  assert.equal(change['reason'], 'abort')
  assert.equal(change['fromGenerationId'], '1')
  assert.equal(change['fromCliSessionId'], 'scripted-session')
  assert.equal(change['importedMessageCount'], 1)
  const expectedImported = contentHash(projectMessages([userMessage('hello')] as unknown as GenerateOptions['messages']))
  assert.equal(change['importedPrefixHash'], expectedImported)
  assert.equal(typeof change['createdAt'], 'string')

  runtime.enqueue(textTurn('third answer', 'm3'))
  const thirdMessages = [
    ...secondMessages,
    assistantMessage(second, 'assistant-2'),
    userMessage('third'),
  ] as unknown as GenerateOptions['messages']
  const third = await collect(model, { ...textRequest('ignored', 'abort-mid'), messages: thirdMessages })
  assert.equal(third.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.sessions[1]?.inputs.length, 2)
  assert.equal(sessionInput(runtime, 1, 1), 'third')
  assert.equal(replayResponse(third)['generationChange'], undefined)
})

test('an abort before dispatch continues with the pending user input in the import', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer', 'm1'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, textRequest('hello', 'abort-before'))
  assert.equal(first.at(-1)?.type, 'finish')

  const preAborted = new AbortController()
  preAborted.abort()
  const interruptedMessages = [
    userMessage('hello'),
    assistantMessage(first, 'assistant-1'),
    userMessage('during abort'),
  ] as unknown as GenerateOptions['messages']
  const interrupted = await collect(model, {
    ...textRequest('during abort', 'abort-before'),
    signal: preAborted.signal,
    messages: interruptedMessages,
  })
  const interruptedFinish = interrupted.at(-1)
  assert.equal(interruptedFinish?.type, 'finish')
  if (interruptedFinish?.type === 'finish') assert.equal(interruptedFinish.reason.kind, 'aborted')
  assert.equal(runtime.closeCount, 1)

  runtime.enqueue(textTurn('after abort', 'm3'))
  const recovery = await collect(model, {
    ...textRequest('after abort', 'abort-before'),
    messages: [...interruptedMessages, userMessage('after abort')] as unknown as GenerateOptions['messages'],
  })
  assert.equal(recovery.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  const change = generationChange(recovery)
  assert.equal(change['reason'], 'abort')
  assert.equal(change['importedMessageCount'], 2)
  const recoveredInput = sessionInput(runtime, 1)
  assert.equal(recoveredInput.includes('"hello"'), true)
  assert.equal(recoveredInput.includes('"answer"'), true)
  assert.equal(recoveredInput.includes('during abort'), true)
  assert.equal(recoveredInput.includes('after abort'), true)
  assert.equal(recoveredInput.includes('sig-'), false)
})

test('a generation timeout recovers on the next user turn', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, generationMs: 20 },
  })
  await assert.rejects(collect(model, textRequest('hello', 'timeout-1')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'NATIVE_OUTCOME_UNKNOWN')
    return true
  })
  assert.equal(runtime.closeCount, 1)
  runtime.enqueue(textTurn('after timeout', 'm2'))
  const recovered = await collect(model, {
    ...textRequest('after timeout', 'timeout-1'),
    messages: [userMessage('hello'), userMessage('after timeout')] as unknown as GenerateOptions['messages'],
  })
  assert.equal(recovered.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  const change = generationChange(recovered)
  assert.equal(change['reason'], 'timeout')
  assert.equal(change['fromGenerationId'], '1')
  assert.equal(change['importedMessageCount'], 1)
  const recoveredInput = sessionInput(runtime, 1)
  assert.equal(recoveredInput.includes('"hello"'), true)
  assert.equal(recoveredInput.includes('after timeout'), true)
})

test('a lost native process between turns recovers with reason process-loss', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer', 'm1'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, textRequest('hello', 'process-loss'))
  assert.equal(first.at(-1)?.type, 'finish')
  runtime.sessions[0]?.close()
  assert.equal(runtime.sessions[0]?.isClosed(), true)
  const closedAt = runtime.closeCount
  runtime.enqueue(textTurn('after loss', 'm2'))
  const messages = [
    userMessage('hello'),
    assistantMessage(first, 'assistant-1'),
    userMessage('after loss'),
  ] as unknown as GenerateOptions['messages']
  const recovered = await collect(model, { ...textRequest('after loss', 'process-loss'), messages })
  assert.equal(recovered.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.closeCount, closedAt)
  const change = generationChange(recovered)
  assert.equal(change['reason'], 'process-loss')
  assert.equal(change['fromGenerationId'], '1')
  assert.equal(change['fromCliSessionId'], 'scripted-session')
  assert.equal(change['importedMessageCount'], 2)
  const recoveredInput = sessionInput(runtime, 1)
  assert.equal(recoveredInput.includes('"hello"'), true)
  assert.equal(recoveredInput.includes('"answer"'), true)
  assert.equal(recoveredInput.includes('after loss'), true)
})

test('a lost process during a tool wait imports the completed tool outcome', async () => {
  const runtime = new ScriptedNativeRuntime()
  let delivered = false
  runtime.enqueue({
    ...toolEvents(['call-1']),
    invokeHandlers: async (call) => {
      await call('call-1')
      delivered = true
    },
  })
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, resultWaitMs: 60_000 },
  })
  const first = await collect(model, {
    ...textRequest('do a tool', 'tool-loss'),
    tools: ECHO_TOOL,
  })
  assert.equal(first.at(-1)?.type, 'finish')
  await tick()
  runtime.sessions[0]?.close()
  runtime.enqueue(textTurn('tool result answer', 'm2'))
  const messages = [
    userMessage('do a tool'),
    assistantMessage(first, 'assistant-1'),
    toolMessage('call-1', 'park-token'),
  ] as unknown as GenerateOptions['messages']
  const recovered = await collect(model, {
    ...textRequest('do a tool', 'tool-loss'),
    tools: ECHO_TOOL,
    messages,
  })
  assert.equal(recovered.at(-1)?.type, 'finish')
  assert.equal(delivered, false)
  assert.equal(runtime.starts.length, 2)
  const change = generationChange(recovered)
  assert.equal(change['reason'], 'process-loss')
  assert.equal(change['importedMessageCount'], 3)
  const recoveredInput = sessionInput(runtime, 1)
  assert.equal(recoveredInput.includes('Tool outcome (completed)'), true)
  assert.equal(recoveredInput.includes('park-token'), true)
  assert.equal(recoveredInput.includes('Completed outcome in this import: yes'), true)
})

test('a recovered generation releases tool results through its own bridge', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer', 'm1'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, textRequest('hello', 'recover-tools'))
  assert.equal(first.at(-1)?.type, 'finish')
  runtime.sessions[0]?.close()

  let delivered = false
  runtime.enqueue({
    ...toolEvents(['call-recovered']),
    invokeHandlers: async (call) => {
      const result = await call('call-recovered')
      delivered = true
      assert.equal(result.callId, 'call-recovered')
    },
  })
  runtime.enqueue(textTurn('final', 'm3'))
  const messages = [
    userMessage('hello'),
    assistantMessage(first, 'assistant-1'),
    userMessage('continue'),
  ] as unknown as GenerateOptions['messages']
  const recovered = await collect(model, { ...textRequest('continue', 'recover-tools'), tools: ECHO_TOOL, messages })
  assert.equal(recovered.at(-1)?.type, 'finish')
  const recoveredFinish = recovered.at(-1)
  if (recoveredFinish?.type === 'finish') assert.equal(recoveredFinish.reason.kind, 'tool-calls')
  assert.equal(runtime.starts.length, 2)
  await tick()
  assert.equal(delivered, false)

  const continued = await collect(model, {
    ...textRequest('continue', 'recover-tools'),
    tools: ECHO_TOOL,
    messages: [
      ...messages,
      assistantMessage(recovered, 'assistant-2'),
      toolMessage('call-recovered', 'recovered-token'),
    ] as unknown as GenerateOptions['messages'],
  })
  assert.equal(continued.at(-1)?.type, 'finish')
  assert.equal(delivered, true)
  assert.equal(runtime.starts.length, 2)
})

test('a restored or reloaded session starts one recorded new generation and continues it', async () => {
  const runtimeA = new ScriptedNativeRuntime()
  runtimeA.enqueue(textTurn('answer', 'm1'))
  const adapterA = makeAdapter({ runtime: runtimeA, spendGate: gate() })
  const first = await collect(adapterA.model, textRequest('hello', 'restore-1'))
  assert.equal(first.at(-1)?.type, 'finish')

  const runtimeB = new ScriptedNativeRuntime()
  runtimeB.enqueue(textTurn('restored answer', 'm2'))
  const adapterB = makeAdapter({ runtime: runtimeB, spendGate: gate() })
  const messages = [
    userMessage('hello'),
    assistantMessage(first, 'assistant-1'),
    userMessage('next'),
  ] as unknown as GenerateOptions['messages']
  const recovered = await collect(adapterB.model, { ...textRequest('next', 'restore-1'), messages })
  assert.equal(recovered.at(-1)?.type, 'finish')
  assert.equal(runtimeB.starts.length, 1)
  assert.equal(runtimeB.closeCount, 0)
  const change = generationChange(recovered)
  assert.equal(change['reason'], 'restore')
  assert.equal(change['fromGenerationId'], null)
  assert.equal(change['fromCliSessionId'], null)
  assert.equal(change['importedMessageCount'], 2)
  const recoveredInput = sessionInput(runtimeB, 0)
  assert.equal(recoveredInput.includes('"hello"'), true)
  assert.equal(recoveredInput.includes('"answer"'), true)
  assert.equal(recoveredInput.includes('next'), true)

  runtimeB.enqueue(textTurn('again', 'm3'))
  const continued = await collect(adapterB.model, {
    ...textRequest('again', 'restore-1'),
    messages: [...messages, assistantMessage(recovered, 'assistant-2'), userMessage('again')] as unknown as GenerateOptions['messages'],
  })
  assert.equal(continued.at(-1)?.type, 'finish')
  assert.equal(runtimeB.starts.length, 1)
  assert.equal(runtimeB.sessions[0]?.inputs.length, 2)
  assert.equal(sessionInput(runtimeB, 0, 1), 'again')
  assert.equal(replayResponse(continued)['generationChange'], undefined)
})

test('a restored tool-result continuation imports the outcome without a live tool call', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('final answer', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const messages = [
    userMessage('do a tool'),
    {
      role: 'assistant' as const,
      id: 'assistant-1',
      content: [{ type: 'tool-call' as const, id: 'call-0', name: 'echo', arguments: '{}' }],
      source: {
        kind: 'model' as const,
        provider: 'claude-code-session',
        model: MODEL,
        replayState: fakeReplayEnvelope(),
      },
    },
    toolMessage('call-0', 'saved-token'),
  ] as unknown as GenerateOptions['messages']
  const recovered = await collect(model, {
    ...textRequest('do a tool', 'restore-tool'),
    tools: ECHO_TOOL,
    messages,
  })
  assert.equal(recovered.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  const change = generationChange(recovered)
  assert.equal(change['reason'], 'restore')
  assert.equal(change['importedMessageCount'], 3)
  const recoveredInput = sessionInput(runtime, 0)
  assert.equal(recoveredInput.includes('saved-token'), true)
  assert.equal(recoveredInput.includes('no live tool calls'), true)
})

test('a forked subagent first request uses reason fork', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('child answer', 'm1'))
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    sessionOrigin: { kind: () => 'fork' },
  })
  const parentChunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'parent answer' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'parent answer' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    {
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: {
        response: {
          format: 'claude-session-v1',
          generationId: '1',
          cliSessionId: 'parent-cli',
          cliVersion: 'cli',
          sdkVersion: 'sdk',
          model: MODEL,
          workspace: '/tmp/ws',
          requestPrefixHash: 'hash',
          projectedContentHash: 'hash',
          nativeRequestRecord: null,
          nativeResponseBlocks: [],
          toolNameMap: {},
          retentionAudit: 'unavailable',
        },
      },
    },
  ]
  const messages = [
    userMessage('parent question'),
    assistantMessage(parentChunks, 'parent-assistant'),
    userMessage('subagent task'),
  ] as unknown as GenerateOptions['messages']
  const recovered = await collect(model, { ...textRequest('subagent task', 'fork-child'), messages })
  assert.equal(recovered.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  const change = generationChange(recovered)
  assert.equal(change['reason'], 'fork')
  assert.equal(change['fromGenerationId'], null)
  assert.equal(change['importedMessageCount'], 2)
})

test('consecutive rollovers record each new generation and keep the dsh session', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('one', 'm1'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, textRequest('hello', 'many'))
  assert.equal(first.at(-1)?.type, 'finish')

  runtime.sessions[0]?.close()
  runtime.enqueue(textTurn('two', 'm2'))
  const messages2 = [
    userMessage('hello'),
    assistantMessage(first, 'assistant-1'),
    userMessage('second'),
  ] as unknown as GenerateOptions['messages']
  const second = await collect(model, { ...textRequest('second', 'many'), messages: messages2 })
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(generationChange(second)['fromGenerationId'], '1')

  runtime.sessions[1]?.close()
  runtime.enqueue(textTurn('three', 'm3'))
  const messages3 = [
    ...messages2,
    assistantMessage(second, 'assistant-2'),
    userMessage('third'),
  ] as unknown as GenerateOptions['messages']
  const third = await collect(model, { ...textRequest('third', 'many'), messages: messages3 })
  assert.equal(third.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 3)
  const change = generationChange(third)
  assert.equal(change['reason'], 'process-loss')
  assert.equal(change['fromGenerationId'], '2')
  const thirdInput = sessionInput(runtime, 2)
  assert.equal(thirdInput.includes('"two"'), true)
  assert.equal(thirdInput.includes('third'), true)
})

test('the textual import omits signatures, thinking text, image bytes, and tool-call ids', () => {
  const messages = [
    {
      role: 'user',
      id: 'u1',
      content: [
        { type: 'text', text: 'first' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'sha256:abcd',
            mediaType: 'image/png',
            bytes: 68,
            width: 1,
            height: 1,
          },
        },
      ],
    },
    {
      role: 'assistant',
      id: 'a1',
      content: [
        { type: 'reasoning', text: 'secret-thought' },
        { type: 'text', text: 'answer' },
        { type: 'tool-call', id: 'toolu-secret', name: 'echo', arguments: '{"value":1}' },
      ],
      source: {
        kind: 'model',
        provider: 'claude-code-session',
        model: MODEL,
        replayState: {
          response: {
            format: 'claude-session-v1',
            nativeResponseBlocks: [{ type: 'thinking', text: '', signature: 'sig-secret' }],
          },
        },
      },
    },
    { role: 'tool', id: 'r1', toolCallId: 'toolu-secret', content: [{ type: 'text', text: 'outcome' }] },
    { role: 'user', id: 'u2', content: [{ type: 'text', text: 'next' }] },
  ]
  const plan = planRollover({
    messages: messages as unknown as GenerateOptions['messages'],
    reason: 'restore',
    now: NOW,
  })
  assert.equal(plan.importedText.includes('sig-secret'), false)
  assert.equal(plan.importedText.includes('secret-thought'), false)
  assert.equal(plan.importedText.includes('toolu-secret'), false)
  assert.equal(plan.importedText.includes('iVBORw0KGgo'), false)
  assert.equal(plan.importedText.includes('sha256:abcd'), true)
  assert.equal(plan.importedText.includes('"answer"'), true)
  assert.equal(plan.importedText.includes('"outcome"'), true)
  assert.equal(plan.importedText.includes('Tool name: "echo"'), true)
  assert.equal(plan.importedText.includes('no signed thinking'), true)
  assert.equal(plan.pendingUserContent.length, 1)
  assert.deepEqual(plan.pendingUserContent[0], { type: 'text', text: 'next' })
  assert.equal(plan.generationChange.createdAt, NOW.toISOString())
})

test('the import is deterministic and bounded', () => {
  const longText = 'x'.repeat(20_000)
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    { role: 'assistant', content: [{ type: 'text', text: longText }] },
    { role: 'user', content: [{ type: 'text', text: 'later' }] },
  ]
  const first = planRollover({ messages: messages as unknown as GenerateOptions['messages'], reason: 'restore', now: NOW })
  const second = planRollover({ messages: messages as unknown as GenerateOptions['messages'], reason: 'restore', now: NOW })
  assert.equal(first.importedText, second.importedText)
  assert.equal(first.generationChange.importedPrefixHash, second.generationChange.importedPrefixHash)
  assert.equal(quoteBounded('short', 100), '"short"')
  assert.equal(quoteBounded('abcdef', 3).includes('characters omitted'), true)
  const many = [] as { role: 'user'; content: { type: 'text'; text: string }[] }[]
  for (let index = 0; index < 80; index += 1) {
    many.push({ role: 'user', content: [{ type: 'text', text: 'y'.repeat(4_000) }] })
  }
  const bounded = planRollover({
    messages: [...many, { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }, { role: 'user', content: [{ type: 'text', text: 'next' }] }] as unknown as GenerateOptions['messages'],
    reason: 'restore',
    now: NOW,
  })
  assert.equal(bounded.importedText.length <= IMPORT_MAX_CHARS + 2_000, true)
  assert.equal(bounded.importedText.includes('omitted from this bounded import'), true)
})

test('a malformed recorded generation change is refused', () => {
  const base = {
    format: 'claude-session-v1',
    generationId: '1',
    cliSessionId: 'cli',
    cliVersion: 'cli',
    sdkVersion: 'sdk',
    model: MODEL,
    workspace: '/tmp/ws',
    requestPrefixHash: 'hash',
    projectedContentHash: 'hash',
    nativeRequestRecord: null,
    nativeResponseBlocks: [],
    toolNameMap: {},
    retentionAudit: 'unavailable',
  }
  const validChange = {
    reason: 'restore',
    fromGenerationId: null,
    fromCliSessionId: null,
    importedMessageCount: 2,
    importedPrefixHash: 'hash',
    createdAt: NOW.toISOString(),
  }
  assert.deepEqual(parseReplay({ ...base, generationChange: validChange }).generationChange, validChange)
  const badReason = parseReplay.bind(null, { ...base, generationChange: { ...validChange, reason: 'made-up' } })
  assert.throws(badReason, (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'REPLAY_STATE_INVALID')
    return true
  })
  const badCount = parseReplay.bind(null, { ...base, generationChange: { ...validChange, importedMessageCount: -1 } })
  assert.throws(badCount, (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'REPLAY_STATE_INVALID')
    return true
  })
  const badTime = parseReplay.bind(null, { ...base, generationChange: { ...validChange, createdAt: 'yesterday' } })
  assert.throws(badTime, (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'REPLAY_STATE_INVALID')
    return true
  })
  assert.equal(parseReplay(base).generationChange, undefined)
})

test('the same dispatched request is refused after a generation failure', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({ events: [] })
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, generationMs: 20 },
  })
  await assert.rejects(collect(model, textRequest('hello', 'repeat-fail')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'NATIVE_OUTCOME_UNKNOWN')
    return true
  })
  await assert.rejects(collect(model, textRequest('hello', 'repeat-fail')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'NATIVE_OUTCOME_UNKNOWN')
    return true
  })
  assert.equal(runtime.starts.length, 1)
  assert.deepEqual(runtime.inputs.map(inputText), ['hello'])
})
