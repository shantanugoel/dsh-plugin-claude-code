import { isAbsolute } from 'node:path'

import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'

import { pluginFailure } from './errors.js'

/** Current absolute workspace. The process directory is not a fallback. */
export interface WorkspaceSource {
  current(sessionId?: string): string | undefined
}

/** Production source used only when no session store is available to the caller. */
export class UnresolvedWorkspace implements WorkspaceSource {
  current(_sessionId?: string): undefined {
    return undefined
  }
}

/** Why a session already holds earlier conversation: a fork subagent seed. */
export interface SessionOriginSource {
  kind(sessionId: string): 'fork' | undefined
}

/**
 * Read the fork origin from the session header.
 * `isSeeded` and `origin` are creation metadata in dsh 0.2.2-rc.1.
 */
export class SessionForkOrigin implements SessionOriginSource {
  constructor(private readonly sessions: Pick<SessionStore, 'get'>) {}

  kind(sessionId: string): 'fork' | undefined {
    if (sessionId.trim() === '') return undefined
    const header = this.sessions.get(SessionId(sessionId))?.header
    if (header === undefined) return undefined
    return header.origin === 'subagent' || header.isSeeded === true ? 'fork' : undefined
  }
}

/**
 * Read the workspace from the session header.
 * `Session.header.cwd` is immutable creation metadata in dsh 0.2.2-rc.1.
 * The filesystem service base is not a session workspace.
 */
export class SessionHeaderWorkspace implements WorkspaceSource {
  constructor(private readonly sessions: Pick<SessionStore, 'get'>) {}

  current(sessionId?: string): string | undefined {
    if (sessionId === undefined || sessionId.trim() === '') return undefined
    return this.sessions.get(SessionId(sessionId))?.header.cwd
  }
}

/**
 * Use the session workspace. A different filesystem base is a refusal.
 * This function does not read `process.cwd()`.
 */
export function assertWorkspaceAgreement(sessionCwd: string | undefined, filesystemCwd?: string): string {
  const workspace = requireAbsoluteWorkspace(sessionCwd)
  if (filesystemCwd !== undefined && filesystemCwd !== workspace) {
    throw pluginFailure(
      'REBASE_REQUIRED',
      'The filesystem base and the session workspace disagree.',
    )
  }
  return workspace
}

/**
 * Accept one absolute workspace path. Do not read or change the process
 * directory. A missing path is not a reason to use `process.cwd()`.
 */
export function requireAbsoluteWorkspace(workspace: string | undefined): string {
  if (workspace === undefined || workspace.trim() === '' || !isAbsolute(workspace)) {
    throw pluginFailure(
      'UNSUPPORTED_INPUT',
      'The session workspace must be an absolute path. The process directory is not a workspace.',
    )
  }
  return workspace
}
