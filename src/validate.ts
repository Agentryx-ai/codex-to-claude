// Validate a converted transcript against the constraints the Messages API
// enforces when a session is resumed. A transcript that violates these loads in
// the UI but fails on the next turn with a 400, so importing must guarantee them.
import type { AnthropicBlock, ClaudeTranscriptLine } from "./types.ts";

export interface ValidationIssue {
  line: number;
  kind: string;
  detail: string;
}

/** Blocks of a line, or [] when absent. */
function blocksOf(line: ClaudeTranscriptLine): AnthropicBlock[] {
  const c = line.message?.content;
  return Array.isArray(c) ? c : [];
}

export function validateTranscript(lines: ClaudeTranscriptLine[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenToolUseIds = new Set<string>();
  /** tool_use ids emitted by the previous assistant line and not yet resolved. */
  let pending: string[] = [];

  lines.forEach((line, i) => {
    const blocks = blocksOf(line);
    const at = i + 1;

    if (blocks.length === 0) {
      issues.push({ line: at, kind: "empty-content", detail: "message.content is empty" });
    }

    for (const b of blocks) {
      if (b.type === "text") {
        if (typeof b.text !== "string" || b.text === "") {
          issues.push({ line: at, kind: "empty-text", detail: "text block is empty" });
        }
      } else if (b.type === "tool_use") {
        if (typeof b.id !== "string" || b.id === "") {
          issues.push({ line: at, kind: "tool-use-id", detail: "tool_use.id missing" });
        }
        if (
          b.input === null ||
          typeof b.input !== "object" ||
          Array.isArray(b.input)
        ) {
          issues.push({
            line: at,
            kind: "tool-use-input",
            detail: `tool_use.input must be an object (got ${Array.isArray(b.input) ? "array" : typeof b.input})`,
          });
        }
        if (seenToolUseIds.has(b.id)) {
          issues.push({ line: at, kind: "duplicate-tool-use-id", detail: b.id });
        }
        seenToolUseIds.add(b.id);
      } else if (b.type === "tool_result") {
        if (!seenToolUseIds.has(b.tool_use_id)) {
          issues.push({
            line: at,
            kind: "orphan-tool-result",
            detail: `tool_result for unknown id ${b.tool_use_id}`,
          });
        }
      }
    }

    // Every tool_use must be answered by tool_result blocks in the next message.
    if (pending.length > 0) {
      const answered = new Set(
        blocks.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id),
      );
      const missing = pending.filter((id) => !answered.has(id));
      if (missing.length > 0) {
        issues.push({
          line: at,
          kind: "unanswered-tool-use",
          detail: `missing tool_result for ${missing.join(", ")}`,
        });
      }
    }
    pending =
      line.type === "assistant"
        ? blocks.filter((b) => b.type === "tool_use").map((b) => b.id)
        : [];
  });

  if (pending.length > 0) {
    issues.push({
      line: lines.length,
      kind: "unanswered-tool-use",
      detail: `transcript ends with unanswered ${pending.join(", ")}`,
    });
  }

  if (lines.length > 0 && lines[0].type !== "user") {
    issues.push({ line: 1, kind: "leading-assistant", detail: "transcript must start with a user message" });
  }

  return issues;
}
