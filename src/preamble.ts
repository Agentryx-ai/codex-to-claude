// Classify Codex messages that are NOT authored by the human user.
//
// Codex injects a lot of context as `developer`-role messages, and even as
// `user`-role messages wrapped in structural tags (environment context, AGENTS.md
// instructions, plugin/skill catalogs, ...). Claude Code marks that same class of
// content with `isMeta: true` on a user line, which keeps it in the transcript but
// out of the conversation proper — including out of title derivation.
//
// Mapping these to plain user text (the naive approach) makes an imported session
// look like the human pasted a wall of tooling boilerplate, and makes the sidebar
// title read e.g. "<recommended_plugins> Here is a list of plugins...".

/** Tags Codex uses to wrap injected, non-user-authored content. */
const INJECTED_TAGS = new Set([
  // environment / workspace
  "environment_context",
  "cwd",
  "shell",
  "filesystem",
  "file_system",
  "workspace_roots",
  "root",
  "permission_profile",
  "current_date",
  "timezone",
  // instruction surfaces
  "instructions",
  "user_instructions",
  "developer_instructions",
  "app-context",
  "apps_instructions",
  "plugins_instructions",
  "skills_instructions",
  "permissions",
  "permissions instructions",
  "collaboration_mode",
  "multi_agent_mode",
  "codex_internal_context",
  // catalogs / runtime notices
  "recommended_plugins",
  "turn_aborted",
  // inter-agent envelope
  "recipient",
  "author",
  "payload",
  "codex_delegation",
  "source_thread_id",
]);

/** Roles Codex uses for content the human did not type. */
const NON_USER_ROLES = new Set(["developer", "system", "tool"]);

/** Leading XML-ish tag of a message body, lowercased (or null). */
export function leadingTag(text: string): string | null {
  const m = /^\s*<([a-z_][a-z0-9_ -]*)/i.exec(text);
  return m ? m[1].trim().toLowerCase() : null;
}

/**
 * True when a Codex message is injected context rather than something the user
 * typed. Such messages become `isMeta: true` user lines on the Claude side.
 */
export function isInjectedContext(role: string, text: string): boolean {
  if (NON_USER_ROLES.has(role)) return true;
  const tag = leadingTag(text);
  if (tag == null) return false;
  if (INJECTED_TAGS.has(tag)) return true;
  // `<permissions instructions>` style: match on the first word too.
  const head = tag.split(/\s+/)[0];
  return INJECTED_TAGS.has(head);
}
