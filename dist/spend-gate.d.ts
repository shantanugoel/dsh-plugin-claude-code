import type { PluginFailureCode } from './errors.js';
/**
 * Result of the pre-inference spend check.
 * `allowed: true` requires proof that paid usage cannot start or change
 * during the request. This package has no such proof.
 */
export type SpendDecision = {
    readonly allowed: true;
    readonly policyId: string;
    readonly validFor: string;
} | {
    readonly allowed: false;
    readonly code: Extract<PluginFailureCode, 'BILLING_GUARD_UNAVAILABLE' | 'PAID_USAGE_REFUSED'>;
};
/** Facts that identify one inference attempt. The gate does not send them. */
export interface SpendCheck {
    readonly provider: string;
    readonly model: string;
    readonly purpose: string;
    readonly identityBinding: string;
    readonly scope: string;
}
/**
 * Evidence that would be required before a request could be allowed.
 * Production does not have a source for this evidence.
 */
export interface SpendProof {
    readonly policyId: string;
    readonly identityBinding: string;
    readonly scope: string;
    readonly expiresAt: string;
    readonly validFor: string;
}
export interface SpendProofCheck {
    readonly proof: SpendProof | undefined;
    readonly identityBinding: string;
    readonly scope: string;
    readonly now: Date;
}
export interface SpendGate {
    decide(check: SpendCheck): Promise<SpendDecision>;
}
/** Policy id for a first-party subscription login with no extra-usage lock. */
export declare const SUBSCRIPTION_LOGIN_POLICY = "subscription-login";
/**
 * Production gate. A first-party subscription login may send a prompt.
 * This gate does not prove that extra usage stays off.
 * A caller-supplied proof cannot change the result.
 * It has no paid-usage switch.
 */
export declare class ProductionSpendGate implements SpendGate {
    decide(_check: SpendCheck): Promise<SpendDecision>;
}
/**
 * Test double. Production registration does not use this class.
 * A fixed allow does not make the official SDK available.
 */
export declare class ScriptedSpendGate implements SpendGate {
    private readonly decision;
    constructor(decision: SpendDecision);
    decide(_check: SpendCheck): Promise<SpendDecision>;
}
/**
 * Test double that applies the proof rules. Production registration does not
 * use this class. A valid result is still not an official spend guard.
 */
export declare class EvidenceSpendGate implements SpendGate {
    private readonly proof;
    private readonly now;
    constructor(proof: SpendProof | undefined, now: Date);
    decide(check: SpendCheck): Promise<SpendDecision>;
}
/**
 * Accept proof only when the identity, scope, expiry, and interval still match.
 * A missing, stale, or moved proof is a refusal. This function is not a
 * production authorization.
 */
export declare function evaluateSpendProof(input: SpendProofCheck): SpendDecision;
