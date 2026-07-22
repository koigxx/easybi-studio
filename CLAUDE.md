# Easy BI Studio Development Rules

## Objective

Build a standalone local Easy BI Studio. It must work with Claude Code first and integrate with Innos later through an AgentBridge adapter.

## Required reading

Before implementation, read:

- /Users/admin/innos/easy-bi-workspace/easy-bi/docs/总体架构.md
- /Users/admin/innos/easy-bi-workspace/easy-bi/docs/开发维护指南.md
- /Users/admin/innos/easy-bi-workspace/easy-bi/skills/目录与项目兼容性规范.md
- /Users/admin/innos/easy-bi-workspace/easy-bi/skills/bundle.manifest.json
- /Users/admin/innos/easy-bi-workspace/easy-bi/toolkit/contracts/统一接口契约.md
- docs/ARCHITECTURE.md (system overview, module map, data flow, security invariants — read first)
- docs/AI_CONTRIBUTING.md (onboarding, layering, skill-sync workflow, quality gates, doc-maintenance duty)
- docs/IMPLEMENTATION_STATUS.md
- docs/UI_STYLE_GUIDE.md (mandatory before any studio-web UI change)
- docs/INNOS_INTEGRATION.md (mandatory before any integration/transport change)
- the SKILL.md and required references inside the synchronized Easy BI bundle

## Directory boundaries

- Product source: /Users/admin/innos/easy-bi-workspace/easybi-studio
- Test workspaces: /Users/admin/innos/easy-bi-workspace/easybi-studio-workspaces
- Canonical Easy BI source: /Users/admin/innos/easy-bi-workspace/easy-bi
- Never write generated customer data into the product repository.
- Treat /Users/admin/innos/easy-bi-workspace/easy-bi as read-only unless the user explicitly requests a source change.

## Architecture

- React 18 + Vite for studio-web.
- Node.js 24 + TypeScript + Fastify for studio-service.
- All AI access must go through AgentBridge.
- All Skill acquisition must go through SkillBundleSource.
- All workspace and Skill paths must go through Workspace/Skill Adapter and bundle.manifest.json.
- ClaudeCodeBridge is the first provider.
- InnosAgentBridge is a later provider.
- Runtime execution must reuse the bundled easybi-runtime.
- Report-specific packages must not duplicate HTTP, MySQL, Excel, OSS, or task code.

## UI style

- All studio-web UI must follow the Innos IDE-Mono design system defined in docs/UI_STYLE_GUIDE.md.
- Use the `--ide-*` design tokens and `.ide-*` component classes; do not introduce ad-hoc colors, spacing, or one-off component styles.
- Default theme is Light (Mono White), following Innos; Dark (Mono Grayscale) is a toggle. Never hardcode a theme.
- Scope structural styles under `.innos-app`; use Tailwind v4 + lucide-react, matching the Innos stack.
- Front-end AI chat goes only through AgentBridge + the Job/SSE pipeline (`/api/easybi/agent-actions`, `/agent-tasks/*`, `/jobs/:id/events`); the provider is switchable by env (`EASYBI_AGENT_PROVIDER`: claude locally → innos later) with no front-end change. The front-end must never call any AI vendor API directly, and must not embed provider-specific protocol handling. Knowledge and report pages remain viewers/editors; the AI drawer is the only generation entry point.
- Studio integrates as an internal platform reverse-proxied by cloud-gateway; keep studio-service bound to 127.0.0.1 under the `/api/easybi/*` prefix (see docs/INNOS_INTEGRATION.md §8).

## Local permissions

- Local Claude Code tasks may use --dangerously-skip-permissions.
- Full tool permission does not authorize work outside the registered product and workspace directories.
- Never expose API keys, database passwords, tokens, or full configuration files in logs.
- Never execute database DDL or DML.

## Stage execution

- Work on only one current stage at a time.
- Read the stage inputs, implementation list, exclusions, and exit criteria before editing.
- Begin the next stage only after the current stage passes all documented exit criteria.
- Continue through later stages in the same development task when no user decision or external blocker is required.
- Update docs/IMPLEMENTATION_STATUS.md only after code and tests are complete.
- At the end of each stage, record changed files, test results, known issues, and the next stage in docs/IMPLEMENTATION_STATUS.md.
- Pause for the user only when business confirmation, credentials, a real database, an external service, or a material scope decision is required.

## Skill bundle

- Synchronize only the documented whitelist from /Users/admin/innos/easy-bi-workspace/easy-bi.
- Use LocalDirectorySource first; keep LocalArchiveSource, BuiltInSource, and HttpRegistrySource behind the same interface.
- Cache immutable Bundle versions and install an independent copy into each workspace.
- Opening a workspace must automatically run bootstrap init or check from the installed Manifest.
- Generate and validate skills/bundle.lock.json for every installed workspace.
- Do not copy docs, generated knowledge, reports, outputs, work files, secrets, or node_modules.
- Generate a manifest and SHA-256 list.
- Never hardcode Skill output paths outside the Workspace/Skill Adapter.
- Do not silently upgrade existing workspaces.

## Workspace rules

- One workspace represents one customer system.
- One write task per workspace.
- Use revision hashes for configuration writes.
- Preserve previous knowledge and report versions.
- Never overwrite published report versions in place.

## Process execution

- Use child_process.spawn with shell: false.
- Pass arguments as arrays.
- Set cwd to the registered workspace.
- Stream Claude and job events as NDJSON/SSE.
- Track PID, session ID, exit code, and artifacts.
- Stop only processes started by Studio.

## Quality gates

- TypeScript strict mode.
- Unit tests for path checks, configuration conflicts, event normalization, and task state transitions.
- Integration tests for ClaudeCodeBridge with a fake CLI.
- Integration tests for Runtime proxy binary and JSON responses.
- Playwright tests for configuration, knowledge, report, test, and publish flows.
- Every Agent write task must create a checkpoint and change summary before it can be marked successful.
- Static validation must never be presented as a successful real export.
- Candidate and production artifacts must remain blocked until their documented gates are implemented.
- No feature is complete without error, cancellation, restart, and empty-state handling.
