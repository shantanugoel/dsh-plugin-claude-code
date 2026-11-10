/**
 * Report whether a value is complete native-request evidence.
 * Missing, redacted, or truncated data is not an audit success.
 * A short marker such as `{ nativeRequestRecord: 'present' }` is not evidence.
 */
export declare function retentionProofAccepted(record: unknown): boolean;
/**
 * Refuse evidence that cannot be stored whole.
 * This function does not shorten signed content.
 */
export declare function assertEvidenceFits(record: unknown): void;
