// Read Codex Desktop's UI state (.codex-global-state.json) to select exactly the
// threads the Desktop shows in its left sidebar. The sidebar lists threads that are
// (a) assigned to a registered project (thread-project-assignments), or (b) projectless
// (projectless-thread-ids) — and only the non-archived ones. This is the authoritative
// membership of the "conversation list"; archived/recency come from the state DB.
import fs from "node:fs";
import path from "node:path";

export interface DesktopProject {
  projectId: string;
  name: string;
  rootPaths: string[];
}
export interface DesktopSelection {
  /** threadId -> owning project (or null for projectless) */
  threadProject: Map<string, DesktopProject | null>;
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

  const threadProject = new Map<string, DesktopProject | null>();
  const assignments = (j["thread-project-assignments"] as Record<string, unknown>) ?? {};
  for (const [tid, v] of Object.entries(assignments)) {
    const pid = (v as { projectId?: string })?.projectId;
    threadProject.set(tid, (pid && projects.get(pid)) || null);
  }
  const projectless = (j["projectless-thread-ids"] as unknown[]) ?? [];
  for (const tid of projectless) {
    if (typeof tid === "string" && !threadProject.has(tid)) threadProject.set(tid, null);
  }

  const projectOrder = Array.isArray(j["project-order"])
    ? (j["project-order"] as unknown[]).map(String)
    : [];

  if (threadProject.size === 0) return null;
  return { threadProject, projects, projectOrder };
}
