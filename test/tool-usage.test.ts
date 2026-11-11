import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import { interpretAuthStatus } from '../src/auth.js'
import { advanceAssistantTurn, newNativeTurn } from '../src/sdk-events.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { textRequest } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { SYNTHETIC_AUTH_STATUS, makeAdapter } from './support.js'

const NOW = new Date('2026-11-10T00:00:00.000Z')

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

function toolRequest(): GenerateOptions {
  return {
    ...textRequest('run the tool', 'tool-usage-1'),
    tools: [{ name: 'echo', description: 'Echo text.', parameters: { type: 'object' } }],
  }
}

test('a tool turn with usage and no stop reason finishes with tool-calls', async () => {
  // One SDK assistant message as the live capture showed it: a tool_use block,
  // usage present, stop_reason null. The official session folds it into these
  // events, including the synthetic tool_use stop after the usage.
  const advanced = advanceAssistantTurn(newNativeTurn(), {
    id: 'm-tool',
    content: [{ type: 'tool_use', id: 'call-1', name: 'echo', input: {} }],
    stop_reason: null,
    usage: {
      input_tokens: 2,
      output_tokens: 32,
      cache_read_input_tokens: 10173,
    },
  })
  assert.deepEqual(advanced.events.map((event) => event.type), ['block-snapshot', 'usage', 'message-stop'])

  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({ events: advanced.events })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const chunks = await collect(model, toolRequest())

  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.deepEqual(usage, {
    type: 'usage',
    usage: { inputTokens: 2, outputTokens: 32, cacheReadTokens: 10173 },
  })
})

test('two assistant messages before a tool stop keep one usage in one stream', async () => {
  const first = advanceAssistantTurn(newNativeTurn(), {
    id: 'm-think',
    content: [{ type: 'thinking', thinking: 'plan', signature: 'sig-plan' }],
    stop_reason: null,
    usage: { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 10173 },
  })
  const second = advanceAssistantTurn(first.state, {
    id: 'm-tool',
    content: [{ type: 'tool_use', id: 'call-1', name: 'echo', input: {} }],
    stop_reason: null,
    usage: { input_tokens: 2, output_tokens: 32, cache_read_input_tokens: 10173 },
  })
  assert.equal(second.events.some((event) => event.type === 'usage'), false)

  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({ events: [...first.events, ...second.events] })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const chunks = await collect(model, toolRequest())

  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
  const usages = chunks.filter((chunk) => chunk.type === 'usage')
  assert.equal(usages.length, 1)
  assert.deepEqual(usages[0], {
    type: 'usage',
    usage: { inputTokens: 2, outputTokens: 9, cacheReadTokens: 10173 },
  })
})

test('one API message split into several assistant messages keeps distinct block indexes', async () => {
  // The live capture showed the CLI splitting one API message into three
  // assistant messages with the same id: thinking, text, then tool_use. Each
  // carries the same usage and a null stop reason. The block indexes must
  // continue across the split, or the translation sees two blocks at index 0.
  const messageId = 'msg-split-1'
  const usage = { input_tokens: 2, output_tokens: 32, cache_read_input_tokens: 10173 }
  let turn = newNativeTurn()
  const events: ReturnType<typeof advanceAssistantTurn>['events'] = []
  for (const block of [
    { type: 'thinking', thinking: 'plan', signature: 'sig-plan' },
    { type: 'text', text: 'working' },
    { type: 'tool_use', id: 'call-1', name: 'echo', input: {} },
  ]) {
    const advanced = advanceAssistantTurn(turn, { id: messageId, content: [block], stop_reason: null, usage })
    events.push(...advanced.events)
    turn = advanced.state
  }
  const snapshots = events.filter((event) => event.type === 'block-snapshot')
  assert.deepEqual(snapshots.map((event) => event.type === 'block-snapshot' ? event.index : -1), [0, 1, 2])
  assert.deepEqual(snapshots.map((event) => event.type === 'block-snapshot' ? event.blockType : ''), ['reasoning', 'text', 'tool-call'])
  assert.equal(events.filter((event) => event.type === 'usage').length, 1)
  assert.deepEqual(events.at(-1), { type: 'message-stop', messageId, stopReason: 'tool_use' })

  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue({ events })
  const { model } = makeAdapter({ runtime, spendGate: gate() })
  const chunks = await collect(model, toolRequest())
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
  const blocks = chunks.flatMap((chunk) => chunk.type === 'block-end' ? [chunk.block] : [])
  assert.deepEqual(blocks.map((block) => block.type), ['reasoning', 'text', 'tool-call'])
})
