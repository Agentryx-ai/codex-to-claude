// Register imported transcripts with Claude Desktop's session list.
//
// Claude Desktop (Code) does NOT list ~/.claude/projects/*.jsonl directly. Its
// conversation list is built from "wrapper records" under
//   %APPDATA%/Claude/claude-code-sessions/<accountId>/<deviceId>/local_<uuid>.json
// Each record points at a transcript via `cliSessionId` + `cwd`
// (transcript path = <claudeHome>/projects/<cwd.replace(/[^a-zA-Z0-9]/g,"-")>/<cliSessionId>.jsonl).
//
// Writing a transcript alone is therefore invisible; a wrapper record is required.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ClaudeTranscriptLine } from "./types.ts";

export interface WrapperRecord {
  sessionId: string;
  cliSessionId: string;
  cwd: string;
  originCwd: string;
  lastFocusedAt: number;
  createdAt: number;
  lastActivityAt: number;
  model: string;
  effort: string;
  isArchived: boolean;
  title: string;
  titleSource: string;
  permissionMode: string;
  completedTurns: number;
  bridgeSessionIds: string[];
  alwaysAllowedReasons: unknown[];
  sessionPermissionUpdates: unknown[];
  classifierSummaryEnabled: boolean;
  spawnSeed: Record<string, unknown>;
}

/** Default root of Claude Desktop's session-record store. */
export function resolveDesktopSessionsRoot(override?: string): string {
  if (override && override.trim() !== "") return path.resolve(override);
  const appData =
    process.env.APPDATA?.trim() ||
    path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Claude", "claude-code-sessions");
}

/**
 * Pick the active <accountId>/<deviceId> directory: the one whose records were
 * modified most recently (ties broken by having non-archived records).
 */
export function findActiveWorkspaceDir(sessionsRoot: string): string | null {
  let best: { dir: string; mtime: number; active: number } | null = null;
  let accounts: string[];
  try {
    accounts = fs.readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  for (const a of accounts) {
    const pa = path.join(sessionsRoot, a);
    if (!safeIsDir(pa)) continue;
    for (const b of fs.readdirSync(pa)) {
      const pb = path.join(pa, b);
      if (!safeIsDir(pb)) continue;
      let mtime = 0;
      let active = 0;
      for (const f of fs.readdirSync(pb)) {
        if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
        const fp = path.join(pb, f);
        try {
          mtime = Math.max(mtime, fs.statSync(fp).mtimeMs);
          const rec = JSON.parse(fs.readFileSync(fp, "utf8")) as { isArchived?: boolean };
          if (!rec.isArchived) active += 1;
        } catch {
          /* ignore unreadable record */
        }
      }
      if (mtime === 0) continue;
      if (
        best == null ||
        active > best.active ||
        (active === best.active && mtime > best.mtime)
      ) {
        best = { dir: pb, mtime, active };
      }
    }
  }
  return best?.dir ?? null;
}

/** cliSessionIds already registered in this workspace dir (for dedup). */
export function existingCliSessionIds(workspaceDir: string): Set<string> {
  const out = new Set<string>();
  let files: string[];
  try {
    files = fs.readdirSync(workspaceDir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, f), "utf8"),
      ) as { cliSessionId?: string };
      if (typeof rec.cliSessionId === "string") out.add(rec.cliSessionId);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export interface BuildRecordInput {
  cliSessionId: string;
  /** Original-cased cwd (Codex session cwd). */
  cwd: string;
  lines: ClaudeTranscriptLine[];
  title: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
}

export function buildWrapperRecord(input: BuildRecordInput): WrapperRecord {
  const first = input.lines[0];
  const last = input.lines[input.lines.length - 1];
  const createdAt = first ? Date.parse(first.timestamp) : Date.now();
  const lastActivityAt = last ? Date.parse(last.timestamp) : createdAt;
  const completedTurns = input.lines.filter((l) => l.type === "user").length;
  return {
    sessionId: `local_${randomUUID()}`,
    cliSessionId: input.cliSessionId,
    cwd: input.cwd,
    originCwd: input.cwd,
    lastFocusedAt: lastActivityAt,
    createdAt: Number.isNaN(createdAt) ? Date.now() : createdAt,
    lastActivityAt: Number.isNaN(lastActivityAt) ? Date.now() : lastActivityAt,
    model: input.model ?? "claude-opus-5",
    effort: input.effort ?? "high",
    isArchived: false,
    title: input.title,
    titleSource: "auto",
    permissionMode: input.permissionMode ?? "default",
    completedTurns,
    bridgeSessionIds: [],
    alwaysAllowedReasons: [],
    sessionPermissionUpdates: [],
    classifierSummaryEnabled: true,
    spawnSeed: {},
  };
}

export function writeWrapperRecord(
  workspaceDir: string,
  record: WrapperRecord,
): string {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const out = path.join(workspaceDir, `${record.sessionId}.json`);
  fs.writeFileSync(out, JSON.stringify(record, null, 2), "utf8");
  return out;
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
