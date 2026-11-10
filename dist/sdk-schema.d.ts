import { z } from 'zod';
/**
 * Convert one JSON object schema into a Zod object shape.
 * The conversion must preserve the schema. A loss is a refusal.
 */
export declare function zodShapeForTool(parameters: Record<string, unknown>): z.ZodRawShape;
