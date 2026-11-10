import { pluginFailure } from './errors.js'

/**
 * Refuse to build a child environment. The allowlist is not certified, so no
 * auth command and no credential helper can run.
 */
export function childEnvironment(): never {
  throw pluginFailure(
    'AUTH_ROUTE_REFUSED',
    'The child environment allowlist is not certified. No auth command was started.',
  )
}
