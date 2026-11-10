import { isAbsolute } from 'node:path'

import { pluginFailure } from './errors.js'

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
