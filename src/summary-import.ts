import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import { contentHash } from './canonical.js'
import { pluginFailure } from './errors.js'
import { projectMessages, type CanonicalMessage, type LooseMessage } from './transcript.js'

/**
 * Auxiliary purposes that replay conversation history for a summary.
 * The harness names the automatic-compaction call `compaction`. `summary` is
 * the earlier harness name and keeps the same request shape.
 */
export const SUMMARY_PURPOSES: readonly string[] = ['compaction', 'summary']

export function isSummaryPurpose(purpose: string): boolean {
  return SUMMARY_PURPOSES.includes(purpose)
}

/** One deterministic textual import of a replayed conversation prefix. */
export interface SummaryImport {
  /** The only user input of the summary native session. The instruction is last. */
  readonly text: string
  /** Hash of the complete replayed request messages. */
  readonly requestHash: string
}

const IMPORT_HEADER = 'This is a recorded textual import of an earlier conversation for a summary. It is not the live signed native transcript. It contains no signed thinking blocks and no image bytes.'

const IMPORT_FOOTER = '--- End of the imported conversation. The instruction follows. ---'

/**
 * Flatten one replayed conversation prefix into one text input.
 *
 * The adapter sends this text to a separate native session. The transform is:
 * no signed thinking, no signature text, no live tool-call IDs, no image bytes,
 * and the final user message text verbatim at the end. It is a recorded
 * textual import. It does not retain a native signed prefix.
 */
export function buildSummaryImport(messages: readonly LooseMessage[]): SummaryImport {
  const projected = projectMessages(messages)
  const last = projected.at(-1)
  if (last === undefined || last.role !== 'user') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'The summary request does not end with a user instruction.')
  }
  const instruction = instructionTextOf(last)
  const parts: string[] = [IMPORT_HEADER]
  let sawConversation = false
  for (const message of projected.slice(0, -1)) {
    if (message.role === 'system') {
      if (sawConversation) {
        throw pluginFailure(
          'UNSUPPORTED_INPUT',
          'A summary request can send system messages only before its conversation rows.',
        )
      }
      continue
    }
    sawConversation = true
    const body = flattenMessage(message)
    if (body === '') continue
    parts.push(`[${messageLabel(message)}]\n${body}`)
  }
  parts.push(IMPORT_FOOTER)
  parts.push(instruction)
  return {
    text: parts.join('\n\n'),
    requestHash: contentHash(projected),
  }
}

function instructionTextOf(message: CanonicalMessage): string {
  const texts: string[] = []
  for (const block of message.blocks) {
    if (block.type !== 'text') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The summary instruction message must contain text only.')
    }
    texts.push(block.text)
  }
  const instruction = texts.join('\n')
  if (instruction.trim() === '') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'The summary instruction message is empty.')
  }
  return instruction
}

function flattenMessage(message: CanonicalMessage): string {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'text') {
      if (block.text !== '') parts.push(block.text)
      continue
    }
    if (block.type === 'tool-call') {
      parts.push(`[tool-call ${block.name}]\n${block.arguments}`)
      continue
    }
    if (block.type === 'image') {
      parts.push(imageLine(block.attachment))
      continue
    }
    // A reasoning block is signed thinking. It stays out of a textual import.
  }
  return parts.join('\n')
}

function messageLabel(message: CanonicalMessage): string {
  if (message.role === 'user') return 'user'
  if (message.role === 'assistant') return 'assistant'
  if (message.role === 'tool') return message.isError ? 'tool error' : 'tool result'
  throw pluginFailure('UNSUPPORTED_INPUT', `The summary request has the unsupported role "${message.role}".`)
}

function imageLine(attachment: ImageAttachmentRef): string {
  const name = attachment.name === undefined ? attachment.attachmentId : `${attachment.name} ${attachment.attachmentId}`
  return `[image ${attachment.mediaType} ${attachment.width}x${attachment.height} ${name}; image bytes are not in this textual import]`
}
