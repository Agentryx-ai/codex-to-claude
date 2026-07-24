# codex-to-claude

**Bring your Codex conversations into Claude Desktop / Claude Code — with the list, titles, and tool calls intact.**

OpenAI's Codex ships an "External Agent Import" that pulls Claude Code, Claude Cowork and Cursor sessions *into* Codex. Nothing goes the other way. This is that missing direction.

```bash
# see what would be imported (reads only)
codex-to-claude list

# preview the import (writes nothing)
codex-to-claude import --dry-run

# do it
codex-to-claude import --title-prefix "[Codex] "
```

Then restart Claude Desktop — your Codex conversations are in the sidebar, grouped under the same projects, openable and resumable.

## Why this exists

Migrating between coding agents means losing your history. Existing converters translate CLI session *files* one id at a time. It targets the **desktop apps**: it selects exactly the conversations Codex Desktop shows you, and registers them so Claude Desktop actually lists them.

| | CLI converters | codex-to-claude |
| --- | --- | --- |
| Scope | session files | **desktop app → desktop app** |
| Selection | one session id at a time | **mirrors the Codex Desktop conversation list**, plus browse + filters |
| Codex state | ignored | reads Codex's own thread index |
| Shows up in Claude's list | no | **yes** (registers a session record) |
| Idempotent re-runs | — | yes (content hash) |

## How it works

Claude Desktop stores a conversation in **two** places, and both are required for it to appear:

| Layer | Location | Role |
| --- | --- | --- |
| Session record | `%APPDATA%/Claude/claude-code-sessions/<account>/<device>/local_<uuid>.json` | **What the conversation list is built from.** Points at a transcript via `cliSessionId` + `cwd`. |
| Transcript | `~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl` | The conversation content. |

Writing only a transcript leaves it invisible. It writes both.

```
~/.codex/sessions/**/rollout-*.jsonl        (Codex rollout)
        │
        ├─ select: the conversations Codex Desktop lists
        ├─ convert: rollout items → Claude transcript lines
        │
        ├──► ~/.claude/projects/<enc-cwd>/<id>.jsonl        (content)
        └──► claude-code-sessions/.../local_<uuid>.json     (list entry)
```

## Selection: the same conversations Codex Desktop shows

By default it does not invent a filter. It reproduces the Codex Desktop sidebar:

- reads Codex Desktop's UI state for which threads belong to a registered project (plus project-less threads)
- keeps non-archived threads only
- falls back to Codex's thread index, then to a rollout-file scan, if that state is unavailable

Optional refinements (all off by default): `--interactive-only` (drop `codex exec` automation runs), `--project`, `--since-days`, `--max`, `--from` / `--to`, `--id`.

## What gets converted

| Codex | Claude |
| --- | --- |
| user message | user message |
| assistant message | assistant message (grouped with its tool calls) |
| `function_call` | `tool_use` block |
| `function_call_output` | `tool_result` block + `toolUseResult` |
| `reasoning` | `thinking` block (`--include-reasoning`) |
| injected context — `developer` role, `<environment_context>`, `<instructions>`, `<recommended_plugins>`, skills/plugins/permissions blocks … | user line flagged `isMeta` |
| `session_meta` | session id, cwd, git branch, timestamps |
| `event_msg`, `world_state` | skipped (conversation is rebuilt from response items) |

| pasted screenshots (`input_image`) | Anthropic `image` block |

Codex injects a lot of tooling boilerplate as messages. Those are marked `isMeta`, which is Claude's own convention for non-user-authored context: they stay in the transcript but out of the conversation — and out of the title, so a session is titled by what you actually asked.

### How injected context is detected

Codex composes these client-side and sends them as ordinary user messages — the rollout carries **no flag** that separates them from something you typed. Detection is therefore textual, and deliberately conservative: a `developer`-role message, a Codex-specific leading tag, or a known heading **plus** a corroborating structure (`## <name>: <path>` entries, a `<response-annotations>` block, an `<INSTRUCTIONS>` block). Generic tags a user might paste (`<instructions>`, `<root>`, `<payload>`, …) are never treated as injected. Attachment lists and response annotations wrap your real message after a `## My request for Codex:` marker, so they are split rather than hidden.

## Install

Requires **Node.js ≥ 22.6**. No dependencies.

```bash
git clone https://github.com/Agentryx-ai/codex-to-claude
cd codex-to-claude
node --experimental-strip-types --experimental-sqlite src/cli.ts list
```

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dry-run` | — | print the plan, write nothing |
| `--title-prefix <s>` | — | prefix conversation titles, e.g. `"[Codex] "` |
| `--include-reasoning` | off | keep Codex reasoning as `thinking` blocks |
| `--interactive-only` | off | drop non-interactive `codex exec` runs |
| `--include-archived` | off | include archived Codex threads |
| `--project <substr>` | — | only conversations whose cwd contains this |
| `--since-days <n>` / `--max <n>` | unlimited | extra age / count limits |
| `--from <date>` / `--to <date>` / `--id <id>` | — | extra range / single conversation |
| `--force` | — | re-import even if already imported |
| `--no-register` | off | write the transcript only (**will not appear in the list**) |
| `--codex-home <p>` | `$CODEX_HOME` or `~/.codex` | source |
| `--claude-home <p>` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | transcript target |
| `--sessions-root <p>` | `%APPDATA%/Claude/claude-code-sessions` | session-record target |

Re-runs are safe: imports are deduplicated by source content hash, and a conversation is never registered twice.

## Replay safety

A transcript can appear in the sidebar and still fail on the next message with a 400. It validates every conversion before writing and repairs the cases Codex's flat tool format produces:

- `tool_use.input` coerced to an object (`Input should be an object` otherwise)
- every `tool_use` answered by a `tool_result` in the next message — multiple calls in a turn answered together, missing outputs synthesized
- orphan `tool_result` (compacted history) demoted to text
- no empty messages, transcript starts with a user message, `parentUuid` forms one chain

See [docs/FORMATS.md](./docs/FORMATS.md). Verified on 21 real conversations: 0 violations.

## Safety

This tool writes into another application's local data, so it is deliberately conservative:

- **Additive only.** It creates new files. It never edits or deletes an existing transcript or session record.
- **Dry run first.** `--dry-run` prints every target path and writes nothing.
- **Reversible.** To undo, delete the transcripts it wrote plus the `local_*.json` records it created (both are listed in its output).
- Prefer running with Claude Desktop closed.

## Status and limitations

Verified against real data: 21 Codex Desktop conversations imported, all transcripts resolved, all listed by Claude Desktop after restart.

- Built on **undocumented, internal formats** of two proprietary desktop apps. They can change at any time; treat this as best-effort.
- Session records carry `model` / `effort` / `permissionMode` values that Codex has no equivalent for; sensible defaults are written.
- Multi-agent constructs (sub-agent threads, inter-agent messages) are not fully modeled.
- Large rollouts are read whole; streaming is not implemented yet.
- Verified on Windows. macOS and Linux paths are implemented but less exercised.

## Development

```bash
node --experimental-strip-types --experimental-sqlite --test test/*.test.ts
```

## Disclaimer

Unofficial. Not affiliated with, endorsed by, or supported by OpenAI or Anthropic. "Codex" and "Claude" are trademarks of their respective owners. Use at your own risk; back up anything you care about.

## License

MIT — see [LICENSE](./LICENSE).
