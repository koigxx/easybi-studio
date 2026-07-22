/**
 * @easybi-studio/contracts
 *
 * Shared, provider-agnostic contracts for Easy BI Studio.
 * These types are the public boundary between studio-web, studio-service,
 * and the provider/source adapters. Pages must never depend on provider- or
 * source-specific private types.
 */

export const CONTRACTS_VERSION = '0.1.0';

export * from './envelope.js';
export * from './project.js';
export * from './job.js';
export * from './agent.js';
export * from './diagnostic.js';
export * from './checkpoint.js';
export * from './skill-bundle.js';
export * from './bootstrap.js';
export * from './report-test.js';
export * from './artifact.js';
