import Ajv, { type ValidateFunction } from 'ajv';

/**
 * JSON Schema validation for config files (plan §10.2).
 * Schemas are provided by the workspace's toolkit (runtime.schema.json) or by
 * lightweight built-in shape checks for the build config.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new WeakMap<object, ValidateFunction>();

function compile(schema: object): ValidateFunction {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(schema, fn);
  }
  return fn;
}

export function validateAgainstSchema(schema: object, value: unknown): ValidationResult {
  const fn = compile(schema);
  const valid = fn(value) as boolean;
  if (valid) return { valid: true, issues: [] };
  const issues: ValidationIssue[] = (fn.errors ?? []).map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? '校验失败',
  }));
  return { valid: false, issues };
}

/** Minimal built-in shape check for config/easy-bi.json (config_version 4). */
export function validateBuildConfigShape(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (typeof value !== 'object' || value === null) {
    return { valid: false, issues: [{ path: '/', message: '配置必须是对象' }] };
  }
  const cfg = value as Record<string, unknown>;
  if (cfg.config_version !== '4') {
    issues.push({ path: '/config_version', message: 'config_version 必须为 "4"' });
  }
  if (typeof cfg.connections !== 'object' || cfg.connections === null) {
    issues.push({ path: '/connections', message: '缺少 connections 对象' });
  } else {
    const conn = cfg.connections as Record<string, unknown>;
    if (!Array.isArray(conn.database_profiles)) {
      issues.push({ path: '/connections/database_profiles', message: '缺少 database_profiles 数组' });
    } else {
      const profiles = conn.database_profiles as Array<Record<string, unknown>>;
      for (const [idx, profile] of profiles.entries()) {
        const prefix = `/connections/database_profiles/${idx}`;
        if (typeof profile.id !== 'string' || !profile.id.trim()) {
          issues.push({ path: `${prefix}/id`, message: '数据库连接 ID 不能为空' });
        }
        // Validate new environments + active_environment format (backward compatible).
        const envActive = profile.active_environment;
        const envs = profile.environments;
        if (envActive !== undefined || envs !== undefined) {
          if (typeof envs !== 'object' || envs === null || Array.isArray(envs)) {
            issues.push({ path: `${prefix}/environments`, message: 'environments 必须是对象' });
          } else {
            const envKeys = Object.keys(envs);
            if (envKeys.length === 0) {
              issues.push({ path: `${prefix}/environments`, message: 'environments 不能为空' });
            }
            if (typeof envActive === 'string' && envActive && !envKeys.includes(envActive)) {
              issues.push({ path: `${prefix}/active_environment`, message: `active_environment "${envActive}" 不在 environments 中` });
            }
          }
        }
      }
    }
  }
  if (typeof cfg.knowledge !== 'object' || cfg.knowledge === null) {
    issues.push({ path: '/knowledge', message: '缺少 knowledge 对象' });
  }
  return { valid: issues.length === 0, issues };
}
