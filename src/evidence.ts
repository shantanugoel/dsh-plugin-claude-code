import { pluginFailure } from './errors.js'

const MAX_EVIDENCE_BYTES = 1_048_576

/**
 * Report whether a value is complete native-request evidence.
 * Missing, redacted, or truncated data is not an audit success.
 * A short marker such as `{ nativeRequestRecord: 'present' }` is not evidence.
 */
export function retentionProofAccepted(record: unknown): boolean {
  if (!isRecord(record)) return false
  if (record['status'] !== 'complete') return false
  if (record['redacted'] !== false) return false
  if (record['truncated'] !== false) return false
  const body = record['body']
  if (!isRecord(body)) return false
  const messages = body['messages']
  if (!Array.isArray(messages) || messages.length === 0) return false
  return evidenceBytes(record) <= MAX_EVIDENCE_BYTES
}

/**
 * Refuse evidence that cannot be stored whole.
 * This function does not shorten signed content.
 */
export function assertEvidenceFits(record: unknown): void {
  if (record === undefined || record === null) return
  if (evidenceBytes(record) <= MAX_EVIDENCE_BYTES) return
  throw pluginFailure(
    'MALFORMED_RESPONSE',
    'The native request evidence does not fit. It was not truncated.',
  )
}

function evidenceBytes(record: unknown): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
