import { isAbsolute } from 'node:path'

import { pluginFailure } from './errors.js'

/** Current absolute workspace. The process directory is not a fallback. */
export interface WorkspaceSource {
  current(sessionId?: string): string | undefined
}

/** Production source until the dsh workspace service is connected. */
export class UnresolvedWorkspace implements WorkspaceSource {
  current(_sessionId?: string): undefined {
    return undefined
  }
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
