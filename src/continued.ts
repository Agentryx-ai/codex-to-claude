// Tell "Claude replayed the history back into the file" apart from "the user
// carried on the conversation".
//
// Both make a transcript differ from what this tool wrote, and `--force` used to
// treat them alike — so a re-import could take a message the user had sent with
// it, unrecoverably. Only the second is worth refusing over.
//
// Replayed turns keep their original Codex timestamps: a forked transcript
// observed after a real continuation carried 2026-07-13/14 stamps for every
// replayed turn and 2026-07-25 only for the new one. So a non-meta `user` line
// stamped after the import is the user's own, and nothing else is.
import fs from "node:fs";

export interface Continuation {
  /** Non-meta user turns written after the import. */
  turns: number;
  /** The first of them, for a message the user can recognise. */
  firstText: string;
  /** When it was sent. */
  firstAtMs: number | null;
}

/**
 * Messages the user sent after `importedAtMs`, or null when there are none —
 * including when the file is unreadable, since nothing can be claimed then.
 */
export function findContinuation(
  targetPath: string,
  importedAtMs: number | undefined,
): Continuation | null {
  if (importedAtMs == null) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(targetPath, "utf8");
  } catch {
    return null;
  }

  let turns = 0;
  let firstText = "";
  let firstAtMs: number | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let rec: {
      type?: unknown;
      isMeta?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown };
    };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (rec.type !== "user" || rec.isMeta === true) continue;
    if (typeof rec.timestamp !== "string") continue;
    const at = Date.parse(rec.timestamp);
    // A second's slack: our own lines are stamped from Codex and are far older,
    // so this only guards against clock jitter around the write itself.
    if (Number.isNaN(at) || at <= importedAtMs + 1000) continue;
    const text = userText(rec.message?.content);
    // Tool results come back as user lines too, and are not something anyone typed.
    if (text === "") continue;
    turns += 1;
    if (firstText === "") {
      firstText = text.replace(/\s+/g, " ").slice(0, 80);
      firstAtMs = at;
    }
  }
  return turns > 0 ? { turns, firstText, firstAtMs } : null;
}

/** Text the user typed, from either shape Claude writes for a user message. */
function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if ((b as { type?: unknown }).type !== "text") continue;
    const t = (b as { text?: unknown }).text;
    if (typeof t === "string") parts.push(t);
  }
  return parts.join("\n").trim();
}
