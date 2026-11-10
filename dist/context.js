import { isAbsolute } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import { pluginFailure } from './errors.js';
/** Production source used only when no session store is available to the caller. */
export class UnresolvedWorkspace {
    current(_sessionId) {
        return undefined;
    }
}
/**
 * Read the workspace from the session header.
 * `Session.header.cwd` is immutable creation metadata in dsh 0.2.2-rc.1.
 * The filesystem service base is not a session workspace.
 */
export class SessionHeaderWorkspace {
    sessions;
    constructor(sessions) {
        this.sessions = sessions;
    }
    current(sessionId) {
        if (sessionId === undefined || sessionId.trim() === '')
            return undefined;
        return this.sessions.get(SessionId(sessionId))?.header.cwd;
    }
}
/**
 * Use the session workspace. A different filesystem base is a refusal.
 * This function does not read `process.cwd()`.
 */
export function assertWorkspaceAgreement(sessionCwd, filesystemCwd) {
    const workspace = requireAbsoluteWorkspace(sessionCwd);
    if (filesystemCwd !== undefined && filesystemCwd !== workspace) {
        throw pluginFailure('REBASE_REQUIRED', 'The filesystem base and the session workspace disagree.');
    }
    return workspace;
}
/**
 * Accept one absolute workspace path. Do not read or change the process
 * directory. A missing path is not a reason to use `process.cwd()`.
 */
export function requireAbsoluteWorkspace(workspace) {
    if (workspace === undefined || workspace.trim() === '' || !isAbsolute(workspace)) {
        throw pluginFailure('UNSUPPORTED_INPUT', 'The session workspace must be an absolute path. The process directory is not a workspace.');
    }
    return workspace;
}
