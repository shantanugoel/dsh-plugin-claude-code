import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LlmError,
  offloadedImageText,
  requestImageHandleText,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import { CLAUDE_IMAGE_MAX_BYTES, claudeImageTarget, claudeImageTokens } from '../src/images.js'
import { projectCatalogModel } from '../src/catalog.js'
import { interpretAuthStatus } from '../src/auth.js'
import { DEFAULT_DEADLINES } from '../src/deadlines.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { CLAUDE_CODE_SESSION_ROUTE } from '../src/route.js'
import type { NativeToolResult } from '../src/sdk-runtime.js'
import { textRequest, textTurn, resultText } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import {
  FakeImageAttachments,
  SYNTHETIC_AUTH_STATUS,
  SYNTHETIC_PNG_BYTES,
  makeAdapter,
  syntheticImage,
} from './support.js'

const NOW = new Date('2026-11-10T00:00:00.000Z')
const ECHO_TOOL = [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }]
const MODEL = 'claude-haiku-5-5'
const BASE64_PNG = SYNTHETIC_PNG_BYTES.toString('base64')

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

function assistantMessage(chunks: readonly StreamChunk[], id = 'assistant-1') {
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

function imageRequest(image: ImageAttachmentRef, text = 'What is in this image?'): GenerateOptions {
  return {
    ...textRequest(text, 'image-session'),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Look closely.' },
        { type: 'image', attachment: image },
        { type: 'text', text },
      ],
    }] as GenerateOptions['messages'],
  }
}

test('the catalog and the resolved model declare text and image input', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const projected = projectCatalogModel(CLAUDE_CODE_SESSION_ROUTE, { value: MODEL, displayName: 'Haiku' })
  assert.deepEqual(projected.inputModalities, ['text', 'image'])
  const resolved = await model.resolveModel(CLAUDE_CODE_SESSION_ROUTE, MODEL)
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
})

test('a user image is sent as descriptor text and request image bytes', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('seen'))
  const attachments = new FakeImageAttachments()
  const image = syntheticImage('sha256:1111111111111111111111111111111111111111111111111111111111111111', {
    width: 3000,
    height: 1000,
    name: 'diagram.png',
  })
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    attachments: () => attachments,
  })
  const chunks = await collect(model, imageRequest(image))
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  const target = claudeImageTarget(image)
  assert.deepEqual(target, { width: 1568, height: 523, maxBytes: CLAUDE_IMAGE_MAX_BYTES })
  assert.equal(attachments.requests.length, 1)
  assert.deepEqual(attachments.requests[0]?.target, target)
  const input = runtime.inputs[0]
  assert.deepEqual(input?.content, [
    { type: 'text', text: 'Look closely.' },
    { type: 'text', text: requestImageHandleText(image, target, undefined) },
    { type: 'image', mediaType: 'image/png', data: BASE64_PNG },
    { type: 'text', text: 'What is in this image?' },
  ])
})

test('an offloaded image becomes placeholder text and reads no bytes', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('ok'))
  const attachments = new FakeImageAttachments()
  const image = syntheticImage('sha256:2222222222222222222222222222222222222222222222222222222222222222')
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  const request: GenerateOptions = {
    ...textRequest('handle it', 'offloaded-image'),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'See the upload.' },
        { type: 'image', attachment: image, offloaded: true as const },
      ],
    }] as GenerateOptions['messages'],
  }
  const chunks = await collect(model, request)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(attachments.requests.length, 0)
  assert.deepEqual(runtime.inputs[0]?.content, [
    { type: 'text', text: 'See the upload.' },
    { type: 'text', text: offloadedImageText(image, undefined) },
  ])
})

test('a missing attachment service refuses an image before native start', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  await assert.rejects(collect(model, imageRequest(syntheticImage())), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.equal(runtime.starts.length, 0)
})

test('images outside user and tool content are refused', async () => {
  const runtime = new ScriptedNativeRuntime()
  const attachments = new FakeImageAttachments()
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  const image = syntheticImage()
  const systemImage: GenerateOptions = {
    ...textRequest('x', 'system-image'),
    system: 'prompt',
    messages: [{
      role: 'system',
      content: [{ type: 'text', text: 'System.' }, { type: 'image', attachment: image }],
    }, {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    }] as GenerateOptions['messages'],
  }
  await assert.rejects(collect(model, systemImage), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  const assistantImage: GenerateOptions = {
    ...textRequest('x', 'assistant-image'),
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [{ type: 'image', attachment: image }],
        source: { kind: 'model', provider: CLAUDE_CODE_SESSION_ROUTE, model: MODEL },
      },
    ] as unknown as GenerateOptions['messages'],
  }
  await assert.rejects(collect(model, assistantImage), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.equal(runtime.starts.length, 0)
})

test('an image-bearing tool result is delivered with text and image content', async () => {
  const runtime = new ScriptedNativeRuntime()
  const attachments = new FakeImageAttachments()
  const image = syntheticImage('sha256:3333333333333333333333333333333333333333333333333333333333333333', {
    width: 640,
    height: 480,
  })
  let delivered: NativeToolResult | undefined
  let markDelivered: (() => void) | undefined
  const deliveredResult = new Promise<void>((resolve) => {
    markDelivered = resolve
  })
  runtime.enqueue({
    events: [
      { type: 'block-start', messageId: 'm1', index: 0, blockType: 'tool-call' },
      {
        type: 'tool-delta',
        messageId: 'm1',
        index: 0,
        id: 'call-1',
        name: 'echo',
        argumentsDelta: '{}',
      },
      { type: 'block-stop', messageId: 'm1', index: 0 },
      { type: 'usage', inputTokens: 2, outputTokens: 1 },
      { type: 'message-stop', messageId: 'm1', stopReason: 'tool_use' },
    ],
    invokeHandlers: async (call) => {
      delivered = await call('call-1')
      markDelivered?.()
    },
  })
  runtime.enqueue(textTurn('finished', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  const firstRequest: GenerateOptions = {
    ...textRequest('read the image', 'tool-image'),
    tools: ECHO_TOOL,
  }
  const first = await collect(model, firstRequest)
  assert.equal(first.at(-1)?.type, 'finish')
  const second = await collect(model, {
    ...firstRequest,
    messages: [
      ...firstRequest.messages,
      assistantMessage(first),
      {
        role: 'tool',
        id: 'result-call-1',
        toolCallId: 'call-1',
        isError: false,
        content: [
          { type: 'text', text: 'Captured 640x480 image.' },
          { type: 'image', attachment: image },
        ],
        source: { kind: 'tool', callId: 'call-1' },
      },
    ] as GenerateOptions['messages'],
  } as GenerateOptions)
  assert.equal(second.at(-1)?.type, 'finish')
  await deliveredResult
  const target = claudeImageTarget(image)
  assert.deepEqual(delivered?.content, [
    { type: 'text', text: 'Captured 640x480 image.' },
    { type: 'text', text: requestImageHandleText(image, target, undefined) },
    { type: 'image', mediaType: 'image/png', data: BASE64_PNG },
  ])
  assert.equal(resultText(delivered as NativeToolResult), `Captured 640x480 image.${requestImageHandleText(image, target, undefined)}[image image/png]`)
})

test('a later user image is sent on the same native session', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('first'))
  runtime.enqueue(textTurn('second', 'm2'))
  const attachments = new FakeImageAttachments()
  const firstImage = syntheticImage('sha256:4444444444444444444444444444444444444444444444444444444444444444')
  const secondImage = syntheticImage('sha256:5555555555555555555555555555555555555555555555555555555555555555')
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  const firstRequest = imageRequest(firstImage)
  const first = await collect(model, firstRequest)
  const second = await collect(model, {
    ...textRequest('and this one?', 'image-session'),
    messages: [
      ...firstRequest.messages,
      assistantMessage(first),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Another.' },
          { type: 'image', attachment: secondImage },
        ],
      },
    ] as GenerateOptions['messages'],
  })
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  assert.equal(runtime.sessions[0]?.inputs.length, 2)
  assert.deepEqual(runtime.sessions[0]?.inputs[1]?.content[0], { type: 'text', text: 'Another.' })
  assert.equal(runtime.sessions[0]?.inputs[1]?.content[1]?.type, 'text')
  const imageBlock = runtime.sessions[0]?.inputs[1]?.content[2]
  assert.equal(imageBlock?.type, 'image')
  if (imageBlock?.type === 'image') assert.equal(imageBlock.data, BASE64_PNG)
})

test('a changed earlier image starts one recorded new generation', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('first'))
  runtime.enqueue(textTurn('recovered', 'm2'))
  const attachments = new FakeImageAttachments()
  const firstImage = syntheticImage('sha256:6666666666666666666666666666666666666666666666666666666666666666')
  const otherImage = syntheticImage('sha256:7777777777777777777777777777777777777777777777777777777777777777')
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  const firstRequest = imageRequest(firstImage)
  const first = await collect(model, firstRequest)
  const changed: GenerateOptions = {
    ...textRequest('next', 'image-session'),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look closely.' },
          { type: 'image', attachment: otherImage },
          { type: 'text', text: 'What is in this image?' },
        ],
      },
      assistantMessage(first),
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ] as GenerateOptions['messages'],
  }
  const second = await collect(model, changed)
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.sessions[0]?.inputs.length, 1)
  // The import holds the changed image as a placeholder, not as image bytes.
  const content = runtime.sessions[1]?.inputs[0]?.content ?? []
  assert.equal(content.some((block) => block.type === 'image'), false)
  const imported = content[0]?.type === 'text' ? content[0].text : ''
  assert.equal(imported.includes(String(otherImage.attachmentId)), true)
  assert.equal(imported.includes(String(firstImage.attachmentId)), false)
})

test('the image target and pricing describe the exact request bytes', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const image = syntheticImage('sha256:8888888888888888888888888888888888888888888888888888888888888888', {
    width: 4000,
    height: 2000,
  })
  const target = model.imageRequestTarget(CLAUDE_CODE_SESSION_ROUTE, MODEL, image)
  assert.deepEqual(target, { width: 1568, height: 784, maxBytes: CLAUDE_IMAGE_MAX_BYTES })
  assert.equal(claudeImageTokens(target.width, target.height), Math.ceil((1568 * 784) / 750))
  const pricing = model.imageRequestPricing(CLAUDE_CODE_SESSION_ROUTE, MODEL)
  assert.notEqual(pricing, undefined)
  const prices = pricing?.priceImages([
    { type: 'image', attachment: image },
    { type: 'image', attachment: image, offloaded: true },
  ]) ?? []
  assert.equal(prices.length, 2)
  assert.equal(prices[0]?.visualTokens, claudeImageTokens(1568, 784))
  assert.equal(prices[0]?.text, requestImageHandleText(image, target, undefined))
  assert.equal(prices[1]?.visualTokens, 0)
  assert.equal(prices[1]?.text, offloadedImageText(image, undefined))
})

test('an invalid image attachment reference is refused before native start', async () => {
  const runtime = new ScriptedNativeRuntime()
  const attachments = new FakeImageAttachments()
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => attachments })
  const broken = {
    ...syntheticImage(),
    width: 0,
  } as ImageAttachmentRef
  await assert.rejects(collect(model, imageRequest(broken)), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.equal(runtime.starts.length, 0)
  assert.equal(attachments.requests.length, 0)
})

test('a tool result with an unsupported content block is refused', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      { type: 'block-start', messageId: 'm1', index: 0, blockType: 'tool-call' },
      { type: 'tool-delta', messageId: 'm1', index: 0, id: 'call-1', name: 'echo', argumentsDelta: '{}' },
      { type: 'block-stop', messageId: 'm1', index: 0 },
      { type: 'usage', inputTokens: 2, outputTokens: 1 },
      { type: 'message-stop', messageId: 'm1', stopReason: 'tool_use' },
    ],
  })
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => new FakeImageAttachments() })
  const firstRequest: GenerateOptions = { ...textRequest('go', 'bad-result'), tools: ECHO_TOOL }
  const first = await collect(model, firstRequest)
  const second: GenerateOptions = {
    ...firstRequest,
    messages: [
      ...firstRequest.messages,
      assistantMessage(first),
      {
        role: 'tool',
        id: 'result-call-1',
        toolCallId: 'call-1',
        isError: false,
        content: [{ type: 'reasoning', text: 'not a result block' }],
        source: { kind: 'tool', callId: 'call-1' },
      },
    ] as GenerateOptions['messages'],
  }
  await assert.rejects(collect(model, second), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
})

test('the deadlined generation budget is unchanged by image preparation', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('ok'))
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    attachments: () => new FakeImageAttachments(),
    deadlines: { ...DEFAULT_DEADLINES, generationMs: 50 },
  })
  const chunks = await collect(model, imageRequest(syntheticImage()))
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('a scripted image turn still stores replay data', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer'))
  const { model } = makeAdapter({ runtime, spendGate: gate(), attachments: () => new FakeImageAttachments() })
  const chunks = await collect(model, imageRequest(syntheticImage()))
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  assert.equal(finish.reason.kind, 'stop')
  assert.notEqual(finish.replayState, undefined)
})

