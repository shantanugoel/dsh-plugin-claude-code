import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import {
  LlmRuntime,
  fileHandleText,
  requestImageHandleText,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'

import { interpretAuthStatus } from '../src/auth.js'
import { claudeImageTarget } from '../src/images.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { CLAUDE_CODE_SESSION_ROUTE } from '../src/route.js'
import { textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import {
  FakeImageAttachments,
  SYNTHETIC_AUTH_STATUS,
  SYNTHETIC_PNG_BYTES,
  makeAdapter,
  syntheticImage,
} from './support.js'

const NOW = new Date('2026-11-10T00:00:00.000Z')
const MODEL = 'claude-haiku-5-5'
const ROUTE = CLAUDE_CODE_SESSION_ROUTE

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

async function mount(runtime: ScriptedNativeRuntime, attachments?: () => FakeImageAttachments): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const { model } = makeAdapter({
    runtime,
    spendGate: gate(),
    ...(attachments === undefined ? {} : { attachments }),
  })
  ctx.llm.registerAdapter([ROUTE], model)
  return ctx
}

async function collect(ctx: Context, request: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
  return chunks
}

test('the real dsh runtime projects a file attachment before adapter dispatch', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('ok'))
  const ctx = await mount(runtime)
  const file: FileAttachmentRef = {
    attachmentId: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as FileAttachmentRef['attachmentId'],
    name: 'notes.txt',
    bytes: 5,
  }
  const request: GenerateOptions = {
    provider: ROUTE,
    model: MODEL,
    sessionId: 'runtime-file' as never,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Read this attachment.' },
        { type: 'file', attachment: file },
      ],
    }] as GenerateOptions['messages'],
  }
  const chunks = await collect(ctx, request)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  const handle = fileHandleText(file, undefined)
  assert.deepEqual(runtime.inputs[0]?.content, [
    { type: 'text', text: 'Read this attachment.' },
    { type: 'text', text: handle },
  ])
})

test('the real dsh runtime forwards an image block to the image-capable route', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('seen'))
  const attachments = new FakeImageAttachments()
  const ctx = await mount(runtime, () => attachments)
  const image = syntheticImage('sha256:9999999999999999999999999999999999999999999999999999999999999999', {
    width: 2000,
    height: 2000,
  })
  const request: GenerateOptions = {
    provider: ROUTE,
    model: MODEL,
    sessionId: 'runtime-image' as never,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe the picture.' },
        { type: 'image', attachment: image },
      ],
    }] as GenerateOptions['messages'],
  }
  const chunks = await collect(ctx, request)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(attachments.requests.length, 1)
  const target = claudeImageTarget(image)
  assert.deepEqual(attachments.requests[0]?.target, target)
  assert.deepEqual(runtime.inputs[0]?.content, [
    { type: 'text', text: 'Describe the picture.' },
    { type: 'text', text: requestImageHandleText(image, target, undefined) },
    { type: 'image', mediaType: 'image/png', data: SYNTHETIC_PNG_BYTES.toString('base64') },
  ])
})

test('the real dsh runtime reports the route image target and price', async () => {
  const runtime = new ScriptedNativeRuntime()
  const ctx = await mount(runtime)
  const image = syntheticImage('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    width: 800,
    height: 400,
  })
  const target = ctx.llm.imageRequestTarget(ROUTE, MODEL, image)
  assert.deepEqual(target, { width: 800, height: 400, maxBytes: 4 * 1024 * 1024 })
  const pricing = ctx.llm.imageRequestPricing(ROUTE, MODEL)
  assert.notEqual(pricing, undefined)
  const prices = pricing?.priceImages([{ type: 'image', attachment: image }]) ?? []
  assert.equal(prices.length, 1)
  assert.equal(prices[0]?.text, requestImageHandleText(image, target, undefined))
})
