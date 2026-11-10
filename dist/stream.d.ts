import { type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm';
import type { CanonicalBlock } from './transcript.js';
import type { NativeEvent } from './sdk-runtime.js';
export interface PendingToolCall {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
}
export interface NativeResponseBlock {
    readonly type: 'text' | 'thinking' | 'redacted-thinking' | 'tool-use';
    readonly text?: string;
    readonly signature?: string;
    readonly data?: string;
    readonly id?: string;
    readonly name?: string;
    readonly arguments?: string;
}
export interface TranslatedTurn {
    readonly chunks: StreamChunk[];
    readonly pendingCalls: readonly PendingToolCall[];
    readonly stopReason: 'end_turn' | 'tool_use';
    readonly blocks: readonly CanonicalBlock[];
    readonly nativeBlocks: readonly NativeResponseBlock[];
    readonly nativeMessageIds: readonly string[];
    readonly usage: TokenUsage;
    readonly evidence: unknown;
    readonly auditAccepted: boolean;
}
export interface TranslateInput {
    readonly nativeToDsh: ReadonlyMap<string, string>;
    readonly dshNames: ReadonlySet<string>;
    readonly allowedNativeTools: ReadonlySet<string>;
}
/** Identity of one native block. Partial events and the final block share this key. */
export declare function blockKey(messageId: string, index: number): string;
/**
 * Translate one complete native turn into dsh chunks.
 * A repeated partial event and its completed snapshot become one block.
 * Malformed tool arguments throw before a tool chunk is returned.
 */
export declare function translateTurn(events: readonly NativeEvent[], input: TranslateInput): TranslatedTurn;
export declare function readUntilStop(iterator: AsyncIterator<NativeEvent>, timeoutMs: number, signal?: AbortSignal): Promise<NativeEvent[]>;
export declare function isAbortError(error: unknown): boolean;
