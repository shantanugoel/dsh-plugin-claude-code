import type { LlmConfigurableProvider, LlmModelInfo } from '@deepseek-ai/dsh-llm';
/**
 * Map one official catalog row to a dsh model entry.
 * The id is the official value. This function does not replace it.
 */
export declare function projectCatalogModel(provider: string, info: {
    readonly value: string;
    readonly displayName: string;
    readonly description?: string;
}): LlmModelInfo;
/** Route entry. The catalog stays empty until model discovery supplies rows. */
export declare function blockedRouteDescriptor(): LlmConfigurableProvider;
