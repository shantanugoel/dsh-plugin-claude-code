import { classifyNativeResult } from './native-failure.js'
import type { NativeEvent } from './sdk-runtime.js'

interface LooseBlock {
  readonly type?: unknown
  readonly text?: unknown
  readonly thinking?: unknown
  readonly signature?: unknown
  readonly data?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly input?: unknown
}

interface LooseUsage {
  readonly input_tokens?: unknown
  readonly output_tokens?: unknown
  readonly cache_read_input_tokens?: unknown
  readonly cache_creation_input_tokens?: unknown
}

interface LooseAssistantMessage {
  readonly id?: unknown
  readonly content?: readonly LooseBlock[]
  readonly stop_reason?: unknown
  readonly usage?: LooseUsage
}

/** Loose facts of one SDK result message. The SDK declarations change between releases. */
export interface LooseResultMessage {
  readonly subtype?: unknown
  readonly is_error?: unknown
  readonly errors?: unknown
  readonly api_error_status?: unknown
  readonly stop_reason?: unknown
  readonly result?: unknown
  readonly usage?: LooseUsage
}

/** State that the result message needs to produce its events. */
export interface ResultEventContext {
  readonly messageId: string
  /** True when a complete assistant stop was already published for this turn. */
  readonly stopSent: boolean
  /** Error value of the latest assistant message in this turn, if it had one. */
  readonly latestAssistantError?: unknown
}

/** Read a tool-call id from an MCP handler extra value. */
export function readToolUseId(extra: unknown): string | undefined {
  return readId(extra, 0)
}

/**
 * Translate one completed assistant message into native events.
 * Empty thinking text stays present when the block exists.
 * A max_tokens stop stays a truncation, not a normal stop.
 * Usage is independent of the stop reason: the CLI attaches it to streamed
 * assistant messages whose stop_reason is null.
 */
export function eventsFromAssistant(message: LooseAssistantMessage, startIndex = 0): NativeEvent[] {
  const messageId = typeof message.id === 'string' && message.id.trim() !== '' ? message.id : 'assistant'
  const content = message.content ?? []
  const events: NativeEvent[] = []
  content.forEach((block, offset) => {
    const snapshot = snapshotFor(messageId, startIndex + offset, block)
    if (snapshot !== undefined) events.push(snapshot)
  })
  pushUsage(events, message.usage)
  const stopReason = message.stop_reason
  if (stopReason !== 'end_turn' && stopReason !== 'tool_use' && stopReason !== 'max_tokens') return events
  events.push({ type: 'message-stop', messageId, stopReason })
  return events
}

/** Folding state for one native turn. At most one usage event is kept. */
export interface NativeTurnState {
  readonly messageId: string
  readonly stopSent: boolean
  readonly usageSent: boolean
  /** Content blocks already emitted for the current native message id. */
  readonly blockCount: number
}

/** Start a new native turn. */
export function newNativeTurn(): NativeTurnState {
  return { messageId: 'assistant', stopSent: false, usageSent: false, blockCount: 0 }
}

/**
 * Fold events into one native turn. The SDK can report usage on more than one
 * message of a turn, and the dsh translation refuses a repeated usage. Keep
 * the first usage event and remember the newest message id and stop.
 */
export function foldTurnEvents(
  state: NativeTurnState,
  events: readonly NativeEvent[],
): { readonly state: NativeTurnState; readonly events: NativeEvent[] } {
  let next = state
  const kept: NativeEvent[] = []
  for (const event of events) {
    if (event.type === 'usage') {
      if (next.usageSent) continue
      next = { ...next, usageSent: true }
    }
    if (event.type === 'block-start' || event.type === 'block-snapshot' || event.type === 'message-stop') {
      next = { ...next, messageId: event.messageId }
      if (event.type === 'message-stop') next = { ...next, stopSent: true }
    }
    kept.push(event)
  }
  return { state: next, events: kept }
}

/**
 * Fold one completed assistant message into a native turn.
 *
 * A tool-call block with no explicit stop adds the synthetic tool_use stop
 * after the usage, so a tool turn ends with both its usage and its stop.
 */
export function advanceAssistantTurn(
  state: NativeTurnState,
  message: LooseAssistantMessage,
): { readonly state: NativeTurnState; readonly events: NativeEvent[] } {
  // The CLI can split one API message into several assistant messages with the
  // same id and one content block each. Continue the block indexes across that
  // split so the translation does not see two blocks at the same index.
  const messageId = typeof message.id === 'string' && message.id.trim() !== '' ? message.id : 'assistant'
  const startIndex = state.messageId === messageId ? state.blockCount : 0
  const contentLength = message.content?.length ?? 0
  const folded = foldTurnEvents(state, eventsFromAssistant(message, startIndex))
  const counted: NativeTurnState = {
    ...folded.state,
    messageId,
    blockCount: startIndex + contentLength,
  }
  const hasTool = folded.events.some((event) => event.type === 'block-snapshot' && event.blockType === 'tool-call')
  if (!hasTool || counted.stopSent) return { state: counted, events: folded.events }
  const stopped: NativeTurnState = { ...counted, stopSent: true }
  return {
    state: stopped,
    events: [
      ...folded.events,
      { type: 'message-stop', messageId: stopped.messageId, stopReason: 'tool_use' },
    ],
  }
}

/**
 * Translate one SDK result message into native events.
 *
 * A result that reports a turn error becomes one `turn-error` event. The event
 * is not produced when a complete assistant response stopped already: that
 * response is usable and the error is not reported twice. The adapter turns the
 * `turn-error` event into one thrown `LlmError` with the stable dsh code.
 */
export function eventsFromResult(message: LooseResultMessage, context: ResultEventContext): NativeEvent[] {
  if (context.stopSent) return []
  const outcome = classifyNativeResult({
    subtype: message.subtype,
    isError: message.is_error,
    errors: message.errors,
    apiErrorStatus: message.api_error_status,
    stopReason: message.stop_reason,
    result: message.result,
    assistantError: context.latestAssistantError,
  })
  if (outcome.kind === 'failure') return [{ type: 'turn-error', failure: outcome.failure }]
  const events: NativeEvent[] = []
  pushUsage(events, message.usage)
  const stopReason = outcome.kind === 'max-tokens'
    ? 'max_tokens'
    : message.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn'
  events.push({ type: 'message-stop', messageId: context.messageId, stopReason })
  return events
}

function pushUsage(events: NativeEvent[], usage: LooseUsage | undefined): void {
  if (typeof usage?.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return
  const cacheReadTokens = tokenCount(usage.cache_read_input_tokens)
  const cacheWriteTokens = tokenCount(usage.cache_creation_input_tokens)
  events.push({
    type: 'usage',
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  })
}

function snapshotFor(messageId: string, index: number, block: LooseBlock): NativeEvent | undefined {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'block-snapshot', messageId, index, blockType: 'text', text: block.text }
  }
  if (block.type === 'thinking') {
    const text = typeof block.thinking === 'string' ? block.thinking : ''
    const signature = typeof block.signature === 'string' ? block.signature : undefined
    return signature === undefined
      ? { type: 'block-snapshot', messageId, index, blockType: 'reasoning', text }
      : { type: 'block-snapshot', messageId, index, blockType: 'reasoning', text, signature }
  }
  if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
    return {
      type: 'block-snapshot',
      messageId,
      index,
      blockType: 'redacted-thinking',
      redactedData: block.data,
    }
  }
  if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
    return {
      type: 'block-snapshot',
      messageId,
      index,
      blockType: 'tool-call',
      id: block.id,
      name: block.name,
      argumentsText: JSON.stringify(block.input ?? {}),
    }
  }
  return undefined
}

function readId(extra: unknown, depth: number): string | undefined {
  if (depth > 2 || typeof extra !== 'object' || extra === null) return undefined
  const record = extra as Record<string, unknown>
  for (const key of ['toolUseID', 'tool_use_id', 'toolUseId', 'claudecode/toolUseId']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  // The MCP request extra can namespace the id. Accept any key that names a
  // tool-use id, so a newer CLI spelling does not lose the call correlation.
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.trim() === '') continue
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
    if (normalized.endsWith('tooluseid') || normalized === 'tooluseid') return value
  }
  return readId(record['_meta'], depth + 1)
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
