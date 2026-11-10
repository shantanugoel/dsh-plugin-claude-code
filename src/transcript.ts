import { pluginFailure } from './errors.js'

/** One frozen request snapshot. Later checks compare this value. They do not change it. */
export interface RequestSnapshot {
  readonly requestPrefixHash: string
  readonly projectedContentHash: string
}

/**
 * Expected assistant publication. Bind the dsh message id only after the next
 * request contains this publication.
 */
export interface PendingPublication {
  readonly projectedContentHash: string
  readonly nativeMessageIds: readonly string[]
}

export interface ToolResultInput {
  readonly callId: string
  readonly text: string
  readonly isError: boolean
}

interface RequestMessage {
  readonly role: string
  readonly content: readonly { readonly type?: unknown; readonly text?: unknown }[]
  readonly toolCallId?: unknown
  readonly isError?: unknown
}

/** Text of the latest user message. Other content types are refused. */
export function latestUserText(messages: readonly RequestMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    const parts: string[] = []
    for (const block of message.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') {
        throw pluginFailure('UNSUPPORTED_INPUT', 'The user message contains unsupported content.')
      }
      parts.push(block.text)
    }
    return parts.join('')
  }
  throw pluginFailure('UNSUPPORTED_INPUT', 'The request has no user text.')
}

/**
 * Tool results at the end of the request, in stored order.
 * A user message after a tool result is not included.
 */
export function trailingToolResults(messages: readonly RequestMessage[]): {
  readonly results: readonly ToolResultInput[]
  readonly endsWithUser: boolean
} {
  const results: ToolResultInput[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'tool') break
    if (typeof message.toolCallId !== 'string' || message.toolCallId.trim() === '') {
      throw pluginFailure('TOOL_RESULT_MISMATCH', 'A tool result has no call id.')
    }
    const parts: string[] = []
    for (const block of message.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') {
        throw pluginFailure('UNSUPPORTED_INPUT', 'A tool result contains unsupported content.')
      }
      parts.push(block.text)
    }
    results.push({
      callId: message.toolCallId,
      text: parts.join(''),
      isError: message.isError === true,
    })
  }
  results.reverse()
  const last = messages.at(-1)
  return { results, endsWithUser: last?.role === 'user' }
}
