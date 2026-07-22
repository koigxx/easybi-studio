#!/usr/bin/env node
type JsonRecord = Record<string, any>;
export declare function inspectReport(options: {
    workspace: string;
    knowledge: string;
    reportId: string;
    out: string;
    version?: string;
}): Promise<JsonRecord>;
export declare function configurePlan(planPathValue: string, configurationPathValue: string): Promise<JsonRecord>;
export declare function approvePlan(planPath: string, reviewedBy: string): Promise<JsonRecord>;
export declare function generatePackage(options: {
    workspace: string;
    plan: string;
    out?: string;
}): Promise<string>;
export declare function validatePackage(packageRootValue: string): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
}>;
/**
 * Re-seal a package after a MANUAL edit: recompute checksums.sha256 so hand-edited
 * files (queries/main.sql, transforms, bindings.json, parameters.schema.json, …)
 * are trusted again, then re-run full validation. Intended for the "AI output
 * isn't always right, a human fixes it" workflow.
 *
 * Guardrails: only DEVELOPMENT packages may be re-sealed — a published/signed
 * package stays immutable. The reseal first verifies STRUCTURE (every check
 * except the checksum match, which is expected to fail after an edit); if the
 * structure is broken (missing file, invalid SQL/binding, bad transform) it
 * refuses and reports those errors instead of blessing a broken package.
 */
export declare function resealPackage(packageRootValue: string): Promise<{
    resealed: boolean;
    errors: string[];
    warnings: string[];
}>;
export {};
