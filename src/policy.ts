// Translate Codex's execution policy into the closest Claude equivalent.
//
// Codex separates *approval* (when to ask the user) from *sandbox* (what the
// process may touch). Claude folds both into one `permissionMode`. The mapping
// below preserves intent where an equivalent exists and only falls back to the
// prompt-on-everything default when nothing corresponds.

/** Claude permission modes, from least to most permissive. */
export type ClaudePermissionMode =
  | "plan"
  | "default"
  | "acceptEdits"
  | "bypassPermissions";

/** Effort levels Claude accepts. */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** `{"type":"workspace-write",…}` → `workspace-write` */
export function sandboxKind(sandboxPolicy: string | null | undefined): string | null {
  if (!sandboxPolicy) return null;
  const raw = sandboxPolicy.trim();
  if (raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    if (typeof parsed?.type === "string") return parsed.type;
  } catch {
    // Older rows store a bare string.
    return raw;
  }
  return null;
}

/**
 * Map Codex approval + sandbox onto a Claude permission mode.
 *
 * - Codex asks the user (`on-request`, `untrusted`, `on-failure`) → `default`,
 *   which is Claude's ask-before-acting mode.
 * - Codex never asks: the sandbox decides how far that goes.
 *     full access / no sandbox → `bypassPermissions`
 *     writable workspace       → `acceptEdits`
 *     read-only                → `plan`
 * - Anything unrecognised → `default` (ask), never something more permissive.
 */
export function mapPermissionMode(
  sandboxPolicy: string | null | undefined,
  approvalMode: string | null | undefined,
): ClaudePermissionMode {
  const approval = (approvalMode ?? "").trim().toLowerCase();
  if (approval === "on-request" || approval === "untrusted" || approval === "on-failure") {
    return "default";
  }

  const kind = sandboxKind(sandboxPolicy);
  if (approval === "never") {
    switch (kind) {
      case "danger-full-access":
      case "disabled":
        return "bypassPermissions";
      case "workspace-write":
      case "managed":
        return "acceptEdits";
      case "read-only":
        return "plan";
      default:
        return "default";
    }
  }

  // Approval unknown: infer from the sandbox only when it is unambiguous.
  if (kind === "read-only") return "plan";
  return "default";
}

/** Codex reasoning effort → Claude effort. `ultra` has no Claude peer; clamp to `max`. */
export function mapEffort(reasoningEffort: string | null | undefined): ClaudeEffort {
  switch ((reasoningEffort ?? "").trim().toLowerCase()) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "ultra":
    case "max":
      return "max";
    default:
      return "high";
  }
}
