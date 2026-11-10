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
}

export interface SpendGate {
  decide(check: SpendCheck): Promise<SpendDecision>
}

/**
 * Production gate. It refuses every inference purpose until an accepted
 * pre-inference guard exists. It has no paid-usage override.
 */
export class ProductionSpendGate implements SpendGate {
  decide(_check: SpendCheck): Promise<SpendDecision> {
    return Promise.resolve({ allowed: false, code: 'BILLING_GUARD_UNAVAILABLE' })
  }
}

/**
 * Test double. Production registration does not use this class.
 * A test can allow a scripted runtime. It cannot allow the official SDK.
 */
export class ScriptedSpendGate implements SpendGate {
  constructor(private readonly decision: SpendDecision) {}

  decide(_check: SpendCheck): Promise<SpendDecision> {
    return Promise.resolve(this.decision)
  }
}
