import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { interpretAuthStatus } from '../src/auth.js'
import { parseReplayEnvelope } from '../src/replay.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { CLAUDE_CODE_SESSION_ROUTE } from '../src/route.js'
import { inputText, textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { SYNTHETIC_AUTH_STATUS, makeAdapter, syntheticImage } from './support.js'

const NOW = new Date('2026-11-10T00:00:00.000Z')
const MODEL = 'claude-haiku-5-5'
const SIGNATURE = 'sig-history-only'
const THINKING = 'hidden reasoning'
const COMPACTION_INSTRUCTION = 'Compact the conversation above into a checkpoint.'

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

function titleRequest(maxTokens = 64): GenerateOptions {
  return {
    ...textRequest('Name this session.', 'title-session'),
    purpose: 'session-title' as never,
    system: 'You write short session titles.',
    maxTokens,
  }
}

function assistantMessage(chunks: readonly StreamChunk[]) {
  const finish = chunks.at(-1)
  const replayState = finish?.type === 'finish' ? finish.replayState : undefined
  return {
    role: 'assistant' as const,
    id: 'assistant-1',
    content: chunks.flatMap((chunk) => chunk.type === 'block-end' ? [chunk.block] : []),
    source: {
      kind: 'model' as const,
      provider: CLAUDE_CODE_SESSION_ROUTE,
      model: MODEL,
      ...(replayState === undefined ? {} : { replayState }),
    },
  }
}

test('a session-title call sends its prompt on an isolated session and closes it', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('A title', 'm-title'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const chunks = await collect(model, titleRequest(64))
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 1)
  const start = runtime.starts[0]
  assert.equal(start?.launch?.maxOutputTokens, 64)
  assert.equal(start?.launch?.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], '64')
  assert.equal(start?.launch?.systemPrompt.prompt, 'You write short session titles.')
  assert.equal(runtime.inputs.length, 1)
  assert.deepEqual(runtime.inputs[0]?.content, [{ type: 'text', text: 'Name this session.' }])
  assert.equal(runtime.closeCount, 1)
})

test('a conversation request maps maxTokens to the documented output cap', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('ok'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const request = { ...textRequest('hello', 'output-cap'), maxTokens: 1_024 }
  const chunks = await collect(model, request)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts[0]?.launch?.maxOutputTokens, 1_024)
  assert.equal(runtime.starts[0]?.launch?.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], '1024')
})

test('a changed output cap starts a new generation with the recorded change', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('first'))
  runtime.enqueue(textTurn('second', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const firstRequest = { ...textRequest('hello', 'output-change'), maxTokens: 1_024 }
  const first = await collect(model, firstRequest)
  const second: GenerateOptions = {
    ...firstRequest,
    maxTokens: 2_048,
    messages: [
      ...firstRequest.messages,
      assistantMessage(first),
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ] as GenerateOptions['messages'],
  }
  const chunks = await collect(model, second)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.starts[1]?.launch?.maxOutputTokens, 2_048)
  const finish = chunks.at(-1)
  const response = finish?.type === 'finish' ? finish.replayState?.response : undefined
  const change = typeof response === 'object' && response !== null
    ? (response as Record<string, unknown>)['generationChange'] as Record<string, unknown> | undefined
    : undefined
  assert.equal(change?.['reason'], 'configuration-change')
  assert.deepEqual(change?.['changedFields'], ['maxTokens'])
})

test('an invalid output cap is refused before native start', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  await assert.rejects(collect(model, {
    ...textRequest('hello', 'bad-cap'),
    maxTokens: 0,
  }), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.equal(runtime.starts.length, 0)
})

test('an auxiliary request with history and no summary purpose is refused clearly', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const request: GenerateOptions = {
    ...textRequest('Name this session.', 'unmapped-session'),
    purpose: 'session-title' as never,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
      assistantMessage([]),
      { role: 'user', content: [{ type: 'text', text: 'Name this session.' }] },
    ] as GenerateOptions['messages'],
  }
  await assert.rejects(collect(model, request), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    assert.equal(error.message.includes('recorded import'), true)
    return true
  })
  assert.equal(runtime.starts.length, 0)
})

test('a compaction request must end with one text instruction', async () => {
  const runtime = new ScriptedNativeRuntime()
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const base: GenerateOptions = {
    ...textRequest('unused', 'bad-compaction'),
    purpose: 'compaction' as never,
  }
  const cases: GenerateOptions['messages'][] = [
    // The last message is not the instruction.
    [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'reply' }] },
    ] as GenerateOptions['messages'],
    // The instruction has no text.
    [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'text', text: '   ' }] },
    ] as GenerateOptions['messages'],
    // The instruction is not text.
    [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'image', attachment: syntheticImage() }] },
    ] as GenerateOptions['messages'],
  ]
  for (const messages of cases) {
    await assert.rejects(collect(model, { ...base, messages }), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'UNSUPPORTED_INPUT')
      return true
    })
  }
  assert.equal(runtime.starts.length, 0)
})

test('a compaction auxiliary call sends one flattened textual import to a fresh session', async () => {
  const runtime = new ScriptedNativeRuntime()
  // The auxiliary turn carries accepted-looking request evidence. The replay
  // envelope must still report an unavailable audit: the import is not signed.
  runtime.enqueue({
    events: [
      {
        type: 'request-evidence',
        record: { status: 'complete', redacted: false, truncated: false, body: { messages: [{}] } },
      },
      ...textTurn('SUMMARY', 'm-summary').events,
    ],
  })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const historyAssistant = {
    role: 'assistant' as const,
    id: 'assistant-history',
    content: [
      { type: 'reasoning', text: THINKING },
      { type: 'text', text: 'I will check the file.' },
      { type: 'tool-call', id: 'call-hist-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ],
    source: {
      kind: 'model' as const,
      provider: CLAUDE_CODE_SESSION_ROUTE,
      model: MODEL,
      replayState: { response: { signature: SIGNATURE } },
    },
  }
  const request: GenerateOptions = {
    ...textRequest('unused', 'compaction-flatten'),
    purpose: 'compaction' as never,
    maxTokens: 4_096,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'System prompt.' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Earlier question.' },
          { type: 'image', attachment: syntheticImage() },
        ],
      },
      historyAssistant,
      {
        role: 'tool',
        id: 'result-hist-1',
        toolCallId: 'call-hist-1',
        isError: false,
        content: [{ type: 'text', text: 'file content' }],
        source: { kind: 'tool', callId: 'call-hist-1' },
      },
      { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
    ] as GenerateOptions['messages'],
  }
  const chunks = await collect(model, request)
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  assert.equal(finish.reason.kind, 'stop')

  // One fresh native session with the conversation prompt and no dsh tools.
  assert.equal(runtime.starts.length, 1)
  assert.equal(runtime.starts[0]?.model, MODEL)
  assert.equal(runtime.starts[0]?.systemPrompt, 'System prompt.')
  assert.equal(runtime.starts[0]?.launch?.maxOutputTokens, 4_096)
  assert.equal(runtime.starts[0]?.launch?.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], '4096')
  assert.deepEqual(runtime.starts[0]?.launch?.mcpTools, [])
  assert.equal(runtime.closeCount, 1)

  // The import is text only and keeps the instruction last.
  assert.equal(runtime.inputs.length, 1)
  const input = runtime.inputs[0]
  assert.ok(input !== undefined)
  assert.equal(input.content.length, 1)
  assert.equal(input.content[0]?.type, 'text')
  const imported = inputText(input)
  assert.equal(imported.includes('Earlier question.'), true)
  assert.equal(imported.includes('[user]'), true)
  assert.equal(imported.includes('[assistant]'), true)
  assert.equal(imported.includes('I will check the file.'), true)
  assert.equal(imported.includes('[tool-call read_file]'), true)
  assert.equal(imported.includes('file content'), true)
  assert.equal(imported.includes('[tool result]'), true)
  assert.equal(imported.includes('[image image/png 1x1'), true)
  // Signed thinking, signature text, tool-call ids, and image bytes stay out.
  assert.equal(imported.includes(THINKING), false)
  assert.equal(imported.includes(SIGNATURE), false)
  assert.equal(imported.includes('call-hist-1'), false)
  assert.equal(imported.includes('iVBOR'), false)
  assert.equal(imported.startsWith('This is a recorded textual import'), true)
  assert.equal(imported.endsWith(COMPACTION_INSTRUCTION), true)

  // A textual import is never a signed-prefix retention audit.
  const replay = parseReplayEnvelope(finish.replayState)
  assert.equal(replay.retentionAudit, 'unavailable')
  assert.equal(replay.nativeRequestRecord, null)
  assert.equal(replay.generationId, 'aux')
})

test('a compaction auxiliary call leaves the live conversation session untouched', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer'))
  runtime.enqueue(textTurn('SUMMARY', 'm-summary'))
  runtime.enqueue(textTurn('second', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const conversation: GenerateOptions = { ...textRequest('hello', 'live-session'), system: 'System prompt.' }
  const first = await collect(model, conversation)
  assert.equal(first.at(-1)?.type, 'finish')

  const compaction: GenerateOptions = {
    ...textRequest(COMPACTION_INSTRUCTION, 'live-session'),
    purpose: 'compaction' as never,
    maxTokens: 2_048,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'System prompt.' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      assistantMessage(first),
      { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
    ] as GenerateOptions['messages'],
  }
  const summary = await collect(model, compaction)
  assert.equal(summary.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.deepEqual(runtime.sessions[0]?.inputs.map(inputText), ['hello'])
  assert.equal(runtime.sessions[1]?.inputs.length, 1)
  const summaryInput = runtime.sessions[1]?.inputs[0]
  assert.ok(summaryInput !== undefined)
  assert.equal(inputText(summaryInput).includes('answer'), true)
  assert.equal(inputText(summaryInput).includes(COMPACTION_INSTRUCTION), true)

  // The next conversation request continues the original native session.
  const continuation: GenerateOptions = {
    ...conversation,
    messages: [
      ...conversation.messages,
      assistantMessage(first),
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ] as GenerateOptions['messages'],
  }
  const next = await collect(model, continuation)
  assert.equal(next.at(-1)?.type, 'finish')
  assert.equal(runtime.starts.length, 2)
  assert.deepEqual(runtime.sessions[0]?.inputs.map(inputText), ['hello', 'again'])
})

test('a title call still requires the spend check first', async () => {
  const runtime = new ScriptedNativeRuntime()
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const { model } = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate({ ...proof(accepted.identityBinding), scope: 'other-scope' }, NOW),
  })
  await assert.rejects(collect(model, titleRequest()), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'BILLING_GUARD_UNAVAILABLE')
    return true
  })
  assert.equal(runtime.starts.length, 0)
})
