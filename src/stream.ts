import { ToolCallId, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'

import { pluginFailure } from './errors.js'
import type { NativeEvent } from './sdk-runtime.js'

export interface PendingToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface TranslatedTurn {
  readonly chunks: StreamChunk[]
  readonly pendingCalls: readonly PendingToolCall[]
  readonly stopReason: 'end_turn' | 'tool_use'
}

interface OpenBlock {
  readonly key: string
  readonly blockType: 'text' | 'reasoning' | 'tool-call' | 'redacted-thinking'
  readonly dshIndex: number
  text: string
  id: string
  name: string
  argumentsText: string
  closed: boolean
}

/** Identity of one native block. Partial events and the final block share this key. */
export function blockKey(messageId: string, index: number): string {
  if (messageId.trim() === '' || !Number.isInteger(index) || index < 0) {
    throw pluginFailure(
      'MALFORMED_RESPONSE',
      'A native block key needs a message id and a non-negative block index.',
    )
  }
  return `${messageId}:${index}`
}

/**
 * Translate one complete native turn into dsh chunks.
 * Malformed tool arguments throw before a tool chunk is returned.
 */
export function translateTurn(events: readonly NativeEvent[], replay: Record<string, unknown>): TranslatedTurn {
  const blocks = new Map<string, OpenBlock>()
  const order: OpenBlock[] = []
  let usage: TokenUsage | undefined
  let stopReason: 'end_turn' | 'tool_use' | undefined
  for (const event of events) {
    if (event.type === 'usage') {
      usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
      continue
    }
    if (event.type === 'message-stop') {
      stopReason = event.stopReason
      continue
    }
    const key = blockKey(event.messageId, event.index)
    if (event.type === 'block-start') {
      if (blocks.has(key)) throw pluginFailure('MALFORMED_RESPONSE', 'A native block was opened twice.')
      const block: OpenBlock = {
        key,
        blockType: event.blockType,
        dshIndex: order.length,
        text: '',
        id: '',
        name: '',
        argumentsText: '',
        closed: false,
      }
      blocks.set(key, block)
      order.push(block)
      continue
    }
    const block = blocks.get(key)
    if (block === undefined || block.closed) {
      throw pluginFailure('MALFORMED_RESPONSE', 'A native block event has no open block.')
    }
    if (event.type === 'text-delta') block.text += event.text
    else if (event.type === 'reasoning-delta') block.text += event.text
    else if (event.type === 'tool-delta') {
      if (block.id === '') block.id = event.id
      else if (block.id !== event.id) throw pluginFailure('MALFORMED_RESPONSE', 'A tool block changed its call id.')
      if (event.name !== undefined) block.name = event.name
      block.argumentsText += event.argumentsDelta
    } else if (event.type === 'block-stop') {
      block.closed = true
    }
  }
  if (stopReason === undefined) {
    throw pluginFailure('MALFORMED_RESPONSE', 'The native response has no stop.')
  }
  if (usage === undefined) {
    throw pluginFailure('MALFORMED_RESPONSE', 'The native response has no usage.')
  }
  const chunks: StreamChunk[] = []
  const pendingCalls: PendingToolCall[] = []
  let dshIndex = 0
  for (const block of order) {
    if (!block.closed) throw pluginFailure('MALFORMED_RESPONSE', 'A native block did not finish.')
    if (block.blockType === 'redacted-thinking') continue
    if (block.blockType === 'tool-call') {
      if (block.id === '' || block.name === '') {
        throw pluginFailure('MALFORMED_RESPONSE', 'A tool call is missing its id or name.')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(block.argumentsText) as unknown
      } catch {
        throw pluginFailure('MALFORMED_RESPONSE', 'A tool call has malformed arguments.')
      }
      if (typeof parsed !== 'object' || parsed === null) {
        throw pluginFailure('MALFORMED_RESPONSE', 'A tool call has malformed arguments.')
      }
      const argumentsText = JSON.stringify(parsed)
      pendingCalls.push({ id: block.id, name: block.name, arguments: argumentsText })
      const index = dshIndex
      dshIndex += 1
      const id = ToolCallId(block.id)
      chunks.push({
        type: 'tool-call-delta',
        index,
        id,
        name: block.name,
        argumentsDelta: argumentsText,
      })
      chunks.push({
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name: block.name, arguments: argumentsText },
      })
      continue
    }
    const index = dshIndex
    dshIndex += 1
    const blockType = block.blockType === 'reasoning' ? 'reasoning' : 'text'
    chunks.push({ type: 'block-start', index, blockType })
    if (blockType === 'reasoning') {
      chunks.push({ type: 'reasoning-delta', index, text: block.text })
      chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text: block.text } })
    } else {
      chunks.push({ type: 'text-delta', index, text: block.text })
      chunks.push({ type: 'block-end', index, block: { type: 'text', text: block.text } })
    }
  }
  if (stopReason === 'tool_use' && pendingCalls.length === 0) {
    throw pluginFailure('MALFORMED_RESPONSE', 'The native response stopped for tools but published none.')
  }
  if (stopReason === 'end_turn' && pendingCalls.length > 0) {
    throw pluginFailure('MALFORMED_RESPONSE', 'The native response stopped but still contains tool calls.')
  }
  chunks.push({ type: 'usage', usage })
  chunks.push({
    type: 'finish',
    reason: stopReason === 'tool_use' ? { kind: 'tool-calls' } : { kind: 'stop' },
    replayState: { response: replay },
  })
  return { chunks, pendingCalls, stopReason }
}

export async function readUntilStop(
  iterator: AsyncIterator<NativeEvent>,
  timeoutMs: number,
): Promise<NativeEvent[]> {
  const events: NativeEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(pluginFailure(
        'NATIVE_OUTCOME_UNKNOWN',
        'The native response exceeded the generation deadline. It was not retried.',
      ))
    }, timeoutMs)
    timer.unref?.()
  })
  timeout.catch(() => undefined)
  try {
  while (true) {
    const pending = iterator.next()
    pending.catch(() => undefined)
    const step = await Promise.race([
      pending.then((result) => ({ kind: 'event' as const, result })),
      timeout.then(() => ({ kind: 'timeout' as const, result: undefined })),
    ])
    if (step.kind === 'timeout' || step.result === undefined) {
      throw pluginFailure(
        'NATIVE_OUTCOME_UNKNOWN',
        'The native response exceeded the generation deadline. It was not retried.',
      )
    }
    if (step.result.done === true) {
      throw pluginFailure('MALFORMED_RESPONSE', 'The native event stream ended before the response stop.')
    }
    events.push(step.result.value)
    if (step.result.value.type === 'message-stop') return events
  }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
