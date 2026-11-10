import { pluginFailure } from './errors.js'

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
