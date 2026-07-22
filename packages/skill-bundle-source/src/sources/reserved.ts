import type {
  BundleManifest,
  FetchedBundle,
  SkillBundleSource,
  SkillBundleVersion,
  SkillSourceHealth,
  SkillSourceType,
} from '@easybi-studio/contracts';

/**
 * Reserved source implementations (plan §8.1).
 *
 * These keep the same SkillBundleSource contract so business code can target
 * any source uniformly, but they are NOT connected to any remote/platform
 * service in the first release. Every method reports unavailability rather than
 * partially implementing a remote protocol.
 */
class NotImplementedSource implements SkillBundleSource {
  constructor(readonly type: SkillSourceType) {}

  async healthCheck(): Promise<SkillSourceHealth> {
    return { type: this.type, available: false, note: '该来源尚未在第一版实现' };
  }

  async listVersions(): Promise<SkillBundleVersion[]> {
    return [];
  }

  async getManifest(): Promise<BundleManifest> {
    throw new Error(`来源类型 ${this.type} 尚未实现 getManifest`);
  }

  async fetch(): Promise<FetchedBundle> {
    throw new Error(`来源类型 ${this.type} 尚未实现 fetch`);
  }
}

/** Reserved: platform built-in bundle shipped with the host. */
export class BuiltInSource extends NotImplementedSource {
  constructor() {
    super('built-in');
  }
}
