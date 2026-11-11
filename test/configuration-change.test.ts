import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { interpretAuthStatus } from '../src/auth.js'
import { DEFAULT_DEADLINES } from '../src/deadlines.js'
import type { DiscoveredModel } from '../src/model-discovery.js'
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

function toolEvents(callIds: readonly string[]): {
  events: readonly import('../src/sdk-runtime.js').NativeEvent[]
  invokeHandlers?: (call: (callId: string) => Promise<import('../src/sdk-runtime.js').NativeToolResult>) => Promise<void>
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

const EFFORT_CATALOG: readonly DiscoveredModel[] = [{
  value: MODEL,
  displayName: 'Haiku',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'max'],
}]

test('a plan-mode prompt change starts a new generation with the new prompt', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('plain answer', 'm1'))
  runtime.enqueue(textTurn('plan answer', 'm2'))
  runtime.enqueue(textTurn('plain answer again', 'm3'))
  runtime.enqueue(textTurn('continued', 'm4'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const basePrompt = 'Base prompt.'
  const planPrompt = 'Base prompt.\n<plan:policy>Plan mode is active.</plan:policy>'

  const firstRequest: GenerateOptions = { ...textRequest('hello', 'plan-mode'), system: basePrompt }
  const first = await collect(model, firstRequest)
  assert.equal(first.at(-1)?.type, 'finish')

  const secondRequest: GenerateOptions = {
    ...textRequest('next', 'plan-mode'),
    system: planPrompt,
    messages: [
      ...firstRequest.messages,
      assistantMessage(first, 'assistant-1'),
      userMessage('next'),
    ] as unknown as GenerateOptions['messages'],
  }
  const second = await collect(model, secondRequest)
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.systemPrompt, planPrompt)
  assert.equal(runtime.sessions[0]?.isClosed(), true)
  assert.equal(runtime.closeCount, 1)
  const change = generationChange(second)
  assert.equal(change['reason'], 'configuration-change')
  assert.deepEqual(change['changedFields'], ['systemPrompt'])
  assert.equal(change['fromGenerationId'], '1')
  assert.equal(change['fromCliSessionId'], 'scripted-session')
  assert.equal(change['importedMessageCount'], 2)
  const importedInput = sessionInput(runtime, 1)
  assert.equal(importedInput.includes('Historical context for a new Claude session.'), true)
  assert.equal(importedInput.includes('"hello"'), true)
  assert.equal(importedInput.includes('"plain answer"'), true)
  assert.equal(importedInput.includes('next'), true)

  const thirdRequest: GenerateOptions = {
    ...textRequest('again', 'plan-mode'),
    system: basePrompt,
    messages: [
      ...secondRequest.messages,
      assistantMessage(second, 'assistant-2'),
      userMessage('again'),
    ] as unknown as GenerateOptions['messages'],
  }
  const third = await collect(model, thirdRequest)
  assert.equal(third.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 3)
  assert.equal(runtime.starts[2]?.systemPrompt, basePrompt)
  const backChange = generationChange(third)
  assert.equal(backChange['reason'], 'configuration-change')
  assert.deepEqual(backChange['changedFields'], ['systemPrompt'])
  assert.equal(backChange['fromGenerationId'], '2')

  const fourthRequest: GenerateOptions = {
    ...textRequest('continued', 'plan-mode'),
    system: basePrompt,
    messages: [
      ...thirdRequest.messages,
      assistantMessage(third, 'assistant-3'),
      userMessage('continued'),
    ] as unknown as GenerateOptions['messages'],
  }
  const fourth = await collect(model, fourthRequest)
  assert.equal(fourth.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 3)
  assert.equal(runtime.sessions[2]?.inputs.length, 2)
  assert.equal(sessionInput(runtime, 2, 1), 'continued')
  assert.equal(replayResponse(fourth)['generationChange'], undefined)
})

test('a tool addition starts a new generation with the complete tool list', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('plain answer', 'm1'))
  runtime.enqueue(toolEvents(['call-add']))
  runtime.enqueue(textTurn('tool result answer', 'm3'))
  runtime.enqueue(textTurn('later', 'm4'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })

  const firstRequest = textRequest('hello', 'tool-add')
  const first = await collect(model, firstRequest)
  assert.equal(first.at(-1)?.type, 'finish')

  const secondRequest: GenerateOptions = {
    ...textRequest('use a tool', 'tool-add'),
    tools: ECHO_TOOL,
    messages: [
      ...firstRequest.messages,
      assistantMessage(first, 'assistant-1'),
      userMessage('use a tool'),
    ] as unknown as GenerateOptions['messages'],
  }
  const second = await collect(model, secondRequest)
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.deepEqual(runtime.starts[1]?.launch?.mcpToolNames, ['dsh__echo'])
  assert.deepEqual(runtime.starts[1]?.launch?.allowedToolNames, ['mcp__dsh__dsh__echo'])
  const change = generationChange(second)
  assert.equal(change['reason'], 'configuration-change')
  assert.deepEqual(change['changedFields'], ['tools'])
  assert.equal(sessionInput(runtime, 1).includes('Historical context'), true)

  const secondFinish = second.at(-1)
  if (secondFinish?.type === 'finish') assert.equal(secondFinish.reason.kind, 'tool-calls')
  const thirdRequest: GenerateOptions = {
    ...secondRequest,
    messages: [
      ...secondRequest.messages,
      assistantMessage(second, 'assistant-2'),
      toolMessage('call-add', 'tool-token'),
    ] as unknown as GenerateOptions['messages'],
  }
  const third = await collect(model, thirdRequest)
  assert.equal(third.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)

  const fourthRequest: GenerateOptions = {
    ...thirdRequest,
    messages: [
      ...thirdRequest.messages,
      assistantMessage(third, 'assistant-3'),
      userMessage('later'),
    ] as unknown as GenerateOptions['messages'],
  }
  const fourth = await collect(model, fourthRequest)
  assert.equal(fourth.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(replayResponse(fourth)['generationChange'], undefined)
})

test('a tool removal starts a new generation with the reduced tool list', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('plain answer', 'm1'))
  runtime.enqueue(textTurn('reduced answer', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const firstRequest: GenerateOptions = { ...textRequest('hello', 'tool-remove'), tools: ECHO_TOOL }
  const first = await collect(model, firstRequest)
  assert.equal(first.at(-1)?.type, 'finish')
  assert.deepEqual(runtime.starts[0]?.launch?.mcpToolNames, ['dsh__echo'])
  const secondRequest: GenerateOptions = {
    ...textRequest('no tools', 'tool-remove'),
    messages: [
      ...firstRequest.messages,
      assistantMessage(first, 'assistant-1'),
      userMessage('no tools'),
    ] as unknown as GenerateOptions['messages'],
  }
  const second = await collect(model, secondRequest)
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.deepEqual(runtime.starts[1]?.launch?.mcpToolNames, [])
  const change = generationChange(second)
  assert.equal(change['reason'], 'configuration-change')
  assert.deepEqual(change['changedFields'], ['tools'])
})

test('a model change starts a new generation with the new model', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('haiku answer', 'm1'))
  runtime.enqueue(textTurn('sonnet answer', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const firstRequest = textRequest('hello', 'model-change')
  const first = await collect(model, firstRequest)
  assert.equal(first.at(-1)?.type, 'finish')
  const secondRequest: GenerateOptions = {
    ...textRequest('use the other model', 'model-change'),
    model: 'claude-sonnet-5',
    messages: [
      ...firstRequest.messages,
      assistantMessage(first, 'assistant-1'),
      userMessage('use the other model'),
    ] as unknown as GenerateOptions['messages'],
  }
  const second = await collect(model, secondRequest)
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.model, 'claude-sonnet-5')
  const change = generationChange(second)
  assert.equal(change['reason'], 'configuration-change')
  assert.deepEqual(change['changedFields'], ['model'])
})

test('an effort change starts a new generation with the new effort', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('low answer', 'm1'))
  runtime.enqueue(textTurn('max answer', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate(), catalog: EFFORT_CATALOG })
  const firstRequest: GenerateOptions = {
    ...textRequest('hello', 'effort-change'),
    reasoningEffort: 'low' as never,
  }
  const first = await collect(model, firstRequest)
  assert.equal(first.at(-1)?.type, 'finish')
  assert.equal(runtime.starts[0]?.launch?.effort, 'low')
  const secondRequest: GenerateOptions = {
    ...textRequest('raise the effort', 'effort-change'),
    reasoningEffort: 'max' as never,
    messages: [
      ...firstRequest.messages,
      assistantMessage(first, 'assistant-1'),
      userMessage('raise the effort'),
    ] as unknown as GenerateOptions['messages'],
  }
  const second = await collect(model, secondRequest)
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.launch?.effort, 'max')
  const change = generationChange(second)
  assert.deepEqual(change['changedFields'], ['reasoningEffort'])
})

test('output-cap and workspace changes start new generations', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('first', 'm1'))
  runtime.enqueue(textTurn('second', 'm2'))
  runtime.enqueue(textTurn('third', 'm3'))
  let workspace = ''
  const { model, workspace: initial } = makeAdapter({
    runtime,
    spendGate: gate(),
    workspace: { current: () => workspace },
  })
  workspace = initial
  const firstRequest: GenerateOptions = { ...textRequest('hello', 'cap-workspace'), maxTokens: 1_024 }
  const first = await collect(model, firstRequest)
  assert.equal(first.at(-1)?.type, 'finish')
  const secondRequest: GenerateOptions = {
    ...textRequest('more tokens', 'cap-workspace'),
    maxTokens: 2_048,
    messages: [
      ...firstRequest.messages,
      assistantMessage(first, 'assistant-1'),
      userMessage('more tokens'),
    ] as unknown as GenerateOptions['messages'],
  }
  const second = await collect(model, secondRequest)
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.launch?.maxOutputTokens, 2_048)
  assert.equal(runtime.starts[1]?.launch?.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], '2048')
  assert.deepEqual(generationChange(second)['changedFields'], ['maxTokens'])

  workspace = `${initial}-other`
  const thirdRequest: GenerateOptions = {
    ...textRequest('new workspace', 'cap-workspace'),
    maxTokens: 2_048,
    messages: [
      ...secondRequest.messages,
      assistantMessage(second, 'assistant-2'),
      userMessage('new workspace'),
    ] as unknown as GenerateOptions['messages'],
  }
  const third = await collect(model, thirdRequest)
  assert.equal(third.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 3)
  assert.equal(runtime.starts[2]?.workspace, `${initial}-other`)
  assert.deepEqual(generationChange(third)['changedFields'], ['workspace'])
})

test('several changed fields are recorded in a stable order', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('first', 'm1'))
  runtime.enqueue(textTurn('second', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const firstRequest = textRequest('hello', 'many-fields')
  const first = await collect(model, firstRequest)
  assert.equal(first.at(-1)?.type, 'finish')
  const secondRequest: GenerateOptions = {
    ...textRequest('many changes', 'many-fields'),
    model: 'claude-sonnet-5',
    maxTokens: 4_096,
    system: 'New prompt.',
    tools: ECHO_TOOL,
    messages: [
      ...firstRequest.messages,
      assistantMessage(first, 'assistant-1'),
      userMessage('many changes'),
    ] as unknown as GenerateOptions['messages'],
  }
  const second = await collect(model, secondRequest)
  assert.equal(second.at(-1)?.type, 'finish')
  assert.deepEqual(generationChange(second)['changedFields'], ['model', 'maxTokens', 'systemPrompt', 'tools'])
  assert.equal(runtime.starts[1]?.model, 'claude-sonnet-5')
  assert.equal(runtime.starts[1]?.systemPrompt, 'New prompt.')
  assert.deepEqual(runtime.starts[1]?.launch?.mcpToolNames, ['dsh__echo'])
})

test('a prompt change during a tool wait imports the completed outcomes', async () => {
  const runtime = new ScriptedNativeRuntime()
  let delivered = false
  runtime.enqueue({
    ...toolEvents(['call-wait']),
    invokeHandlers: async (call) => {
      await call('call-wait')
      delivered = true
    },
  })
  runtime.enqueue(textTurn('finished after change', 'm2'))
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    deadlines: { ...DEFAULT_DEADLINES, resultWaitMs: 60_000 },
  })
  const firstRequest: GenerateOptions = {
    ...textRequest('use a tool', 'tool-wait-change'),
    tools: ECHO_TOOL,
    system: 'First prompt.',
  }
  const first = await collect(model, firstRequest)
  assert.equal(first.at(-1)?.type, 'finish')
  await tick()
  assert.equal(delivered, false)

  const secondRequest: GenerateOptions = {
    ...textRequest('use a tool', 'tool-wait-change'),
    tools: ECHO_TOOL,
    system: 'Second prompt.',
    messages: [
      ...firstRequest.messages,
      assistantMessage(first, 'assistant-1'),
      toolMessage('call-wait', 'park-token'),
    ] as unknown as GenerateOptions['messages'],
  }
  const second = await collect(model, secondRequest)
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(delivered, false)
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.systemPrompt, 'Second prompt.')
  const change = generationChange(second)
  assert.equal(change['reason'], 'configuration-change')
  assert.deepEqual(change['changedFields'], ['systemPrompt'])
  const importedInput = sessionInput(runtime, 1)
  assert.equal(importedInput.includes('Tool outcome (completed)'), true)
  assert.equal(importedInput.includes('park-token'), true)
  assert.equal(importedInput.includes('no live tool calls'), true)
})

test('a changed earlier prefix with a configuration change starts one new generation', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer', 'm1'))
  runtime.enqueue(textTurn('recovered', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const firstRequest: GenerateOptions = { ...textRequest('hello', 'edit-change'), system: 'First prompt.' }
  const first = await collect(model, firstRequest)
  assert.equal(first.at(-1)?.type, 'finish')
  const changed: GenerateOptions = {
    ...textRequest('hello', 'edit-change'),
    system: 'Second prompt.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'edited hello' }] },
      assistantMessage(first, 'assistant-1'),
      userMessage('next'),
    ] as unknown as GenerateOptions['messages'],
  }
  const second = await collect(model, changed)
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.systemPrompt, 'Second prompt.')
  const change = generationChange(second)
  assert.equal(change['reason'], 'history-change')
  assert.deepEqual(change['changedFields'], ['systemPrompt'])
  assert.equal(sessionInput(runtime, 1).includes('"edited hello"'), true)
})
