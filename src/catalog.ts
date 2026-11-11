import type { LlmConfigurableProvider, LlmModelInfo } from '@deepseek-ai/dsh-llm'

import { pluginFailure } from './errors.js'
import { CLAUDE_CODE_SESSION_ROUTE } from './route.js'

/**
 * Map one official catalog row to a dsh model entry.
 * The id is the official value. This function does not replace it.
 */
export function projectCatalogModel(
  provider: string,
  info: { readonly value: string; readonly displayName: string; readonly description?: string },
): LlmModelInfo {
  if (info.value.trim() === '' || info.value !== info.value.trim()) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'The catalog model id is empty.')
  }
  const name = info.displayName.trim() === '' ? info.value : info.displayName
  const description = info.description?.trim()
  return {
    provider,
    id: info.value,
    name,
    inputModalities: ['text', 'image'],
    ...(description === undefined || description === '' ? {} : { description }),
  }
}

/**
 * Display name for one resolved model.
 * Use the discovered catalog name when that row exists. Otherwise keep the
 * exact requested id. An empty catalog name also keeps the raw id.
 */
export function resolvedModelName(
  id: string,
  row: { readonly displayName: string } | undefined,
): string {
  if (row === undefined || row.displayName.trim() === '') return id
  return row.displayName
}

/** Route entry. The catalog stays empty until model discovery supplies rows. */
export function blockedRouteDescriptor(): LlmConfigurableProvider {
  return {
    provider: CLAUDE_CODE_SESSION_ROUTE,
    displayName: 'Claude Code session',
    settingsNs: 'dsh-plugin-claude-code',
    settingsPath: [],
  }
}
