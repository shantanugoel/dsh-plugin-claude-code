import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  LlmError,
  LlmRuntime,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import type { ClaudeCodeAdapter } from '../src/adapter.js'
import { interpretAuthStatus } from '../src/auth.js'
import { classifyNativeResult, type NativeFailure } from '../src/native-failure.js'
import { CLAUDE_CODE_SESSION_ROUTE } from '../src/route.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { SYNTHETIC_AUTH_STATUS, makeAdapter } from './support.js'

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

function adapterFor(runtime: ScriptedNativeRuntime): ClaudeCodeAdapter {
  return makeAdapter({ runtime, spendGate: gate() }).model
}

async function collect(
  model: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> },
  request: GenerateOptions,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of model.stream(request)) chunks.push(chunk)
  return chunks
}

async function mount(runtime: ScriptedNativeRuntime): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  ctx.llm.registerAdapter([ROUTE], model)
  return ctx
}

async function collectDsh(ctx: Context, request: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
  return chunks
}

function turnError(failure: NativeFailure) {
  return { events: [{ type: 'turn-error' as const, failure }] }
}

function finishOf(chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const finishes = chunks.filter((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
  assert.equal(finishes.length, 1)
  const finish = finishes[0]
  assert.ok(finish !== undefined)
  return finish
}

test('a max_tokens turn yields one max-tokens finish and no stop finish', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      { type: 'block-start', messageId: 'm1', index: 0, blockType: 'text' },
      { type: 'text-delta', messageId: 'm1', index: 0, text: 'a truncated answer' },
      { type: 'block-stop', messageId: 'm1', index: 0 },
      { type: 'usage', inputTokens: 6, outputTokens: 2 },
      { type: 'message-stop', messageId: 'm1', stopReason: 'max_tokens' },
    ],
  })
  const chunks = await collect(adapterFor(runtime), textRequest('hello', 'max-tokens-1'))
  const finish = finishOf(chunks)
  assert.deepEqual(finish.reason, { kind: 'max-tokens' })
  assert.equal(finish.replayState !== undefined, true)
  assert.equal(chunks.some((chunk) => chunk.type === 'finish' && chunk.reason.kind === 'stop'), false)
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  assert.deepEqual(assembler.finish, { kind: 'max-tokens' })
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'a truncated answer' }])
  assert.equal(assembler.replayState !== undefined, true)
  assert.equal(runtime.closeCount, 0)
})

test('a successful turn still yields a stop finish', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('done'))
  const chunks = await collect(adapterFor(runtime), textRequest('hello', 'stop-1'))
  const finish = finishOf(chunks)
  assert.deepEqual(finish.reason, { kind: 'stop' })
})

test('a turn-error event surfaces a thrown LlmError with the stable code', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(turnError({
    code: 'CONTEXT_WINDOW_EXCEEDED',
    message: 'The native session reported a context-window overflow.',
    status: 400,
  }))
  await assert.rejects(collect(adapterFor(runtime), textRequest('hello', 'native-error-1')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'CONTEXT_WINDOW_EXCEEDED')
    assert.equal(error.failure.status, 400)
    return true
  })
  assert.equal(runtime.closeCount, 1)
})

test('the real dsh runtime turns a native context overflow into a terminal error finish', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(turnError({
    code: 'CONTEXT_WINDOW_EXCEEDED',
    message: 'The native session reported a context-window overflow. Native detail: prompt is too long.',
    status: 400,
  }))
  const ctx = await mount(runtime)
  const chunks = await collectDsh(ctx, textRequest('hello', 'overflow-1'))
  const finish = finishOf(chunks)
  assert.equal(finish.reason.kind, 'error')
  if (finish.reason.kind !== 'error') return
  assert.equal(finish.reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(finish.reason.failure.status, 400)
  assert.equal(runtime.closeCount, 1)
})

test('an unknown native outcome keeps NATIVE_OUTCOME_UNKNOWN', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(turnError({
    code: 'NATIVE_OUTCOME_UNKNOWN',
    message: 'The native session reported an execution error. The inference outcome is unknown.',
  }))
  const ctx = await mount(runtime)
  const finish = finishOf(await collectDsh(ctx, textRequest('hello', 'unknown-1')))
  assert.equal(finish.reason.kind, 'error')
  if (finish.reason.kind !== 'error') return
  assert.equal(finish.reason.failure.code, 'NATIVE_OUTCOME_UNKNOWN')
})

test('a truncated turn that carries a tool call is refused', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({
    events: [
      { type: 'block-start', messageId: 'm1', index: 0, blockType: 'tool-call' },
      { type: 'tool-delta', messageId: 'm1', index: 0, id: 'call-1', name: 'echo', argumentsDelta: '{}' },
      { type: 'block-stop', messageId: 'm1', index: 0 },
      { type: 'usage', inputTokens: 4, outputTokens: 2 },
      { type: 'message-stop', messageId: 'm1', stopReason: 'max_tokens' },
    ],
  })
  const request: GenerateOptions = {
    ...textRequest('call the tool', 'max-tokens-tool-1'),
    tools: [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }],
  }
  await assert.rejects(collect(adapterFor(runtime), request), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'MALFORMED_RESPONSE')
    return true
  })
  assert.equal(runtime.closeCount, 1)
})

test('a native failure message carries no secret text to the dsh failure', async () => {
  const outcome = classifyNativeResult({
    subtype: 'error_during_execution',
    isError: true,
    errors: [
      'Authorization: Bearer sk-ant-api03-SECRETVALUE12345',
      'account_id: acct_9f8e7d6c5b4a3210',
      'contact user@example.com',
    ],
  })
  assert.equal(outcome.kind, 'failure')
  if (outcome.kind !== 'failure') return
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(turnError(outcome.failure))
  await assert.rejects(collect(adapterFor(runtime), textRequest('hello', 'leak-1')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    for (const secret of ['SECRETVALUE12345', 'sk-ant', 'acct_9f8e7d6c5b4a3210', 'user@example.com']) {
      assert.equal(error.message.includes(secret), false, `the failure leaked ${secret}`)
    }
    return true
  })
})
