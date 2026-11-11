import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError } from '@deepseek-ai/dsh-llm'

import {
  classifyNativeResult,
  nativeFailureError,
  sanitizeNativeMessage,
  type NativeFailure,
  type NativeTurnOutcome,
} from '../src/native-failure.js'
import { eventsFromAssistant, eventsFromResult } from '../src/sdk-events.js'

/** Read the mapped failure from an outcome, or fail the test. */
function failureOf(outcome: NativeTurnOutcome): NativeFailure {
  assert.equal(outcome.kind, 'failure')
  if (outcome.kind !== 'failure') throw new Error('not a failure')
  return outcome.failure
}

test('a successful result classifies as success', () => {
  assert.deepEqual(classifyNativeResult({
    subtype: 'success',
    isError: false,
    stopReason: 'end_turn',
    result: 'hello',
  }), { kind: 'success' })
})

test('Claude context-overflow wording maps to CONTEXT_WINDOW_EXCEEDED', () => {
  const failure = failureOf(classifyNativeResult({
    subtype: 'error_during_execution',
    isError: true,
    apiErrorStatus: 400,
    stopReason: null,
    errors: [
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",'
        + '"message":"prompt is too long: 208310 tokens > 200000 maximum"}}',
    ],
  }))
  assert.equal(failure.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(failure.status, 400)
  assert.equal(failure.message.includes('prompt is too long'), true)
  const carried = nativeFailureError(failure)
  assert.ok(carried instanceof LlmError)
  assert.equal(carried.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(carried.failure.status, 400)
})

test('generic overflow wording recognized by the dsh classifier also maps to CONTEXT_WINDOW_EXCEEDED', () => {
  const failure = failureOf(classifyNativeResult({
    subtype: 'error_during_execution',
    isError: true,
    errors: ['maximum context length is 200000 tokens'],
  }))
  assert.equal(failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('an HTTP 429 result maps to RATE_LIMIT', () => {
  const failure = failureOf(classifyNativeResult({
    subtype: 'success',
    isError: true,
    apiErrorStatus: 429,
    result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error",'
      + '"message":"Number of requests exceeded your rate limit."}}',
  }))
  assert.equal(failure.code, 'RATE_LIMIT')
  assert.equal(failure.status, 429)
  assert.equal(failure.message.includes('rate limit'), true)
})

test('quota wording maps to QUOTA', () => {
  const failure = failureOf(classifyNativeResult({
    subtype: 'error_during_execution',
    isError: true,
    errors: ['You have exceeded your current quota.'],
  }))
  assert.equal(failure.code, 'QUOTA')
})

test('first-party credit wording maps to ACCOUNT_QUOTA', () => {
  const failure = failureOf(classifyNativeResult({
    subtype: 'success',
    isError: true,
    apiErrorStatus: 400,
    result: 'Your credit balance is too low to access the Claude API. Purchase credits in the billing page.',
  }))
  assert.equal(failure.code, 'ACCOUNT_QUOTA')
  assert.equal(failure.message.includes('credit balance is too low'), true)
})

test('an auth status or assistant auth error maps to AUTH', () => {
  const statusFailure = failureOf(classifyNativeResult({
    subtype: 'success',
    isError: true,
    apiErrorStatus: 401,
    result: 'invalid authentication',
  }))
  assert.equal(statusFailure.code, 'AUTH')
  assert.equal(statusFailure.status, 401)
  const assistantFailure = failureOf(classifyNativeResult({
    subtype: 'error_during_execution',
    isError: true,
    assistantError: 'authentication_failed',
  }))
  assert.equal(assistantFailure.code, 'AUTH')
})

test('an overloaded provider maps to SERVER', () => {
  const failure = failureOf(classifyNativeResult({
    subtype: 'error_during_execution',
    isError: true,
    apiErrorStatus: 529,
    assistantError: 'overloaded',
    errors: ['overloaded_error'],
  }))
  assert.equal(failure.code, 'SERVER')
  assert.equal(failure.status, 529)
})

test('a turn-limit result maps to MALFORMED_RESPONSE and keeps the native facts', () => {
  const failure = failureOf(classifyNativeResult({
    subtype: 'error_max_turns',
    isError: true,
    stopReason: 'tool_use',
    errors: ['Reached maximum number of turns'],
  }))
  assert.equal(failure.code, 'MALFORMED_RESPONSE')
  assert.equal(failure.message.includes('error_max_turns'), true)
  assert.equal(failure.message.includes('maximum number of turns'), true)
})

test('an execution error maps to NATIVE_OUTCOME_UNKNOWN', () => {
  const failure = failureOf(classifyNativeResult({
    subtype: 'error_during_execution',
    isError: true,
    stopReason: null,
  }))
  assert.equal(failure.code, 'NATIVE_OUTCOME_UNKNOWN')
  const readable = failureOf(classifyNativeResult({
    subtype: 'error_during_execution',
    isError: true,
    errors: ['The native process exited during the turn.'],
  }))
  assert.equal(readable.code, 'NATIVE_OUTCOME_UNKNOWN')
})

test('an unreadable turn error maps to MALFORMED_RESPONSE', () => {
  const failure = failureOf(classifyNativeResult({
    subtype: 'error_something_new',
    isError: true,
    errors: ['The turn failed for a new reason.'],
  }))
  assert.equal(failure.code, 'MALFORMED_RESPONSE')
})

test('a max_tokens stop is a truncation, not a failure', () => {
  assert.deepEqual(classifyNativeResult({
    subtype: 'success',
    isError: false,
    stopReason: 'max_tokens',
  }), { kind: 'max-tokens' })
  assert.deepEqual(classifyNativeResult({
    subtype: 'error_during_execution',
    isError: true,
    assistantError: 'max_output_tokens',
  }), { kind: 'max-tokens' })
})

test('failure messages keep the native text and never expose secrets', () => {
  const failure = failureOf(classifyNativeResult({
    subtype: 'error_during_execution',
    isError: true,
    errors: [
      'Authorization: Bearer sk-ant-api03-SECRETVALUE12345',
      'x-api-key: sk-ant-keyvalue-ABCDEF',
      'account_id: acct_9f8e7d6c5b4a3210',
      'contact user@example.com',
      'opaque 0123456789abcdef0123456789abcdef0123456789abcdef',
    ],
  }))
  for (const secret of [
    'SECRETVALUE12345',
    'sk-ant',
    'acct_9f8e7d6c5b4a3210',
    'user@example.com',
    '0123456789abcdef0123456789abcdef',
  ]) {
    assert.equal(failure.message.includes(secret), false, `the message leaked ${secret}`)
  }
  assert.equal(failure.message.includes('execution error'), true)
})

test('sanitizeNativeMessage keeps benign native detail and bounds its length', () => {
  assert.equal(
    sanitizeNativeMessage('The  prompt\nis   too long: 208310 tokens > 200000 maximum'),
    'The prompt is too long: 208310 tokens > 200000 maximum',
  )
  const long = sanitizeNativeMessage('detail '.repeat(200), 40)
  assert.equal(long.length <= 43, true)
  assert.equal(long.endsWith('...'), true)
  assert.equal(long.startsWith('detail'), true)
})

test('a result message yields usage and one stop', () => {
  const events = eventsFromResult({
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
    },
  }, { messageId: 'm1', stopSent: false })
  assert.deepEqual(events, [
    {
      type: 'usage',
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
    },
    { type: 'message-stop', messageId: 'm1', stopReason: 'end_turn' },
  ])
})

test('a result error becomes one turn-error event', () => {
  const events = eventsFromResult({
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['prompt is too long: 210000 tokens > 200000 maximum'],
  }, { messageId: 'm1', stopSent: false })
  assert.equal(events.length, 1)
  const error = events[0]
  assert.equal(error?.type, 'turn-error')
  if (error?.type !== 'turn-error') return
  assert.equal(error.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('a result error after a complete stop is not reported twice', () => {
  const events = eventsFromResult({
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['late failure'],
  }, { messageId: 'm1', stopSent: true })
  assert.deepEqual(events, [])
})

test('a result max_tokens stop yields a max_tokens stop event', () => {
  const events = eventsFromResult({
    subtype: 'success',
    is_error: false,
    stop_reason: 'max_tokens',
    usage: { input_tokens: 5, output_tokens: 2 },
  }, { messageId: 'm1', stopSent: false })
  assert.deepEqual(events, [
    { type: 'usage', inputTokens: 5, outputTokens: 2 },
    { type: 'message-stop', messageId: 'm1', stopReason: 'max_tokens' },
  ])
})

test('an assistant message max_tokens stop is a max_tokens stop event', () => {
  const events = eventsFromAssistant({
    id: 'm1',
    content: [{ type: 'text', text: 'partial' }],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 3, output_tokens: 1 },
  })
  assert.deepEqual(events, [
    { type: 'block-snapshot', messageId: 'm1', index: 0, blockType: 'text', text: 'partial' },
    { type: 'usage', inputTokens: 3, outputTokens: 1 },
    { type: 'message-stop', messageId: 'm1', stopReason: 'max_tokens' },
  ])
})

test('a streamed assistant message with no stop reason yields no stop event', () => {
  const events = eventsFromAssistant({
    id: 'm1',
    content: [{ type: 'text', text: 'one block' }],
    stop_reason: null,
  })
  assert.deepEqual(events, [
    { type: 'block-snapshot', messageId: 'm1', index: 0, blockType: 'text', text: 'one block' },
  ])
})
