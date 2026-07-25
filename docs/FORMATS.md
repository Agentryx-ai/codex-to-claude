# Formats

What this tool reads and writes. These are **undocumented, internal** formats of two proprietary desktop apps, reconstructed by observation. They can change without notice.

## Source — Codex rollout

`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`, one JSON object per line:

```jsonc
{ "timestamp": "2026-07-24T05:38:12.123Z", "type": "<item-type>", "payload": { … } }
```

| `type` | Meaning | Used |
| --- | --- | --- |
| `session_meta` | first line: `id`, `cwd`, `cli_version`, `source`, `git`, `parent_thread_id`, … | yes |
| `response_item` | model output and tool traffic | yes — the conversation is rebuilt from these |
| `turn_context` | per-turn settings snapshot (model, cwd, approval policy) | model only |
| `event_msg` | UI/protocol events (`agent_message`, `token_count`, …) | no (duplicates response items) |
| `compacted` | context-compaction summary | no |
| `world_state`, `inter_agent_communication_metadata` | agent internals | no |

`response_item` payload variants:

```jsonc
{ "type":"message", "role":"user"|"assistant"|"developer", "content":[{"type":"input_text"|"output_text","text":"…"}] }
{ "type":"reasoning", "summary":[{"type":"summary_text","text":"…"}] }
{ "type":"function_call", "name":"shell", "arguments":"{\"cmd\":\"ls\"}", "call_id":"call_x" }
{ "type":"function_call_output", "call_id":"call_x", "output":"…" }
{ "type":"custom_tool_call",  "name":"…", "input":"…", "call_id":"…" }
{ "type":"tool_search_call",  "call_id":"…", "arguments":"…" }   // note: no `name`
{ "type":"tool_search_output","call_id":"…", "tools":[…] }        // note: no `output`
```

Calls and results are flat and paired by `call_id`, not nested.

### Selecting the conversations Codex Desktop lists

Not every rollout is a conversation in the sidebar. Sub-agent threads, `codex exec` automation runs and archived threads all live in the same directory. It resolves the list from Codex's own state, in this order:

1. `~/.codex/.codex-global-state.json` — `thread-project-assignments` (threads belonging to a registered project) plus `projectless-thread-ids`. This is the sidebar's membership.
2. `~/.codex/state_<n>.sqlite` — `threads` (`archived`, `rollout_path`, `title`, `cwd`, `source`, `recency_at_ms`) and `thread_spawn_edges` (parent → child). Used to drop archived and spawned threads, and to resolve each thread's rollout file.
3. Rollout-file scan, applying the equivalent rules from `session_meta` (`parent_thread_id`, `source`), when neither is available.

## Target — Claude Desktop

A conversation needs **two** artifacts. Writing only the transcript leaves it invisible.

### 1. Session record (what the list is built from)

`%APPDATA%/Claude/claude-code-sessions/<accountId>/<deviceId>/local_<uuid>.json`

Windows only: this is the one path here observed on a single platform. `--sessions-root` overrides it.

```jsonc
{
  "sessionId": "local_<uuid>",
  "cliSessionId": "<uuid>",          // → transcript file name
  "cwd": "C:\\path\\to\\project",    // → transcript folder
  "originCwd": "…",
  "createdAt": 0, "lastActivityAt": 0, "lastFocusedAt": 0,
  "model": "…", "effort": "…", "permissionMode": "…",
  "title": "…", "titleSource": "auto",
  "isArchived": false,
  "completedTurns": 0,
  "bridgeSessionIds": [], "alwaysAllowedReasons": [], "sessionPermissionUpdates": [],
  "classifierSummaryEnabled": true, "spawnSeed": {}
}
```

Only non-archived records are listed. It picks the `<accountId>/<deviceId>` directory with active records and the most recent activity, and never touches existing records.

### 2. Transcript (the content)

`<claudeHome>/projects/<projectKey>/<cliSessionId>.jsonl`, where

```js
projectKey = cwd.replace(/[^a-zA-Z0-9]/g, "-")   // hashed suffix past 200 chars
```

One JSON object per line:

```jsonc
{
  "parentUuid": "<previous uuid|null>",
  "isSidechain": false,
  "userType": "external",
  "cwd": "…", "sessionId": "…", "version": "…", "gitBranch": "…",
  "type": "user" | "assistant",
  "message": { "role": "…", "content": [ /* Anthropic content blocks */ ] },
  "uuid": "…", "timestamp": "ISO-8601",
  "isMeta": true,              // injected context, not authored by the user
  "customTitle": "…",          // display title (highest priority)
  "toolUseResult": { }         // raw tool payload, for rendering
}
```

Titles resolve as `customTitle` → `aiTitle` → `lastPrompt` → `summary` → first non-meta user message.

## Conversion rules

| Codex | Claude |
| --- | --- |
| `message` user | user message |
| `message` assistant | assistant message, grouped with the turn's tool calls |
| `message` developer/system, or user text wrapped in a Codex tag (`<environment_context>`, `<instructions>`, `<recommended_plugins>`, `<skills_instructions>`, `<permissions …>`, `<collaboration_mode>`, `<app-context>`, `<codex_delegation>`, …) | user message with `isMeta: true` |
| `reasoning` | `thinking` block (opt-in) |
| `*_call` | `tool_use` block — `name` falls back to the item type; `input` is coerced to an object |
| `*_output` | `tool_result` block — content falls back across `output` / `result` / `tools` / `content` |

## Replay invariants

A transcript can load in the UI and still fail on the next turn with a 400. Every conversion is validated before writing, and repairs these:

- `tool_use.input` must be an object — a JSON string or array is rejected.
- Every `tool_use` must be answered by a `tool_result` with the same id **in the next message**. Multiple calls in one turn are answered in one user message; calls with no recorded output get a synthesized error result.
- A `tool_result` whose `tool_use` never appeared (compacted history) is demoted to text.
- No empty message content, no empty text blocks.
- The transcript starts with a user message, and `parentUuid` forms one chain.

`src/validate.ts` encodes these; the import path refuses to write a transcript that violates them.
