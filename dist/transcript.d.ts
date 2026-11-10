import { type ReplayV1 } from './replay.js';
/** One frozen request snapshot. Later checks compare this value. They do not change it. */
export interface RequestSnapshot {
    readonly requestPrefixHash: string;
    readonly projectedContentHash: string;
}
export interface CanonicalBlock {
    readonly type: 'text' | 'reasoning' | 'tool-call';
    readonly text: string;
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
}
export interface CanonicalMessage {
    readonly role: string;
    readonly id: string | null;
    readonly blocks: readonly CanonicalBlock[];
    readonly toolCallId: string | null;
    readonly isError: boolean;
    readonly replayState: unknown;
}
/**
 * Expected assistant publication. Bind the dsh message id only after the next
 * request contains this publication.
 */
export interface PendingPublication {
    readonly projectedContentHash: string;
    readonly nativeMessageIds: readonly string[];
    readonly replayHash: string;
    readonly blocks: readonly CanonicalBlock[];
    readonly callIds: readonly string[];
    readonly boundMessageId: string | null;
}
export interface TranscriptState {
    readonly committed: readonly CanonicalMessage[];
    readonly pending: PendingPublication | undefined;
    readonly dispatchedHash: string | undefined;
}
export interface ToolResultInput {
    readonly callId: string;
    readonly text: string;
    readonly isError: boolean;
}
export type Admission = {
    readonly kind: 'first-user';
    readonly userText: string;
    readonly requestHash: string;
    readonly committed: readonly CanonicalMessage[];
} | {
    readonly kind: 'next-user';
    readonly userText: string;
    readonly requestHash: string;
    readonly committed: readonly CanonicalMessage[];
    readonly boundMessageId: string;
} | {
    readonly kind: 'tool-results';
    readonly results: readonly ToolResultInput[];
    readonly requestHash: string;
    readonly committed: readonly CanonicalMessage[];
    readonly boundMessageId: string;
};
interface LooseBlock {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly id?: unknown;
    readonly name?: unknown;
    readonly arguments?: unknown;
}
interface LooseMessage {
    readonly role: string;
    readonly id?: unknown;
    readonly content: readonly LooseBlock[];
    readonly toolCallId?: unknown;
    readonly isError?: unknown;
    readonly source?: object;
}
/** Compare one request with the stored prefix and the pending publication. */
export declare function admitTranscript(input: {
    readonly messages: readonly LooseMessage[];
    readonly waitingForResults: boolean;
    readonly state: TranscriptState;
}): Admission;
/** True when a restored request already carries replay data. */
export declare function requestHasReplay(messages: readonly LooseMessage[]): boolean;
export declare function projectMessages(messages: readonly LooseMessage[]): CanonicalMessage[];
export declare function publicationFrom(input: {
    readonly blocks: readonly CanonicalBlock[];
    readonly nativeMessageIds: readonly string[];
    readonly replay: ReplayV1;
    readonly callIds: readonly string[];
}): PendingPublication;
export {};
