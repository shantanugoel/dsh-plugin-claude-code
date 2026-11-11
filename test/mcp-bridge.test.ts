import assert from 'node:assert/strict'
import { test } from 'node:test'

import { McpBridge } from '../src/mcp-bridge.js'
import type { NativeToolResult } from '../src/sdk-runtime.js'

function result(callId: string): NativeToolResult {
  return {
    callId,
    content: [{ type: 'text', text: callId }],
    isError: false,
  }
}

test('a handler that arrives before its call ids are published stays parked', async () => {
  const bridge = new McpBridge()
  bridge.expect(['call-1'])
  const first = bridge.wait('call-1', 2_000)
  bridge.stage([result('call-1')])
  assert.equal((await first).callId, 'call-1')

  // The CLI invokes the next tool handler as soon as it emits the tool call.
  // dsh publishes that turn's call ids only after the native turn ends, so the
  // handler of every later call can arrive before the next expect().
  const second = bridge.wait('call-2', 2_000)
  bridge.expect(['call-2'])
  bridge.stage([result('call-2')])
  assert.equal((await second).callId, 'call-2')
})

test('a released result is delivered to a later handler for the same call id', async () => {
  const bridge = new McpBridge()
  bridge.expect(['call-1'])
  bridge.stage([result('call-1')])
  const delivered = await bridge.wait('call-1', 2_000)
  assert.equal(delivered.callId, 'call-1')
  assert.equal(bridge.deliveryCount, 1)
})

test('a handler outside the published call ids is refused when the turn publishes them', async () => {
  const bridge = new McpBridge()
  const stray = bridge.wait('call-9', 2_000)
  bridge.expect(['call-1'])
  await assert.rejects(stray, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'TOOL_RESULT_MISMATCH')
    return true
  })
})

test('a handler with no matching call id is refused when the batch releases', async () => {
  const bridge = new McpBridge()
  bridge.expect(['call-1'])
  const stray = bridge.wait('call-9', 2_000)
  bridge.stage([result('call-1')])
  await assert.rejects(stray, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'TOOL_RESULT_MISMATCH')
    return true
  })
})

test('a repeated handler for one call id is refused', async () => {
  const bridge = new McpBridge()
  bridge.expect(['call-1'])
  const first = bridge.wait('call-1', 2_000)
  await assert.rejects(bridge.wait('call-1', 2_000), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'TOOL_RESULT_MISMATCH')
    return true
  })
  bridge.stage([result('call-1')])
  assert.equal((await first).callId, 'call-1')
})
