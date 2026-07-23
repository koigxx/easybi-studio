import { spawn } from "node:child_process";
import { join } from "node:path";
import type {
  ReportPhaseHookInput,
  ReportPhaseHookResult,
} from "@easybi-studio/job-manager";
import { WorkspaceSkillAdapter } from "@easybi-studio/workspace-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPORT_SKILL_ID = "create-report-package";

interface CliResult {
  ok: boolean;
  json: unknown;
  stdout: string;
  stderr: string;
  code: number | null;
}

function runReportCli(
  workspaceRoot: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<CliResult> {
  return new Promise<CliResult>(async (resolve) => {
    let adapter: WorkspaceSkillAdapter;
    let cliPath: string;
    try {
      adapter = new WorkspaceSkillAdapter(workspaceRoot);
      cliPath = await adapter.resolveCommand(REPORT_SKILL_ID, "package_cli");
    } catch (err) {
      resolve({
        ok: false,
        json: null,
        stdout: "",
        stderr: `无法解析报表技能 CLI: ${String((err as Error).message ?? err)}`,
        code: null,
      });
      return;
    }

    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: workspaceRoot,
      shell: false,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        json: null,
        stdout,
        stderr: String(err.message ?? err),
        code: null,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let json: unknown = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      const jsonOk =
        json && typeof json === "object" && "ok" in (json as Record<string, unknown>)
          ? Boolean((json as Record<string, unknown>).ok)
          : code === 0;
      resolve({ ok: code === 0 && jsonOk, json, stdout, stderr, code });
    });
  });
}

/** Phases that produce a compilable package. */
const FINAL_PHASES = new Set(["QUERY_COMPILATION", "SCRIPT_COMPILATION"]);

// ---------------------------------------------------------------------------
// StagedReportWorkflow
// ---------------------------------------------------------------------------

export class StagedReportWorkflow {
  async ensureCapabilities(
    _input: ReportPhaseHookInput,
  ): Promise<ReportPhaseHookResult> {
    return { ok: true };
  }

  async prepare(_input: ReportPhaseHookInput): Promise<ReportPhaseHookResult> {
    return { ok: true };
  }

  /**
   * After the final compilation phase completes, automatically assemble the
   * report package via `report-package-cli.js finalize-staged` so the user
   * doesn't have to run it manually.
   */
  async complete(input: ReportPhaseHookInput): Promise<ReportPhaseHookResult> {
    if (!FINAL_PHASES.has(input.phase)) return { ok: true };

    const planPath = join(
      input.workspaceRoot,
      "reports",
      "plans",
      `${input.reportId}.json`,
    );
    const buildRoot = join(
      input.workspaceRoot,
      "work",
      "report-build",
      input.reportId,
      input.reportRevision,
    );

    const result = await runReportCli(input.workspaceRoot, [
      "finalize-staged",
      "--workspace",
      input.workspaceRoot,
      "--plan",
      planPath,
      "--root",
      buildRoot,
      "--reviewed-by",
      input.reviewedBy ?? "studio",
    ]);

    if (!result.ok) {
      const message =
        (result.json &&
        typeof result.json === "object" &&
        "error" in (result.json as Record<string, unknown>)
          ? String((result.json as Record<string, unknown>).error)
          : undefined) ??
        result.stderr.trim() ??
        "报表包组装失败";
      return { ok: false, error: message };
    }

    const pkg =
      result.json && typeof result.json === "object"
        ? String((result.json as Record<string, unknown>).package ?? "")
        : "";
    return {
      ok: true,
      details: { package: pkg, phase: input.phase },
    };
  }
}
