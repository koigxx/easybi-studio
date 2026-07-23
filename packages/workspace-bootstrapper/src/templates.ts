/** Workspace-level CLAUDE.md template (plan §19). */
export const WORKSPACE_CLAUDE_MD = `# Easy BI Workspace Rules

This directory is one isolated Easy BI customer-system workspace.

## Required workflow

1. Read skills/bundle.manifest.json and skills/bundle.lock.json.
2. Read skills/目录与项目兼容性规范.md.
3. Read the relevant skills/<skill-id>/SKILL.md completely.
4. Read only the references required by that Skill.
5. Follow the Skill approval gates.
6. Resolve commands and output paths from the Manifest.
7. Use the deterministic compiled CLI under dist/scripts.
8. Validate generated knowledge or report packages before reporting success.

## Permissions

- Claude Code runs in local full-permission development mode.
- Full permission is limited by intent to this workspace.
- Do not modify the Skill source directory outside this workspace.
- Do not access another Easy BI workspace.
- Do not print database passwords, API keys, or tokens.
- Database access must remain read-only.

## Files

- config/easy-bi.json is the build configuration.
- skills/bundle.manifest.json is the installed Skill contract.
- skills/bundle.lock.json records the installed Bundle version and hash.
- toolkit/config/runtime.json is the Runtime configuration.
- knowledge/drafts is editable.
- knowledge/versions is immutable.
- reports/packages contains versioned report packages.
- outputs contains generated test files and artifacts.

## Safety

- Never overwrite an existing published version.
- Never execute DDL or DML.
- Never claim a real export succeeded without a generated and verified Excel file.
- Ask only blocking business questions and preserve all user-confirmed decisions.
`;

/** Default workspace.json content (workspace_format_version 1). */
export function defaultWorkspaceManifest(systemId?: string, systemName?: string): unknown {
  return {
    workspace_format_version: '1',
    status: 'unconfigured',
    system: {
      id: systemId ?? null,
      name: systemName ?? null,
    },
    paths: {
      config: 'config',
      skills: 'skills',
      skill_bundle_manifest: 'skills/bundle.manifest.json',
      skill_bundle_lock: 'skills/bundle.lock.json',
      toolkit: 'toolkit',
      scripts: 'scripts',
      knowledge: 'knowledge',
      report_models: 'reports/models',
      report_packages: 'reports/packages',
      outputs: 'outputs',
      work: 'work',
    },
  };
}
