// Make a converted transcript replayable.
//
// Codex records tool calls and their outputs as independent, flat items, so a
// straight conversion can produce shapes the Messages API rejects on the next
// turn: an assistant message carrying several `tool_use` blocks whose results
// arrive as separate user messages, tool calls that never got an output (aborted
// turns, truncated sessions), and empty messages. Each of those fails a resume
// with a 400, so repair them at import time.
import { randomUUID } from "node:crypto";
import type { AnthropicBlock, ClaudeTranscriptLine } from "./types.ts";

export const MISSING_RESULT_TEXT =
  "[sessionport] no tool result was recorded in the source session";

function blocksOf(line: ClaudeTranscriptLine): AnthropicBlock[] {
  const c = line.message?.content;
  return Array.isArray(c) ? c : [];
}

function isPureToolResult(line: ClaudeTranscriptLine): boolean {
  const b = blocksOf(line);
  return (
    line.type === "user" && b.length > 0 && b.every((x) => x.type === "tool_result")
  );
}

/**
 * Guarantees, in order:
 *  - no empty messages
 *  - every assistant `tool_use` is answered, in the immediately following user
 *    message, by a `tool_result` with the same id (synthesised when absent)
 *  - the transcript starts with a user message
 *  - `parentUuid` forms a single chain over the final lines
 */
export function repairTranscript(
  lines: ClaudeTranscriptLine[],
): ClaudeTranscriptLine[] {
  const out: ClaudeTranscriptLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (blocksOf(line).length === 0) continue; // drop empty messages

    out.push(line);
    if (line.type !== "assistant") continue;

    const ids = blocksOf(line)
      .filter((b) => b.type === "tool_use")
      .map((b) => b.id);
    if (ids.length === 0) continue;

    // Absorb the run of following tool-result-only user messages.
    const found = new Map<string, AnthropicBlock>();
    let firstResultLine: ClaudeTranscriptLine | null = null;
    let j = i + 1;
    while (j < lines.length && isPureToolResult(lines[j])) {
      firstResultLine ??= lines[j];
      for (const b of blocksOf(lines[j])) {
        if (b.type === "tool_result") found.set(b.tool_use_id, b);
      }
      j++;
    }

    // One user message answering every tool_use of this assistant turn, in order.
    const merged: AnthropicBlock[] = [];
    for (const id of ids) {
      merged.push(
        found.get(id) ?? {
          type: "tool_result",
          tool_use_id: id,
          content: MISSING_RESULT_TEXT,
          is_error: true,
        },
      );
      found.delete(id);
    }
    for (const leftover of found.values()) merged.push(leftover); // keep stray results

    const template = firstResultLine ?? line;
    const answer: ClaudeTranscriptLine = {
      ...template,
      type: "user",
      message: { role: "user", content: merged },
      uuid: randomUUID(),
    };
    delete answer.customTitle;
    if (merged.length !== 1 || firstResultLine == null) delete answer.toolUseResult;
    out.push(answer);

    i = j - 1;
  }

  // Safety net: a tool_result whose tool_use never appeared (compacted history,
  // an unmapped call variant) is rejected by the API. Keep the content, drop the
  // pairing by demoting it to text.
  const knownIds = new Set<string>();
  for (const line of out) {
    for (const b of blocksOf(line)) if (b.type === "tool_use") knownIds.add(b.id);
  }
  for (const line of out) {
    const blocks = blocksOf(line);
    if (!blocks.some((b) => b.type === "tool_result" && !knownIds.has(b.tool_use_id))) {
      continue;
    }
    line.message.content = blocks.map((b) =>
      b.type === "tool_result" && !knownIds.has(b.tool_use_id)
        ? { type: "text", text: `[tool result ${b.tool_use_id}]\n${b.content}` }
        : b,
    );
  }

  // A transcript must open with a user message.
  while (out.length > 0 && out[0].type !== "user") out.shift();

  // Re-link the chain after merges and drops.
  let parent: string | null = null;
  for (const line of out) {
    line.parentUuid = parent;
    parent = line.uuid;
  }
  return out;
}
