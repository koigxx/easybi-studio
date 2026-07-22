import { describe, it, expect } from 'vitest';
import { FakeMysqlAdapter, RealMysqlAdapter, normalizeEngine } from './mysql-adapter.js';

describe('normalizeEngine', () => {
  it('defaults to mysql and maps postgres aliases', () => {
    expect(normalizeEngine(undefined)).toBe('mysql');
    expect(normalizeEngine('mysql')).toBe('mysql');
    expect(normalizeEngine('MySQL')).toBe('mysql');
    expect(normalizeEngine('postgres')).toBe('postgresql');
    expect(normalizeEngine('postgresql')).toBe('postgresql');
    expect(normalizeEngine('pg')).toBe('postgresql');
    // Unknown engines fall back to mysql (structural checks still guard use).
    expect(normalizeEngine('oracle')).toBe('mysql');
  });
});

describe('FakeMysqlAdapter', () => {
  const adapter = new FakeMysqlAdapter();

  it('is labeled as fake', () => {
    expect(adapter.kind).toBe('fake');
  });

  it('passes structural validation and never echoes the password', async () => {
    const r = await adapter.testConnection('p1', {
      host: '127.0.0.1',
      port: 3306,
      username: 'reader',
      databases: ['db1'],
      password: 'super-secret',
    });
    expect(r.reachable).toBe(true);
    expect(r.adapter).toBe('fake');
    expect(JSON.stringify(r)).not.toContain('super-secret');
  });

  it('reports incomplete structure', async () => {
    const r = await adapter.testConnection('p2', {
      host: '',
      port: 0,
      username: '',
      databases: [],
    });
    expect(r.reachable).toBe(false);
    expect(r.note).toContain('结构不完整');
  });
});

describe('RealMysqlAdapter (no-connection paths)', () => {
  const adapter = new RealMysqlAdapter({ timeoutMs: 500 });

  it('is labeled as real', () => {
    expect(adapter.kind).toBe('real');
  });

  it('reports incomplete structure without connecting', async () => {
    const r = await adapter.testConnection('p1', {
      host: '',
      port: 0,
      username: '',
      databases: [],
    });
    expect(r.reachable).toBe(false);
    expect(r.adapter).toBe('real');
    expect(r.note).toContain('结构不完整');
  });

  it('fails clearly when a password env var is unset', async () => {
    const r = await adapter.testConnection('p2', {
      host: '127.0.0.1',
      port: 3306,
      username: 'reader',
      databases: ['db1'],
      passwordEnv: 'DEFINITELY_UNSET_EASYBI_TEST_VAR',
    });
    expect(r.reachable).toBe(false);
    expect(r.note).toContain('DEFINITELY_UNSET_EASYBI_TEST_VAR');
  });
});
