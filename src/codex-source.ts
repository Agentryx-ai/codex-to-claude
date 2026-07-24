import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexSession, RolloutLine, SessionMeta } from "./types.ts";
import { normalizeCwd } from "./paths.ts";
import { loadDesktopThreads, loadThreadsByIds } from "./codex-db.ts";
import { loadDesktopSelection } from "./codex-desktop-state.ts";

/** Recursively collect rollout .jsonl files under <codexHome>/sessions. */
export function discoverRolloutFiles(codexHome: string): string[] {
  const root = path.join(codexHome, "sessions");
  const out: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  walk(root);
  return out;
}

function tsToMs(ts: string | undefined): number | null {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

function blocksToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
      parts.push((b as { text: string }).text);
    }
  }
  return parts.join("\n").trim();
}

/** Parse a single rollout file into a CodexSession (returns null if it has no usable content). */
export function parseRollout(rolloutPath: string): CodexSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(rolloutPath, "utf8");
  } catch {
    return null;
  }

  const meta: SessionMeta = {};
  const items: CodexSession["items"] = [];
  let firstTsMs: number | null = null;
  let lastTsMs: number | null = null;
  let model: string | null = null;
  let messageCount = 0;
  let title = "";

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let rec: RolloutLine;
    try {
      rec = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    const tsMs = tsToMs(rec.timestamp);
    if (tsMs != null) {
      if (firstTsMs == null) firstTsMs = tsMs;
      lastTsMs = tsMs;
    }
    const payload = (rec.payload ?? {}) as Record<string, unknown>;

    if (rec.type === "session_meta") {
      Object.assign(meta, payload as SessionMeta);
      continue;
    }
    if (rec.type === "turn_context") {
      const m = payload["model"];
      if (typeof m === "string" && m !== "") model = m;
      continue;
    }
    if (rec.type !== "response_item") continue;

    items.push({ tsMs, payload });

    if (payload["type"] === "message") {
      const role = payload["role"];
      if (role === "user" || role === "assistant") {
        messageCount += 1;
        if (title === "" && role === "user") {
          const t = blocksToText(payload["content"]);
          if (t !== "") title = t.replace(/\s+/g, " ").slice(0, 100);
        }
      }
    }
  }

  if (items.length === 0) return null;

  // Prefer the per-file UUID from the rollout filename: Codex reuses the same
  // session_meta.id across multiple rollout files when a thread is resumed/forked,
  // so keying on meta.id would make a later file overwrite an earlier transcript.
  // The filename UUID is unique per rollout file -> one file maps to one transcript.
  const sessionId =
    deriveSessionIdFromFilename(rolloutPath) ||
    (typeof meta.id === "string" && meta.id) ||
    randomUUID();

  // Codex sometimes records the Windows extended-length prefix (\\?\C:\...).
  // Strip it so the path matches what Claude Desktop stores as cwd.
  const rawCwd =
    typeof meta.cwd === "string" && meta.cwd !== ""
      ? meta.cwd.replace(/^\\\\\?\\/, "")
      : "";
  const cwd = rawCwd !== "" ? normalizeCwd(rawCwd) : "";
  const source =
    typeof meta.source === "string"
      ? meta.source
      : meta.source != null
        ? JSON.stringify(meta.source)
        : "";
  const isChild = meta.parent_thread_id != null && meta.parent_thread_id !== "";
  if (model == null && typeof meta.model_provider === "string") {
    // model_provider is a provider name, not a model; leave model null unless a turn_context set it.
  }

  return {
    sessionId,
    rolloutPath,
    cwd,
    cwdOriginal: rawCwd,
    meta,
    firstTsMs: firstTsMs ?? tsToMs(meta.timestamp),
    lastTsMs: lastTsMs ?? tsToMs(meta.timestamp),
    items,
    model,
    messageCount,
    title,
    source,
    isChild,
  };
}

/** rollout-2026-07-24T05-38-12-<uuid>.jsonl -> <uuid> (best effort). */
export function deriveSessionIdFromFilename(rolloutPath: string): string {
  const base = path.basename(rolloutPath).replace(/\.jsonl$/, "");
  const uuidMatch = base.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return uuidMatch ? uuidMatch[0] : base;
}

/** Discover + parse all sessions under a codex home. */
export function loadCodexSessions(codexHome: string): CodexSession[] {
  const files = discoverRolloutFiles(codexHome);
  const sessions: CodexSession[] = [];
  for (const f of files) {
    const s = parseRollout(f);
    if (s) sessions.push(s);
  }
  // newest last-activity first
  sessions.sort((a, b) => (b.lastTsMs ?? 0) - (a.lastTsMs ?? 0));
  return sessions;
}

export interface DesktopSelectOptions {
  interactiveOnly?: boolean; // drop `codex exec` automation runs
  includeArchived?: boolean;
}
export interface DesktopSelectResult {
  via: "desktop" | "db" | "scan";
  sessions: CodexSession[];
}

/**
 * Select the conversations Codex Desktop shows in its left sidebar.
 *
 * Preferred ("desktop"): read Codex Desktop's UI state (.codex-global-state.json)
 * for the exact sidebar membership — threads assigned to a registered project plus
 * projectless threads — and keep the non-archived ones (archived/rollout_path/title
 * come from state_*.sqlite). This matches the Desktop list exactly.
 *
 * Fallbacks: ("db") replicate the listThreads filter over the whole threads table;
 * ("scan") scan rollout files with the equivalent semantic filter.
 */
export function loadDesktopSessions(
  codexHome: string,
  opts: DesktopSelectOptions = {},
): DesktopSelectResult {
  const selection = loadDesktopSelection(codexHome);
  if (selection) {
    const ids = [...selection.threadProject.keys()];
    const rows = loadThreadsByIds(codexHome, ids, opts);
    if (rows) {
      const sessions: CodexSession[] = [];
      for (const r of rows) {
        if (!r.rolloutPath) continue;
        if (opts.interactiveOnly && r.source.includes("exec")) continue;
        const s = parseRollout(r.rolloutPath);
        if (!s) continue;
        if (r.title) s.title = r.title.replace(/\s+/g, " ").slice(0, 100);
        if (r.source) s.source = r.source;
        const proj = selection.threadProject.get(r.id) ?? null;
        s.projectName = proj?.name ?? "(no project)";
        s.hasProject = proj != null;
        s.isArchived = r.archived;
        s.sandboxPolicy = r.sandboxPolicy;
        s.approvalMode = r.approvalMode;
        s.reasoningEffort = r.reasoningEffort;
        sessions.push(s);
      }
      return { via: "desktop", sessions };
    }
  }

  const rows = loadDesktopThreads(codexHome, opts);
  if (rows) {
    const sessions: CodexSession[] = [];
    for (const r of rows) {
      if (!r.rolloutPath) continue;
      const s = parseRollout(r.rolloutPath);
      if (!s) continue;
      if (r.title) s.title = r.title.replace(/\s+/g, " ").slice(0, 100);
      if (r.source) s.source = r.source;
      s.sandboxPolicy = r.sandboxPolicy;
      s.approvalMode = r.approvalMode;
      s.reasoningEffort = r.reasoningEffort;
      s.isArchived = r.archived;
      sessions.push(s); // DB already ordered by recency
    }
    return { via: "db", sessions };
  }

  // Fallback: file scan + semantic Desktop-equivalent filter.
  // (archived threads are physically moved to archived_sessions/, so scanning
  // sessions/ already excludes them.)
  const sessions = loadCodexSessions(codexHome).filter((s) => {
    if (s.isChild) return false;
    if (s.source.includes("subagent")) return false;
    if (opts.interactiveOnly && s.source.includes("exec")) return false;
    return true;
  });
  return { via: "scan", sessions };
}
