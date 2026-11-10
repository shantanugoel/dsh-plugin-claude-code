import type { PluginFailureCode } from './errors.js'

/**
 * Result of the pre-inference spend check.
 * `allowed: true` requires proof that paid usage cannot start or change
 * during the request. This package has no such proof.
 */
export type SpendDecision =
  | { readonly allowed: true; readonly policyId: string; readonly validFor: string }
  | { readonly allowed: false; readonly code: Extract<PluginFailureCode, 'BILLING_GUARD_UNAVAILABLE' | 'PAID_USAGE_REFUSED'> }

/** Facts that identify one inference attempt. The gate does not send them. */
export interface SpendCheck {
  readonly provider: string
  readonly model: string
  readonly purpose: string
  readonly identityBinding: string
  readonly scope: string
}

/**
 * Evidence that would be required before a request could be allowed.
 * Production does not have a source for this evidence.
 */
export interface SpendProof {
  readonly policyId: string
  readonly identityBinding: string
  readonly scope: string
  readonly expiresAt: string
  readonly validFor: string
}

export interface SpendProofCheck {
  readonly proof: SpendProof | undefined
  readonly identityBinding: string
  readonly scope: string
  readonly now: Date
}

export interface SpendGate {
  decide(check: SpendCheck): Promise<SpendDecision>
}

/**
 * Production gate. It refuses every inference purpose until an accepted
 * pre-inference guard exists. A caller-supplied proof cannot change the result.
 * It has no paid-usage override.
 */
export class ProductionSpendGate implements SpendGate {
  decide(_check: SpendCheck): Promise<SpendDecision> {
    return Promise.resolve({ allowed: false, code: 'BILLING_GUARD_UNAVAILABLE' })
  }
}

/**
 * Test double. Production registration does not use this class.
 * A fixed allow does not make the official SDK available.
 */
export class ScriptedSpendGate implements SpendGate {
  constructor(private readonly decision: SpendDecision) {}

  decide(_check: SpendCheck): Promise<SpendDecision> {
    return Promise.resolve(this.decision)
  }
}

/**
 * Test double that applies the proof rules. Production registration does not
 * use this class. A valid result is still not an official spend guard.
 */
export class EvidenceSpendGate implements SpendGate {
  constructor(
    private readonly proof: SpendProof | undefined,
    private readonly now: Date,
  ) {}

  decide(check: SpendCheck): Promise<SpendDecision> {
    return Promise.resolve(evaluateSpendProof({
      proof: this.proof,
      identityBinding: check.identityBinding,
      scope: check.scope,
      now: this.now,
    }))
  }
}

/**
 * Accept proof only when the identity, scope, expiry, and interval still match.
 * A missing, stale, or moved proof is a refusal. This function is not a
 * production authorization.
 */
export function evaluateSpendProof(input: SpendProofCheck): SpendDecision {
  const proof = input.proof
  if (proof === undefined) return unavailable()
  if (proof.policyId.trim() === '' || proof.validFor.trim() === '' || proof.scope.trim() === '') {
    return unavailable()
  }
  if (proof.identityBinding !== input.identityBinding || proof.scope !== input.scope) return unavailable()
  const expiresAt = Date.parse(proof.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime()) return unavailable()
  return { allowed: true, policyId: proof.policyId, validFor: proof.validFor }
}

function unavailable(): SpendDecision {
  return { allowed: false, code: 'BILLING_GUARD_UNAVAILABLE' }
}
