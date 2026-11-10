import { z } from 'zod'

import { canonicalJson } from './canonical.js'
import { pluginFailure } from './errors.js'

const SAFE_INTEGER = Number.MAX_SAFE_INTEGER

/**
 * Convert one JSON object schema into a Zod object shape.
 * Declared fields, enums, and bounds must survive. Zod writes an open object
 * as an empty schema and an unbounded integer as the safe integer range.
 */
export function zodShapeForTool(parameters: Record<string, unknown>): z.ZodRawShape {
  let parsed: z.ZodType
  try {
    parsed = z.fromJSONSchema(parameters)
  } catch {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A tool schema cannot be preserved.')
  }
  if (!(parsed instanceof z.ZodObject)) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A tool schema must stay a JSON object schema.')
  }
  const rebuilt = z.toJSONSchema(parsed) as Record<string, unknown>
  if (canonicalJson(normalizeSchema(parameters)) !== canonicalJson(normalizeSchema(rebuilt))) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A tool schema cannot be preserved.')
  }
  return parsed.shape
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema)
  if (value === null || typeof value !== 'object') return value
  const copy: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema') continue
    copy[key] = normalizeSchema(child)
  }
  if (copy['type'] === 'integer' && copy['minimum'] === -SAFE_INTEGER && copy['maximum'] === SAFE_INTEGER) {
    delete copy['minimum']
    delete copy['maximum']
  }
  if (copy['type'] === 'object') {
    const properties = copy['properties']
    if (isRecord(properties) && Object.keys(properties).length === 0) delete copy['properties']
    const additional = copy['additionalProperties']
    if (additional === undefined || additional === true || isRecord(additional) && Object.keys(additional).length === 0) {
      copy['additionalProperties'] = true
    }
  }
  return copy
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
