#!/usr/bin/env -S node --experimental-strip-types --experimental-sqlite
import { parseArgs } from "node:util";
import { resolveCodexHome, resolveClaudeHome } from "./paths.ts";
import { loadDesktopSessions } from "./codex-source.ts";
import { sourceKind } from "./codex-db.ts";
import { applyFilter } from "./filter.ts";
import { mapSessionToClaudeLines } from "./map.ts";
import {
  alreadyImported,
  inspectTarget,
  lastRecordFor,
  loadImportHistory,
  makeHistoryRecord,
  saveImportHistory,
  sha256File,
  targetPathFor,
  writeTranscript,
} from "./claude-target.ts";
import {
  buildWrapperRecord,
  existingCliSessionIds,
  findActiveWorkspaceDir,
  findRecordFor,
  refreshWrapperRecord,
  resolveDesktopSessionsRoot,
  writeWrapperRecord,
} from "./claude-desktop-target.ts";
import { validateTranscript } from "./validate.ts";
import { fixTranscriptFile } from "./fix.ts";
import type { SessionFilter } from "./types.ts";

const HELP = `codex-import — import Codex CLI/Desktop sessions into Claude Code / Claude Desktop

By default this selects exactly the conversations Codex Desktop shows in its list:
it reads Codex's own index (state_*.sqlite) and replicates the Desktop filter
listThreads({archived:false, parentThreadId:null}) — i.e. non-archived, top-level
threads, excluding subagent/worker threads. (Falls back to a rollout-file scan with
the equivalent filter if no index DB is present.)

USAGE
  codex-import list   [options] [--json]
  codex-import fix    [--dry-run]        de-duplicate already-imported transcripts
  codex-import import [options] [--dry-run] [--force] [--include-reasoning] [--version-tag <s>]

SELECTION (Codex Desktop conversation-list criteria)
  --interactive-only   drop non-interactive 'codex exec' automation runs
  --include-archived   also include archived threads (Desktop hides these)
  --archived-only      only archived threads (implies --include-archived)
  --projects-only      only conversations assigned to a Codex project
  --projectless-only   only conversations with no project (Codex 'Recents')
  --include-empty      keep threads the user never wrote in (Codex hides these)
  --max-tool-output <n>  cap each tool result at n characters (default 4000)
  --max-chars <n>        cap the whole transcript (default 1000000); older turns
                         are dropped so a resumed conversation fits the context

OPTIONAL REFINEMENTS (off by default)
  --since-days <n>   only threads active within N days
  --max <n>          cap number of threads
  --project <substr> only threads whose cwd contains substr
  --from <date>      lower bound on last activity (ISO or YYYY-MM-DD)
  --to <date>        upper bound on last activity
  --id <sessionId>   a single thread by id

PATHS
  --codex-home <p>   default $CODEX_HOME or ~/.codex
  --claude-home <p>  default $CLAUDE_CONFIG_DIR or ~/.claude

Sessions are written to <claude-home>/projects/<encoded-cwd>/<sessionId>.jsonl and
deduped via <claude-home>/codex-import-history.json (source-content sha256).
`;

function parseDateMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Date.parse(v);
  return Number.isNaN(n) ? undefined : n;
}

function toFilter(v: Record<string, string | boolean | undefined>): SessionFilter {
  return {
    // Default 0 = no age/count cut: the Codex Desktop criteria drive selection,
    // these are opt-in refinements only.
    sinceDays: v["since-days"] != null ? Number(v["since-days"]) : 0,
    max: v["max"] != null ? Number(v["max"]) : 0,
    project: typeof v["project"] === "string" ? v["project"] : undefined,
    fromMs: parseDateMs(v["from"] as string | undefined),
    toMs: parseDateMs(v["to"] as string | undefined),
    id: typeof v["id"] === "string" ? v["id"] : undefined,
    projectsOnly: v["projects-only"] === true,
    projectlessOnly: v["projectless-only"] === true,
    archivedOnly: v["archived-only"] === true,
    includeEmpty: v["include-empty"] === true,
  };
}

function fmtDate(ms: number | null): string {
  if (ms == null) return "??????????";
  return new Date(ms).toISOString().slice(0, 10);
}

function main(argv: string[]): number {
  const command = argv[0];
  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    allowPositionals: false,
    options: {
      "codex-home": { type: "string" },
      "claude-home": { type: "string" },
      "interactive-only": { type: "boolean", default: false },
      "include-archived": { type: "boolean", default: false },
      "since-days": { type: "string" },
      max: { type: "string" },
      project: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      id: { type: "string" },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "include-reasoning": { type: "boolean", default: false },
      "version-tag": { type: "string" },
      "title-prefix": { type: "string" },
      "no-register": { type: "boolean", default: false },
      "sessions-root": { type: "string" },
      model: { type: "string" },
      "projects-only": { type: "boolean", default: false },
      "projectless-only": { type: "boolean", default: false },
      "archived-only": { type: "boolean", default: false },
      "include-empty": { type: "boolean", default: false },
      "max-tool-output": { type: "string" },
      "max-chars": { type: "string" },
    },
  });

  const codexHome = resolveCodexHome(values["codex-home"] as string | undefined);
  const claudeHome = resolveClaudeHome(values["claude-home"] as string | undefined);
  const nowMs = Date.now();
  const filter = toFilter(values as Record<string, string | boolean | undefined>);

  const { via, sessions: all } = loadDesktopSessions(codexHome, {
    interactiveOnly: values["interactive-only"] === true,
    includeArchived:
      values["include-archived"] === true || values["archived-only"] === true,
  });
  const selected = applyFilter(all, filter, nowMs);

  if (command === "list") {
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          selected.map((s) => ({
            sessionId: s.sessionId,
            cwd: s.cwd,
            rolloutPath: s.rolloutPath,
            firstTsMs: s.firstTsMs,
            lastTsMs: s.lastTsMs,
            messageCount: s.messageCount,
            model: s.model,
            title: s.title,
          })),
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    const byKind: Record<string, number> = {};
    for (const s of selected) {
      const k = sourceKind(s.source);
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    const kindStr = Object.entries(byKind)
      .map(([k, c]) => `${k}:${c}`)
      .join("  ");
    const viaLabel =
      via === "desktop"
        ? "Desktop sidebar state"
        : via === "db"
          ? "index DB (all top-level threads)"
          : "file scan";
    // Codex Desktop groups by project; conversations with no project are only
    // reachable through Recents, so show the split before anything is imported.
    const grouped = new Map<string, number>();
    for (const s of selected) {
      const key =
        s.hasProject === false ? "(no project — Recents)" : (s.projectName ?? "(unknown)");
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    const byProject = [...grouped.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, c]) => `  ${String(c).padStart(3)}  ${k}`)
      .join("\n");
    process.stderr.write(
      `Codex home: ${codexHome}\nSelection: Codex Desktop conversation list (via ${viaLabel}).\n` +
        `${all.length} conversation(s), ${selected.length} after refinements.  [${kindStr}]\n\n` +
        `By project:\n${byProject}\n\n`,
    );
    if (selected.length === 0) {
      process.stderr.write("No conversations match.\n");
      return 0;
    }
    for (let i = 0; i < selected.length; i++) {
      const s = selected[i];
      const idx = String(i + 1).padStart(3, " ");
      const msgs = String(s.messageCount).padStart(4, " ");
      const kind = sourceKind(s.source).padEnd(7, " ");
      const proj = s.projectName ? `[${s.projectName}] ` : "";
      process.stdout.write(
        `${idx}. ${fmtDate(s.lastTsMs)}  ${kind}  ${msgs} msg  ${proj}${s.cwd || "(no cwd)"}\n` +
          `     ${s.sessionId}  ${s.title || "(untitled)"}\n`,
      );
    }
    return 0;
  }

  if (command === "import") {
    const history = loadImportHistory(claudeHome);
    const dryRun = values["dry-run"] === true;
    const force = values.force === true;
    let imported = 0;
    let skipped = 0;
    let registered = 0;
    let conflicts = 0;

    // Claude Desktop lists conversations from wrapper records, not from the
    // transcript files. Without a record an imported transcript stays invisible.
    const register = values["no-register"] !== true;
    const sessionsRoot = resolveDesktopSessionsRoot(
      values["sessions-root"] as string | undefined,
    );
    const workspaceDir = register ? findActiveWorkspaceDir(sessionsRoot) : null;
    const alreadyRegistered =
      workspaceDir != null ? existingCliSessionIds(workspaceDir) : new Set<string>();
    if (register && workspaceDir == null) {
      process.stderr.write(
        `WARNING: no Claude Desktop session-record directory found under\n  ${sessionsRoot}\n` +
          `Transcripts will be written but will NOT appear in the Claude Desktop list.\n\n`,
      );
    }

    process.stderr.write(
      `Codex home:  ${codexHome}\nClaude home: ${claudeHome}\n` +
        `Selection: Codex Desktop conversation list (via ${via === "desktop" ? "Desktop sidebar state" : via === "db" ? "index DB" : "file scan"}).\n` +
        `${selected.length} conversation(s) selected${dryRun ? " (dry-run)" : ""}.\n\n`,
    );

    for (const s of selected) {
      const sha = sha256File(s.rolloutPath);
      if (!force && alreadyImported(history, sha)) {
        skipped += 1;
        // The transcript already exists, but it may predate registration —
        // register it so it actually shows up in the Claude Desktop list.
        if (workspaceDir != null && !alreadyRegistered.has(s.sessionId) && !dryRun) {
          const catchUp = mapSessionToClaudeLines(s, {
            titlePrefix:
              typeof values["title-prefix"] === "string"
                ? (values["title-prefix"] as string)
                : undefined,
          });
          if (catchUp.length > 0) {
            const record = buildWrapperRecord({
              cliSessionId: s.sessionId,
              cwd: s.cwdOriginal || s.cwd,
              lines: catchUp,
              title: catchUp[0]?.customTitle ?? s.title ?? "(untitled)",
              model: typeof values["model"] === "string" ? (values["model"] as string) : undefined,
              sandboxPolicy: s.sandboxPolicy,
              approvalMode: s.approvalMode,
              reasoningEffort: s.reasoningEffort,
            });
            writeWrapperRecord(workspaceDir, record);
            alreadyRegistered.add(s.sessionId);
            registered += 1;
            process.stdout.write(
              `skip  ${s.sessionId}  (already imported) — registered\n`,
            );
            continue;
          }
        }
        process.stdout.write(`skip  ${s.sessionId}  (already imported)\n`);
        continue;
      }
      const lines = mapSessionToClaudeLines(s, {
        version:
          typeof values["version-tag"] === "string"
            ? (values["version-tag"] as string)
            : undefined,
        includeReasoning: values["include-reasoning"] === true,
        titlePrefix:
          typeof values["title-prefix"] === "string"
            ? (values["title-prefix"] as string)
            : undefined,
        maxToolChars:
          values["max-tool-output"] != null
            ? Number(values["max-tool-output"])
            : undefined,
        maxChars: values["max-chars"] != null ? Number(values["max-chars"]) : undefined,
      });
      if (lines.length === 0) {
        skipped += 1;
        process.stdout.write(`skip  ${s.sessionId}  (no convertible content)\n`);
        continue;
      }
      // Never write a transcript that would fail on resume.
      const issues = validateTranscript(lines);
      if (issues.length > 0) {
        skipped += 1;
        process.stdout.write(
          `skip  ${s.sessionId}  (would not be replayable: ${issues[0].kind} @line ${issues[0].line})
`,
        );
        continue;
      }
      const { targetPath } = targetPathFor(claudeHome, s);

      // Claude appends to a transcript when the conversation is opened or
      // continued. Overwriting then destroys messages sent after the import,
      // so a transcript that changed since we wrote it is left alone.
      const prior = lastRecordFor(history, s.sessionId);
      const state = inspectTarget(targetPath, prior?.targetSha256);
      if (force && (state === "modified" || state === "foreign")) {
        conflicts += 1;
        process.stdout.write(
          state === "modified"
            ? `WARN  ${s.sessionId}  overwriting a transcript continued in Claude
`
            : `WARN  ${s.sessionId}  overwriting a transcript this tool did not write
`,
        );
      }
      if (!force && (state === "modified" || state === "foreign")) {
        conflicts += 1;
        skipped += 1;
        process.stdout.write(
          state === "modified"
            ? `skip  ${s.sessionId}  (continued in Claude since import — use --force to overwrite)
`
            : `skip  ${s.sessionId}  (a transcript this tool did not write is already there)
`,
        );
        continue;
      }

      if (dryRun) {
        process.stdout.write(`would write  ${lines.length} lines -> ${targetPath}\n`);
        imported += 1;
        continue;
      }
      const res = writeTranscript(claudeHome, s, lines);
      history.records = history.records.filter((r) => r.importedSessionId !== s.sessionId);
      history.records.push(makeHistoryRecord(s, sha, nowMs, res.sha256));
      imported += 1;
      process.stdout.write(
        `import ${res.lineCount} lines (${res.bytes}b) -> ${res.targetPath}\n`,
      );

      if (workspaceDir != null && alreadyRegistered.has(s.sessionId) && force) {
        // Refresh the record we wrote earlier so remapped fields (title,
        // permission mode, effort, turn count) take effect.
        const existing = findRecordFor(workspaceDir, s.sessionId);
        if (existing) {
          refreshWrapperRecord(
            existing.path,
            existing.record,
            buildWrapperRecord({
              cliSessionId: s.sessionId,
              cwd: s.cwdOriginal || s.cwd,
              lines,
              title: lines[0]?.customTitle ?? s.title ?? "(untitled)",
              model: typeof values["model"] === "string" ? (values["model"] as string) : undefined,
              sandboxPolicy: s.sandboxPolicy,
              approvalMode: s.approvalMode,
              reasoningEffort: s.reasoningEffort,
            }),
          );
          registered += 1;
          process.stdout.write(`  refreshed -> ${existing.record.sessionId}.json
`);
        }
      } else if (workspaceDir != null && !alreadyRegistered.has(s.sessionId)) {
        const record = buildWrapperRecord({
          cliSessionId: s.sessionId,
          cwd: s.cwdOriginal || s.cwd,
          lines,
          title: lines[0]?.customTitle ?? s.title ?? "(untitled)",
          model: typeof values["model"] === "string" ? (values["model"] as string) : undefined,
          sandboxPolicy: s.sandboxPolicy,
          approvalMode: s.approvalMode,
          reasoningEffort: s.reasoningEffort,
        });
        writeWrapperRecord(workspaceDir, record);
        alreadyRegistered.add(s.sessionId);
        registered += 1;
        process.stdout.write(`  registered -> ${record.sessionId}.json\n`);
      }
    }

    if (!dryRun) saveImportHistory(claudeHome, history);
    process.stderr.write(
      `\nDone. imported=${imported} skipped=${skipped} registered=${registered}\n` +
        (registered > 0
          ? `Restart Claude Desktop to see the imported conversations.\n`
          : ""),
    );
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}

process.exit(main(process.argv.slice(2)));
