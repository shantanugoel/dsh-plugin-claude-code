import { type SessionStore } from '@deepseek-ai/dsh-session';
/** Current absolute workspace. The process directory is not a fallback. */
export interface WorkspaceSource {
    current(sessionId?: string): string | undefined;
}
/** Production source used only when no session store is available to the caller. */
export declare class UnresolvedWorkspace implements WorkspaceSource {
    current(_sessionId?: string): undefined;
}
/**
 * Read the workspace from the session header.
 * `Session.header.cwd` is immutable creation metadata in dsh 0.2.2-rc.1.
 * The filesystem service base is not a session workspace.
 */
export declare class SessionHeaderWorkspace implements WorkspaceSource {
    private readonly sessions;
    constructor(sessions: Pick<SessionStore, 'get'>);
    current(sessionId?: string): string | undefined;
}
/**
 * Use the session workspace. A different filesystem base is a refusal.
 * This function does not read `process.cwd()`.
 */
export declare function assertWorkspaceAgreement(sessionCwd: string | undefined, filesystemCwd?: string): string;
/**
 * Accept one absolute workspace path. Do not read or change the process
 * directory. A missing path is not a reason to use `process.cwd()`.
 */
export declare function requireAbsoluteWorkspace(workspace: string | undefined): string;
