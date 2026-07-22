import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeWorkflowState } from './workflow.js';

let ws: string;

async function seedWorkspace(): Promise<void> {
  await mkdir(join(ws, 'skills'), { recursive: true });
  await mkdir(join(ws, 'config'), { recursive: true });
  await mkdir(join(ws, 'knowledge', 'drafts'), { recursive: true });
  await mkdir(join(ws, 'reports', 'plans'), { recursive: true });
  await writeFile(join(ws, 'skills', 'bundle.manifest.json'), '{}');
  await writeFile(join(ws, 'skills', 'bundle.lock.json'), '{}');
  await writeFile(join(ws, 'knowledge', 'index.json'), JSON.stringify({ versions: [] }));
  await writeFile(join(ws, 'reports', 'index.json'), JSON.stringify({ reports: [] }));
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'easybi-wf-'));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('computeWorkflowState (disk-fact driven)', () => {
  it('reports WORKSPACE_READY step false when manifest/lock missing', async () => {
    const state = await computeWorkflowState(ws);
    const step = state.steps.find((s) => s.stage === 'WORKSPACE_READY');
    expect(step?.done).toBe(false);
    expect(state.current).toBe('WORKSPACE_READY');
    // A Chinese label accompanies the raw stage enum for display.
    expect(state.currentLabel).toBe('工作区就绪');
  });

  it('advances to BUILD_CONFIG_READY when workspace is adapted but config missing', async () => {
    await seedWorkspace();
    const state = await computeWorkflowState(ws);
    expect(state.current).toBe('BUILD_CONFIG_READY');
    expect(state.nextAction).toContain('数据库连接');
  });

  it('advances to knowledge step when build config has db profile + report requirements', async () => {
    await seedWorkspace();
    await writeFile(
      join(ws, 'config', 'easy-bi.json'),
      JSON.stringify({
        config_version: '4',
        connections: { database_profiles: [{ id: 'p' }] },
        knowledge: { report_requirements: [{ id: 'r', name: 'R', required_fields: ['a'] }] },
      }),
    );
    const state = await computeWorkflowState(ws);
    // No knowledge draft/published yet -> KNOWLEDGE_MISSING.
    expect(state.current).toBe('KNOWLEDGE_MISSING');
  });

  it('reflects a published knowledge version and a report package', async () => {
    await seedWorkspace();
    await writeFile(
      join(ws, 'config', 'easy-bi.json'),
      JSON.stringify({
        config_version: '4',
        connections: { database_profiles: [{ id: 'p' }] },
        knowledge: { report_requirements: [] },
      }),
    );
    await writeFile(join(ws, 'knowledge', 'index.json'), JSON.stringify({ versions: ['1.0.0'] }));
    await writeFile(join(ws, 'reports', 'index.json'), JSON.stringify({ reports: [{ id: 'r' }] }));
    const state = await computeWorkflowState(ws);
    expect(state.current).toBe('RUNTIME_TEST_REQUIRED');
  });
});
