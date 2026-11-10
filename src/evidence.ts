/**
 * Report whether a value is complete native-request evidence.
 * No value is accepted. Missing, redacted, or truncated data is not an audit success.
 */
export function retentionProofAccepted(_record: unknown): false {
  return false
}
