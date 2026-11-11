import {
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'

/**
 * Map one loose official SDK result message to a stable dsh failure.
 *
 * The module is pure. It reads the facts a result message carries and it does
 * not import the SDK. A turn that stopped at the output-token limit is not a
 * failure; it becomes a `max-tokens` outcome.
 */

/** Stable dsh failure codes this module produces. */
export const NATIVE_FAILURE_CODES = [
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  'RATE_LIMIT',
  'AUTH',
  'SERVER',
  'MALFORMED_RESPONSE',
  'NATIVE_OUTCOME_UNKNOWN',
] as const

export type NativeFailureCode = (typeof NATIVE_FAILURE_CODES)[number]

/** One provider-neutral failure. The message keeps the native text with private data removed. */
export interface NativeFailure {
  readonly code: NativeFailureCode
  readonly message: string
  readonly status?: number
}

/** The mapped outcome of one native turn. */
export type NativeTurnOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'failure'; readonly failure: NativeFailure }

/**
 * Facts read from one loose SDK result message and the latest assistant
 * message. Every value is unknown because the SDK declares them as optional or
 * absent, and because a production message may carry more fields than the
 * declarations show.
 */
export interface NativeResultFacts {
  readonly subtype?: unknown
  readonly isError?: unknown
  readonly errors?: unknown
  readonly apiErrorStatus?: unknown
  readonly stopReason?: unknown
  readonly result?: unknown
  readonly assistantError?: unknown
}

/** SDK result subtypes that report a turn limit, not an unreadable response. */
const TURN_LIMIT_LABELS: ReadonlyMap<string, string> = new Map([
  ['error_max_turns', 'The native session stopped at its turn limit. The turn is not a complete answer.'],
  ['error_max_budget_usd', 'The native session stopped at its budget limit. The turn is not a complete answer.'],
  [
    'error_max_structured_output_retries',
    'The native session stopped at its structured-output retry limit. The turn is not a complete answer.',
  ],
])

/** Assistant message error values that identify an authentication problem. */
const AUTH_ASSISTANT_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'verification_required',
  'cloud_credential_error',
  'account_on_hold',
])

const AUTH_WORDING = /\b(?:auth(?:entication)?|unauthori[sz]ed|forbidden|invalid[\s_-]?(?:api[\s_-]?key|token|credential)|credential|oauth|login|logged[\s_-]?in|permission[\s_-]?denied)\b/i
const RATE_LIMIT_WORDING = /\b(?:rate[\s_-]?limit(?:ed|ing)?|too[\s_-]?many[\s_-]?requests|requests?[\s_-]?limit)\b/i
const OVERLOAD_WORDING = /\b(?:overloaded|server[\s_-]?error|service[\s_-]?unavailable|internal[\s_-]?server)\b/i
const BILLING_WORDING = /\b(?:credit|credits|balance|billing|payment|purchase|replenish)\b/i

/**
 * Context-overflow wording that the dsh classifier does not read. The Claude
 * API reports an oversized request as "prompt is too long: N tokens > M
 * maximum"; `isContextWindowExceededError` reads the generic forms only.
 */
const CLAUDE_CONTEXT_OVERFLOW_WORDING: readonly RegExp[] = [
  /\bprompt is too long\b/i,
  /\binput length\b.{0,60}\bexceed(?:s|ed)?\b.{0,60}\bcontext\b/i,
]

/** Limits for the sanitized native detail that the failure message keeps. */
const MAX_NATIVE_DETAIL = 600

/**
 * Redactions for text from a provider error. Keep the diagnosis; remove
 * credentials, headers, account identities, and long opaque values.
 */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [
    /\b((?:proxy-)?authorization|(?:x-)?api[-_]?key|apikey|cookie|set-cookie|secret|password|passwd)\b\s*[:=]\s*[^\s,;]+/gi,
    '$1=<redacted>',
  ],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer <redacted>'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '<redacted>'],
  [/\b(?:acct|org|usr|team)_[A-Za-z0-9_-]{3,}/gi, '<redacted>'],
  [
    /\b(?:account|organization|user|session|member|workspace)[ _-]?id\b\s*[:=]?\s*[A-Za-z0-9_-]+/gi,
    '<redacted>',
  ],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<redacted-email>'],
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<redacted-id>'],
  [/\b[0-9a-fA-F]{32,}\b/g, '<redacted>'],
  [/\b[A-Za-z0-9+/_=-]{40,}\b/g, '<redacted>'],
]

/**
 * Classify one native result message.
 *
 * Order: an output-token limit is not a failure; then context overflow, quota,
 * rate limit, authentication, and provider server errors; then the declared
 * turn limits; then the unreadable-turn fallbacks.
 */
export function classifyNativeResult(facts: NativeResultFacts): NativeTurnOutcome {
  const subtype = textOf(facts.subtype)
  const assistantError = textOf(facts.assistantError)
  const stopReason = textOf(facts.stopReason)
  const status = httpStatusOf(facts.apiErrorStatus)
  const detail = detailOf(facts)
  if (
    !TURN_LIMIT_LABELS.has(subtype)
    && (stopReason === 'max_tokens' || assistantError === 'max_output_tokens')
  ) {
    return { kind: 'max-tokens' }
  }
  const failed = facts.isError === true || (subtype !== '' && subtype !== 'success')
  if (!failed) return { kind: 'success' }
  return {
    kind: 'failure',
    failure: failureOf({ subtype, assistantError, status, detail }),
  }
}

/** Build the dsh error for one mapped native failure. */
export function nativeFailureError(failure: NativeFailure): LlmError {
  return new LlmError(
    failure.message,
    failure.code,
    failure.status === undefined ? undefined : { status: failure.status },
  )
}

/**
 * Clean provider text for a user-visible failure message. Keep the diagnosis;
 * remove credentials, headers, account identities, and long opaque values.
 */
export function sanitizeNativeMessage(value: string, limit = MAX_NATIVE_DETAIL): string {
  let text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement)
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > limit) text = `${text.slice(0, limit).trimEnd()}...`
  return text
}

function failureOf(input: {
  readonly subtype: string
  readonly assistantError: string
  readonly status: number | undefined
  readonly detail: string
}): NativeFailure {
  const { subtype, assistantError, status, detail } = input
  if (isContextOverflow(subtype, assistantError, detail)) {
    return failure(CONTEXT_WINDOW_EXCEEDED_CODE, 'The native session reported a context-window overflow.', status, detail)
  }
  if (isQuotaExceededError(detail) || assistantError === 'billing_error' || BILLING_WORDING.test(detail)) {
    const code = BILLING_WORDING.test(detail) || assistantError === 'billing_error'
      ? ACCOUNT_QUOTA_EXCEEDED_CODE
      : QUOTA_EXCEEDED_CODE
    const label = code === ACCOUNT_QUOTA_EXCEEDED_CODE
      ? 'The native session reported an exhausted first-party account quota.'
      : 'The native session reported an exhausted provider quota.'
    return failure(code, label, status, detail)
  }
  if (status === 429 || assistantError === 'rate_limit' || RATE_LIMIT_WORDING.test(detail)) {
    return failure('RATE_LIMIT', 'The native session reported a rate limit.', status, detail)
  }
  if (status === 401 || status === 403 || AUTH_ASSISTANT_ERRORS.has(assistantError) || AUTH_WORDING.test(detail)) {
    return failure('AUTH', 'The native session reported an authentication failure.', status, detail)
  }
  if (
    (status !== undefined && status >= 500)
    || assistantError === 'overloaded'
    || assistantError === 'server_error'
    || OVERLOAD_WORDING.test(detail)
  ) {
    return failure('SERVER', 'The native session reported a provider server error.', status, detail)
  }
  const limitLabel = TURN_LIMIT_LABELS.get(subtype)
  if (limitLabel !== undefined) return failure('MALFORMED_RESPONSE', limitLabel, status, detail)
  if (subtype === 'error_during_execution' || assistantError === 'unknown') {
    return failure(
      'NATIVE_OUTCOME_UNKNOWN',
      'The native session reported an execution error. The inference outcome is unknown.',
      status,
      detail,
    )
  }
  return failure(
    'MALFORMED_RESPONSE',
    'The native session reported a turn error that the plugin cannot read.',
    status,
    detail,
  )
}

function isContextOverflow(subtype: string, assistantError: string, detail: string): boolean {
  if (isContextWindowExceededError(detail) || isContextWindowExceededError(`${subtype} ${assistantError}`)) return true
  return CLAUDE_CONTEXT_OVERFLOW_WORDING.some((pattern) => pattern.test(detail))
}

function failure(
  code: NativeFailureCode,
  label: string,
  status: number | undefined,
  detail: string,
): NativeFailure {
  const clean = sanitizeNativeMessage(detail)
  const message = clean === '' ? label : `${label} Native detail: ${clean}`
  return {
    code,
    message,
    ...(status === undefined ? {} : { status }),
  }
}

/** Join the readable facts. The joining is not the sanitized form. */
function detailOf(facts: NativeResultFacts): string {
  const subtype = textOf(facts.subtype)
  const parts = [
    ...(subtype === '' || subtype === 'success' ? [] : [subtype]),
    textOf(facts.assistantError),
    textOf(facts.result),
    ...errorTexts(facts.errors),
  ]
  return parts.filter((part) => part !== '').join(' ')
}

function errorTexts(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value]
  if (!Array.isArray(value)) return []
  const texts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim() !== '') texts.push(item)
      continue
    }
    if (typeof item === 'object' && item !== null) {
      const message = (item as Record<string, unknown>)['message']
      if (typeof message === 'string' && message.trim() !== '') texts.push(message)
    }
  }
  return texts
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function httpStatusOf(value: unknown): number | undefined {
  const status = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined
}
