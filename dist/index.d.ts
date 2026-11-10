import { type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-plugin-claude-code";
export declare const inject: string[];
/**
 * User settings. The object is empty. There is no paid-usage switch and no
 * path that selects a different client identity.
 */
export declare const Config: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
export type PluginConfig = Schemastery.TypeT<typeof Config>;
export { CLAUDE_CODE_SESSION_ROUTE } from './route.js';
/**
 * Register the route and release owned sessions on unload.
 * Registration does not choose a model. The model list is read from Claude
 * when dsh asks for it. That read does not send a user prompt.
 */
export declare function apply(ctx: Context, _config: PluginConfig): void;
