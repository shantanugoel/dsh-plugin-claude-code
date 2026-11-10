import type { Session, SessionStore } from '@deepseek-ai/dsh-session';
interface QuotedMessage {
    readonly role: string;
    readonly content: readonly {
        readonly type?: string;
        readonly text?: string;
        readonly name?: string;
    }[];
}
/**
 * Quote completed history for a new generation.
 * The text has no thinking blocks and no live tool-call ids.
 */
export declare function historicalContextText(messages: readonly QuotedMessage[]): string;
/**
 * Replace the model-visible conversation with one historical import.
 * The leading system prompt stays. The raw log keeps the earlier events.
 * Flush must have a durability listener before the import is complete.
 */
export declare function recordContextImport(input: {
    readonly session: Session;
    readonly sessions: Pick<SessionStore, 'flush'>;
}): Promise<{
    readonly text: string;
    readonly seq: number;
}>;
export {};
