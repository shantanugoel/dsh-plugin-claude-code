import { pluginFailure } from './errors.js';
import { CLAUDE_CODE_SESSION_ROUTE } from './route.js';
/**
 * Map one official catalog row to a dsh model entry.
 * The id is the official value. This function does not replace it.
 */
export function projectCatalogModel(provider, info) {
    if (info.value.trim() === '' || info.value !== info.value.trim()) {
        throw pluginFailure('UNSUPPORTED_INPUT', 'The catalog model id is empty.');
    }
    const name = info.displayName.trim() === '' ? info.value : info.displayName;
    const description = info.description?.trim();
    return {
        provider,
        id: info.value,
        name,
        inputModalities: ['text'],
        ...(description === undefined || description === '' ? {} : { description }),
    };
}
/** Route entry. The catalog stays empty until model discovery supplies rows. */
export function blockedRouteDescriptor() {
    return {
        provider: CLAUDE_CODE_SESSION_ROUTE,
        displayName: 'Claude Code session',
        settingsNs: 'dsh-plugin-claude-code',
        settingsPath: [],
    };
}
