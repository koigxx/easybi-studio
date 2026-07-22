/** Artifact levels and precheck (plan §10.6, §10.14, §12.6). */

export type ArtifactLevel = 'development' | 'candidate' | 'production';

export interface ArtifactPrecheckItem {
  key: string;
  label: string;
  ok: boolean;
  /** Chinese detail. */
  detail: string;
}

export interface ArtifactPrecheck {
  level: ArtifactLevel;
  /** Whether a build is allowed for this level in the first release. */
  buildable: boolean;
  items: ArtifactPrecheckItem[];
  /** Missing configuration / gates (Chinese). */
  missing: string[];
  developmentOnly: boolean;
}

export interface ArtifactRecord {
  id: string;
  projectId: string;
  level: ArtifactLevel;
  /** Selected knowledge version. */
  knowledgeVersion?: string;
  /** Selected report package versions (reportId -> version). */
  reportVersions?: Record<string, string>;
  developmentOnly: boolean;
  createdAt: string;
  /** Workspace-relative path to the tar.gz. */
  file: string;
  sha256: string;
  sizeBytes: number;
}
