// Tell Codex's injected context apart from what the human actually wrote.
//
// Codex injects context as `developer`-role messages, as `user`-role messages
// wrapped in structural tags, and as markdown headings. Claude Code marks that
// same class of content with `isMeta: true`: kept in the transcript, but out of
// the conversation and out of title derivation.
//
// Misclassifying is bad in both directions — hiding a real message loses user
// content, and keeping boilerplate makes an import look like the user pasted a
// wall of tooling text. So detection requires a Codex-specific signal, never a
// heading or tag a user could plausibly write themselves.

/**
 * Tags that only Codex emits, matched as the *leading* tag of a message.
 * Deliberately excludes generic names (`instructions`, `root`, `payload`, `cwd`,
 * …): those occur nested inside these parents, and as a leading tag they are more
 * likely to be something the user pasted.
 */
const INJECTED_TAGS = new Set([
  "environment_context",
  "codex_internal_context",
  "codex_delegation",
  "recommended_plugins",
  "user_instructions",
  "developer_instructions",
  "skills_instructions",
  "plugins_instructions",
  "apps_instructions",
  "app-context",
  "collaboration_mode",
  "multi_agent_mode",
  "permissions",
  "turn_aborted",
]);

/** Roles the human never authors. */
const NON_USER_ROLES = new Set(["developer", "system", "tool"]);

/**
 * Markdown-heading injections. Each needs a corroborating structural signal,
 * because the heading alone is something a user could legitimately write.
 */
const INJECTED_HEADINGS: Array<{ heading: string; corroborate: RegExp }> = [
  {
    // "# Files mentioned by the user:" + "## <name>: <path>" entries
    heading: "# Files mentioned by the user:",
    corroborate: /^##\s+.+:\s*(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])/m,
  },
  {
    heading: "# Response annotations:",
    corroborate: /<response-annotations>/,
  },
  {
    heading: "# AGENTS.md instructions for",
    corroborate: /<INSTRUCTIONS>/,
  },
];

/** Marks the start of the user's own message inside a wrapped injection. */
const REQUEST_MARKER = /^##\s*My request for Codex:\s*$/m;

export interface SplitMessage {
  /** Injected context, if any. */
  meta: string | null;
  /** What the user actually wrote, if any. */
  request: string | null;
}

/** Leading XML-ish tag of a message body, lowercased (or null). */
export function leadingTag(text: string): string | null {
  const m = /^\s*<([a-z_][a-z0-9_ -]*)/i.exec(text);
  return m ? m[1].trim().toLowerCase() : null;
}

/** True when the message is injected context rather than something the user typed. */
export function isInjectedContext(role: string, text: string): boolean {
  if (NON_USER_ROLES.has(role)) return true;

  const tag = leadingTag(text);
  if (tag != null) {
    if (INJECTED_TAGS.has(tag)) return true;
    // `<permissions instructions>` — match on the first word too.
    if (INJECTED_TAGS.has(tag.split(/\s+/)[0])) return true;
  }

  return matchedHeading(text) != null;
}

function matchedHeading(text: string): { heading: string } | null {
  const trimmed = text.trimStart();
  for (const h of INJECTED_HEADINGS) {
    if (!trimmed.startsWith(h.heading)) continue;
    // The heading alone is not enough: require Codex's own structure, or the
    // request marker, so user-authored markdown is never swallowed.
    if (h.corroborate.test(trimmed) || REQUEST_MARKER.test(trimmed)) {
      return { heading: h.heading };
    }
  }
  return null;
}

/**
 * Separate injected context from the user's own message. An ordinary message
 * comes back as `{meta: null, request: text}`.
 */
export function splitUserMessage(role: string, text: string): SplitMessage {
  const trimmed = text.trim();
  if (trimmed === "") return { meta: null, request: null };

  if (matchedHeading(trimmed) != null) {
    const m = REQUEST_MARKER.exec(trimmed);
    if (m) {
      const meta = trimmed.slice(0, m.index).trim();
      const request = trimmed.slice(m.index + m[0].length).trim();
      return {
        meta: meta === "" ? null : meta,
        request: request === "" ? null : request,
      };
    }
    return { meta: trimmed, request: null };
  }

  if (isInjectedContext(role, trimmed)) return { meta: trimmed, request: null };
  return { meta: null, request: trimmed };
}
