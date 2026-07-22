import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BundleManifest,
  FetchedBundle,
  SkillBundleSource,
  SkillBundleVersion,
  SkillSourceHealth,
} from '@easybi-studio/contracts';
import { LocalArchiveSource } from './local-archive.js';

/**
 * HTTP registry Skill source (cloud distribution).
 *
 * A registry only needs to serve three read-only endpoints (see
 * docs/INNOS_INTEGRATION.md §3):
 *
 *   GET  {base}/bundles/{bundleId}/versions           -> { versions: [{version}] } | [{version}]
 *   GET  {base}/bundles/{bundleId}/{version}/manifest  -> BundleManifest
 *   GET  {base}/bundles/{bundleId}/{version}/archive   -> immutable .tar.gz bytes
 *
 * `fetch` downloads the archive to a temp file, then delegates to
 * LocalArchiveSource so extraction, whitelist validation, SHA-256 and snapshot
 * install are shared with the local sources. The registry never receives
 * customer databases, knowledge, reports or secrets.
 *
 * Auth: an optional bearer token is read from the environment at call time and
 * sent as a header. It is NEVER stored in config, lock files, or logs.
 */
export interface HttpRegistryOptions {
  /** Base URL, e.g. https://registry.example.com/easybi */
  baseUrl: string;
  /** Env var name holding a bearer token (value read at call time, never persisted). */
  authTokenEnv?: string;
  /** Fetch timeout in ms. */
  timeoutMs?: number;
}

export class HttpRegistrySource implements SkillBundleSource {
  readonly type = 'http-registry' as const;
  private readonly baseUrl: string;
  private readonly authTokenEnv: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: HttpRegistryOptions) {
    if (!options.baseUrl) throw new Error('HttpRegistrySource 需要 baseUrl');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.authTokenEnv = options.authTokenEnv;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    const token = this.authTokenEnv ? process.env[this.authTokenEnv] : undefined;
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  private async request(path: string, accept: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: { ...this.headers(), accept },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Registry 请求失败 HTTP ${res.status}：${path}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<SkillSourceHealth> {
    try {
      const res = await this.request(`/health`, 'application/json').catch(() => null);
      // A registry may not expose /health; treat a reachable base as available.
      const reachable = res?.ok ?? (await this.request(`/`, 'text/html').then(() => true).catch(() => false));
      return {
        type: this.type,
        available: Boolean(reachable),
        location: this.baseUrl,
        note: reachable ? 'HTTP Registry 可达' : 'HTTP Registry 不可达',
      };
    } catch (err) {
      return {
        type: this.type,
        available: false,
        location: this.baseUrl,
        note: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listVersions(bundleId: string): Promise<SkillBundleVersion[]> {
    const res = await this.request(`/bundles/${bundleId}/versions`, 'application/json');
    const body = (await res.json()) as unknown;
    const raw = Array.isArray(body)
      ? body
      : Array.isArray((body as { versions?: unknown[] })?.versions)
        ? (body as { versions: unknown[] }).versions
        : [];
    return raw.map((v) => {
      const version = typeof v === 'string' ? v : String((v as { version?: string }).version ?? '');
      return { bundleId, version };
    });
  }

  async getManifest(bundleId: string, version: string): Promise<BundleManifest> {
    const res = await this.request(`/bundles/${bundleId}/${version}/manifest`, 'application/json');
    return (await res.json()) as BundleManifest;
  }

  async fetch(bundleId: string, version: string, destination: string): Promise<FetchedBundle> {
    // Resolve concrete version (registry may accept 'current' / 'latest').
    const manifest = await this.getManifest(bundleId, version);
    const resolvedVersion = manifest.bundle_version || version;

    // Download the immutable archive to a temp file.
    const tmp = await mkdtemp(join(tmpdir(), 'easybi-registry-'));
    const archivePath = join(tmp, `${bundleId}-${resolvedVersion}.tar.gz`);
    try {
      const res = await this.request(
        `/bundles/${bundleId}/${resolvedVersion}/archive`,
        'application/gzip',
      );
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(archivePath, buf);

      // Delegate extraction + whitelist + hash + install to the archive source.
      const fetched = await new LocalArchiveSource(archivePath).fetch(
        bundleId,
        resolvedVersion,
        destination,
      );

      // Record registry provenance (not the temp archive path).
      const provManifest: BundleManifest = {
        ...fetched.manifest,
        source: { type: this.type, location: `${this.baseUrl}/bundles/${bundleId}/${resolvedVersion}` },
      };
      const { readFile } = await import('node:fs/promises');
      const manifestPath = join(destination, 'skills', 'bundle.manifest.json');
      const onDisk = JSON.parse(await readFile(manifestPath, 'utf8')) as BundleManifest;
      onDisk.source = provManifest.source;
      await writeFile(manifestPath, JSON.stringify(onDisk, null, 2) + '\n', 'utf8');

      return { ...fetched, manifest: provManifest };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
