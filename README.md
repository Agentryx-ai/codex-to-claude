# codex-to-claude

Import your Codex conversations into Claude Desktop and Claude Code.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.6-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)

```console
$ codex-to-claude list
20 conversation(s), 20 after refinements.  [vscode:19  cli:1]

By project:
    3  Agentryx
    2  ReTalk
    2  Itineva
    1  ModuBoza
    1  (no project)
    ...

$ codex-to-claude import --dry-run          # writes nothing
$ codex-to-claude import --title-prefix "[Codex] "
```

Restart Claude Desktop. The conversations are in the sidebar under the same
projects, and you can open and continue them.

## Background

Codex ships an External Agent Import that pulls Claude Code, Claude Cowork and
Cursor sessions into Codex, including settings, projects and recent chats.
Claude has nothing that goes the other way, so switching means leaving your
history behind.

This tool covers that direction. It was written for
[Agentryx](https://github.com/Agentryx-ai), an AI-native agent harness, which
needs conversation history to move between providers. It is a separate
repository because it depends on the on-disk formats of two proprietary desktop
apps. Those change on someone else's schedule, and that churn is easier to
handle in a small project that can be fixed and released on its own. It works
without Agentryx.

## What it does

- Selects the same conversations Codex Desktop lists, including its
  project grouping
- Converts messages, tool calls, tool results, images and sub-agent reports
- Registers each import so Claude Desktop actually shows it
- Maps Codex sandbox and approval settings to a Claude permission mode
- Starts from the context Codex compacted to, so long sessions still fit
- Marks Codex's injected boilerplate as metadata, keeping titles readable
- Validates every conversion, and refuses to write one that would fail on resume
- Skips conversations you continued in Claude instead of overwriting them

## Scope

In scope: Codex CLI and Desktop conversations, moved into Claude Code and
Claude Desktop, with the filters needed to choose which ones.

Out of scope: the reverse direction (Codex already has it), settings, skills,
plugins and MCP servers, anything requiring a network call or an account, and
editing conversations you already have.

## How it works

Claude Desktop keeps a conversation in two places. Both are needed for it to
appear:

| Layer | Location | Role |
| --- | --- | --- |
| Session record | `%APPDATA%/Claude/claude-code-sessions/<account>/<device>/local_<uuid>.json` | Builds the conversation list. Points at a transcript by `cliSessionId` and `cwd`. |
| Transcript | `~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl` | The conversation itself. |

Writing only a transcript leaves it invisible, so this writes both.

```
~/.codex/sessions/**/rollout-*.jsonl
        │
        ├─ select    what Codex Desktop lists
        ├─ convert   rollout items to transcript lines
        ├─ validate  replay invariants
        │
        ├──► ~/.claude/projects/<enc-cwd>/<id>.jsonl
        └──► claude-code-sessions/.../local_<uuid>.json
```

## Choosing conversations

Codex Desktop groups by project. Conversations without one appear only under
Recents, and plenty of people never look at them, so membership is a filter:

| Flag | Imports |
| --- | --- |
| *(default)* | everything the sidebar shows |
| `--projects-only` | only conversations in a project |
| `--projectless-only` | only the Recents ones |
| `--project <name>` | one project, by Codex name or path |
| `--include-archived`, `--archived-only` | include or restrict to archived threads |
| `--interactive-only` | drop `codex exec` automation runs |

`list` prints the per-project breakdown first. Further limits: `--since-days`,
`--max`, `--from`, `--to`, `--id`.

## Conversion

| Codex | Claude |
| --- | --- |
| user, assistant message | user, assistant message |
| `function_call`, `custom_tool_call`, `tool_search_call` | `tool_use` |
| `*_output` | `tool_result` |
| `reasoning` | `thinking` (with `--include-reasoning`) |
| pasted screenshots | `image` |
| `agent_message` | metadata line, prefixed with the sender |
| injected context | metadata line |
| sandbox and approval policy | `permissionMode` |
| reasoning effort | `effort` |
| `event_msg`, `world_state` | dropped |

### Injected context

Codex adds a lot of tooling boilerplate to conversations as ordinary user
messages: environment blocks, plugin catalogs, skill and permission
instructions, AGENTS.md contents. Importing those as messages makes it look
like you pasted them, and one of them usually becomes the title.

They are marked `isMeta` instead, which is Claude's own convention for context
nobody typed. They stay in the transcript, out of the conversation and out of
the title.

Codex builds that boilerplate client-side and sends it as a normal user
message, so nothing in the rollout marks it. Detection is textual and needs a
Codex-specific signal: a `developer` role, a Codex-specific opening tag, or a
known heading together with the structure that goes with it. Tags you might
paste yourself, like `<instructions>` or `<root>`, are left alone. When an
injection wraps a real message (attachment lists, response annotations), the
two are split.

### Permissions

Codex separates approval (when to ask) from sandbox (what it may touch). Claude
has one `permissionMode`:

| Codex | Claude |
| --- | --- |
| approval asks the user (`default`, `on-request`, `untrusted`, `on-failure`) | `default` |
| never asks, `danger-full-access` or sandbox disabled | `bypassPermissions` |
| never asks, `workspace-write` or `managed` | `acceptEdits` |
| never asks, `read-only` | `plan` |
| anything else | `default` |

Reasoning effort carries over directly. Codex `ultra` becomes `max`. The Claude
model has no Codex counterpart and defaults to `claude-opus-5`, which `--model`
overrides.

### Long conversations

Claude replays a whole transcript when you resume, so a long Codex session can
blow past the context window before you send anything. Codex records the
shortened context it kept on each compaction, and imports start from the most
recent one. On a real set of 20 conversations this took 39 MB of history down
to 6.5 MB, and the largest conversation from roughly 2.1M tokens to 250K.

Nothing is summarised, and nothing needs to be. Codex does not summarise at
import either. It seeds token counts so its own auto-compaction runs on the
next turn, which Claude cannot do because it fails first.

Claude has a different mechanism for the same problem: a
`system`/`compact_boundary` line in the transcript, after which everything
earlier is left out when the conversation loads. `--full-history` keeps every
turn on disk and writes one of those markers wherever Codex compacted, so the
whole conversation stays searchable while only the recent part is replayed.

`--max-tool-output` changes the 4000-character cap on tool results, and
`--max-chars` sets the overall ceiling.

### Resuming

A transcript can show up in the sidebar and still fail on the first message
with a 400. Every conversion is checked before it is written, and these are
repaired:

- `tool_use.input` must be an object, not a JSON string
- every `tool_use` needs a `tool_result` in the next message, so several calls
  in one turn are answered together and missing outputs get a placeholder
- a `tool_result` with no matching call becomes text
- no empty messages, transcripts start with a user message, `parentUuid` forms
  one chain

## Install

Node.js 22.6 or newer. No dependencies.

```bash
git clone https://github.com/Agentryx-ai/codex-to-claude
cd codex-to-claude
node --experimental-strip-types --experimental-sqlite src/cli.ts list
```

## Commands

```
codex-to-claude list    [options] [--json]
codex-to-claude import  [options] [--dry-run] [--force]
codex-to-claude fix     [--dry-run]
```

`fix` cleans up transcripts that Claude duplicated. Opening an imported
conversation makes Claude append the history it replayed, so every message
shows twice. `fix` collapses that without re-converting. Messages you really
did repeat are kept, since their timestamps differ.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dry-run` | | print the plan, write nothing |
| `--title-prefix <s>` | | prefix titles, e.g. `"[Codex] "` |
| `--include-reasoning` | off | keep Codex reasoning as `thinking` blocks |
| `--full-history` | off | every turn instead of Codex's compacted context |
| `--max-tool-output <n>` | 4000 | cap on each tool result, in characters |
| `--max-chars <n>` | 1000000 | cap on a whole transcript |
| `--include-empty` | off | keep threads you never wrote in |
| `--force` | | re-import, and refresh records this tool wrote |
| `--no-register` | off | transcript only, so it will not be listed |
| `--model <id>` | `claude-opus-5` | model recorded for resumed sessions |
| `--codex-home`, `--claude-home`, `--sessions-root` | standard paths | override source and targets |

Re-runs are safe. Imports are deduplicated by source hash, and a conversation
is never registered twice.

## Safety

This writes into another application's local data, so it stays cautious.

- It creates files and deletes none. The only records it rewrites are ones it
  wrote itself, and only with `--force`.
- `--dry-run` prints every target path and writes nothing.
- If you continued an imported conversation in Claude, the transcript changed
  since the import and it is skipped, with a note. `--force` overrides that and
  says what it overwrote.
- To undo an import, delete the transcripts and the `local_*.json` records it
  created. Both are listed in its output.
- Prefer running with Claude Desktop closed.

## Limitations

- Built on undocumented internals of two proprietary desktop apps. They can
  change at any time.
- Verified on Windows. macOS and Linux paths are implemented, less exercised.
- Codex encrypts its compaction summaries, so an import shows where compaction
  happened but not what it said.
- Sub-agent threads arrive as messages, not as separate threads.
- Large rollouts are read whole. No streaming yet.

## Related

- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), calling
  Codex from Claude Code
- [inmzhang/transession](https://github.com/inmzhang/transession), CLI session
  translation by session id
- Codex CLI `/import`, Claude into Codex

## Development

```bash
npm test
```

Format details are in [docs/FORMATS.md](./docs/FORMATS.md).

## Disclaimer

Unofficial, and not affiliated with OpenAI or Anthropic. "Codex" and "Claude"
are trademarks of their respective owners. Back up anything you care about.

## License

MIT, see [LICENSE](./LICENSE).
