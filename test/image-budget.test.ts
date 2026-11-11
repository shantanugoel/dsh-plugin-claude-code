import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { interpretAuthStatus } from '../src/auth.js'
import {
  clearRequestVersionBytesCache,
  IMAGE_REQUEST_MAX_IMAGES,
} from '../src/images.js'
import { parseReplayEnvelope } from '../src/replay.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { CLAUDE_CODE_SESSION_ROUTE } from '../src/route.js'
import { inputText, textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { FakeImageAttachments, SYNTHETIC_AUTH_STATUS, makeAdapter, syntheticImage } from './support.js'

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

function imageRef(index: number): ImageAttachmentRef {
  return syntheticImage(`sha256:${index.toString(16).padStart(64, '0')}`)
}

function userMessage(
  text: string,
  images: readonly ImageAttachmentRef[],
  offloadedCount = 0,
): GenerateOptions['messages'][number] {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map((attachment, index) => index < offloadedCount
        ? { type: 'image' as const, attachment, offloaded: true as const }
        : { type: 'image' as const, attachment }),
    ],
  } as GenerateOptions['messages'][number]
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
      provider: CLAUDE_CODE_SESSION_ROUTE,
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
  return parseReplayEnvelope(finish.replayState) as unknown as Record<string, unknown>
}

function generationChange(chunks: readonly StreamChunk[]): Record<string, unknown> {
  const change = replayResponse(chunks)['generationChange']
  if (typeof change !== 'object' || change === null) {
    throw new Error('The replay has no recorded generation change.')
  }
  return change as Record<string, unknown>
}

function sessionInput(runtime: ScriptedNativeRuntime, sessionIndex: number, inputIndex = 0) {
  const input = runtime.sessions[sessionIndex]?.inputs[inputIndex]
  if (input === undefined) throw new Error('The scripted session has no recorded input.')
  return input
}

function nativeImageCount(runtime: ScriptedNativeRuntime, sessionIndex: number, inputIndex = 0): number {
  return sessionInput(runtime, sessionIndex, inputIndex).content.filter((block) => block.type === 'image').length
}

test('a request above the image count budget fails before dispatch and a retry sends placeholders', async () => {
  clearRequestVersionBytesCache()
  const runtime = new ScriptedNativeRuntime()
  const attachments = new FakeImageAttachments()
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  const images = Array.from({ length: IMAGE_REQUEST_MAX_IMAGES + 1 }, (_value, index) => imageRef(index))
  const request: GenerateOptions = {
    ...textRequest('ignored', 'image-budget-count'),
    messages: [userMessage('describe the images', images)],
  }
  await assert.rejects(collect(model, request), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'IMAGE_OFFLOAD_REQUIRED')
    assert.equal(error.failure.offloadImages, 1)
    return true
  })
  assert.equal(runtime.starts.length, 0)
  // The count excess is exact without an attachment read.
  assert.equal(attachments.requests.length, 0)

  // dsh records one image/offload decision, then retries the same step.
  attachments.requests.length = 0
  runtime.enqueue(textTurn('description', 'm-after-offload'))
  const retry: GenerateOptions = {
    ...request,
    messages: [userMessage('describe the images', images, 1)],
  }
  const chunks = await collect(model, retry)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  assert.equal(attachments.requests.length, IMAGE_REQUEST_MAX_IMAGES)
  assert.equal(nativeImageCount(runtime, 0), IMAGE_REQUEST_MAX_IMAGES)
  const text = inputText(sessionInput(runtime, 0))
  assert.equal(text.includes('image omitted to fit request image limits'), true)
  assert.equal(text.includes(String(images[0]?.attachmentId)), true)
})

test('a request above the image byte budget names the byte-driven offload count', async () => {
  clearRequestVersionBytesCache()
  const runtime = new ScriptedNativeRuntime()
  const fiveMib = new Uint8Array(5 * 1024 * 1024)
  const attachments = new FakeImageAttachments(fiveMib)
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  const images = Array.from({ length: 4 }, (_value, index) => imageRef(100 + index))
  const request: GenerateOptions = {
    ...textRequest('ignored', 'image-budget-bytes'),
    messages: [userMessage('describe the images', images)],
  }
  await assert.rejects(collect(model, request), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'IMAGE_OFFLOAD_REQUIRED')
    // 4 x 5 MiB encoded is about 28 MiB. The 20 MiB budget needs 2 offloads.
    assert.equal(error.failure.offloadImages, 2)
    return true
  })
  assert.equal(runtime.starts.length, 0)
})

test('an over-budget request keeps the live generation usable for the offload retry', async () => {
  clearRequestVersionBytesCache()
  const runtime = new ScriptedNativeRuntime()
  const attachments = new FakeImageAttachments()
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  runtime.enqueue(textTurn('first answer', 'm1'))
  const first = await collect(model, {
    ...textRequest('hello', 'image-budget-retry'),
    messages: [userMessage('hello', [])],
  })
  assert.equal(first.at(-1)?.type, 'finish')

  const images = Array.from({ length: IMAGE_REQUEST_MAX_IMAGES + 1 }, (_value, index) => imageRef(index))
  const overBudget: GenerateOptions = {
    ...textRequest('ignored', 'image-budget-retry'),
    messages: [
      userMessage('hello', []),
      assistantMessage(first, 'assistant-1'),
      userMessage('look at these', images),
    ] as GenerateOptions['messages'],
  }
  await assert.rejects(collect(model, overBudget), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'IMAGE_OFFLOAD_REQUIRED')
    assert.equal(error.failure.offloadImages, 1)
    return true
  })
  assert.equal(runtime.starts.length, 1)
  assert.equal(runtime.closeCount, 0)

  runtime.enqueue(textTurn('after offload', 'm2'))
  const retry: GenerateOptions = {
    ...overBudget,
    messages: [
      userMessage('hello', []),
      assistantMessage(first, 'assistant-1'),
      userMessage('look at these', images, 1),
    ] as GenerateOptions['messages'],
  }
  const chunks = await collect(model, retry)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  assert.equal(runtime.sessions[0]?.inputs.length, 2)
})

test('the retained image threshold starts one recorded image-budget generation', async () => {
  clearRequestVersionBytesCache()
  const runtime = new ScriptedNativeRuntime()
  const attachments = new FakeImageAttachments()
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  runtime.enqueue(textTurn('first answer', 'm1'))
  const firstImages = Array.from({ length: 50 }, (_value, index) => imageRef(index))
  const firstMessages = [userMessage('first batch', firstImages)]
  const first = await collect(model, {
    ...textRequest('ignored', 'image-budget-rollover'),
    messages: firstMessages,
  })
  assert.equal(first.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)

  // The dsh session later offloads 30 old occurrences, then adds 50 images.
  // The dsh request fits its budget (70 retained), but the live generation
  // would hold 100 images, above the conservative 80-image threshold.
  const secondImages = Array.from({ length: 50 }, (_value, index) => imageRef(100 + index))
  const secondMessages = [
    userMessage('first batch', firstImages, 30),
    assistantMessage(first, 'assistant-1'),
    userMessage('second batch', secondImages),
  ] as GenerateOptions['messages']
  runtime.enqueue(textTurn('second answer', 'm2'))
  const second = await collect(model, {
    ...textRequest('ignored', 'image-budget-rollover'),
    messages: secondMessages,
  })
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.closeCount, 1)
  assert.equal(runtime.sessions[0]?.inputs.length, 1)

  const change = generationChange(second)
  assert.equal(change['reason'], 'image-budget')
  assert.equal(change['fromGenerationId'], '1')
  assert.equal(change['fromCliSessionId'], 'scripted-session')
  assert.equal(change['importedMessageCount'], 2)

  // The new generation gets one text import with placeholders plus the current
  // user content. No historical image byte reaches the new native session.
  const imported = inputText(sessionInput(runtime, 1))
  assert.equal(imported.includes('Historical context for a new Claude session.'), true)
  assert.equal(imported.includes('[Image attachment'), true)
  assert.equal(imported.includes('iVBORw0KGgo'), false)
  assert.equal(nativeImageCount(runtime, 1), 50)
  const firstBlock = runtime.sessions[1]?.inputs[0]?.content[0]
  assert.equal(firstBlock?.type, 'text')

  // The same dsh session continues on the new generation.
  runtime.enqueue(textTurn('third answer', 'm3'))
  const thirdMessages = [
    ...secondMessages,
    assistantMessage(second, 'assistant-2'),
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'third' }] },
  ] as GenerateOptions['messages']
  const third = await collect(model, {
    ...textRequest('ignored', 'image-budget-rollover'),
    messages: thirdMessages,
  })
  assert.equal(third.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.sessions[1]?.inputs.length, 2)
  assert.equal(replayResponse(third)['generationChange'], undefined)
})

test('an image-budget change on a tool-result continuation quotes the outcome', async () => {
  clearRequestVersionBytesCache()
  const runtime = new ScriptedNativeRuntime()
  const attachments = new FakeImageAttachments()
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  runtime.enqueue({
    events: [
      { type: 'block-start', messageId: 'm1', index: 0, blockType: 'tool-call' },
      { type: 'tool-delta', messageId: 'm1', index: 0, id: 'call-1', name: 'echo', argumentsDelta: '{"value":"one"}' },
      { type: 'block-stop', messageId: 'm1', index: 0 },
      { type: 'usage', inputTokens: 3, outputTokens: 2 },
      { type: 'message-stop', messageId: 'm1', stopReason: 'tool_use' },
    ],
  })
  const tools = [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }]
  const toolRequest: GenerateOptions = {
    ...textRequest('ignored', 'image-budget-tool'),
    tools,
    messages: [userMessage('do a tool', Array.from({ length: 50 }, (_value, index) => imageRef(index)))],
  }
  const first = await collect(model, toolRequest)
  const firstFinish = first.at(-1)
  assert.equal(firstFinish?.type, 'finish')
  if (firstFinish?.type !== 'finish') return
  assert.equal(firstFinish.reason.kind, 'tool-calls')
  assert.equal(runtime.starts.length, 1)

  // The tool result adds 40 images. The dsh request still fits its budget
  // after 20 old occurrences are offloaded, but the live generation would
  // hold 90 images, so the adapter starts one recorded generation.
  const toolResultImages = Array.from({ length: 40 }, (_value, index) => imageRef(100 + index))
  const messages = [
    userMessage('do a tool', Array.from({ length: 50 }, (_value, index) => imageRef(index)), 20),
    assistantMessage(first, 'assistant-1'),
    {
      role: 'tool',
      id: 'result-call-1',
      toolCallId: 'call-1',
      isError: false,
      content: [
        { type: 'text', text: 'screenshot attached' },
        ...toolResultImages.map((attachment) => ({ type: 'image' as const, attachment })),
      ],
      source: { kind: 'tool', callId: 'call-1' },
    },
  ] as GenerateOptions['messages']
  runtime.enqueue(textTurn('after rollover', 'm2'))
  const second = await collect(model, {
    ...textRequest('ignored', 'image-budget-tool'),
    tools,
    messages,
  })
  const secondFinish = second.at(-1)
  assert.equal(secondFinish?.type, 'finish')
  if (secondFinish?.type !== 'finish') return
  assert.equal(secondFinish.reason.kind, 'stop')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.closeCount, 1)
  const change = generationChange(second)
  assert.equal(change['reason'], 'image-budget')
  const imported = inputText(sessionInput(runtime, 1))
  assert.equal(imported.includes('Tool outcome (completed)'), true)
  assert.equal(imported.includes('screenshot attached'), true)
  assert.equal(imported.includes('iVBORw0KGgo'), false)
  assert.equal(nativeImageCount(runtime, 1), 0)
})

test('a turn below the retained image threshold keeps the same native generation', async () => {
  clearRequestVersionBytesCache()
  const runtime = new ScriptedNativeRuntime()
  const attachments = new FakeImageAttachments()
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  runtime.enqueue(textTurn('first answer', 'm1'))
  const firstImages = Array.from({ length: 40 }, (_value, index) => imageRef(index))
  const first = await collect(model, {
    ...textRequest('ignored', 'image-budget-under'),
    messages: [userMessage('first batch', firstImages)],
  })
  const secondImages = Array.from({ length: 40 }, (_value, index) => imageRef(100 + index))
  runtime.enqueue(textTurn('second answer', 'm2'))
  const second = await collect(model, {
    ...textRequest('ignored', 'image-budget-under'),
    messages: [
      userMessage('first batch', firstImages),
      assistantMessage(first, 'assistant-1'),
      userMessage('second batch', secondImages),
    ] as GenerateOptions['messages'],
  })
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  assert.equal(runtime.closeCount, 0)
  assert.equal(runtime.sessions[0]?.inputs.length, 2)
  assert.equal(nativeImageCount(runtime, 0, 1), 40)
})

test('the request image budget does not apply to a flat-text summary import', async () => {
  clearRequestVersionBytesCache()
  const runtime = new ScriptedNativeRuntime()
  const attachments = new FakeImageAttachments()
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  runtime.enqueue(textTurn('SUMMARY', 'm-summary'))
  const images = Array.from({ length: IMAGE_REQUEST_MAX_IMAGES + 1 }, (_value, index) => imageRef(index))
  const request: GenerateOptions = {
    ...textRequest('ignored', 'image-budget-summary'),
    purpose: 'compaction' as never,
    maxTokens: 1_024,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'System prompt.' }] },
      userMessage('many images earlier', images),
      { role: 'user', content: [{ type: 'text', text: 'Compact the conversation above.' }] },
    ] as GenerateOptions['messages'],
  }
  const chunks = await collect(model, request)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  assert.equal(attachments.requests.length, 0)
  assert.equal(nativeImageCount(runtime, 0), 0)
  assert.equal(inputText(sessionInput(runtime, 0)).includes('[image image/png 1x1'), true)
})
