import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { AuthCommand, AuthCommandResult, AuthCommandRunner } from './auth.js';
export interface SpawnLike {
    (command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
}
/**
 * Run `claude auth status` without a shell. The caller supplies the allowlisted
 * environment. stderr is discarded so a credential cannot enter an error string.
 */
export declare function createProcessAuthRunner(timeoutMs?: number, spawnImpl?: SpawnLike): AuthCommandRunner;
export declare function runAuthProcess(command: AuthCommand, timeoutMs: number, spawnImpl: SpawnLike): Promise<AuthCommandResult>;
