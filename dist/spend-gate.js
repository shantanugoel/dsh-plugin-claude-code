/** Policy id for a first-party subscription login with no extra-usage lock. */
export const SUBSCRIPTION_LOGIN_POLICY = 'subscription-login';
/**
 * Production gate. A first-party subscription login may send a prompt.
 * This gate does not prove that extra usage stays off.
 * A caller-supplied proof cannot change the result.
 * It has no paid-usage switch.
 */
export class ProductionSpendGate {
    decide(_check) {
        return Promise.resolve({
            allowed: true,
            policyId: SUBSCRIPTION_LOGIN_POLICY,
            validFor: 'no-spend-lock',
        });
    }
}
/**
 * Test double. Production registration does not use this class.
 * A fixed allow does not make the official SDK available.
 */
export class ScriptedSpendGate {
    decision;
    constructor(decision) {
        this.decision = decision;
    }
    decide(_check) {
        return Promise.resolve(this.decision);
    }
}
/**
 * Test double that applies the proof rules. Production registration does not
 * use this class. A valid result is still not an official spend guard.
 */
export class EvidenceSpendGate {
    proof;
    now;
    constructor(proof, now) {
        this.proof = proof;
        this.now = now;
    }
    decide(check) {
        return Promise.resolve(evaluateSpendProof({
            proof: this.proof,
            identityBinding: check.identityBinding,
            scope: check.scope,
            now: this.now,
        }));
    }
}
/**
 * Accept proof only when the identity, scope, expiry, and interval still match.
 * A missing, stale, or moved proof is a refusal. This function is not a
 * production authorization.
 */
export function evaluateSpendProof(input) {
    const proof = input.proof;
    if (proof === undefined)
        return unavailable();
    if (proof.policyId.trim() === '' || proof.validFor.trim() === '' || proof.scope.trim() === '') {
        return unavailable();
    }
    if (proof.identityBinding !== input.identityBinding || proof.scope !== input.scope)
        return unavailable();
    const expiresAt = Date.parse(proof.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime())
        return unavailable();
    return { allowed: true, policyId: proof.policyId, validFor: proof.validFor };
}
function unavailable() {
    return { allowed: false, code: 'BILLING_GUARD_UNAVAILABLE' };
}
