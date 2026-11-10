import type { NativeSession, NativeSessionConfig } from './sdk-runtime.js';
/**
 * Start one official Agent SDK query. The offline suite does not call this.
 * A missing extra-usage lock does not stop the start.
 */
export declare function startOfficialSession(config: NativeSessionConfig): Promise<NativeSession>;
export declare function findClaudeExecutable(pathValue: string | undefined): string;
