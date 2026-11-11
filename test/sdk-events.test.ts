import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError } from '@deepseek-ai/dsh-llm'

import { eventsFromAssistant, readToolUseId } from '../src/sdk-events.js'
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
