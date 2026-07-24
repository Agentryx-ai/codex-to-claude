# codex-to-claude

> Move your Codex conversations into Claude Desktop / Claude Code — list, titles, tool calls and permissions intact.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.6-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)

```bash
codex-to-claude list                              # what would be imported (reads only)
codex-to-claude import --dry-run                  # preview (writes nothing)
codex-to-claude import --title-prefix "[Codex] "  # do it
```

Restart Claude Desktop and your Codex conversations are there — grouped under the same projects, openable, resumable.

---

## Background

OpenAI's Codex ships **External Agent Import**: it pulls Claude Code, Claude Cowork and Cursor sessions *into* Codex — settings, projects and recent chats. Claude has no equivalent. Migration between coding agents is one-directional by construction, and history is the thing that makes switching expensive.

This tool is the missing direction.

It was built for **Agentryx**, an AI-native agent harness in development, which needs to carry conversation history across providers instead of stranding it in whichever tool produced it. It lives in its own repository because the hard part — the on-disk formats of two proprietary desktop apps — changes on someone else's release schedule, and that churn shouldn't be entangled with a product codebase. Standalone means it can be fixed, versioned and released on its own, and used by people not running Agentryx at all.

## Goals

| Goal | What it means here |
| --- | --- |
| **Nothing silently lost** | Tool calls, results, attached images, sub-agent reports and injected context all survive, each as its closest Claude equivalent. |
| **Imports that actually work** | An imported conversation appears in the app's list, opens, and accepts the next message — not just a file on disk. |
| **The list you already know** | Selection mirrors what Codex Desktop shows you, instead of inventing a filter you have to learn. |
| **Safe to run twice** | Additive writes, content-hash dedup, dry-run first, and never editing what this tool did not create. |
| **Honest about the seams** | Where Codex has no Claude counterpart, the mapping is documented rather than quietly guessed. |

## Scope

**In scope**

- Codex (CLI and Desktop) → Claude Code / Claude Desktop, conversations only
- Browsing, filtering and selecting what to bring over
- Registering imports so the target app lists them
- Preserving execution policy (sandbox/approval → permission mode) and reasoning effort

**Out of scope**

- The reverse direction — Codex already implements it
- Settings, skills, plugins, MCP servers and other configuration
- Anything needing a network call or an account; this is entirely local
- Editing or cleaning up conversations you already have in either app

## How it works

Claude Desktop stores a conversation in **two** places, and both are required for it to appear:

| Layer | Location | Role |
| --- | --- | --- |
| Session record | `%APPDATA%/Claude/claude-code-sessions/<account>/<device>/local_<uuid>.json` | **What the conversation list is built from.** Points at a transcript via `cliSessionId` + `cwd`. |
| Transcript | `~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl` | The conversation content. |

Writing only a transcript leaves it invisible. This tool writes both.

```
~/.codex/sessions/**/rollout-*.jsonl        (Codex rollout)
        │
        ├─ select    the conversations Codex Desktop lists
        ├─ convert   rollout items → Claude transcript lines
        ├─ validate  replay invariants (repair, or refuse to write)
        │
        ├──► ~/.claude/projects/<enc-cwd>/<id>.jsonl        (content)
        └──► claude-code-sessions/.../local_<uuid>.json     (list entry)
```

### Selection

By default it doesn't invent a filter — it reproduces the Codex Desktop sidebar: threads assigned to a registered project plus project-less ones, non-archived, newest first. It falls back to Codex's thread index, then to a rollout-file scan, when that state isn't available.

Optional refinements, all off by default: `--interactive-only` (drop `codex exec` automation runs), `--project`, `--since-days`, `--max`, `--from` / `--to`, `--id`.

### What gets converted

| Codex | Claude |
| --- | --- |
| user / assistant message | user / assistant message |
| `function_call`, `custom_tool_call`, `tool_search_call` | `tool_use` block |
| `*_output` | `tool_result` block (+ raw payload for rendering) |
| `reasoning` | `thinking` block (`--include-reasoning`) |
| pasted screenshots (`input_image`) | `image` block |
| `agent_message` (sub-agent reporting back) | `isMeta` line, prefixed with the sender |
| injected context — `developer` role, `<environment_context>`, `<recommended_plugins>`, skills/permissions blocks, `# AGENTS.md instructions …` | `isMeta` line |
| sandbox + approval policy | `permissionMode` |
| reasoning effort | `effort` |
| `event_msg`, `world_state`, `compacted` | skipped — duplicated by response items |

Codex injects a lot of tooling boilerplate as ordinary user messages. Those become `isMeta` — Claude's own convention for non-user-authored context — so they stay in the transcript but out of the conversation, and out of the title. A session ends up titled by what you actually asked.

**Detection is textual, by necessity.** Codex composes that boilerplate client-side and sends it as a normal user message; the rollout carries no flag separating it from something you typed. So detection requires a Codex-specific signal — a `developer` role, a Codex-specific leading tag, or a known heading **plus** corroborating structure — and generic tags you might paste yourself (`<instructions>`, `<root>`, …) are never treated as injected. Where an injection wraps your real message, the two are split rather than the whole thing hidden.

### Execution policy

Codex separates *approval* (when to ask) from *sandbox* (what it may touch); Claude folds both into one `permissionMode`:

| Codex | Claude |
| --- | --- |
| approval asks the user (`on-request`, `untrusted`, `on-failure`) | `default` |
| never asks + `danger-full-access` / sandbox disabled | `bypassPermissions` |
| never asks + `workspace-write` / `managed` | `acceptEdits` |
| never asks + `read-only` | `plan` |
| unrecognised | `default` — never something more permissive |

Reasoning effort maps straight across (Codex `ultra` clamps to `max`). The Claude model has no Codex counterpart and defaults to `claude-opus-5`; override with `--model`.

## Replay safety

A transcript can appear in the sidebar and still fail on the next message with a 400. Every conversion is validated before writing, and these are repaired:

- `tool_use.input` coerced to an object (`Input should be an object` otherwise)
- every `tool_use` answered by a `tool_result` in the next message — multiple calls answered together, missing outputs synthesised
- orphan `tool_result` (compacted history) demoted to text
- no empty messages; transcript starts with a user message; `parentUuid` forms one chain

Verified on 21 real conversations: 0 violations. Details in [docs/FORMATS.md](./docs/FORMATS.md).

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
| `--title-prefix <s>` | — | prefix titles, e.g. `"[Codex] "` |
| `--include-reasoning` | off | keep Codex reasoning as `thinking` blocks |
| `--interactive-only` | off | drop non-interactive `codex exec` runs |
| `--include-archived` | off | include archived Codex threads |
| `--project <substr>` / `--id <id>` | — | narrow to a project, or one conversation |
| `--since-days <n>` / `--max <n>` / `--from` / `--to` | unlimited | extra age, count and range limits |
| `--force` | — | re-import, and refresh records this tool created |
| `--no-register` | off | transcript only (**will not appear in the list**) |
| `--model <id>` | `claude-opus-5` | model recorded for resumed sessions |
| `--codex-home` / `--claude-home` / `--sessions-root` | standard paths | override source and targets |

Re-runs are safe: imports are deduplicated by source content hash, and a conversation is never registered twice.

## Safety

This writes into another application's local data, so it's deliberately conservative:

- **Additive.** It creates new files, deletes nothing, and the only records it rewrites are ones it created itself (with `--force`).
- **Dry run first.** `--dry-run` prints every target path and writes nothing.
- **Reversible.** To undo, delete the transcripts it wrote and the `local_*.json` records it created — both are listed in its output.
- Prefer running with Claude Desktop closed.

## Limitations

- Built on **undocumented, internal formats** of two proprietary desktop apps. They can change at any time; treat this as best-effort.
- Verified on Windows. macOS and Linux paths are implemented but less exercised.
- Sub-agent threads are imported as messages, not as separate branching threads.
- Large rollouts are read whole; streaming isn't implemented yet.

## Related

- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) — call Codex *from* Claude Code (the other way round)
- [inmzhang/transession](https://github.com/inmzhang/transession) — CLI-only session translation, one session id at a time
- Codex CLI `/import` — Claude → Codex, built in

## Development

```bash
npm test
```

## Disclaimer

Unofficial. Not affiliated with, endorsed by, or supported by OpenAI or Anthropic. "Codex" and "Claude" are trademarks of their respective owners. Use at your own risk; back up anything you care about.

## License

MIT — see [LICENSE](./LICENSE).
