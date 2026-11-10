export interface DiscoveredModel {
    readonly value: string;
    readonly displayName: string;
    readonly description?: string;
}
/**
 * Process-wide catalog. A successful read is kept. A failed read is empty
 * until the short retry interval passes. The read does not send a user prompt.
 */
export declare const officialModelDiscovery: {
    list(): Promise<readonly DiscoveredModel[]>;
};
