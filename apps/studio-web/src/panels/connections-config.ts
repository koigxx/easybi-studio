// Pure helpers for editing connection info inside config/easy-bi.json.
// Only connections.database_profiles and connections.object_storage_profiles are
// touched; every other field (and every unknown key inside a profile) is
// preserved verbatim on merge.

export interface DbProfileDraft {
  id: string;
  connectorId: string;
  host: string;
  port: number;
  username: string;
  password: string;
  databases: string[];
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
    return {
      id: String(rec.id ?? ''),
      connectorId: String(rec.connector_id ?? 'mysql'),
      host: String(s.host ?? ''),
      port: Number(s.port ?? 3306),
      username: String(s.username ?? ''),
      password: typeof rec.password === 'string' ? rec.password : '',
      databases: Array.isArray(s.databases) ? s.databases.map((d) => String(d)) : [],
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
  settings.host = db.host.trim();
  settings.port = db.port;
  settings.username = db.username.trim();
  settings.databases = db.databases.map((d) => d.trim()).filter((d) => d.length > 0);

  raw.id = db.id.trim();
  raw.connector_id = db.connectorId;
  raw.settings = settings;
  // Plaintext password: keep it out of the object entirely when empty, so we do
  // not clobber an existing password_env with an empty string.
  if (db.password) {
    raw.password = db.password;
  } else {
    delete raw.password;
  }
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
    if (!db.host.trim()) return `连接「${id}」缺少 host`;
    if (!Number.isInteger(db.port) || db.port < 1 || db.port > 65535)
      return `连接「${id}」端口无效（1–65535）`;
    if (!db.username.trim()) return `连接「${id}」缺少 username`;
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

export function newDbProfile(): DbProfileDraft {
  return {
    id: '',
    connectorId: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    username: '',
    password: '',
    databases: [],
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
