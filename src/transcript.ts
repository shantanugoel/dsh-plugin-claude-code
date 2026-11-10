import { canonicalJson, contentHash } from './canonical.js'
import { pluginFailure } from './errors.js'
import { parseReplayEnvelope, type ReplayV1 } from './replay.js'

/** One frozen request snapshot. Later checks compare this value. They do not change it. */
export interface RequestSnapshot {
  readonly requestPrefixHash: string
  readonly projectedContentHash: string
}

export interface CanonicalBlock {
  readonly type: 'text' | 'reasoning' | 'tool-call'
  readonly text: string
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface CanonicalMessage {
  readonly role: string
  readonly id: string | null
  readonly blocks: readonly CanonicalBlock[]
  readonly toolCallId: string | null
  readonly isError: boolean
  readonly replayState: unknown
}

/**
 * Expected assistant publication. Bind the dsh message id only after the next
 * request contains this publication.
 */
export interface PendingPublication {
  readonly projectedContentHash: string
  readonly nativeMessageIds: readonly string[]
  readonly replayHash: string
  readonly blocks: readonly CanonicalBlock[]
  readonly callIds: readonly string[]
  readonly boundMessageId: string | null
}

export interface TranscriptState {
  readonly committed: readonly CanonicalMessage[]
  readonly pending: PendingPublication | undefined
  readonly dispatchedHash: string | undefined
}

export interface ToolResultInput {
  readonly callId: string
  readonly text: string
  readonly isError: boolean
}

export type Admission =
  | {
    readonly kind: 'first-user'
    readonly userText: string
    readonly requestHash: string
    readonly committed: readonly CanonicalMessage[]
  }
  | {
    readonly kind: 'next-user'
    readonly userText: string
    readonly requestHash: string
    readonly committed: readonly CanonicalMessage[]
    readonly boundMessageId: string
  }
  | {
    readonly kind: 'tool-results'
    readonly results: readonly ToolResultInput[]
    readonly requestHash: string
    readonly committed: readonly CanonicalMessage[]
    readonly boundMessageId: string
  }

interface LooseBlock {
  readonly type?: unknown
  readonly text?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
}

interface LooseMessage {
  readonly role: string
  readonly id?: unknown
  readonly content: readonly LooseBlock[]
  readonly toolCallId?: unknown
  readonly isError?: unknown
  readonly source?: object
}

/** Compare one request with the stored prefix and the pending publication. */
export function admitTranscript(input: {
  readonly messages: readonly LooseMessage[]
  readonly waitingForResults: boolean
  readonly state: TranscriptState
}): Admission {
  const projected = projectMessages(input.messages)
  const requestHash = contentHash(projected)
  if (input.state.dispatchedHash !== undefined && input.state.dispatchedHash === requestHash) {
    throw pluginFailure(
      'NATIVE_OUTCOME_UNKNOWN',
      'This request was already dispatched. It was not sent again.',
    )
  }
  if (input.state.pending === undefined) {
    if (input.state.committed.length > 0) {
      throw pluginFailure('REPLAY_STATE_INVALID', 'The generation has committed input and no pending publication.')
    }
    if (projected.some((message) => message.role === 'assistant' || message.role === 'tool')) {
      throw pluginFailure('REPLAY_STATE_INVALID', 'The first request contains an assistant message or a tool result.')
    }
    return {
      kind: 'first-user',
      userText: lastUserText(projected),
      requestHash,
      committed: freezeMessages(projected),
    }
  }
  const prefix = projected.slice(0, input.state.committed.length)
  if (!sameMessages(prefix, input.state.committed)) {
    throw pluginFailure('REBASE_REQUIRED', 'Earlier message content, identity, or order changed.')
  }
  const split = splitAtAssistant(projected, input.state.committed.length)
  const boundMessageId = matchPublication(split.assistant, input.state.pending)
  const published = freezeMessage({ ...split.assistant, id: boundMessageId })
  if (input.waitingForResults) {
    const results = toolSuffix(split.rest)
    return {
      kind: 'tool-results',
      results,
      requestHash,
      committed: freezeMessages([...split.prefix, published, ...split.rest]),
      boundMessageId,
    }
  }
  if (split.rest.length !== 1 || split.rest[0]?.role !== 'user') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'The continuation needs one new user message.')
  }
  return {
    kind: 'next-user',
    userText: textOf(split.rest[0]),
    requestHash,
    committed: freezeMessages([...split.prefix, published, ...split.rest]),
    boundMessageId,
  }
}

/** True when a restored request already carries replay data. */
export function requestHasReplay(messages: readonly LooseMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant' && replayStateOf(message.source) !== null)
}

export function projectMessages(messages: readonly LooseMessage[]): CanonicalMessage[] {
  return messages.map((message) => {
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') {
      throw pluginFailure('UNSUPPORTED_INPUT', `The message role "${message.role}" is not supported.`)
    }
    const blocks = message.content.map((block) => projectBlock(block))
    return {
      role: message.role,
      id: typeof message.id === 'string' && message.id.trim() !== '' ? message.id : null,
      blocks,
      toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : null,
      isError: message.isError === true,
      replayState: message.role === 'assistant' ? replayStateOf(message.source) : null,
    }
  })
}

export function publicationFrom(input: {
  readonly blocks: readonly CanonicalBlock[]
  readonly nativeMessageIds: readonly string[]
  readonly replay: ReplayV1
  readonly callIds: readonly string[]
}): PendingPublication {
  const envelope = { response: input.replay }
  return {
    projectedContentHash: contentHash(input.blocks),
    nativeMessageIds: [...input.nativeMessageIds],
    replayHash: contentHash(envelope),
    blocks: input.blocks.map((block) => ({ ...block })),
    callIds: [...input.callIds],
    boundMessageId: null,
  }
}

function replayStateOf(source: object | undefined): unknown {
  if (source === undefined || !('replayState' in source)) return null
  return source.replayState ?? null
}

function projectBlock(block: LooseBlock): CanonicalBlock {
  if (block.type === 'text') {
    if (typeof block.text !== 'string') throw pluginFailure('UNSUPPORTED_INPUT', 'A text block has no text.')
    return { type: 'text', text: block.text, id: '', name: '', arguments: '' }
  }
  if (block.type === 'reasoning') {
    if (typeof block.text !== 'string') throw pluginFailure('UNSUPPORTED_INPUT', 'A reasoning block has no text.')
    return { type: 'reasoning', text: block.text, id: '', name: '', arguments: '' }
  }
  if (block.type === 'tool-call') {
    if (typeof block.id !== 'string' || typeof block.name !== 'string' || typeof block.arguments !== 'string') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'A tool call is missing its id, name, or arguments.')
    }
    return { type: 'tool-call', text: '', id: block.id, name: block.name, arguments: block.arguments }
  }
  const type = typeof block.type === 'string' ? block.type : 'unknown'
  throw pluginFailure('UNSUPPORTED_INPUT', `The content type "${type}" is not supported.`)
}

function splitAtAssistant(messages: readonly CanonicalMessage[], prefixLength: number): {
  readonly prefix: readonly CanonicalMessage[]
  readonly assistant: CanonicalMessage
  readonly rest: readonly CanonicalMessage[]
} {
  const prefix = messages.slice(0, prefixLength)
  const assistant = messages[prefixLength]
  if (assistant === undefined || assistant.role !== 'assistant') {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The pending assistant publication is missing.')
  }
  const laterAssistant = messages.slice(prefixLength + 1).some((message) => message.role === 'assistant')
  if (laterAssistant) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The request contains more than one new assistant publication.')
  }
  return { prefix, assistant, rest: messages.slice(prefixLength + 1) }
}

function matchPublication(message: CanonicalMessage, pending: PendingPublication): string {
  if (message.id === null) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The published assistant message has no durable id.')
  }
  if (pending.boundMessageId !== null && pending.boundMessageId !== message.id) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The published assistant id changed.')
  }
  if (canonicalJson(message.blocks) !== canonicalJson(pending.blocks)) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The published assistant content changed.')
  }
  if (message.replayState === null) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The published assistant message has no replay data.')
  }
  parseReplayEnvelope(message.replayState)
  if (contentHash(message.replayState) !== pending.replayHash) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The published replay data changed.')
  }
  return message.id
}

function toolSuffix(messages: readonly CanonicalMessage[]): ToolResultInput[] {
  if (messages.length === 0) {
    throw pluginFailure('TOOL_RESULT_MISMATCH', 'The tool-result suffix is empty.')
  }
  if (messages.some((message) => message.role !== 'tool')) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A user message cannot enter a tool-result suffix.')
  }
  return messages.map((message) => {
    if (message.toolCallId === null || message.toolCallId.trim() === '') {
      throw pluginFailure('TOOL_RESULT_MISMATCH', 'A tool result has no call id.')
    }
    const text = message.blocks.map((block) => {
      if (block.type !== 'text') {
        throw pluginFailure('UNSUPPORTED_INPUT', 'A tool result contains unsupported content.')
      }
      return block.text
    }).join('')
    return { callId: message.toolCallId, text, isError: message.isError }
  })
}

function lastUserText(messages: readonly CanonicalMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return textOf(message)
  }
  throw pluginFailure('UNSUPPORTED_INPUT', 'The request has no user text.')
}

function textOf(message: CanonicalMessage): string {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type !== 'text') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The user message contains unsupported content.')
    }
    parts.push(block.text)
  }
  return parts.join('')
}

function sameMessages(left: readonly CanonicalMessage[], right: readonly CanonicalMessage[]): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function freezeMessages(messages: readonly CanonicalMessage[]): readonly CanonicalMessage[] {
  return messages.map((message) => freezeMessage(message))
}

function freezeMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    role: message.role,
    id: message.id,
    blocks: message.blocks.map((block) => ({ ...block })),
    toolCallId: message.toolCallId,
    isError: message.isError,
    replayState: message.replayState === null ? null : JSON.parse(canonicalJson(message.replayState)) as unknown,
  }
}
