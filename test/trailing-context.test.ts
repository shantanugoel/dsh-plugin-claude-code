import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { interpretAuthStatus } from '../src/auth.js'
import { DEFAULT_DEADLINES } from '../src/deadlines.js'
import type { NativeEvent, NativeToolResult } from '../src/sdk-runtime.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { inputText, resultText, textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { SYNTHETIC_AUTH_STATUS, makeAdapter, syntheticImage } from './support.js'

const NOW = new Date('2026-11-11T00:00:00.000Z')
const MODEL = 'claude-haiku-5-5'
const SESSION = 'trailing-1'

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

function userMessage(text: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text }] }
}

function toolMessage(callId: string, text: string) {
  return {
    role: 'tool' as const,
    id: `result-${callId}`,
    toolCallId: callId,
    isError: false,
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

function toolEvents(callIds: readonly string[]): readonly NativeEvent[] {
  const events: NativeEvent[] = []
  callIds.forEach((callId, index) => {
    events.push(
      { type: 'block-start', messageId: 'm1', index, blockType: 'tool-call' },
      { type: 'tool-delta', messageId: 'm1', index, id: callId, name: 'echo', argumentsDelta: '{}' },
      { type: 'block-stop', messageId: 'm1', index },
    )
  })
  events.push(
    { type: 'usage', inputTokens: 3, outputTokens: 2 },
    { type: 'message-stop', messageId: 'm1', stopReason: 'tool_use' },
  )
  return events
}

function sessionInputText(runtime: ScriptedNativeRuntime, sessionIndex: number, inputIndex = 0): string {
  const session = runtime.sessions[sessionIndex]
  const input = session?.inputs[inputIndex]
  if (input === undefined) throw new Error('The scripted session has no recorded input.')
  return inputText(input)
}

function midTurnInputText(runtime: ScriptedNativeRuntime, sessionIndex: number, inputIndex = 0): string {
  const session = runtime.sessions[sessionIndex]
  const input = session?.midTurnInputs[inputIndex]
  if (input === undefined) throw new Error('The scripted session has no recorded mid-turn input.')
  return inputText(input)
}

const ECHO_TOOL = [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }]

function firstToolRequest(session = SESSION) {
  return { ...textRequest('hello', session), tools: ECHO_TOOL }
}

function continuationRequest(
  firstRequest: GenerateOptions,
  first: readonly StreamChunk[],
  suffix: readonly object[],
  overrides: Partial<GenerateOptions> = {},
) {
  return {
    ...firstRequest,
    ...overrides,
    messages: [
      ...firstRequest.messages,
      assistantMessage(first, 'assistant-1'),
      ...suffix,
    ] as unknown as GenerateOptions['messages'],
  }
}

test('a reminder after tool results reaches one native turn before the result is released', async () => {
  const runtime = new ScriptedNativeRuntime()
  const order: string[] = []
  let deliveredResult: NativeToolResult | undefined
  runtime.enqueue({
    events: toolEvents(['call-1']),
    invokeHandlers: async (call) => {
      deliveredResult = await call('call-1')
      const session = runtime.sessions[0]
      order.push(`queued-mid-turn:${session === undefined ? 'none' : session.midTurnInputs.length}`)
    },
  })
  runtime.enqueue(textTurn('token plus reminder answer', 'm2'))
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, resultWaitMs: 60_000 },
  })
  const firstRequest = firstToolRequest()
  const first = await collect(model, firstRequest)
  const firstFinish = first.at(-1)
  assert.equal(firstFinish?.type, 'finish')
  if (firstFinish?.type === 'finish') assert.equal(firstFinish.reason.kind, 'tool-calls')
  await tick()

  const second = await collect(model, continuationRequest(firstRequest, first, [
    toolMessage('call-1', 'RESULT_TOKEN'),
    userMessage('REMINDER: also use the result token.'),
  ]))
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  const session = runtime.sessions[0]
  assert.equal(session?.midTurnInputs.length, 1)
  assert.equal(midTurnInputText(runtime, 0), 'REMINDER: also use the result token.')
  assert.equal(deliveredResult === undefined ? '' : resultText(deliveredResult), 'RESULT_TOKEN')
  assert.deepEqual(order, ['queued-mid-turn:1'])
  assert.equal(session?.inputs.length, 1)
  assert.equal(replayResponse(second)['generationChange'], undefined)

  runtime.enqueue(textTurn('next answer', 'm3'))
  const secondRequest = continuationRequest(firstRequest, first, [
    toolMessage('call-1', 'RESULT_TOKEN'),
    userMessage('REMINDER: also use the result token.'),
  ])
  const third = await collect(model, {
    ...firstRequest,
    messages: [
      ...(secondRequest.messages as GenerateOptions['messages']),
      assistantMessage(second, 'assistant-2'),
      userMessage('next'),
    ] as unknown as GenerateOptions['messages'],
  })
  assert.equal(third.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  assert.equal(session?.inputs.length, 2)
  assert.equal(replayResponse(third)['generationChange'], undefined)
})

test('two trailing user messages keep their order inside the same native turn', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: toolEvents(['call-1']),
  })
  runtime.enqueue(textTurn('one answer', 'm2'))
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, resultWaitMs: 60_000 },
  })
  const firstRequest = firstToolRequest('trailing-2')
  const first = await collect(model, firstRequest)
  await tick()
  const second = await collect(model, continuationRequest(firstRequest, first, [
    toolMessage('call-1', 'RESULT_TOKEN'),
    userMessage('REMINDER-ONE'),
    userMessage('REMINDER-TWO'),
  ]))
  assert.equal(second.at(-1)?.type, 'finish')
  const session = runtime.sessions[0]
  assert.deepEqual(
    session?.midTurnInputs.map(inputText),
    ['REMINDER-ONE', 'REMINDER-TWO'],
  )
  assert.equal(runtime.starts.length, 1)
  assert.equal(session?.inputs.length, 1)
})

test('trailing content is not moved inside the tool result', async () => {
  const runtime = new ScriptedNativeRuntime()
  let delivered: NativeToolResult | undefined
  runtime.enqueue({
    events: toolEvents(['call-1']),
    invokeHandlers: async (call) => {
      delivered = await call('call-1')
    },
  })
  runtime.enqueue(textTurn('answer', 'm2'))
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, resultWaitMs: 60_000 },
  })
  const firstRequest = firstToolRequest('trailing-3')
  const first = await collect(model, firstRequest)
  await tick()
  await collect(model, continuationRequest(firstRequest, first, [
    toolMessage('call-1', 'PURE_RESULT'),
    userMessage('SEPARATE_USER_CONTENT'),
  ]))
  assert.ok(delivered !== undefined)
  assert.equal(resultText(delivered), 'PURE_RESULT')
  assert.equal(resultText(delivered).includes('SEPARATE_USER_CONTENT'), false)
  assert.equal(midTurnInputText(runtime, 0), 'SEPARATE_USER_CONTENT')
})

test('a system message after the tool results is still refused', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({ events: toolEvents(['call-1']) })
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, resultWaitMs: 60_000 },
  })
  const firstRequest = firstToolRequest('trailing-4')
  const first = await collect(model, firstRequest)
  await tick()
  await assert.rejects(collect(model, continuationRequest(firstRequest, first, [
    toolMessage('call-1', 'RESULT_TOKEN'),
    { role: 'system', content: [{ type: 'text', text: 'late system context' }] },
  ])), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.equal(runtime.midTurnInputs.length, 0)
})

test('an image in a trailing mid-turn message is refused before native dispatch', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({ events: toolEvents(['call-1']) })
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, resultWaitMs: 60_000 },
    attachments: () => undefined,
  })
  const firstRequest = firstToolRequest('trailing-5')
  const first = await collect(model, firstRequest)
  await tick()
  await assert.rejects(collect(model, continuationRequest(firstRequest, first, [
    toolMessage('call-1', 'RESULT_TOKEN'),
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', attachment: syntheticImage() },
      ],
    },
  ])), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.equal(runtime.midTurnInputs.length, 0)
  assert.equal(runtime.starts.length, 1)
})

test('trailing content with a prompt change uses the recorded rollover', async () => {
  const runtime = new ScriptedNativeRuntime()
  let delivered = false
  runtime.enqueue({
    events: toolEvents(['call-1']),
    invokeHandlers: async (call) => {
      await call('call-1')
      delivered = true
    },
  })
  runtime.enqueue(textTurn('rolled answer', 'm2'))
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, resultWaitMs: 60_000 },
  })
  const firstRequest: GenerateOptions = { ...firstToolRequest('trailing-6'), system: 'First prompt.' }
  const first = await collect(model, firstRequest)
  await tick()
  const second = await collect(model, continuationRequest(firstRequest, first, [
    toolMessage('call-1', 'RESULT_TOKEN'),
    userMessage('REMINDER: use the result token.'),
  ], { system: 'Second prompt.' }))
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(delivered, false)
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.systemPrompt, 'Second prompt.')
  const response = replayResponse(second)
  const change = response['generationChange'] as Record<string, unknown> | undefined
  assert.equal(change?.['reason'], 'configuration-change')
  const newInput = sessionInputText(runtime, 1)
  assert.equal(newInput.includes('Tool outcome (completed)'), true)
  assert.equal(newInput.includes('RESULT_TOKEN'), true)
  assert.equal(newInput.includes('REMINDER: use the result token.'), true)
})

test('a restored tool-result continuation keeps its trailing user message', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('restored answer', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const request: GenerateOptions = {
    ...textRequest('done', 'trailing-7'),
    tools: ECHO_TOOL,
    messages: [
      userMessage('hello'),
      {
        role: 'assistant' as const,
        id: 'assistant-1',
        content: [{ type: 'tool-call' as const, id: 'call-1', name: 'echo', arguments: '{}' }],
        source: {
          kind: 'model' as const,
          provider: 'claude-code-session',
          model: MODEL,
          replayState: { response: { format: 'claude-session-v1', generationId: '1' } },
        },
      },
      toolMessage('call-1', 'SAVED_RESULT'),
      userMessage('TRAILING_AFTER_RESTORE'),
    ] as unknown as GenerateOptions['messages'],
  }
  const recovered = await collect(model, request)
  assert.equal(recovered.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  const newInput = sessionInputText(runtime, 0)
  assert.equal(newInput.includes('SAVED_RESULT'), true)
  assert.equal(newInput.includes('TRAILING_AFTER_RESTORE'), true)
  const response = replayResponse(recovered)
  const change = response['generationChange'] as Record<string, unknown> | undefined
  assert.equal(change?.['reason'], 'restore')
})
