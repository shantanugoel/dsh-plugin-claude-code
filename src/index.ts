import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { ClaudeCodeAdapter } from './adapter.js'
import { AuthGuard, ProcessHome } from './auth.js'
import { createProcessAuthRunner } from './auth-process.js'
import { blockedRouteDescriptor } from './catalog.js'
import { SessionHeaderWorkspace } from './context.js'
import { DEFAULT_DEADLINES } from './deadlines.js'
import { CLAUDE_CODE_SESSION_ROUTE } from './route.js'
import { SdkNativeRuntime } from './sdk-runtime.js'
import { SessionManager } from './session-manager.js'
import { ProductionSpendGate } from './spend-gate.js'

export const name = 'dsh-plugin-claude-code'
export const inject = ['llm', 'sessions']

/**
 * User settings. The object is empty. There is no paid-usage switch and no
 * path that selects a different client identity.
 */
export const Config = z.object({})

export type PluginConfig = Schemastery.TypeT<typeof Config>

export { CLAUDE_CODE_SESSION_ROUTE } from './route.js'

/**
 * Register the route and release owned sessions on unload.
 * Registration does not advertise a model and does not start a native process.
 */
export function apply(ctx: Context, _config: PluginConfig): void {
  const sessions = new SessionManager()
  const adapter = new ClaudeCodeAdapter({
    runtime: new SdkNativeRuntime(),
    spendGate: new ProductionSpendGate(),
    sessions,
    workspace: new SessionHeaderWorkspace(ctx.sessions),
    auth: new AuthGuard(createProcessAuthRunner()),
    home: new ProcessHome(),
    parentEnv: () => process.env,
    deadlines: DEFAULT_DEADLINES,
  })
  ctx.llm.registerAdapter([CLAUDE_CODE_SESSION_ROUTE], adapter)
  ctx.llm.registerConfigurableProviders([blockedRouteDescriptor()])
  ctx.effect(() => () => {
    adapter.closeOwnedSessions()
  }, 'claude-code-session.close')
}

Object.assign(apply, { inject })
