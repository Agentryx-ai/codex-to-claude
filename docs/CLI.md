# CLI

```
codex-to-claude list    [options] [--json]
codex-to-claude import  [options] [--dry-run] [--force]
codex-to-claude fix     [--dry-run] [--prune]
```

Without a global install, that is:

```bash
node --experimental-strip-types --experimental-sqlite src/cli.ts list
```

## Pass flags to node, not through npm

npm has its own `--dry-run` and `--force`, and consumes them instead of
forwarding them to the script — `npm run import -- --dry-run` reached the tool
as a plain `import` and wrote for real. It now detects the swallowed flag and
refuses, and `npm run import:dry` has the flag baked in. Everything else belongs
on a direct `node src/cli.ts` invocation.

## Commands

`list` prints the per-project breakdown and the conversations that would be
imported. Read-only.

`import` converts and writes. Re-runs are safe: imports are deduplicated by
source hash, and a conversation is never registered twice.

`fix` cleans up transcripts that Claude duplicated. Opening an imported
conversation makes Claude append the history it replayed, so every message
shows twice. `fix` collapses that without re-converting. Messages you really
did repeat are kept, since their timestamps differ. It also re-syncs titles from
the transcripts, and reports records left behind for conversations no longer
imported — `--prune` removes those.

## Selecting conversations

| Flag | Imports |
| --- | --- |
| *(default)* | everything the Codex Desktop sidebar shows |
| `--projects-only` | only conversations in a project |
| `--projectless-only` | only the Recents ones |
| `--project <name>` | one project, by Codex name or path |
| `--include-archived`, `--archived-only` | include or restrict to archived threads |
| `--interactive-only` | drop `codex exec` automation runs |
| `--since-days <n>`, `--max <n>`, `--from <d>`, `--to <d>`, `--id <id>` | further limits |

## Import options

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
| `--version-tag <s>` | | `version` field written into transcript lines |
| `--codex-home`, `--claude-home`, `--sessions-root` | standard paths | override source and targets |
| `--json` | off | machine-readable `list` output |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | done |
| 1 | unknown command, or no command given |
| 2 | npm swallowed a flag; nothing ran |
