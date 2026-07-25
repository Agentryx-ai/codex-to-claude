// Read Codex Desktop's UI state (.codex-global-state.json) to group threads the
// way the Desktop's left sidebar does.
//
// Two shapes exist in the wild:
//  - "assigned": the state file carries an explicit `thread-project-assignments`
//    map. Together with `projectless-thread-ids` that map *is* the sidebar
//    membership, so selection can be driven straight off it.
//  - "derived" (current Codex Desktop): there is no assignment map. Projects are
//    registered under `local-projects` with `rootPaths`, and a thread belongs to
//    whichever project contains its cwd; `projectless-thread-ids` only covers
//    Desktop-created threads that have no workspace. Membership therefore has to
//    come from the thread index, with this file supplying the grouping.
//
// Treating the second shape like the first selects almost nothing, because the
// assignment map is simply absent.
import fs from "node:fs";
import path from "node:path";

export interface DesktopProject {
  projectId: string;
  name: string;
  rootPaths: string[];
}
export interface DesktopSelection {
  /**
   * "assigned": `threadProject` is the sidebar membership.
   * "derived":  membership comes from the thread index; use `projectForCwd`.
   */
  mode: "assigned" | "derived";
  /** threadId -> owning project (or null for projectless). Empty when derived. */
  threadProject: Map<string, DesktopProject | null>;
  /** Threads Codex Desktop tracks as having no project. */
  projectlessThreadIds: Set<string>;
  projects: Map<string, DesktopProject>;
  projectOrder: string[];
}

export function findGlobalState(codexHome: string): string | null {
  const p = path.join(codexHome, ".codex-global-state.json");
  return fs.existsSync(p) ? p : null;
}

export function loadDesktopSelection(codexHome: string): DesktopSelection | null {
  const p = findGlobalState(codexHome);
  if (!p) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  const rawProjects = (j["local-projects"] as Record<string, unknown>) ?? {};
  const projects = new Map<string, DesktopProject>();
  for (const [pid, v] of Object.entries(rawProjects)) {
    const o = (v ?? {}) as { name?: string; rootPaths?: string[] };
    projects.set(pid, {
      projectId: pid,
      name: typeof o.name === "string" ? o.name : pid,
      rootPaths: Array.isArray(o.rootPaths) ? o.rootPaths.map(String) : [],
    });
  }

  const projectlessThreadIds = new Set<string>();
  for (const tid of (j["projectless-thread-ids"] as unknown[]) ?? []) {
    if (typeof tid === "string") projectlessThreadIds.add(tid);
  }

  const rawAssignments = j["thread-project-assignments"];
  const hasAssignments =
    rawAssignments != null &&
    typeof rawAssignments === "object" &&
    Object.keys(rawAssignments as Record<string, unknown>).length > 0;

  const projectOrder = Array.isArray(j["project-order"])
    ? (j["project-order"] as unknown[]).map(String)
    : [];

  const threadProject = new Map<string, DesktopProject | null>();
  if (hasAssignments) {
    for (const [tid, v] of Object.entries(rawAssignments as Record<string, unknown>)) {
      const pid = (v as { projectId?: string })?.projectId;
      threadProject.set(tid, (pid && projects.get(pid)) || null);
    }
    for (const tid of projectlessThreadIds) {
      if (!threadProject.has(tid)) threadProject.set(tid, null);
    }
    return {
      mode: "assigned",
      threadProject,
      projectlessThreadIds,
      projects,
      projectOrder,
    };
  }

  // No assignment map: this only helps if it can still say what the projects are.
  if (projects.size === 0 && projectlessThreadIds.size === 0) return null;
  return { mode: "derived", threadProject, projectlessThreadIds, projects, projectOrder };
}

/**
 * The project owning a thread's cwd, by longest matching root path. Codex
 * Desktop groups a thread under a project when the thread works inside one of
 * that project's roots; nested roots make the longest match the right one.
 */
export function projectForCwd(
  selection: DesktopSelection,
  cwd: string,
): DesktopProject | null {
  if (cwd === "") return null;
  const needle = normalizeRoot(cwd);
  let best: { project: DesktopProject; len: number } | null = null;
  for (const project of selection.projects.values()) {
    for (const raw of project.rootPaths) {
      const root = normalizeRoot(raw);
      if (root === "") continue;
      if (needle !== root && !needle.startsWith(root + "/")) continue;
      if (best == null || root.length > best.len) best = { project, len: root.length };
    }
  }
  return best?.project ?? null;
}

/** Compare paths the way the two apps write them: '/' separators, no trailing slash. */
function normalizeRoot(p: string): string {
  const unified = p.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  // Windows paths differ only in drive-letter case between the two apps.
  return /^[A-Za-z]:/.test(unified) ? unified[0].toLowerCase() + unified.slice(1) : unified;
}
