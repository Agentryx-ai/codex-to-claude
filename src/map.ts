import { randomUUID } from "node:crypto";
import type {
  AnthropicBlock,
  ClaudeTranscriptLine,
  CodexSession,
} from "./types.ts";
import { isInjectedContext } from "./preamble.ts";
import { repairTranscript } from "./repair.ts";

export interface MapOptions {
  /** Value written to each line's `version` field. */
  version?: string;
  /** Include Codex `reasoning` items as Claude `thinking` blocks. Default false. */
  includeReasoning?: boolean;
  /** Prefix prepended to the conversation title (via customTitle on the first line). */
  titlePrefix?: string;
}

const DEFAULT_VERSION = "0.0.0-codex-import";

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n").trim();
}

function safeJsonParse(s: unknown): unknown {
  if (typeof s !== "string") return s ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * `tool_use.input` must be a JSON object — the Messages API rejects a string or
 * array with `tool_use.input: Input should be an object`, which makes an imported
 * session fail to resume. Codex stores `arguments` as a JSON string that is not
 * always an object (and is occasionally not valid JSON at all), so coerce here
 * while preserving the original payload.
 */
function toToolInput(raw: unknown): Record<string, unknown> {
  const parsed = safeJsonParse(raw);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  if (parsed === null || parsed === undefined || parsed === "") return {};
  return { input: parsed };
}

function normalizeOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const content = (output as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return textFromContent(content);
    return JSON.stringify(output);
  }
  return output == null ? "" : String(output);
}

function isErrorOutput(output: unknown): boolean {
  return (
    !!output &&
    typeof output === "object" &&
    (output as { is_error?: unknown }).is_error === true
  );
}

/**
 * Convert a parsed Codex session into an ordered list of Claude Code transcript lines.
 * Inverse of Codex's bD/CD/BD pipeline (see DAU-025/DAU-026 and the design doc §3).
 */
export function mapSessionToClaudeLines(
  session: CodexSession,
  opts: MapOptions = {},
): ClaudeTranscriptLine[] {
  const version = opts.version ?? DEFAULT_VERSION;
  const includeReasoning = opts.includeReasoning ?? false;
  const gitBranch = session.meta.git?.branch;
  const model = session.model ?? undefined;

  let lines: ClaudeTranscriptLine[] = [];
  let parentUuid: string | null = null;
  /** First message the human actually typed — used for the display title. */
  let firstRealUserText = "";

  // Buffer that groups an assistant turn's blocks (thinking + text + tool_use)
  // into a single assistant message, matching Claude Code's turn shape.
  let assistantBuf: AnthropicBlock[] = [];
  let assistantTsMs: number | null = null;

  const isoOf = (tsMs: number | null): string =>
    new Date(tsMs ?? session.firstTsMs ?? session.lastTsMs ?? 0).toISOString();

  const emit = (
    type: "user" | "assistant",
    content: AnthropicBlock[],
    tsMs: number | null,
    extra?: { toolUseResult?: unknown; isMeta?: boolean },
  ): void => {
    const uuid = randomUUID();
    const line: ClaudeTranscriptLine = {
      parentUuid,
      isSidechain: false,
      userType: "external",
      cwd: session.cwd,
      sessionId: session.sessionId,
      version,
      type,
      message:
        type === "assistant"
          ? { role: "assistant", content, model }
          : { role: "user", content },
      uuid,
      timestamp: isoOf(tsMs),
    };
    if (gitBranch) line.gitBranch = gitBranch;
    if (extra?.isMeta) line.isMeta = true;
    if (extra?.toolUseResult !== undefined) line.toolUseResult = extra.toolUseResult;
    lines.push(line);
    parentUuid = uuid;
  };

  const flushAssistant = (): void => {
    if (assistantBuf.length === 0) return;
    emit("assistant", assistantBuf, assistantTsMs);
    assistantBuf = [];
    assistantTsMs = null;
  };

  for (const { tsMs, payload } of session.items) {
    const type = payload["type"];

    if (type === "message") {
      const role = payload["role"];
      const text = textFromContent(payload["content"]);
      if (role === "assistant") {
        if (text !== "") {
          if (assistantTsMs == null) assistantTsMs = tsMs;
          assistantBuf.push({ type: "text", text });
        }
      } else {
        // user | developer | system -> user line.
        // Injected context (developer role, or a user message wrapped in a
        // structural tag) becomes isMeta so Claude keeps it in the transcript
        // but out of the conversation and out of title derivation.
        flushAssistant();
        if (text !== "") {
          const meta = isInjectedContext(String(role ?? "user"), text);
          emit("user", [{ type: "text", text }], tsMs, meta ? { isMeta: true } : undefined);
          if (!meta && firstRealUserText === "") {
            firstRealUserText = text.replace(/\s+/g, " ").trim().slice(0, 100);
          }
        }
      }
      continue;
    }

    if (type === "reasoning") {
      if (!includeReasoning) continue;
      const summary = textFromContent(payload["summary"]);
      const body = textFromContent(payload["content"]);
      const thinking = [summary, body].filter((s) => s !== "").join("\n\n");
      if (thinking !== "") {
        if (assistantTsMs == null) assistantTsMs = tsMs;
        assistantBuf.push({ type: "thinking", thinking });
      }
      continue;
    }

    if (type === "function_call") {
      const callId = String(payload["call_id"] ?? randomUUID());
      if (assistantTsMs == null) assistantTsMs = tsMs;
      assistantBuf.push({
        type: "tool_use",
        id: callId,
        name: String(payload["name"] ?? "unknown"),
        input: toToolInput(payload["arguments"]),
      });
      continue;
    }

    // Result of a tool call. Codex has several shapes beyond function_call_output
    // (custom_tool_call_output, local_shell_call_output, ...); they all pair with
    // their call via call_id, so match structurally rather than by exact type.
    const isToolOutput =
      typeof payload["call_id"] === "string" &&
      (type === "function_call_output" ||
        String(type ?? "").endsWith("_output") ||
        "output" in payload);
    if (isToolOutput) {
      flushAssistant();
      const callId = String(payload["call_id"] ?? "");
      // Not every variant uses `output` (tool_search_output carries `tools`).
      const output =
        payload["output"] ?? payload["result"] ?? payload["tools"] ?? payload["content"];
      const text = normalizeOutput(output);
      emit(
        "user",
        [
          {
            type: "tool_result",
            tool_use_id: callId,
            // tool_result content must be non-empty.
            content: text !== "" ? text : `[${String(type ?? "tool output")}]`,
            ...(isErrorOutput(output) ? { is_error: true } : {}),
          },
        ],
        tsMs,
        { toolUseResult: output },
      );
      continue;
    }

    // Remaining tool-call variants (custom_tool_call, tool_search_call,
    // local_shell_call, ...). Some carry no `name` (tool_search_call), so fall
    // back to the item type — every call still has to produce a tool_use, or its
    // output would be left without a matching call.
    const isToolCall =
      typeof payload["call_id"] === "string" &&
      (typeof payload["name"] === "string" || String(type ?? "").endsWith("_call"));
    if (isToolCall) {
      if (assistantTsMs == null) assistantTsMs = tsMs;
      assistantBuf.push({
        type: "tool_use",
        id: String(payload["call_id"]),
        name:
          typeof payload["name"] === "string" && payload["name"] !== ""
            ? payload["name"]
            : String(type ?? "tool").replace(/_call$/, ""),
        input: toToolInput(payload["arguments"] ?? payload["input"]),
      });
    }
  }

  flushAssistant();

  // Make the result replayable before anything reads lines[0].
  lines = repairTranscript(lines);

  // Set a display title on the first line. Claude reads "customTitle" from the
  // file head with the highest priority, so this controls the sidebar label.
  if (opts.titlePrefix != null && opts.titlePrefix !== "" && lines.length > 0) {
    // Prefer the first message the human actually typed over Codex's injected
    // preamble, so titles read like the conversation rather than like tooling.
    const base =
      firstRealUserText !== ""
        ? firstRealUserText
        : session.title && session.title !== ""
          ? session.title
          : "(untitled)";
    lines[0].customTitle = (opts.titlePrefix + base).slice(0, 200);
  }

  return lines;
}
