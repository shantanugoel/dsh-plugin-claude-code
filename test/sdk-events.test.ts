import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError } from '@deepseek-ai/dsh-llm'

import {
  advanceAssistantTurn,
  eventsFromAssistant,
  eventsFromResult,
  foldTurnEvents,
  newNativeTurn,
  readToolUseId,
} from '../src/sdk-events.js'
import { zodShapeForTool } from '../src/sdk-schema.js'

test('an assistant message keeps empty thinking and its signature', () => {
  const events = eventsFromAssistant({
    id: 'msg-1',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'text', text: 'answer' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 2, output_tokens: 1 },
  })
  const thinking = events.find((event) => event.type === 'block-snapshot' && event.blockType === 'reasoning')
  assert.equal(thinking?.type, 'block-snapshot')
  if (thinking?.type !== 'block-snapshot') return
  assert.equal(thinking.text, '')
  assert.equal(thinking.signature, 'sig-1')
  assert.equal(events.at(-1)?.type, 'message-stop')
})

test('assistant usage keeps cache read and write tokens', () => {
  const events = eventsFromAssistant({
    id: 'msg-1',
    content: [{ type: 'text', text: 'answer' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
    },
  })
  const usage = events.find((event) => event.type === 'usage')
  assert.deepEqual(usage, {
    type: 'usage',
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 900,
    cacheWriteTokens: 50,
  })
})

test('a tool handler extra value yields its call id', () => {
  assert.equal(readToolUseId({ toolUseID: 'call-1' }), 'call-1')
  assert.equal(readToolUseId({ _meta: { tool_use_id: 'call-2' } }), 'call-2')
  // Live MCP request extra from CLI 2.1.319 / SDK 0.3.322.
  assert.equal(readToolUseId({ signal: {}, _meta: { 'claudecode/toolUseId': 'call-3' }, requestId: 2 }), 'call-3')
  assert.equal(readToolUseId({ _meta: { 'some.namespace/tool_use_id': 'call-4' } }), 'call-4')
  assert.equal(readToolUseId({ arguments: { value: 'one' } }), undefined)
})

test('a preserved tool schema survives the Zod conversion', () => {
  const shape = zodShapeForTool({
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  })
  assert.equal(typeof shape['value'], 'object')
  const harnessShape = zodShapeForTool({
    type: 'object',
    properties: {
      code: { type: 'string' },
      mode: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
      limit: { type: 'integer' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      args: { type: 'object', additionalProperties: true },
    },
    required: ['code'],
  })
  assert.equal(typeof harnessShape['code'], 'object')
  assert.equal(typeof harnessShape['args'], 'object')
  assert.throws(() => zodShapeForTool({ type: 'string' }), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
  assert.throws(() => zodShapeForTool({
    type: 'object',
    unevaluatedProperties: false,
    properties: { value: { type: 'string' } },
  }), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'UNSUPPORTED_INPUT')
    return true
  })
})


test('a streamed assistant message reports its usage without a stop reason', () => {
  const events = eventsFromAssistant({
    id: 'm1',
    content: [{ type: 'tool_use', id: 'call-1', name: 'echo', input: {} }],
    stop_reason: null,
    usage: {
      input_tokens: 2,
      output_tokens: 32,
      cache_read_input_tokens: 10173,
      cache_creation_input_tokens: 7,
    },
  })
  assert.deepEqual(events, [
    {
      type: 'block-snapshot',
      messageId: 'm1',
      index: 0,
      blockType: 'tool-call',
      id: 'call-1',
      name: 'echo',
      argumentsText: '{}',
    },
    {
      type: 'usage',
      inputTokens: 2,
      outputTokens: 32,
      cacheReadTokens: 10173,
      cacheWriteTokens: 7,
    },
  ])
})

test('a tool turn keeps one usage and adds the synthetic stop after it', () => {
  // Two assistant messages before the stop: only one usage event is kept.
  const first = advanceAssistantTurn(newNativeTurn(), {
    id: 'm1',
    content: [{ type: 'thinking', thinking: 'plan', signature: 'sig-plan' }],
    stop_reason: null,
    usage: { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 10173 },
  })
  assert.equal(first.events.some((event) => event.type === 'usage'), true)
  assert.equal(first.events.some((event) => event.type === 'message-stop'), false)
  assert.equal(first.state.stopSent, false)
  assert.equal(first.state.usageSent, true)

  const second = advanceAssistantTurn(first.state, {
    id: 'm2',
    content: [{ type: 'tool_use', id: 'call-1', name: 'echo', input: {} }],
    stop_reason: null,
    usage: { input_tokens: 2, output_tokens: 32, cache_read_input_tokens: 10173 },
  })
  const types = second.events.map((event) => event.type)
  assert.deepEqual(types, ['block-snapshot', 'message-stop'])
  const usageIndex = types.indexOf('usage')
  assert.equal(usageIndex, -1)
  assert.equal(second.events.at(0)?.type, 'block-snapshot')
  assert.deepEqual(second.events.at(-1), { type: 'message-stop', messageId: 'm2', stopReason: 'tool_use' })
  assert.equal(second.state.stopSent, true)
})

test('a tool turn emits the kept usage before the synthetic tool stop', () => {
  const advanced = advanceAssistantTurn(newNativeTurn(), {
    id: 'm1',
    content: [{ type: 'tool_use', id: 'call-1', name: 'echo', input: {} }],
    stop_reason: null,
    usage: { input_tokens: 2, output_tokens: 32, cache_read_input_tokens: 10173 },
  })
  const types = advanced.events.map((event) => event.type)
  assert.deepEqual(types, ['block-snapshot', 'usage', 'message-stop'])
})

test('the result message supplies usage when no assistant message had it', () => {
  const assistant = advanceAssistantTurn(newNativeTurn(), {
    id: 'm1',
    content: [{ type: 'text', text: 'answer' }],
    stop_reason: null,
  })
  assert.equal(assistant.events.some((event) => event.type === 'usage'), false)
  const folded = foldTurnEvents(assistant.state, eventsFromResult({
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 2 },
  }, { messageId: assistant.state.messageId, stopSent: assistant.state.stopSent }))
  assert.deepEqual(folded.events, [
    { type: 'usage', inputTokens: 5, outputTokens: 2 },
    { type: 'message-stop', messageId: 'm1', stopReason: 'end_turn' },
  ])
  assert.equal(folded.state.stopSent, true)
})

test('a usage that appears on the assistant message and the result is kept once', () => {
  const assistant = advanceAssistantTurn(newNativeTurn(), {
    id: 'm1',
    content: [{ type: 'text', text: 'answer' }],
    stop_reason: null,
    usage: { input_tokens: 2, output_tokens: 32 },
  })
  const folded = foldTurnEvents(assistant.state, eventsFromResult({
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    usage: { input_tokens: 2, output_tokens: 32 },
  }, { messageId: assistant.state.messageId, stopSent: assistant.state.stopSent }))
  // The assistant usage is the one kept for the turn; the result adds none.
  assert.equal(assistant.events.filter((event) => event.type === 'usage').length, 1)
  assert.equal(folded.events.filter((event) => event.type === 'usage').length, 0)
  assert.deepEqual(folded.events, [
    { type: 'message-stop', messageId: 'm1', stopReason: 'end_turn' },
  ])
})
