import { type Deadlines } from './deadlines.js';
import type { McpBridge } from './mcp-bridge.js';
import type { NativeEvent, NativeSession } from './sdk-runtime.js';
import type { PendingToolCall } from './stream.js';
import type { CanonicalMessage, PendingPublication } from './transcript.js';
/** Live session phases. A generation that enters INVALID does not return to READY. */
export type SessionPhase = 'NEW' | 'STARTING' | 'READY' | 'GENERATING' | 'WAITING_FOR_RESULTS' | 'INVALID' | 'CLOSED';
export interface LiveGeneration {
    readonly key: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly auxiliary: boolean;
    phase: SessionPhase;
    readonly native: NativeSession;
    readonly bridge: McpBridge;
    readonly iterator: AsyncIterator<NativeEvent>;
    readonly model: string;
    readonly workspace: string;
    readonly systemPrompt: string;
    readonly toolsCanonical: string;
    readonly toolNameMap: Readonly<Record<string, string>>;
    readonly nativeToDsh: ReadonlyMap<string, string>;
    readonly dshNames: ReadonlySet<string>;
    readonly allowedNativeTools: ReadonlySet<string>;
    readonly deadlines: Deadlines;
    pendingCalls: readonly PendingToolCall[];
    committed: readonly CanonicalMessage[];
    pending: PendingPublication | undefined;
    dispatchedHash: string | undefined;
}
/**
 * Owned native sessions. Close is safe to call more than once.
 */
export declare class SessionManager {
    private readonly live;
    private readonly admitting;
    private readonly generationCount;
    size(): number;
    get(key: string): LiveGeneration | undefined;
    conversation(sessionId: string): LiveGeneration | undefined;
    insert(session: LiveGeneration): void;
    /** Allocate the next generation id for one dsh session. */
    nextGeneration(sessionId: string): string;
    /** Reserve one key before the first await. A second admission fails closed. */
    tryAdmit(key: string): void;
    endAdmit(key: string): void;
    closeKey(key: string): Promise<void>;
    closeOwned(): Promise<void>;
}
