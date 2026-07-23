#!/usr/bin/env node
type JsonRecord = Record<string, any>;
export declare function inspectReport(options: {
    workspace: string;
    knowledge: string;
    reportId: string;
    out: string;
    version?: string;
}): Promise<JsonRecord>;
export declare function renderPlanReview(plan: JsonRecord): string;
export declare function explainPlan(planPath: string): Promise<string>;
export declare function buildKnowledgeContext(options: {
    plan: string;
    out: string;
    include?: string[];
    maxTables?: number;
    maxFields?: number;
    maxBytes?: number;
}): Promise<JsonRecord>;
export declare function initializeReportModel(options: {
    plan: string;
    out: string;
}): Promise<JsonRecord>;
export declare function validateDiscoveryReportModelValue(model: JsonRecord): string[];
export declare function validateReportModelValue(model: JsonRecord, requireApproved?: boolean): string[];
export declare function approveReportModel(modelPath: string, reviewedBy: string, planPathValue?: string): Promise<JsonRecord>;
export declare function createModelConfirmation(options: {
    model: string;
    input: string;
    out: string;
    reviewedBy: string;
}): Promise<JsonRecord>;
export declare function buildPhaseContext(options: {
    phase: "discovery" | "modeling" | "query" | "script" | "repair";
    plan: string;
    out: string;
    model?: string;
    confirmation?: string;
    queryId?: string;
    failure?: string;
    queryOutputs?: string;
}): Promise<JsonRecord>;
type StagedArtifactPhase = "discovery" | "modeling" | "query" | "script";
export declare function validateStagedArtifacts(options: {
    phase: StagedArtifactPhase;
    plan: string;
    root: string;
    requireApprovedModel?: boolean;
    queryId?: string;
}): Promise<JsonRecord>;
export declare function approveStagedModel(options: {
    plan: string;
    root: string;
    reviewedBy: string;
}): Promise<JsonRecord>;
/**
 * Validate and approve a staged model, then atomically replace the one current
 * model package owned by the report. Discovery/chat/context files remain work
 * artifacts and are deliberately excluded; the model package carries only the
 * approved model, semantic/execution plans, optional declarative configuration,
 * and the compact physical source slice needed by later query compilation.
 */
export declare function finalizeStagedModel(options: {
    plan: string;
    root: string;
    out: string;
    reviewedBy: string;
}): Promise<JsonRecord>;
export declare function finalizeStagedPackage(options: {
    workspace: string;
    plan: string;
    root: string;
    reviewedBy: string;
}): Promise<JsonRecord>;
export declare function configurePlan(planPathValue: string, configurationPathValue: string): Promise<JsonRecord>;
export declare function approvePlan(planPath: string, reviewedBy: string): Promise<JsonRecord>;
export declare function generatePackage(options: {
    workspace: string;
    plan: string;
    out?: string;
    register?: boolean;
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
