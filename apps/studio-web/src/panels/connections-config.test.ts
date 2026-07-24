import { describe, it, expect } from 'vitest';
import {
  extractConnections,
  mergeConnections,
  validateConnections,
  toTestProfile,
  newDbProfile,
  newEnvDraft,
} from './connections-config.js';

const CONFIG = {
  config_version: '4',
  system: { id: 'transport-system' },
  connections: {
    database_profiles: [
      {
        id: 'main',
        connector_id: 'mysql',
        connection_group: 'grp',
        password: 'plain-secret',
        settings: {
          host: '127.0.0.1',
          port: 3306,
          username: 'reader',
          databases: ['a', 'b'],
          discover_databases: false,
        },
      },
      {
        id: 'archive',
        connector_id: 'mysql',
        password_env: 'ARCHIVE_PW',
        settings: { host: '10.0.0.1', port: 3307, username: 'r2', databases: ['c'] },
      },
    ],
    object_storage_profiles: [
      {
        id: 'oss1',
        connector_id: 'aliyun-oss',
        access_key_id: 'AK',
        access_key_secret: 'SK',
        settings: {
          endpoint: 'https://x',
          region: 'cn-hangzhou',
          bucket: 'bkt',
          object_key_prefix: 'easy-bi/x',
          signed_url_expires_seconds: 86400,
        },
      },
    ],
  },
  knowledge: { inactivity_days: 90 },
};

describe('extractConnections', () => {
  it('reads db and oss profiles', () => {
    const d = extractConnections(CONFIG);
    expect(d.databases).toHaveLength(2);
    expect(d.databases[0]).toMatchObject({
      id: 'main',
      host: '127.0.0.1',
      port: 3306,
      username: 'reader',
      password: 'plain-secret',
      databases: ['a', 'b'],
      activeEnvironment: '',
      environments: [],
    });
    expect(d.databases[1]!.password).toBe(''); // password_env is not surfaced as plaintext
    expect(d.ossProfiles[0]).toMatchObject({
      id: 'oss1',
      bucket: 'bkt',
      accessKeyId: 'AK',
      accessKeySecret: 'SK',
    });
  });

  it('tolerates missing connections', () => {
    expect(extractConnections({})).toEqual({ databases: [], ossProfiles: [] });
    expect(extractConnections(null)).toEqual({ databases: [], ossProfiles: [] });
  });
});

describe('mergeConnections', () => {
  it('preserves other config and unknown profile keys', () => {
    const d = extractConnections(CONFIG);
    const merged = mergeConnections(CONFIG, d) as typeof CONFIG;
    expect(merged.config_version).toBe('4');
    expect(merged.system).toEqual({ id: 'transport-system' });
    expect(merged.knowledge).toEqual({ inactivity_days: 90 });
    // unknown key connection_group preserved
    expect((merged.connections.database_profiles[0] as Record<string, unknown>).connection_group).toBe(
      'grp',
    );
    // settings.discover_databases preserved
    expect(
      (
        (merged.connections.database_profiles[0] as Record<string, unknown>).settings as Record<
          string,
          unknown
        >
      ).discover_databases,
    ).toBe(false);
  });

  it('does not clobber password_env when plaintext password is empty', () => {
    const d = extractConnections(CONFIG);
    const merged = mergeConnections(CONFIG, d) as typeof CONFIG;
    const archive = merged.connections.database_profiles[1] as Record<string, unknown>;
    expect(archive.password).toBeUndefined();
    expect(archive.password_env).toBe('ARCHIVE_PW');
  });

  it('writes plaintext password when provided', () => {
    const d = extractConnections(CONFIG);
    d.databases[0]!.password = 'new-pw';
    const merged = mergeConnections(CONFIG, d) as typeof CONFIG;
    expect((merged.connections.database_profiles[0] as Record<string, unknown>).password).toBe('new-pw');
  });

  it('does not mutate the input config', () => {
    const input = structuredClone(CONFIG);
    mergeConnections(input, { databases: [], ossProfiles: [] });
    expect(input.connections.database_profiles).toHaveLength(2);
  });
});

describe('validateConnections', () => {
  it('accepts a valid draft', () => {
    expect(validateConnections(extractConnections(CONFIG))).toBeNull();
  });

  it('rejects bad port, missing id, duplicate id', () => {
    const d = extractConnections(CONFIG);
    d.databases[0]!.port = 0;
    expect(validateConnections(d)).toMatch(/端口/);

    const d2 = extractConnections(CONFIG);
    d2.databases[0]!.id = '';
    expect(validateConnections(d2)).toMatch(/ID/);

    const d3 = extractConnections(CONFIG);
    d3.databases[1]!.id = 'main';
    expect(validateConnections(d3)).toMatch(/重复/);
  });
});

describe('toTestProfile', () => {
  it('builds an inline profile with settings and trims databases', () => {
    const db = { ...newDbProfile(), id: 'x ', host: '1.2.3.4', username: 'u', password: 'p', databases: ['a', ' ', ''] };
    const p = toTestProfile(db) as { id: string; password?: string; settings: { databases: string[] } };
    expect(p.id).toBe('x');
    expect(p.password).toBe('p');
    expect(p.settings.databases).toEqual(['a']);
  });

  it('omits password when empty', () => {
    const db = { ...newDbProfile(), id: 'x', host: '1.2.3.4', username: 'u' };
    const p = toTestProfile(db) as { password?: string };
    expect(p.password).toBeUndefined();
  });

  it('uses active environment settings when env mode is on', () => {
    const db = {
      ...newDbProfile(),
      id: 'x',
      host: '1.2.3.4',
      username: 'u',
      activeEnvironment: 'production',
      environments: [
        newEnvDraft('qa'),
        { ...newEnvDraft('production'), host: '10.0.0.99', port: 3307, username: 'prod_u', password: 'prod_pw', databases: ['prod_db'] },
      ],
    };
    const p = toTestProfile(db) as { id: string; settings: Record<string, unknown>; password?: string; active_environment?: string };
    expect(p.id).toBe('x');
    expect(p.active_environment).toBe('production');
    expect(p.settings.host).toBe('10.0.0.99');
    expect(p.settings.port).toBe(3307);
    expect(p.settings.username).toBe('prod_u');
    expect(p.password).toBe('prod_pw');
    expect(p.settings.databases).toEqual(['prod_db']);
  });
});

describe('mergeConnections env mode', () => {
  it('writes active_environment + environments and strips top-level password', () => {
    const d = extractConnections(CONFIG);
    d.databases[0]!.activeEnvironment = 'production';
    d.databases[0]!.environments = [
      { ...newEnvDraft('qa'), host: 'qa-host', username: 'qa_u', password: 'qa_pw', databases: ['qa_db'] },
      { ...newEnvDraft('production'), host: 'prod-host', username: 'prod_u', password: 'prod_pw', databases: ['prod_db'] },
    ];
    const merged = mergeConnections(CONFIG, d) as Record<string, unknown>;
    const profiles = (merged.connections as Record<string, unknown>).database_profiles as Record<string, unknown>[];
    const main = profiles[0]!;
    expect(main.active_environment).toBe('production');
    expect(main.password).toBeUndefined();
    const envs = main.environments as Record<string, Record<string, unknown>>;
    expect(envs.production).toBeDefined();
    expect((envs.production!.settings as Record<string, unknown>).host).toBe('prod-host');
  });
});

describe('validateConnections env mode', () => {
  it('accepts valid env mode', () => {
    const d = extractConnections(CONFIG);
    d.databases[0]!.activeEnvironment = 'prod';
    d.databases[0]!.environments = [
      { ...newEnvDraft('qa'), host: 'qa', username: 'qa_u', password: 'pw', databases: ['a'] },
      { ...newEnvDraft('prod'), host: 'prod', username: 'p_u', password: 'pw', databases: ['a'] },
    ];
    expect(validateConnections(d)).toBeNull();
  });

  it('rejects missing host in env', () => {
    const d = extractConnections(CONFIG);
    d.databases[0]!.activeEnvironment = 'qa';
    d.databases[0]!.environments = [{ ...newEnvDraft('qa'), host: '', username: 'u', databases: ['a'] }];
    expect(validateConnections(d)).toMatch(/host/);
  });

  it('rejects invalid port in env', () => {
    const d = extractConnections(CONFIG);
    d.databases[0]!.activeEnvironment = 'qa';
    d.databases[0]!.environments = [{ ...newEnvDraft('qa'), host: 'h', port: 0, username: 'u', databases: ['a'] }];
    expect(validateConnections(d)).toMatch(/端口/);
  });
});
