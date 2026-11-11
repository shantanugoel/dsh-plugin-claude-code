import { ToolCallId, type FinishReason, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'

import type { CanonicalBlock } from './transcript.js'
import { assertEvidenceFits, retentionProofAccepted } from './evidence.js'
import { pluginFailure } from './errors.js'
import { nativeFailureError } from './native-failure.js'
import type { NativeEvent } from './sdk-runtime.js'

/** Why the native generation ended, for the recorded generation change. */
export type NativeFailureReason = 'timeout' | 'process-loss'

const NATIVE_FAILURE_REASON = Symbol.for('dsh-plugin-claude-code.native-failure-reason')

/** Attach the generation-level reason to one native failure. */
export function markNativeFailure<T>(error: T, reason: NativeFailureReason): T {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<symbol, unknown>
    if (record[NATIVE_FAILURE_REASON] === undefined) record[NATIVE_FAILURE_REASON] = reason
  }
  return error
}

/** Read the reason that `markNativeFailure` attached, if any. */
export function nativeFailureReasonOf(error: unknown): NativeFailureReason | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as Record<symbol, unknown>)[NATIVE_FAILURE_REASON]
  return value === 'timeout' || value === 'process-loss' ? value : undefined
}

export interface PendingToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface NativeResponseBlock {
  readonly type: 'text' | 'thinking' | 'redacted-thinking' | 'tool-use'
  readonly text?: string
  readonly signature?: string
  readonly data?: string
  readonly id?: string
  readonly name?: string
  readonly arguments?: string
}

export interface TranslatedTurn {
  readonly chunks: StreamChunk[]
  readonly pendingCalls: readonly PendingToolCall[]
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
  readonly blocks: readonly CanonicalBlock[]
  readonly nativeBlocks: readonly NativeResponseBlock[]
  readonly nativeMessageIds: readonly string[]
  readonly usage: TokenUsage
  readonly evidence: unknown
  readonly auditAccepted: boolean
}

interface OpenBlock {
  readonly key: string
  readonly blockType: 'text' | 'reasoning' | 'tool-call' | 'redacted-thinking'
  text: string
  id: string
  name: string
  argumentsText: string
  signature: string | undefined
  redactedData: string | undefined
  closed: boolean
  snapshotted: boolean
}

export interface TranslateInput {
  readonly nativeToDsh: ReadonlyMap<string, string>
  readonly dshNames: ReadonlySet<string>
  readonly allowedNativeTools: ReadonlySet<string>
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
 * A repeated partial event and its completed snapshot become one block.
 * A turn-error event becomes one thrown LlmError with its stable code.
 * Malformed tool arguments throw before a tool chunk is returned.
 */
export function translateTurn(events: readonly NativeEvent[], input: TranslateInput): TranslatedTurn {
  const blocks = new Map<string, OpenBlock>()
  const order: OpenBlock[] = []
  let usage: TokenUsage | undefined
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | undefined
  let evidence: unknown
  const messageIds: string[] = []
  for (const event of events) {
    if (event.type === 'turn-error') {
      // The native turn failed before it published a complete response.
      // A complete response is never reported twice: the producer drops a
      // turn-error event that follows its message-stop.
      throw nativeFailureError(event.failure)
    }
    if (event.type === 'usage') {
      if (usage !== undefined) throw pluginFailure('MALFORMED_RESPONSE', 'The native response repeated its usage.')
      usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...(event.cacheReadTokens === undefined ? {} : { cacheReadTokens: event.cacheReadTokens }),
        ...(event.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: event.cacheWriteTokens }),
      }
      continue
    }
    if (event.type === 'message-stop') {
      if (stopReason !== undefined) throw pluginFailure('MALFORMED_RESPONSE', 'The native response stopped twice.')
      if (event.stopReason !== 'end_turn' && event.stopReason !== 'tool_use' && event.stopReason !== 'max_tokens') {
        throw pluginFailure('MALFORMED_RESPONSE', 'The native response has an unknown stop.')
      }
      stopReason = event.stopReason
      rememberMessage(messageIds, event.messageId)
      continue
    }
    if (event.type === 'request-evidence') {
      assertEvidenceFits(event.record)
      evidence = event.record
      continue
    }
    if (event.type === 'native-tool-list') {
      assertNativeTools(event.names, input.allowedNativeTools)
      continue
    }
    if (event.type === 'model-usage') {
      // The adapter records capacity before this translation. This event is not
      // part of the model response, so it cannot open a block.
      continue
    }
    rememberMessage(messageIds, event.messageId)
    const key = blockKey(event.messageId, event.index)
    if (event.type === 'block-start') {
      const existing = blocks.get(key)
      if (existing !== undefined) {
        if (existing.blockType !== event.blockType) {
          throw pluginFailure('MALFORMED_RESPONSE', 'A native block changed its type.')
        }
        assignSignature(existing, event.signature, event.redactedData)
        continue
      }
      const block = openBlock(key, event.blockType, event.signature, event.redactedData)
      blocks.set(key, block)
      order.push(block)
      continue
    }
    if (event.type === 'block-snapshot') {
      const existing = blocks.get(key) ?? openBlock(key, event.blockType, event.signature, event.redactedData)
      if (!blocks.has(key)) {
        blocks.set(key, existing)
        order.push(existing)
      }
      if (existing.blockType !== event.blockType) {
        throw pluginFailure('MALFORMED_RESPONSE', 'A native block changed its type.')
      }
      const nextText = event.text ?? existing.text
      const nextId = event.id ?? existing.id
      const nextName = event.name ?? existing.name
      const nextArguments = event.argumentsText ?? existing.argumentsText
      const nextSignature = event.signature ?? existing.signature
      const nextRedacted = event.redactedData ?? existing.redactedData
      if (existing.snapshotted && !sameSnapshot(existing, nextText, nextId, nextName, nextArguments, nextSignature, nextRedacted)) {
        throw pluginFailure('MALFORMED_RESPONSE', 'A completed native block changed its content.')
      }
      existing.text = nextText
      existing.id = nextId
      existing.name = nextName
      existing.argumentsText = nextArguments
      existing.signature = nextSignature
      existing.redactedData = nextRedacted
      existing.snapshotted = true
      continue
    }
    const block = blocks.get(key)
    if (block === undefined || block.closed) {
      throw pluginFailure('MALFORMED_RESPONSE', 'A native block event has no open block.')
    }
    if (block.snapshotted) continue
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
  const projected: CanonicalBlock[] = []
  const nativeBlocks: NativeResponseBlock[] = []
  let dshIndex = 0
  for (const block of order) {
    if (!block.closed && !block.snapshotted) {
      throw pluginFailure('MALFORMED_RESPONSE', 'A native block did not finish.')
    }
    if (block.blockType === 'redacted-thinking') {
      if (block.redactedData === undefined) {
        throw pluginFailure('MALFORMED_RESPONSE', 'Redacted thinking has no opaque data.')
      }
      nativeBlocks.push({ type: 'redacted-thinking', data: block.redactedData })
      continue
    }
    if (block.blockType === 'tool-call') {
      const published = publishTool(block, input)
      pendingCalls.push(published.call)
      projected.push(published.block)
      const index = dshIndex
      dshIndex += 1
      const id = ToolCallId(published.call.id)
      chunks.push({
        type: 'tool-call-delta',
        index,
        id,
        name: published.call.name,
        argumentsDelta: published.call.arguments,
      })
      chunks.push({
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name: published.call.name, arguments: published.call.arguments },
      })
      nativeBlocks.push({
        type: 'tool-use',
        id: published.call.id,
        name: block.name,
        arguments: published.call.arguments,
      })
      continue
    }
    const index = dshIndex
    dshIndex += 1
    const blockType = block.blockType === 'reasoning' ? 'reasoning' : 'text'
    projected.push({ type: blockType, text: block.text, id: '', name: '', arguments: '' })
    chunks.push({ type: 'block-start', index, blockType })
    if (blockType === 'reasoning') {
      chunks.push({ type: 'reasoning-delta', index, text: block.text })
      chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text: block.text } })
      nativeBlocks.push(block.signature === undefined
        ? { type: 'thinking', text: block.text }
        : { type: 'thinking', text: block.text, signature: block.signature })
    } else {
      chunks.push({ type: 'text-delta', index, text: block.text })
      chunks.push({ type: 'block-end', index, block: { type: 'text', text: block.text } })
      nativeBlocks.push({ type: 'text', text: block.text })
    }
  }
  if (stopReason === 'tool_use' && pendingCalls.length === 0) {
    throw pluginFailure('MALFORMED_RESPONSE', 'The native response stopped for tools but published none.')
  }
  if (stopReason === 'end_turn' && pendingCalls.length > 0) {
    throw pluginFailure('MALFORMED_RESPONSE', 'The native response stopped but still contains tool calls.')
  }
  if (stopReason === 'max_tokens' && pendingCalls.length > 0) {
    throw pluginFailure(
      'MALFORMED_RESPONSE',
      'The native response hit the output-token limit with a tool call. The truncated call was not executed.',
    )
  }
  chunks.push({ type: 'usage', usage })
  const auditAccepted = retentionProofAccepted(evidence)
  return {
    chunks,
    pendingCalls,
    stopReason,
    blocks: projected,
    nativeBlocks,
    nativeMessageIds: messageIds,
    usage,
    evidence: auditAccepted ? evidenceBody(evidence) : null,
    auditAccepted,
  }
}

export async function readUntilStop(
  iterator: AsyncIterator<NativeEvent>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<NativeEvent[]> {
  const events: NativeEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(markNativeFailure(pluginFailure(
        'NATIVE_OUTCOME_UNKNOWN',
        'The native response exceeded the generation deadline. It was not retried.',
      ), 'timeout'))
    }, timeoutMs)
    timer.unref?.()
  })
  timeout.catch(() => undefined)
  let onAbort: (() => void) | undefined
  const aborted = signal === undefined
    ? undefined
    : new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DOMException('The model request was aborted.', 'AbortError'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  aborted?.catch(() => undefined)
  try {
    while (true) {
      const pending = iterator.next()
      pending.catch(() => undefined)
      const failed = pending.then(
        (result) => result,
        (error: unknown) => {
          throw markNativeFailure(error, 'process-loss')
        },
      )
      failed.catch(() => undefined)
      const step = await Promise.race([
        failed.then((result) => ({ kind: 'event' as const, result })),
        timeout.then(() => ({ kind: 'timeout' as const, result: undefined })),
        ...(aborted === undefined ? [] : [aborted.then(
          () => ({ kind: 'abort' as const, result: undefined }),
          () => ({ kind: 'abort' as const, result: undefined }),
        )]),
      ])
      if (step.kind === 'abort') throw new DOMException('The model request was aborted.', 'AbortError')
      if (step.kind === 'timeout' || step.result === undefined) {
        throw markNativeFailure(pluginFailure(
          'NATIVE_OUTCOME_UNKNOWN',
          'The native response exceeded the generation deadline. It was not retried.',
        ), 'timeout')
      }
      if (step.result.done === true) {
        throw markNativeFailure(pluginFailure(
          'NATIVE_OUTCOME_UNKNOWN',
          'The native event stream ended before the response stop. The outcome is unknown.',
        ), 'process-loss')
      }
      events.push(step.result.value)
      if (step.result.value.type === 'message-stop' || step.result.value.type === 'turn-error') return events
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Translate one native stop reason into its dsh finish reason.
 * A max_tokens stop stays a truncation forever: it is never reported as stop.
 */
export function finishReasonFor(stopReason: TranslatedTurn['stopReason']): FinishReason {
  if (stopReason === 'tool_use') return { kind: 'tool-calls' }
  if (stopReason === 'max_tokens') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

function publishTool(block: OpenBlock, input: TranslateInput): {
  readonly call: PendingToolCall
  readonly block: CanonicalBlock
} {
  if (block.id === '' || block.name === '') {
    throw pluginFailure('MALFORMED_RESPONSE', 'A tool call is missing its id or name.')
  }
  const name = publishedToolName(block.name, input)
  let parsed: unknown
  try {
    parsed = JSON.parse(block.argumentsText) as unknown
  } catch {
    throw pluginFailure('MALFORMED_RESPONSE', 'A tool call has malformed arguments.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw pluginFailure('MALFORMED_RESPONSE', 'A tool call has malformed arguments.')
  }
  const argumentsText = JSON.stringify(parsed)
  return {
    call: { id: block.id, name, arguments: argumentsText },
    block: { type: 'tool-call', text: '', id: block.id, name, arguments: argumentsText },
  }
}

function publishedToolName(name: string, input: TranslateInput): string {
  const mapped = input.nativeToDsh.get(name)
  if (mapped !== undefined) return mapped
  if (input.dshNames.has(name)) return name
  throw pluginFailure('NATIVE_CONTEXT_MISMATCH', 'The native response named a tool outside the dsh tool list.')
}

function assertNativeTools(names: readonly string[], allowed: ReadonlySet<string>): void {
  for (const name of names) {
    if (!allowed.has(name)) {
      throw pluginFailure('NATIVE_CONTEXT_MISMATCH', 'The native session exposed a tool outside the dsh MCP server.')
    }
  }
}

function openBlock(
  key: string,
  blockType: OpenBlock['blockType'],
  signature: string | undefined,
  redactedData: string | undefined,
): OpenBlock {
  return {
    key,
    blockType,
    text: '',
    id: '',
    name: '',
    argumentsText: '',
    signature,
    redactedData,
    closed: false,
    snapshotted: false,
  }
}

function assignSignature(block: OpenBlock, signature: string | undefined, redactedData: string | undefined): void {
  if (signature !== undefined) block.signature = signature
  if (redactedData !== undefined) block.redactedData = redactedData
}

function sameSnapshot(
  block: OpenBlock,
  text: string,
  id: string,
  name: string,
  argumentsText: string,
  signature: string | undefined,
  redactedData: string | undefined,
): boolean {
  return block.text === text
    && block.id === id
    && block.name === name
    && block.argumentsText === argumentsText
    && block.signature === signature
    && block.redactedData === redactedData
}

function rememberMessage(ids: string[], messageId: string): void {
  if (messageId.trim() === '') throw pluginFailure('MALFORMED_RESPONSE', 'A native message has no id.')
  if (!ids.includes(messageId)) ids.push(messageId)
}

function evidenceBody(record: unknown): unknown {
  if (typeof record !== 'object' || record === null || !('body' in record)) return null
  return record.body
}
