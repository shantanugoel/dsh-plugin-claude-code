import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { interpretAuthStatus } from '../src/auth.js'
import { parseReplay } from '../src/replay.js'
import type { NativeEvent, NativeToolResult } from '../src/sdk-runtime.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import {
  MAX_UNKNOWN_TOOL_NAMES,
  sanitizeUnknownToolName,
  translateTurn,
  type TranslateInput,
} from '../src/stream.js'
import { inputText, resultText, textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { SYNTHETIC_AUTH_STATUS, makeAdapter } from './support.js'

const NOW = new Date('2026-11-10T00:00:00.000Z')
const ECHO_TOOL = [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }]
const NO_SUCH_TOOL = 'unknown tool bash: only echo is callable directly'

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

async function collect(model: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }, request: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of model.stream(request)) chunks.push(chunk)
  return chunks
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
      model: 'claude-haiku-5-5',
      ...(replayState === undefined ? {} : { replayState }),
    },
  }
}

function toolMessage(callId: string, text: string, isError = false) {
  return {
    role: 'tool' as const,
    id: 'result-' + callId,
    toolCallId: callId,
    isError,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'tool' as const, callId },
  }
}

function request(sessionId: string, messages: readonly unknown[]): GenerateOptions {
  return {
    ...textRequest('hello', sessionId),
    tools: ECHO_TOOL,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ...messages,
    ] as GenerateOptions['messages'],
  }
}

function toolBlock(messageId: string, index: number, id: string, name: string, argumentsText = '{"command":"pwd"}'): NativeEvent {
  return { type: 'block-snapshot', messageId, index, blockType: 'tool-call', id, name, argumentsText }
}

function callTurn(messageId: string, blocks: readonly NativeEvent[], stopReason: 'tool_use' | 'end_turn' = 'tool_use'): { events: NativeEvent[] } {
  return {
    events: [
      ...blocks,
      { type: 'usage', inputTokens: 3, outputTokens: 2 },
      { type: 'message-stop', messageId, stopReason },
    ],
  }
}

function toolCalls(chunks: readonly StreamChunk[]): { id: string; name: string; arguments: string }[] {
  return chunks.flatMap((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call'
    ? [{ id: String(chunk.block.id), name: chunk.block.name, arguments: chunk.block.arguments }]
    : [])
}

function replayResponse(chunks: readonly StreamChunk[]): Record<string, unknown> {
  const finish = chunks.at(-1)
  if (finish?.type !== 'finish' || finish.replayState === undefined) {
    throw new Error('The finish chunk has no replay envelope.')
  }
  return finish.replayState.response as Record<string, unknown>
}

function text(chunks: readonly StreamChunk[]): string {
  return chunks.map((chunk) => chunk.type === 'text-delta' ? chunk.text : '').join('')
}

const TRANSLATE_INPUT: TranslateInput = {
  nativeToDsh: new Map([['dsh__echo', 'echo']]),
  dshNames: new Set(['echo']),
  allowedNativeTools: new Set(['mcp__dsh__dsh__echo']),
}

test('a call to a tool outside the dsh list is published and the turn continues', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(callTurn('m1', [toolBlock('m1', 0, 'call-bash', 'bash')]))
  runtime.enqueue(textTurn('recovered', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, request('unknown-1', []))
  assert.deepEqual(toolCalls(first), [{ id: 'call-bash', name: 'bash', arguments: '{"command":"pwd"}' }])
  const finish = first.at(-1)
  assert.deepEqual(finish?.type === 'finish' ? finish.reason : undefined, { kind: 'tool-calls' })
  assert.deepEqual(replayResponse(first)['unknownToolNames'], ['bash'])
  // dsh records its own error result for the call. The native session has no
  // handler for it, so the result is not delivered natively.
  const second = await collect(model, request('unknown-1', [
    assistantMessage(first, 'assistant-1'),
    toolMessage('call-bash', NO_SUCH_TOOL, true),
  ]))
  assert.equal(text(second), 'recovered')
  assert.equal(replayResponse(second)['unknownToolNames'], undefined)
  assert.equal(runtime.starts.length, 1)
  assert.equal(runtime.closeCount, 0)
})

test('a handler of the next turn stays parked across an unknown-tool turn', async () => {
  const runtime = new ScriptedNativeRuntime()
  let delivered: Promise<NativeToolResult> | undefined
  // The CLI answers the unknown call itself and sends the next request. The
  // handler of that next response can arrive before dsh returns its result.
  runtime.enqueue({
    ...callTurn('m1', [toolBlock('m1', 0, 'call-bash', 'bash')]),
    invokeHandlers: async (call) => {
      delivered = call('call-echo')
      await delivered
    },
  })
  runtime.enqueue(callTurn('m2', [toolBlock('m2', 0, 'call-echo', 'dsh__echo', '{"value":"one"}')]))
  runtime.enqueue(textTurn('done', 'm3'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, request('unknown-2', []))
  const second = await collect(model, request('unknown-2', [
    assistantMessage(first, 'assistant-1'),
    toolMessage('call-bash', NO_SUCH_TOOL, true),
  ]))
  assert.deepEqual(toolCalls(second), [{ id: 'call-echo', name: 'echo', arguments: '{"value":"one"}' }])
  const third = await collect(model, request('unknown-2', [
    assistantMessage(first, 'assistant-1'),
    toolMessage('call-bash', NO_SUCH_TOOL, true),
    assistantMessage(second, 'assistant-2'),
    toolMessage('call-echo', 'echo-result'),
  ]))
  assert.equal(text(third), 'done')
  assert.ok(delivered !== undefined)
  assert.equal(resultText(await delivered), 'echo-result')
  assert.equal(runtime.starts.length, 1)
})

test('one response with a dsh tool and an unknown tool publishes both in model order', async () => {
  const runtime = new ScriptedNativeRuntime()
  let delivered: Promise<NativeToolResult> | undefined
  runtime.enqueue({
    ...callTurn('m1', [
      toolBlock('m1', 0, 'call-echo', 'mcp__dsh__dsh__echo', '{"value":"one"}'),
      toolBlock('m1', 1, 'call-bash', 'bash'),
    ]),
    invokeHandlers: async (call) => {
      delivered = call('call-echo')
      await delivered
    },
  })
  runtime.enqueue(textTurn('done', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, request('unknown-3', []))
  assert.deepEqual(toolCalls(first).map((call) => [call.id, call.name]), [['call-echo', 'echo'], ['call-bash', 'bash']])
  assert.deepEqual(replayResponse(first)['unknownToolNames'], ['bash'])
  const second = await collect(model, request('unknown-3', [
    assistantMessage(first, 'assistant-1'),
    toolMessage('call-echo', 'echo-result'),
    toolMessage('call-bash', NO_SUCH_TOOL, true),
  ]))
  assert.equal(text(second), 'done')
  assert.ok(delivered !== undefined)
  assert.equal(resultText(await delivered), 'echo-result')
  assert.equal(runtime.starts.length, 1)
})

test('a user message after an all-unknown result batch starts a recorded new generation', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(callTurn('m1', [toolBlock('m1', 0, 'call-bash', 'bash')]))
  runtime.enqueue(textTurn('after reminder', 'm2'))
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const first = await collect(model, request('unknown-4', []))
  const second = await collect(model, request('unknown-4', [
    assistantMessage(first, 'assistant-1'),
    toolMessage('call-bash', NO_SUCH_TOOL, true),
    { role: 'user', content: [{ type: 'text', text: 'reminder' }] },
  ]))
  assert.equal(text(second), 'after reminder')
  assert.equal(runtime.starts.length, 2)
  assert.equal(runtime.closeCount, 1)
  assert.deepEqual(runtime.midTurnInputs, [])
  const change = replayResponse(second)['generationChange'] as Record<string, unknown>
  assert.equal(change['reason'], 'invalid')
  const imported = inputText(runtime.inputs[1] ?? { content: [] })
  assert.ok(imported.includes('reminder'))
  assert.ok(imported.includes(NO_SUCH_TOOL))
})

test('an unknown tool keeps its qualified name and gets empty arguments when they are malformed', () => {
  const turn = translateTurn(callTurn('m1', [
    toolBlock('m1', 0, 'call-1', 'mcp__dsh__nonexistent', '"not an object"'),
    toolBlock('m1', 1, 'call-2', 'bash', '{broken'),
  ]).events, TRANSLATE_INPUT)
  assert.deepEqual(turn.pendingCalls, [
    { id: 'call-1', name: 'mcp__dsh__nonexistent', arguments: '{}', known: false },
    { id: 'call-2', name: 'bash', arguments: '{}', known: false },
  ])
  assert.deepEqual(turn.unknownToolNames, ['mcp__dsh__nonexistent', 'bash'])
  // The replay block keeps the native name.
  assert.deepEqual(turn.nativeBlocks.map((block) => block.name), ['mcp__dsh__nonexistent', 'bash'])
  // Malformed arguments of a dsh tool stay a failure.
  assert.throws(() => translateTurn(callTurn('m1', [
    toolBlock('m1', 0, 'call-1', 'dsh__echo', '"not an object"'),
  ]).events, TRANSLATE_INPUT), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'MALFORMED_RESPONSE')
    return true
  })
})

test('an unknown tool call with a normal stop stays malformed and names the tool', () => {
  assert.throws(() => translateTurn(
    callTurn('m1', [toolBlock('m1', 0, 'call-1', 'bash')], 'end_turn').events,
    TRANSLATE_INPUT,
  ), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'MALFORMED_RESPONSE')
    assert.ok(error.message.includes('"bash"'))
    assert.ok(!error.message.includes('pwd'))
    return true
  })
})

test('an unknown tool name is sanitized, bounded, and never selects a dsh tool', () => {
  assert.equal(sanitizeUnknownToolName('bash'), 'bash')
  assert.equal(sanitizeUnknownToolName('ba\u0000sh\nrm\u001b[0m'), 'ba?sh?rm?[0m')
  assert.equal(sanitizeUnknownToolName('x'.repeat(200)).length, 64)
  assert.equal(sanitizeUnknownToolName('\u0000'), '?')
  assert.equal(sanitizeUnknownToolName('   '), '?')
  const turn = translateTurn(callTurn('m1', [toolBlock('m1', 0, 'call-1', 'ba\u0000sh')]).events, TRANSLATE_INPUT)
  assert.deepEqual(turn.pendingCalls.map((call) => call.name), ['ba?sh'])
  // A sanitized name that equals a dsh tool name must not run that tool.
  assert.throws(() => translateTurn(callTurn('m1', [toolBlock('m1', 0, 'call-1', 'ec\u0000o')]).events, {
    ...TRANSLATE_INPUT,
    dshNames: new Set(['echo', 'ec?o']),
  }), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'NATIVE_CONTEXT_MISMATCH')
    assert.ok(error.message.includes('"ec?o"'))
    return true
  })
})

test('one turn records at most eight different unknown tool names', () => {
  const blocks = Array.from({ length: 12 }, (_unused, index) => toolBlock('m1', index, 'call-' + index, 'tool' + (index % 10)))
  const turn = translateTurn(callTurn('m1', blocks).events, TRANSLATE_INPUT)
  assert.equal(turn.pendingCalls.length, 12)
  assert.equal(turn.unknownToolNames.length, MAX_UNKNOWN_TOOL_NAMES)
  assert.deepEqual(turn.unknownToolNames, ['tool0', 'tool1', 'tool2', 'tool3', 'tool4', 'tool5', 'tool6', 'tool7'])
})

test('replay data keeps valid unknown tool names and refuses an invalid list', () => {
  const base = {
    format: 'claude-session-v1',
    generationId: 'g1',
    cliSessionId: 'cli',
    cliVersion: '1',
    sdkVersion: '1',
    model: 'm',
    workspace: '/w',
    requestPrefixHash: 'a',
    projectedContentHash: 'b',
    nativeRequestRecord: null,
    nativeResponseBlocks: [],
    toolNameMap: {},
    retentionAudit: 'unavailable',
  }
  assert.equal(parseReplay(base).unknownToolNames, undefined)
  const parsed = parseReplay({ ...base, unknownToolNames: ['bash'] })
  assert.deepEqual(parsed.unknownToolNames, ['bash'])
  assert.deepEqual(parseReplay(JSON.parse(JSON.stringify(parsed))), parsed)
  for (const invalid of [[], [''], [1], 'bash']) {
    assert.throws(() => parseReplay({ ...base, unknownToolNames: invalid }), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'REPLAY_STATE_INVALID')
      return true
    })
  }
})
