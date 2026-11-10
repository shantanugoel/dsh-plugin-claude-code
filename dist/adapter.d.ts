import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AuthGuard, HomeSource } from './auth.js';
import { type WorkspaceSource } from './context.js';
import { type Deadlines } from './deadlines.js';
import type { DiscoveredModel } from './model-discovery.js';
import type { NativeRuntime } from './sdk-runtime.js';
import type { SessionManager } from './session-manager.js';
import type { Session, SessionStore } from '@deepseek-ai/dsh-session';
import type { SpendGate } from './spend-gate.js';
export interface AdapterDependencies {
    readonly runtime: NativeRuntime;
    readonly spendGate: SpendGate;
    readonly sessions: SessionManager;
    readonly workspace: WorkspaceSource;
    readonly auth: AuthGuard;
    readonly home: HomeSource;
    readonly parentEnv: () => NodeJS.ProcessEnv;
    readonly deadlines: Deadlines;
    readonly settingsFiles?: () => readonly string[];
    readonly configuration?: {
        current(): number;
    };
    readonly catalog?: readonly DiscoveredModel[];
    readonly discoverModels?: () => Promise<readonly DiscoveredModel[]>;
}
/**
 * dsh adapter for route `claude-code-session`.
 * A model prompt cannot leave this object while the spend gate refuses.
 */
export declare class ClaudeCodeAdapter extends LlmAdapter {
    private readonly dependencies;
    private readonly retryPolicy;
    constructor(dependencies: AdapterDependencies);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(provider: string): ResolvedRetryPolicy;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    closeOwnedSessions(): Promise<void>;
    /**
     * Record one full context import, then close the live native generation.
     * An open tool call refuses the import before the session log changes.
     */
    recordContextImport(session: Session, sessions: Pick<SessionStore, 'flush'>): Promise<string>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private runAuxiliary;
    private runAdmitted;
    private collectTurn;
    private ensureSession;
    private invalidate;
    private assertRoute;
}
