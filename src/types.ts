// Shared types for Codex rollout (source) and Claude Code transcript (target).
// See docs/research/CODEX_TO_CLAUDE_SESSION_IMPORT.md for the format contract.

// ---------- Codex rollout (source) ----------

/** One line of a Codex rollout .jsonl file: RolloutLine wrapping a RolloutItem. */
export interface RolloutLine {
  timestamp?: string; // ISO-8601 UTC
  ordinal?: number;
  type: string; // session_meta | response_item | event_msg | turn_context | compacted | ...
  payload: unknown;
}

export interface CodexContentBlock {
  type: string; // input_text | output_text | text | summary_text | ...
  text?: string;
}

export interface CodexMessageItem {
  type: "message";
  role: "user" | "assistant" | "developer" | "system";
  content: CodexContentBlock[] | string;
}

export interface CodexReasoningItem {
  type: "reasoning";
  summary?: CodexContentBlock[];
  content?: CodexContentBlock[];
}

export interface CodexFunctionCallItem {
  type: "function_call";
  name: string;
  arguments: string; // JSON string
  call_id: string;
}

export interface CodexFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: unknown; // string, or { content: ... }
}

export interface SessionMeta {
  id?: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  model_provider?: string;
  instructions?: string;
  source?: unknown; // "cli" | {subagent:{...}} | ...
  parent_thread_id?: string | null;
  git?: { branch?: string; commit?: string; repository_url?: string } | null;
}

/** A parsed Codex session ready for filtering / conversion. */
export interface CodexSession {
  sessionId: string;
  rolloutPath: string;
  cwd: string;
  /** cwd exactly as Codex recorded it (original case, \?\ prefix stripped). */
  cwdOriginal: string;
  meta: SessionMeta;
  firstTsMs: number | null;
  lastTsMs: number | null;
  /** response_item payloads in file order, plus the line timestamp. */
  items: Array<{ tsMs: number | null; payload: Record<string, unknown> }>;
  model: string | null;
  messageCount: number;
  title: string;
  /** Coarse source string from session_meta ("cli", "vscode", subagent JSON, ...). */
  source: string;
  /** True when this rollout is a spawned child (has parent_thread_id). */
  isChild: boolean;
  /** Codex Desktop project name this thread is assigned to (desktop-state selection only). */
  projectName?: string;
  /** Codex sandbox policy JSON, when known (thread index only). */
  sandboxPolicy?: string | null;
  /** Codex approval mode ("never", "on-request", ...), when known. */
  approvalMode?: string | null;
  /** Codex reasoning effort, when known. */
  reasoningEffort?: string | null;
  /** Assigned to a registered Codex Desktop project (vs. only reachable via Recents). */
  hasProject?: boolean;
  /** Archived in Codex. */
  isArchived?: boolean;
}

// ---------- Claude Code transcript (target) ----------

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}
export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
}
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export type AnthropicBlock =
  | AnthropicImageBlock
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

/** One line of a Claude Code transcript .jsonl file. */
export interface ClaudeTranscriptLine {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: "external";
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch?: string;
  type: "user" | "assistant";
  message: { role: "user" | "assistant"; content: AnthropicBlock[]; model?: string };
  uuid: string;
  timestamp: string; // ISO-8601 UTC
  toolUseResult?: unknown;
  /** Optional display title. Claude reads "customTitle" (highest priority) from the file head/tail. */
  customTitle?: string;
  /** Injected (non-user-authored) context. Claude excludes these from the conversation and from title derivation. */
  isMeta?: boolean;
  /** Marks a context-compaction summary. Claude excludes these from title derivation. */
  isCompactSummary?: boolean;
}

// ---------- Filtering ----------

export interface SessionFilter {
  sinceDays?: number; // default 30 (mirrors Codex maxSessionAgeMs=30d)
  max?: number; // default 50 (mirrors Codex maxSessions=50)
  project?: string; // substring match against cwd
  fromMs?: number; // inclusive lower bound on lastTs
  toMs?: number; // inclusive upper bound on lastTs
  id?: string; // exact sessionId
  /** Only conversations assigned to a Codex Desktop project. */
  projectsOnly?: boolean;
  /** Only conversations with no project (Codex shows these under Recents). */
  projectlessOnly?: boolean;
  /** Only archived conversations (requires archived to be fetched). */
  archivedOnly?: boolean;
}

// ---------- Import history (dedup) ----------

export interface ImportHistoryRecord {
  contentSha256: string;
  importedAtMs: number;
  importedSessionId: string;
  sourceRolloutPath: string;
  projectRoot: string;
}
export interface ImportHistory {
  version: 1;
  records: ImportHistoryRecord[];
}
