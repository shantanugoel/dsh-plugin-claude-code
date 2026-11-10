import { z } from 'zod'

import { canonicalJson } from './canonical.js'
import { pluginFailure } from './errors.js'

/**
 * Convert one JSON object schema into a Zod object shape.
 * The conversion must preserve the schema. A loss is a refusal.
 */
export function zodShapeForTool(parameters: Record<string, unknown>): z.ZodRawShape {
  const parsed = z.fromJSONSchema(parameters)
  if (!(parsed instanceof z.ZodObject)) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A tool schema must stay a JSON object schema.')
  }
  const rebuilt = schemaBody(z.toJSONSchema(z.object(parsed.shape)))
  if (canonicalJson(schemaBody(parameters)) !== canonicalJson(rebuilt)) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A tool schema cannot be preserved.')
  }
  return parsed.shape
}

function schemaBody(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value }
  delete copy['$schema']
  return copy
}
