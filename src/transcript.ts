import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import { canonicalJson, contentHash } from './canonical.js'
import { pluginFailure } from './errors.js'
import { isNativeImageMediaType, type OutgoingBlock } from './images.js'
import { parseReplayEnvelope, type GenerationChangeV1, type ReplayV1 } from './replay.js'

/** One frozen request snapshot. Later checks compare this value. They do not change it. */
export interface RequestSnapshot {
  readonly requestPrefixHash: string
  readonly projectedContentHash: string
}

/**
 * One canonical content block. The canonical form holds an image by its
 * durable attachment reference, not by request bytes. The `offloaded`
 * projection flag is left out because an image-offload decision changes later
 * request text, not the logged message identity.
 */
export type CanonicalBlock =
  | {
    readonly type: 'text'
    readonly text: string
    readonly id: ''
    readonly name: ''
    readonly arguments: ''
  }
  | {
    readonly type: 'reasoning'
    readonly text: string
    readonly id: ''
    readonly name: ''
    readonly arguments: ''
  }
  | {
    readonly type: 'tool-call'
    readonly text: ''
    readonly id: string
    readonly name: string
    readonly arguments: string
  }
  | {
    readonly type: 'image'
    readonly attachment: ImageAttachmentRef
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
  readonly content: readonly OutgoingBlock[]
  readonly isError: boolean
}

export type Admission =
  | {
    readonly kind: 'first-user'
    readonly userContent: readonly OutgoingBlock[]
    readonly requestHash: string
    readonly committed: readonly CanonicalMessage[]
  }
  | {
    readonly kind: 'next-user'
    readonly userContent: readonly OutgoingBlock[]
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
  | {
    /**
     * A recovered request starts a new native generation. The committed value
     * is the complete frozen dsh request, so the next request compares equal.
     * `generationChange` is the recorded import for that new generation.
     */
    readonly kind: 'recovered'
    readonly requestHash: string
    readonly committed: readonly CanonicalMessage[]
    readonly generationChange: GenerationChangeV1
  }

interface LooseBlock {
  readonly type?: unknown
  readonly text?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
  readonly attachment?: unknown
  readonly offloaded?: unknown
}

export interface LooseMessage {
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
    const userIndex = firstUserIndex(projected)
    for (let index = 0; index < userIndex; index += 1) {
      const message = projected[index]
      if (message?.role !== 'system') {
        throw pluginFailure('UNSUPPORTED_INPUT', 'The first request can send only system messages before its user messages.')
      }
    }
    for (let index = userIndex; index < projected.length; index += 1) {
      if (projected[index]?.role !== 'user') {
        throw pluginFailure('UNSUPPORTED_INPUT', 'The first request can send only user messages after its system prompt.')
      }
    }
    const userContent = input.messages
      .slice(userIndex)
      .flatMap((message) => outgoingBlocks(message.content))
    if (userContent.length === 0) {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The request has an empty user message.')
    }
    return {
      kind: 'first-user',
      userContent,
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
    const rawSuffix = input.messages.slice(input.state.committed.length + 1)
    const results = toolSuffix(rawSuffix)
    return {
      kind: 'tool-results',
      results,
      requestHash,
      committed: freezeMessages([...split.prefix, published, ...split.rest]),
      boundMessageId,
    }
  }
  if (split.rest.length === 0 || split.rest.some((message) => message.role !== 'user')) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'The continuation needs one or more new user messages.')
  }
  const rawSuffix = input.messages.slice(input.state.committed.length + 1)
  const userContent = rawSuffix.flatMap((message) => outgoingBlocks(message.content))
  if (userContent.length === 0) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'The request has an empty user message.')
  }
  return {
    kind: 'next-user',
    userContent,
    requestHash,
    committed: freezeMessages([...split.prefix, published, ...split.rest]),
    boundMessageId,
  }
}

/** True when a restored request already carries replay data. */
export function requestHasReplay(messages: readonly LooseMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant' && replayStateOf(message.source) !== null)
}

/**
 * True when a new adapter instance has no live native process but the frozen
 * request already holds earlier conversation. This needs the recorded import.
 */
export function requestNeedsRecovery(messages: readonly LooseMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant' || message.role === 'tool')
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
    blocks: input.blocks.map((block) => freezeBlock(block)),
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
  if (block.type === 'image') {
    return { type: 'image', attachment: imageRefOf(block.attachment) }
  }
  const type = typeof block.type === 'string' ? block.type : 'unknown'
  throw pluginFailure('UNSUPPORTED_INPUT', `The content type "${type}" is not supported.`)
}

/** Read one message content as the blocks that this adapter sends natively. */
export function outgoingBlocks(blocks: readonly LooseBlock[]): OutgoingBlock[] {
  return blocks.map((block) => {
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw pluginFailure('UNSUPPORTED_INPUT', 'A text block has no text.')
      return { type: 'text', text: block.text }
    }
    if (block.type === 'image') {
      const attachment = imageRefOf(block.attachment)
      return block.offloaded === true
        ? { type: 'image', attachment, offloaded: true }
        : { type: 'image', attachment }
    }
    if (block.type === 'tool-call') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'A tool call cannot be sent as user content.')
    }
    if (block.type === 'reasoning') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'A reasoning block cannot be sent as user content.')
    }
    const type = typeof block.type === 'string' ? block.type : 'unknown'
    throw pluginFailure('UNSUPPORTED_INPUT', `The content type "${type}" cannot be sent as user content.`)
  })
}

function firstUserIndex(messages: readonly CanonicalMessage[]): number {
  const index = messages.findIndex((message) => message.role === 'user')
  if (index < 0) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'The request has no user text.')
  }
  return index
}

function imageRefOf(value: unknown): ImageAttachmentRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'An image block has no attachment reference.')
  }
  const record = value as Record<string, unknown>
  const attachmentId = record['attachmentId']
  const mediaType = record['mediaType']
  const bytes = record['bytes']
  const width = record['width']
  const height = record['height']
  const name = record['name']
  if (typeof attachmentId !== 'string' || attachmentId.trim() === '') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'An image attachment reference has no id.')
  }
  if (!isNativeImageMediaType(mediaType)) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'An image attachment reference has no supported media type.')
  }
  if (!isPositiveInteger(bytes) || !isPositiveInteger(width) || !isPositiveInteger(height)) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'An image attachment reference has invalid size metadata.')
  }
  const validName = typeof name === 'string' && name.trim() !== '' ? name : undefined
  if (name !== undefined && validName === undefined) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'An image attachment reference has an invalid name.')
  }
  const original = originalDimensionsOf(record['originalDimensions'])
  return {
    attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType,
    bytes,
    width,
    height,
    ...(validName === undefined ? {} : { name: validName }),
    ...(original === undefined ? {} : { originalDimensions: original }),
  }
}

function originalDimensionsOf(value: unknown): { readonly width: number; readonly height: number } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'An image attachment reference has invalid original dimensions.')
  }
  const record = value as Record<string, unknown>
  if (!isPositiveInteger(record['width']) || !isPositiveInteger(record['height'])) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'An image attachment reference has invalid original dimensions.')
  }
  return { width: record['width'], height: record['height'] }
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

function toolSuffix(messages: readonly LooseMessage[]): ToolResultInput[] {
  if (messages.length === 0) {
    throw pluginFailure('TOOL_RESULT_MISMATCH', 'The tool-result suffix is empty.')
  }
  if (messages.some((message) => message.role !== 'tool')) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A user message cannot enter a tool-result suffix.')
  }
  return messages.map((message) => {
    const toolCallId = message.toolCallId
    if (typeof toolCallId !== 'string' || toolCallId.trim() === '') {
      throw pluginFailure('TOOL_RESULT_MISMATCH', 'A tool result has no call id.')
    }
    return {
      callId: toolCallId,
      content: outgoingBlocks(message.content),
      isError: message.isError === true,
    }
  })
}

function sameMessages(left: readonly CanonicalMessage[], right: readonly CanonicalMessage[]): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export function freezeMessages(messages: readonly CanonicalMessage[]): readonly CanonicalMessage[] {
  return messages.map((message) => freezeMessage(message))
}

function freezeMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    role: message.role,
    id: message.id,
    blocks: message.blocks.map((block) => freezeBlock(block)),
    toolCallId: message.toolCallId,
    isError: message.isError,
    replayState: message.replayState === null ? null : JSON.parse(canonicalJson(message.replayState)) as unknown,
  }
}

function freezeBlock(block: CanonicalBlock): CanonicalBlock {
  if (block.type === 'image') {
    return {
      type: 'image',
      attachment: JSON.parse(canonicalJson(block.attachment)) as ImageAttachmentRef,
    }
  }
  return { ...block }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
