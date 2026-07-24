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
 * Encode an absolute cwd into a Claude Code project-directory name.
 * Claude Code replaces every non-alphanumeric character with '-'.
 * Verified against a real project dir: `c:\_projects\Agentryx-ai` -> `c---projects-Agentryx-ai`.
 */
export function encodeProjectDir(cwd: string): string {
  return normalizeCwd(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}
