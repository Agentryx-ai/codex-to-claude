// Read Codex's own thread index (state_*.sqlite) and select exactly the set that
// Codex Desktop's conversation list shows. The Desktop sidebar calls the app-server
// RPC `listThreads({ archived:false, parentThreadId:null, sortKey:"updated..." })`;
// this module replicates that against the SQLite `threads` table.
//
// Requires `node --experimental-sqlite` (Node >= 22.5).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DbThreadRow {
  id: string;
  rolloutPath: string;
  cwd: string;
  title: string;
  source: string;
  updatedAtMs: number | null;
}

export interface DbSelectOptions {
  /** Exclude non-interactive `codex exec` automation runs. Default false (match the raw RPC). */
  interactiveOnly?: boolean;
  /** Include archived threads (Desktop hides these by default). Default false. */
  includeArchived?: boolean;
}

/** Locate the newest state DB: state_<n>.sqlite with the highest <n>. */
export function findStateDb(codexHome: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(codexHome);
  } catch {
    return null;
  }
  const candidates = entries
    .map((name) => {
      const m = name.match(/^state_(\d+)\.sqlite$/);
      return m ? { name, n: Number(m[1]) } : null;
    })
    .filter((x): x is { name: string; n: number } => x != null)
    .sort((a, b) => b.n - a.n);
  return candidates.length ? path.join(codexHome, candidates[0].name) : null;
}

/**
 * Select the Codex Desktop conversation-list set from the threads table.
 * Returns null if no state DB exists or it cannot be opened (caller should fall back).
 */
export function loadDesktopThreads(
  codexHome: string,
  opts: DbSelectOptions = {},
): DbThreadRow[] | null {
  const dbPath = findStateDb(codexHome);
  if (!dbPath) return null;

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    const where: string[] = [];
    if (!opts.includeArchived) where.push("archived = 0");
    // parentThreadId:null  -> exclude spawned children
    where.push(
      "id NOT IN (SELECT child_thread_id FROM thread_spawn_edges WHERE child_thread_id IS NOT NULL)",
    );
    // exclude subagent worker threads (agent_job spawns not linked via spawn_edges)
    where.push("source NOT LIKE '%subagent%'");
    if (opts.interactiveOnly) where.push("source NOT LIKE '%exec%'");

    const sql =
      `SELECT id, rollout_path AS rolloutPath, cwd, ` +
      `COALESCE(title, name, first_user_message, '') AS title, ` +
      `source, ` +
      `COALESCE(recency_at_ms, updated_at_ms, updated_at) AS updatedAtMs ` +
      `FROM threads WHERE ${where.join(" AND ")} ` +
      `ORDER BY updatedAtMs DESC`;

    const rows = db.prepare(sql).all() as unknown as DbThreadRow[];
    return rows.map((r) => ({
      id: String(r.id),
      rolloutPath: String(r.rolloutPath ?? ""),
      cwd: String(r.cwd ?? ""),
      title: String(r.title ?? ""),
      source: String(r.source ?? ""),
      updatedAtMs: r.updatedAtMs != null ? Number(r.updatedAtMs) : null,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Fetch specific threads by id (used with the Desktop sidebar selection).
 * Non-archived only unless includeArchived. Ordered by recency desc.
 * Returns null if no DB. Missing ids are simply absent from the result.
 */
export function loadThreadsByIds(
  codexHome: string,
  ids: string[],
  opts: DbSelectOptions = {},
): DbThreadRow[] | null {
  const dbPath = findStateDb(codexHome);
  if (!dbPath || ids.length === 0) return dbPath ? [] : null;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const placeholders = ids.map(() => "?").join(",");
    const archClause = opts.includeArchived ? "" : "AND archived = 0";
    const sql =
      `SELECT id, rollout_path AS rolloutPath, cwd, ` +
      `COALESCE(title, name, first_user_message, '') AS title, source, ` +
      `COALESCE(recency_at_ms, updated_at_ms, updated_at) AS updatedAtMs ` +
      `FROM threads WHERE id IN (${placeholders}) ${archClause} ORDER BY updatedAtMs DESC`;
    const rows = db.prepare(sql).all(...ids) as unknown as DbThreadRow[];
    return rows.map((r) => ({
      id: String(r.id),
      rolloutPath: String(r.rolloutPath ?? ""),
      cwd: String(r.cwd ?? ""),
      title: String(r.title ?? ""),
      source: String(r.source ?? ""),
      updatedAtMs: r.updatedAtMs != null ? Number(r.updatedAtMs) : null,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Coarse source-kind label for display / filtering. */
export function sourceKind(source: string): string {
  if (source.includes("subagent")) return "subagent";
  if (source.includes("vscode")) return "vscode";
  if (source.includes("exec")) return "exec";
  if (source.includes("cli")) return "cli";
  return source.replace(/[{}"]/g, "").slice(0, 12) || "unknown";
}
