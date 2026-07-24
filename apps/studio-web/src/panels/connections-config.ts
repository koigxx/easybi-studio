// Pure helpers for editing connection info inside config/easy-bi.json.
// Only connections.database_profiles and connections.object_storage_profiles are
// touched; every other field (and every unknown key inside a profile) is
// preserved verbatim on merge.

export interface EnvDraft {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  databases: string[];
}

export interface DbProfileDraft {
  id: string;
  connectorId: string;
  host: string;
  port: number;
  username: string;
  password: string;
  databases: string[];
  /** Multi-environment mode. Empty string = classic single-host mode. */
  activeEnvironment: string;
  environments: EnvDraft[];
  /** Untouched original profile object, used to preserve unknown keys on merge. */
  _raw: Record<string, unknown>;
}

export interface OssProfileDraft {
  id: string;
  connectorId: string;
  endpoint: string;
  region: string;
  bucket: string;
  objectKeyPrefix: string;
  accessKeyId: string;
  accessKeySecret: string;
  signedUrlExpiresSeconds: number;
  _raw: Record<string, unknown>;
}

export interface ConnectionsDraft {
  databases: DbProfileDraft[];
  ossProfiles: OssProfileDraft[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function extractConnections(configValue: unknown): ConnectionsDraft {
  const conn = asRecord(asRecord(configValue).connections);

  const rawDbs = Array.isArray(conn.database_profiles) ? conn.database_profiles : [];
  const databases: DbProfileDraft[] = rawDbs.map((p) => {
    const rec = asRecord(p);
    const s = asRecord(rec.settings);

    // Parse environments from raw profile (new multi-env format).
    const rawEnvs = rec.environments as Record<string, unknown> | undefined;
    const environments: EnvDraft[] = [];
    if (rawEnvs && typeof rawEnvs === 'object' && !Array.isArray(rawEnvs)) {
      for (const [name, rawEnv] of Object.entries(rawEnvs)) {
        if (typeof rawEnv !== 'object' || rawEnv === null) continue;
        const e = rawEnv as Record<string, unknown>;
        const es = asRecord(e.settings);
        environments.push({
          name,
          host: String(es.host ?? ''),
          port: Number(es.port ?? 3306),
          username: String(es.username ?? ''),
          password: typeof e.password === 'string' ? e.password : '',
          databases: Array.isArray(es.databases) ? es.databases.map((d) => String(d)) : [],
        });
      }
    }

    return {
      id: String(rec.id ?? ''),
      connectorId: String(rec.connector_id ?? 'mysql'),
      host: String(s.host ?? ''),
      port: Number(s.port ?? 3306),
      username: String(s.username ?? ''),
      password: typeof rec.password === 'string' ? rec.password : '',
      databases: Array.isArray(s.databases) ? s.databases.map((d) => String(d)) : [],
      activeEnvironment: typeof rec.active_environment === 'string' ? rec.active_environment : '',
      environments,
      _raw: rec,
    };
  });

  const rawOss = Array.isArray(conn.object_storage_profiles) ? conn.object_storage_profiles : [];
  const ossProfiles: OssProfileDraft[] = rawOss.map((p) => {
    const rec = asRecord(p);
    const s = asRecord(rec.settings);
    return {
      id: String(rec.id ?? ''),
      connectorId: String(rec.connector_id ?? 'aliyun-oss'),
      endpoint: String(s.endpoint ?? ''),
      region: String(s.region ?? ''),
      bucket: String(s.bucket ?? ''),
      objectKeyPrefix: String(s.object_key_prefix ?? ''),
      accessKeyId: typeof rec.access_key_id === 'string' ? rec.access_key_id : '',
      accessKeySecret: typeof rec.access_key_secret === 'string' ? rec.access_key_secret : '',
      signedUrlExpiresSeconds: Number(s.signed_url_expires_seconds ?? 86400),
      _raw: rec,
    };
  });

  return { databases, ossProfiles };
}

/** Build the adapter-friendly inline profile used by the test-mysql endpoint. */
export function toTestProfile(db: DbProfileDraft): unknown {
  if (db.activeEnvironment) {
    const env = db.environments.find((e) => e.name === db.activeEnvironment);
    if (env) {
      return {
        id: db.id.trim(),
        connector_id: db.connectorId,
        active_environment: db.activeEnvironment,
        ...(env.password ? { password: env.password } : {}),
        settings: {
          host: env.host.trim(),
          port: env.port,
          username: env.username.trim(),
          databases: env.databases.map((d) => d.trim()).filter((d) => d.length > 0),
        },
      };
    }
  }
  // Classic mode
  return {
    id: db.id.trim(),
    connector_id: db.connectorId,
    ...(db.password ? { password: db.password } : {}),
    settings: {
      host: db.host.trim(),
      port: db.port,
      username: db.username.trim(),
      databases: db.databases.map((d) => d.trim()).filter((d) => d.length > 0),
    },
  };
}

function mergeDbProfile(db: DbProfileDraft): Record<string, unknown> {
  const raw = { ...db._raw };
  const settings = { ...asRecord(raw.settings) };

  if (db.activeEnvironment) {
    // Multi-environment mode: write active_environment + environments object.
    raw.active_environment = db.activeEnvironment;
    const envs: Record<string, unknown> = {};
    for (const env of db.environments) {
      const entry: Record<string, unknown> = {};
      if (env.password) entry.password = env.password;
      entry.settings = {
        host: env.host.trim(),
        port: env.port,
        username: env.username.trim(),
        databases: env.databases.map((d) => d.trim()).filter((d) => d.length > 0),
      };
      envs[env.name.trim()] = entry;
    }
    raw.environments = envs;
    // Keep top-level settings as defaults; remove top-level password when env-mode
    // so we don't leak plaintext across environments.
    delete raw.password;
  } else {
    // Classic single-host mode: remove env fields, use top-level settings.
    delete raw.active_environment;
    delete raw.environments;
    settings.host = db.host.trim();
    settings.port = db.port;
    settings.username = db.username.trim();
    settings.databases = db.databases.map((d) => d.trim()).filter((d) => d.length > 0);

    raw.settings = settings;
    // Plaintext password: keep it out of the object entirely when empty, so we do
    // not clobber an existing password_env with an empty string.
    if (db.password) {
      raw.password = db.password;
    } else {
      delete raw.password;
    }
  }

  raw.id = db.id.trim();
  raw.connector_id = db.connectorId;
  return raw;
}

function mergeOssProfile(oss: OssProfileDraft): Record<string, unknown> {
  const raw = { ...oss._raw };
  const settings = { ...asRecord(raw.settings) };
  settings.endpoint = oss.endpoint.trim();
  settings.region = oss.region.trim();
  settings.bucket = oss.bucket.trim();
  settings.object_key_prefix = oss.objectKeyPrefix.trim();
  settings.signed_url_expires_seconds = oss.signedUrlExpiresSeconds;

  raw.id = oss.id.trim();
  raw.connector_id = oss.connectorId;
  raw.settings = settings;
  if (oss.accessKeyId) raw.access_key_id = oss.accessKeyId;
  else delete raw.access_key_id;
  if (oss.accessKeySecret) raw.access_key_secret = oss.accessKeySecret;
  else delete raw.access_key_secret;
  return raw;
}

export function mergeConnections(configValue: unknown, draft: ConnectionsDraft): unknown {
  const root = { ...asRecord(configValue) };
  const connections = { ...asRecord(root.connections) };

  connections.database_profiles = draft.databases.map(mergeDbProfile);
  connections.object_storage_profiles = draft.ossProfiles.map(mergeOssProfile);

  root.connections = connections;
  return root;
}

export function validateConnections(draft: ConnectionsDraft): string | null {
  const ids = new Set<string>();
  for (const db of draft.databases) {
    const id = db.id.trim();
    if (!id) return '每个数据库连接都必须填写 ID';
    if (ids.has(id)) return `数据库连接 ID 重复：${id}`;
    ids.add(id);

    if (db.activeEnvironment) {
      // Multi-environment mode validation
      const envNames = new Set<string>();
      for (const env of db.environments) {
        const envId = env.name.trim();
        if (!envId) return `连接「${id}」环境名称不能为空`;
        if (envNames.has(envId)) return `连接「${id}」环境名重复：${envId}`;
        envNames.add(envId);
        if (!env.host.trim()) return `连接「${id}」环境「${envId}」缺少 host`;
        if (!Number.isInteger(env.port) || env.port < 1 || env.port > 65535)
          return `连接「${id}」环境「${envId}」端口无效（1–65535）`;
        if (!env.username.trim()) return `连接「${id}」环境「${envId}」缺少 username`;
      }
      if (!db.environments.some((e) => e.name === db.activeEnvironment)) {
        return `连接「${id}」当前激活环境「${db.activeEnvironment}」未配置完整信息`;
      }
    } else {
      // Classic single-host mode validation
      if (!db.host.trim()) return `连接「${id}」缺少 host`;
      if (!Number.isInteger(db.port) || db.port < 1 || db.port > 65535)
        return `连接「${id}」端口无效（1–65535）`;
      if (!db.username.trim()) return `连接「${id}」缺少 username`;
    }
  }
  const ossIds = new Set<string>();
  for (const oss of draft.ossProfiles) {
    const id = oss.id.trim();
    if (!id) return '每个 OSS 配置都必须填写 ID';
    if (ossIds.has(id)) return `OSS 配置 ID 重复：${id}`;
    ossIds.add(id);
    if (!oss.bucket.trim()) return `OSS「${id}」缺少 bucket`;
  }
  return null;
}

export function newEnvDraft(name = ''): EnvDraft {
  return { name, host: '127.0.0.1', port: 3306, username: '', password: '', databases: [] };
}

export function newDbProfile(): DbProfileDraft {
  return {
    id: '',
    connectorId: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    username: '',
    password: '',
    databases: [],
    activeEnvironment: '',
    environments: [],
    _raw: {},
  };
}

export function newOssProfile(): OssProfileDraft {
  return {
    id: '',
    connectorId: 'aliyun-oss',
    endpoint: '',
    region: '',
    bucket: '',
    objectKeyPrefix: '',
    accessKeyId: '',
    accessKeySecret: '',
    signedUrlExpiresSeconds: 86400,
    _raw: {},
  };
}
