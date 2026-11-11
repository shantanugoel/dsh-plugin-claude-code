import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import { canonicalJson, contentHash } from './canonical.js'
import { pluginFailure } from './errors.js'
import type { OutgoingBlock } from './images.js'
import type { GenerationChangeReason, GenerationChangeV1 } from './replay.js'
import {
  freezeMessages,
  outgoingBlocks,
  projectMessages,
  type CanonicalBlock,
  type CanonicalMessage,
  type LooseMessage,
  type ToolResultInput,
} from './transcript.js'

/**
 * Upper bound of one bounded import text. The imported history is a recorded
 * summary for a new generation. The dsh log keeps the complete original events.
 */
export const IMPORT_MAX_CHARS = 120_000

/** Upper bound of one quoted text block in the import. */
export const IMPORT_MAX_TEXT_CHARS = 8_000

/** Upper bound of one quoted tool-argument value in the import. */
export const IMPORT_MAX_ARGUMENT_CHARS = 4_000

/** The closed generation that the new generation replaces. */
export interface RolloverDeadGeneration {
  readonly generationId: string
  readonly cliSessionId: string | null
  readonly committed: readonly CanonicalMessage[]
  readonly dispatchedMessages: readonly CanonicalMessage[] | undefined
  readonly dispatchedHash: string | undefined
}

export interface RolloverInput {
  readonly messages: readonly LooseMessage[]
  readonly reason: GenerationChangeReason
  readonly dead?: RolloverDeadGeneration
  readonly now?: Date
}

/**
 * One recovery plan. It holds no native bytes and no signature.
 * `committed` is the frozen dsh request, so the next request compares equal.
 */
export interface RolloverPlan {
  readonly requestHash: string
  readonly committed: readonly CanonicalMessage[]
  readonly importedMessages: readonly CanonicalMessage[]
  readonly importedText: string
  readonly pendingUserContent: readonly OutgoingBlock[]
  readonly pendingToolResults: readonly ToolResultInput[]
  readonly generationChange: GenerationChangeV1
}

/**
 * Split a frozen request into the history to import and the current content.
 *
 * Rules, in order:
 * 1. An exact second copy of a dispatched request is refused. It can have
 *    reached the model already.
 * 2. The history ends at the last assistant message. A tool batch after that
 *    message is a completed tool outcome and is quoted in the import.
 * 3. Without an assistant message, the last dispatched request or the
 *    committed prefix of the dead generation is the history boundary.
 *
 * The caller sends `importedText` plus `pendingUserContent` as one user turn.
 * The function does not read image bytes and does not include a signature.
 */
export function planRollover(input: RolloverInput): RolloverPlan {
  const projected = projectMessages(input.messages)
  if (projected.length === 0) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'The recovery request has no message.')
  }
  const requestHash = contentHash(projected)
  const dead = input.dead
  if (dead?.dispatchedHash !== undefined && dead.dispatchedHash === requestHash) {
    throw pluginFailure(
      'NATIVE_OUTCOME_UNKNOWN',
      'This request was already dispatched. It was not sent again.',
    )
  }
  const split = splitBoundary(projected, input.messages, dead)
  const importedText = historicalImportText({
    imported: split.importedMessages,
    hasPendingUserContent: split.pendingUserContent.length > 0,
  })
  const generationChange: GenerationChangeV1 = {
    reason: input.reason,
    fromGenerationId: dead?.generationId ?? null,
    fromCliSessionId: dead?.cliSessionId ?? null,
    importedMessageCount: split.importedMessages.length,
    importedPrefixHash: contentHash(split.importedMessages),
    createdAt: (input.now ?? new Date()).toISOString(),
  }
  return {
    requestHash,
    committed: freezeMessages(projected),
    importedMessages: split.importedMessages,
    importedText,
    pendingUserContent: split.pendingUserContent,
    pendingToolResults: split.pendingToolResults,
    generationChange,
  }
}

interface BoundarySplit {
  readonly importedMessages: readonly CanonicalMessage[]
  readonly pendingUserContent: readonly OutgoingBlock[]
  readonly pendingToolResults: readonly ToolResultInput[]
}

function splitBoundary(
  projected: readonly CanonicalMessage[],
  raw: readonly LooseMessage[],
  dead: RolloverDeadGeneration | undefined,
): BoundarySplit {
  const lastAssistant = findLastAssistant(projected)
  if (lastAssistant >= 0) {
    const tail = projected.slice(lastAssistant + 1)
    let toolCount = 0
    while (toolCount < tail.length && tail[toolCount]?.role === 'tool') toolCount += 1
    const toolMessages = tail.slice(0, toolCount)
    const userMessages = tail.slice(toolCount)
    if (userMessages.some((message) => message.role !== 'user')) {
      throw pluginFailure(
        'UNSUPPORTED_INPUT',
        'The recovery request has content after a tool-result batch that is not user input.',
      )
    }
    if (toolMessages.length === 0 && userMessages.length === 0) {
      throw pluginFailure(
        'UNSUPPORTED_INPUT',
        'The recovery request has no new user input or tool result.',
      )
    }
    const assistant = projected[lastAssistant]
    if (assistant === undefined) {
      throw pluginFailure('REPLAY_STATE_INVALID', 'The recovery history has no assistant message.')
    }
    const pendingToolResults = toolMessages.length === 0
      ? []
      : toolResultsOf(assistant, toolMessages)
    const importedMessages: CanonicalMessage[] = [
      ...projected.slice(0, lastAssistant + 1),
      ...toolMessages,
    ]
    const pendingRaw = raw.slice(lastAssistant + 1 + toolCount)
    const pendingUserContent = pendingRaw.flatMap((message) => outgoingBlocks(message.content))
    return { importedMessages, pendingUserContent, pendingToolResults }
  }
  if (dead === undefined) {
    throw pluginFailure(
      'REPLAY_STATE_INVALID',
      'The recovery request has no assistant history and no closed generation.',
    )
  }
  const boundary = matchingPrefixLength(projected, dead.dispatchedMessages)
    ?? matchingPrefixLength(projected, dead.committed)
  if (boundary === undefined) {
    throw pluginFailure(
      'REBASE_REQUIRED',
      'Earlier message content, identity, or order changed. This recovery cannot import the prefix.',
    )
  }
  const importedMessages = projected.slice(0, boundary).filter((message) => message.role !== 'system')
  const pending = projected.slice(boundary)
  if (pending.length === 0) {
    throw pluginFailure(
      'UNSUPPORTED_INPUT',
      'The recovery request has no new user input or tool result.',
    )
  }
  if (pending.some((message) => message.role !== 'user')) {
    throw pluginFailure(
      'UNSUPPORTED_INPUT',
      'The recovery request after its history has a message that is not user input.',
    )
  }
  const pendingRaw = raw.slice(boundary)
  return {
    importedMessages,
    pendingUserContent: pendingRaw.flatMap((message) => outgoingBlocks(message.content)),
    pendingToolResults: [],
  }
}

function findLastAssistant(messages: readonly CanonicalMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return index
  }
  return -1
}

/** Index of the complete prefix, or undefined when the prefix does not match. */
function matchingPrefixLength(
  projected: readonly CanonicalMessage[],
  prefix: readonly CanonicalMessage[] | undefined,
): number | undefined {
  if (prefix === undefined || prefix.length === 0 || prefix.length > projected.length) return undefined
  if (canonicalJson(projected.slice(0, prefix.length)) !== canonicalJson(prefix)) return undefined
  return prefix.length
}

function toolResultsOf(
  assistant: CanonicalMessage,
  messages: readonly CanonicalMessage[],
): ToolResultInput[] {
  const callIds = assistant.blocks.flatMap((block) => block.type === 'tool-call' ? [block.id] : [])
  if (callIds.length !== messages.length) {
    throw pluginFailure(
      'TOOL_RESULT_MISMATCH',
      'The recovery tool-result batch does not match the pending tool calls.',
    )
  }
  return messages.map((message, index) => {
    const callId = message.toolCallId
    if (callId === null || callId !== callIds[index]) {
      throw pluginFailure(
        'TOOL_RESULT_MISMATCH',
        'The recovery tool-result batch does not match the pending tool calls.',
      )
    }
    return {
      callId,
      content: canonicalOutgoing(message.blocks),
      isError: message.isError,
    }
  })
}

function canonicalOutgoing(blocks: readonly CanonicalBlock[]): OutgoingBlock[] {
  return blocks.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'reasoning') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'A reasoning block cannot be tool-result content.')
    }
    if (block.type === 'tool-call') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'A tool call cannot be tool-result content.')
    }
    return { type: 'image', attachment: block.attachment }
  })
}

/**
 * Build the deterministic bounded import text.
 * It quotes text verbatim, quotes tool names and arguments, and quotes complete
 * tool outcomes. It replaces each image with its attachment id.
 */
export function historicalImportText(input: {
  readonly imported: readonly CanonicalMessage[]
  readonly hasPendingUserContent: boolean
}): string {
  const lines: string[] = [
    'Historical context for a new Claude session.',
    'This text is the recorded import of an earlier dsh conversation. The earlier native session is closed.',
    'This context has no signed thinking, no reasoning text, and no signature.',
    'There are no live tool calls. Each tool outcome below is complete. This text does not show tool call ids.',
    'Each image below is a placeholder with its attachment id. The image bytes are not in this text.',
  ]
  let budget = IMPORT_MAX_CHARS
  const outcomes = completedOutcomeIds(input.imported)
  for (const [index, message] of input.imported.entries()) {
    const section = renderMessage(message, outcomes)
    if (section === '') continue
    if (section.length > budget) {
      lines.push(`[... ${input.imported.length - index} later messages omitted from this bounded import ...]`)
      budget = 0
      break
    }
    lines.push(section)
    budget -= section.length + 1
  }
  if (input.hasPendingUserContent) {
    lines.push('## Current request')
    lines.push('The current dsh user input follows after this text.')
  } else {
    lines.push('## Current request')
    lines.push('The completed tool outcomes above are the current dsh input. Continue the task and write the next assistant message.')
  }
  return lines.join('\n')
}

function renderMessage(message: CanonicalMessage, outcomes: ReadonlySet<string>): string {
  if (message.role === 'system') return ''
  if (message.role === 'user') {
    const body = renderUserBlocks(message.blocks)
    return body === '' ? '' : `## User message\n${body}`
  }
  if (message.role === 'tool') {
    const label = message.isError
      ? '## Tool outcome (completed with an error)'
      : '## Tool outcome (completed)'
    const body = renderResultBlocks(message.blocks)
    return `${label}\n${body}`
  }
  if (message.role === 'assistant') {
    const parts: string[] = []
    const text = message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.type === 'text' ? quoteBounded(block.text, IMPORT_MAX_TEXT_CHARS) : '')
      .join('\n')
    if (text !== '') parts.push(`## Assistant message\n${text}`)
    for (const block of message.blocks) {
      if (block.type !== 'tool-call') continue
      const completed = outcomes.has(block.id) ? 'yes' : 'no'
      parts.push([
        '## Assistant tool call',
        `Tool name: ${JSON.stringify(block.name)}`,
        `Tool arguments: ${quoteBounded(block.arguments, IMPORT_MAX_ARGUMENT_CHARS)}`,
        `Completed outcome in this import: ${completed}`,
      ].join('\n'))
    }
    return parts.join('\n')
  }
  return ''
}

function renderUserBlocks(blocks: readonly CanonicalBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') lines.push(quoteBounded(block.text, IMPORT_MAX_TEXT_CHARS))
    else if (block.type === 'image') lines.push(imagePlaceholder(block.attachment))
    else if (block.type === 'reasoning') continue
    else lines.push('[... unsupported historical block omitted ...]')
  }
  return lines.join('\n')
}

function renderResultBlocks(blocks: readonly CanonicalBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') lines.push(quoteBounded(block.text, IMPORT_MAX_TEXT_CHARS))
    else if (block.type === 'image') lines.push(imagePlaceholder(block.attachment))
    else lines.push('[... unsupported historical result block omitted ...]')
  }
  return lines.join('\n')
}

function imagePlaceholder(attachment: ImageAttachmentRef): string {
  return `[Image attachment ${String(attachment.attachmentId)}, ${attachment.mediaType}. The image bytes are not in this text.]`
}

function completedOutcomeIds(messages: readonly CanonicalMessage[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId !== null) ids.add(message.toolCallId)
  }
  return ids
}

/** Quote one string as JSON. A longer string gets a deterministic omission mark. */
export function quoteBounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return JSON.stringify(text)
  const omitted = text.length - maxChars
  return `${JSON.stringify(text.slice(0, maxChars))} [... ${omitted} characters omitted ...]`
}
