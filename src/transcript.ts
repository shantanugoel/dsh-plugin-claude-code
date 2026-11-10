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
