import type { NativeEvent } from './sdk-runtime.js';
interface LooseBlock {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly thinking?: unknown;
    readonly signature?: unknown;
    readonly data?: unknown;
    readonly id?: unknown;
    readonly name?: unknown;
    readonly input?: unknown;
}
interface LooseAssistantMessage {
    readonly id?: unknown;
    readonly content?: readonly LooseBlock[];
    readonly stop_reason?: unknown;
    readonly usage?: {
        readonly input_tokens?: unknown;
        readonly output_tokens?: unknown;
    };
}
/** Read a tool-call id from an MCP handler extra value. */
export declare function readToolUseId(extra: unknown): string | undefined;
/**
 * Translate one completed assistant message into native events.
 * Empty thinking text stays present when the block exists.
 */
export declare function eventsFromAssistant(message: LooseAssistantMessage): NativeEvent[];
export {};
