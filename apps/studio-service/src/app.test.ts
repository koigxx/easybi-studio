import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from './app.js';

const { app } = buildApp({
  dbFile: ':memory:',
  allowedWorkspaceRoots: ['/Users/admin/innos/easy-bi-workspace/easybi-studio-workspaces'],
});

afterAll(async () => {
  await app.close();
});

describe('studio-service health', () => {
  it('returns a unified success envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/easybi/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.requestId).toMatch(/^req_/);
    expect(body.data.status).toBe('ok');
    expect(body.data.service).toBe('easybi-studio-service');
  });

  it('reports active agent provider health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/easybi/agent-health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    // Default (no EASYBI_AGENT_PROVIDER, no CLI in test) resolves to a provider
    // that reports its availability and identifier via the frozen AgentHealth shape.
    expect(typeof body.data.available).toBe('boolean');
    expect(typeof body.data.provider).toBe('string');
  });
});
