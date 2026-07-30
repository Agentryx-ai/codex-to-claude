import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Resolve the Codex home directory (rollout sessions live under <codexHome>/sessions). */
export function resolveCodexHome(override?: string): string {
  if (override && override.trim() !== "") return path.resolve(override);
  const env = process.env.CODEX_HOME?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".codex");
}

/** Resolve the Claude config directory (transcripts live under <claudeHome>/projects). */
export function resolveClaudeHome(override?: string): string {
  if (override && override.trim() !== "") return path.resolve(override);
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".claude");
}

/**
 * Normalize a cwd to match Claude Code's on-disk convention.
 * Observed: Claude Code stores Windows paths with a lowercase drive letter
 * (`c:\...`) while Codex stores an uppercase drive (`C:\...`). Lowercasing the
 * drive lets an imported session co-locate with the same project's existing
 * Claude sessions instead of creating a separate project entry.
 */
export function normalizeCwd(cwd: string): string {
  if (/^[A-Za-z]:/.test(cwd)) return cwd[0].toLowerCase() + cwd.slice(1);
  return cwd;
}

/**
 * The spelling of a cwd to put in a Claude Desktop session record.
 *
 * Desktop groups the conversation list by that string as written, so two
 * spellings of one directory show up as two projects. Codex keeps whatever case
 * the session was started with — `C:\...\Riddlemesh` in one thread and
 * `c:\...\Riddlemesh` in the next — which split one project in half. Ask the
 * filesystem for the canonical spelling, which is what Claude's own records use.
 *
 * A symlinked root would resolve to a different directory rather than a
 * different casing, so that result is discarded: only the casing is adopted.
 */
export function canonicalCwd(cwd: string): string {
  if (cwd === "") return cwd;
  const uppercaseDrive = /^[a-z]:/.test(cwd) ? cwd[0].toUpperCase() + cwd.slice(1) : cwd;
  let real: string;
  try {
    real = fs.realpathSync.native(cwd);
  } catch {
    return uppercaseDrive;
  }
  return real.toLowerCase() === uppercaseDrive.toLowerCase() ? real : uppercaseDrive;
}

/**
 * Encode an absolute cwd into a Claude Code project-directory name.
 * Claude Code replaces every non-alphanumeric character with '-'.
 * Verified against a real project dir: `c:\_projects\Agentryx-ai` -> `c---projects-Agentryx-ai`.
 */
export function encodeProjectDir(cwd: string): string {
  return normalizeCwd(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}
