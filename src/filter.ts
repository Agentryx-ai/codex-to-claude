import type { CodexSession, SessionFilter } from "./types.ts";

export const DEFAULT_SINCE_DAYS = 30; // mirrors Codex maxSessionAgeMs = 2_592_000_000
export const DEFAULT_MAX = 50; // mirrors Codex maxSessions = 50

/**
 * Apply the browse/import filter, mirroring Codex External Agent Import (DAU-024/DAU-023).
 * Sessions are assumed pre-sorted newest-first; `max` is applied last.
 */
export function applyFilter(
  sessions: CodexSession[],
  filter: SessionFilter,
  nowMs: number,
): CodexSession[] {
  const sinceDays = filter.sinceDays ?? DEFAULT_SINCE_DAYS;
  const max = filter.max ?? DEFAULT_MAX;
  const ageFloorMs = sinceDays > 0 ? nowMs - sinceDays * 24 * 60 * 60 * 1000 : -Infinity;

  const filtered = sessions.filter((s) => {
    if (filter.id != null && s.sessionId !== filter.id) return false;
    const activity = s.lastTsMs ?? s.firstTsMs ?? 0;
    if (activity < ageFloorMs) return false;
    if (filter.fromMs != null && activity < filter.fromMs) return false;
    if (filter.toMs != null && activity > filter.toMs) return false;
    // Codex Desktop groups by project; conversations with no project are only
    // reachable through Recents, so they are separable here.
    if (filter.projectsOnly === true && s.hasProject !== true) return false;
    if (filter.projectlessOnly === true && s.hasProject === true) return false;
    if (filter.archivedOnly === true && s.isArchived !== true) return false;
    if (filter.project != null && filter.project !== "") {
      const needle = filter.project.toLowerCase();
      const inName = (s.projectName ?? "").toLowerCase().includes(needle);
      const inCwd = s.cwd.toLowerCase().includes(needle);
      if (!inName && !inCwd) return false;
    }
    return true;
  });

  return max > 0 ? filtered.slice(0, max) : filtered;
}
