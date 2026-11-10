/**
 * Successful response-level replay data. Store it as `{ response: replayV1 }`.
 * Do not add a `blocks` field.
 */
export interface ReplayV1 {
    readonly format: 'claude-session-v1';
    readonly generationId: string;
    readonly cliSessionId: string;
    readonly cliVersion: string;
    readonly sdkVersion: string;
    readonly model: string;
    readonly workspace: string;
    readonly requestPrefixHash: string;
    readonly projectedContentHash: string;
    readonly nativeRequestRecord: unknown;
    readonly nativeResponseBlocks: readonly unknown[];
    readonly toolNameMap: Readonly<Record<string, string>>;
    readonly retentionAudit: 'accepted' | 'unavailable';
}
/** Refuse the per-block replay shape. Response-level data has no `blocks` field. */
export declare function rejectBlockReplay(value: unknown): void;
/** Read one response envelope. A missing or changed field is refused. */
export declare function parseReplayEnvelope(value: unknown): ReplayV1;
export declare function parseReplay(value: unknown): ReplayV1;
