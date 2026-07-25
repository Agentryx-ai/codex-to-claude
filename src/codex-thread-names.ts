// The name Codex shows for a conversation is not the first thing the user typed.
// Codex generates a short name for threads started from the app ("최신화하고 문서
// 읽기" for a thread whose first message was "git pull 해서 최신화하고
// tagless-p2p4-mac-hardware-handoff.md 읽으세요"), and that is what its sidebar
// displays. CLI threads never get one.
//
// It lives in two places, neither of them obvious:
//
//  1. `<codexHome>/session_index.jsonl` — append-only, one line per naming:
//     `{"id":"<threadId>","thread_name":"…","updated_at":"<ISO-8601>"}`.
//     Renaming a thread appends another line, so the latest `updated_at` wins.
//     This is the freshest source and the only one that has every name.
//
//  2. `threads.name`, or `threads.title` when it differs from
//     `threads.first_user_message`, in the state DB. The DB lags: on this
//     machine 8 of 38 named threads still carried the first message as their
//     title. Used only as a fallback, for installs with no index file.
//
// Reading neither leaves an import titled with the raw first message, which is
// what the conversation looked like in Codex before it was named.
import fs from "node:fs";
import path from "node:path";

const INDEX_FILE = "session_index.jsonl";

/** threadId -> the newest name Codex recorded for it. */
export function loadThreadNames(codexHome: string): Map<string, string> {
  const out = new Map<string, string>();
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(codexHome, INDEX_FILE), "utf8");
  } catch {
    return out;
  }
  // Later lines win at equal (or unparsable) timestamps: the file is appended to.
  const seenAt = new Map<string, number>();
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let rec: { id?: unknown; thread_name?: unknown; updated_at?: unknown };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    const id = rec.id;
    const name = rec.thread_name;
    if (typeof id !== "string" || id === "") continue;
    if (typeof name !== "string" || name.trim() === "") continue;
    const at =
      typeof rec.updated_at === "string" ? Date.parse(rec.updated_at) : Number.NaN;
    const stamp = Number.isNaN(at) ? -Infinity : at;
    const prev = seenAt.get(id);
    if (prev != null && stamp < prev) continue;
    seenAt.set(id, stamp);
    out.set(id, name.trim());
  }
  return out;
}

/**
 * The generated name a thread row carries, if it can be told apart from the
 * first message. `name` is authoritative; `title` only counts when it diverges
 * from `first_user_message`, which is what Codex seeds it with.
 */
export function nameFromThreadRow(row: {
  name?: string | null;
  title?: string | null;
  firstUserMessage?: string | null;
}): string | null {
  const name = row.name?.trim();
  if (name != null && name !== "") return name;
  const title = row.title?.trim();
  if (title == null || title === "") return null;
  const first = (row.firstUserMessage ?? "").trim();
  return title === first ? null : title;
}
