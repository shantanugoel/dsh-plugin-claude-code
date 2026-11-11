import { type Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'

import { ClaudeCodeAdapter } from './adapter.js'
import { AuthGuard, ProcessHome } from './auth.js'
import { createProcessAuthRunner } from './auth-process.js'
import { blockedRouteDescriptor } from './catalog.js'
import { officialModelDiscovery } from './model-discovery.js'
import { SessionHeaderWorkspace } from './context.js'
import { DEFAULT_DEADLINES } from './deadlines.js'
import type { ImageAttachmentReader } from './images.js'
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
 * Registration does not choose a model. The model list is read from Claude
 * when dsh asks for it. That read does not send a user prompt.
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
    attachments: () => imageAttachmentReader(ctx),
    discoverModels: () => officialModelDiscovery.list(),
  })
  ctx.llm.registerAdapter([CLAUDE_CODE_SESSION_ROUTE], adapter)
  ctx.llm.registerConfigurableProviders([blockedRouteDescriptor()])
  ctx.effect(() => () => {
    adapter.closeOwnedSessions()
  }, 'claude-code-session.close')
}

/**
 * Resolve the attachment service lazily. The plugin registers its route and
 * accepts text even when the profile has no attachment store; an image request
 * then refuses before native dispatch.
 */
function imageAttachmentReader(ctx: Context): ImageAttachmentReader | undefined {
  const store = ctx.get('attachments') as AttachmentStore | undefined
  if (store === undefined) return undefined
  return {
    readImageRequest: (ref, target, signal) => store.readImageRequest(ref, target, signal),
  }
}

Object.assign(apply, { inject })
