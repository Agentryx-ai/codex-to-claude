import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  parseRollout,
  loadCodexSessions,
  loadDesktopSessions,
} from "../src/codex-source.ts";
import { applyFilter } from "../src/filter.ts";
import { mapSessionToClaudeLines } from "../src/map.ts";
import { isInjectedContext, splitUserMessage } from "../src/preamble.ts";
import {
  alreadyImported,
  loadImportHistory,
  makeHistoryRecord,
  saveImportHistory,
  sha256File,
  targetPathFor,
  writeTranscript,
} from "../src/claude-target.ts";
import {
  countWorkspaceDirs,
  findActiveWorkspaceDir,
  resolveDesktopSessionsRoot,
  signedInWorkspaceDir,
} from "../src/claude-desktop-target.ts";
import { loadDesktopSelection, projectForCwd } from "../src/codex-desktop-state.ts";
import { loadThreadNames, nameFromThreadRow } from "../src/codex-thread-names.ts";
import { encodeProjectDir } from "../src/paths.ts";
import type { CodexSession } from "../src/types.ts";

const SID = "11111111-1111-4111-8111-111111111111";
const ROLLOUT_LINES = [
  { timestamp: "2026-07-24T05:38:12.000Z", type: "session_meta", payload: { id: SID, cwd: "/home/u/proj", originator: "codex_cli", cli_version: "0.145.0", git: { branch: "main" } } },
  { timestamp: "2026-07-24T05:38:13.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] } },
  { timestamp: "2026-07-24T05:38:14.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "think about it" }] } },
  { timestamp: "2026-07-24T05:38:15.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I'll run a command" }] } },
  { timestamp: "2026-07-24T05:38:16.000Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "call_1" } },
  { timestamp: "2026-07-24T05:38:17.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "file1\nfile2" } },
  { timestamp: "2026-07-24T05:38:18.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
];
const ROLLOUT_TEXT = ROLLOUT_LINES.map((l) => JSON.stringify(l)).join("\n") + "\n";
const NOW = Date.parse("2026-07-25T00:00:00.000Z");

function writeFixtureCodexHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-src-"));
  const dir = path.join(home, "sessions", "2026", "07", "24");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-07-24T05-38-12-${SID}.jsonl`), ROLLOUT_TEXT);
  return home;
}

function fixtureSession(): CodexSession {
  const home = writeFixtureCodexHome();
  const files = loadCodexSessions(home);
  assert.equal(files.length, 1);
  return files[0];
}

test("parseRollout extracts meta, cwd, title, messageCount", () => {
  const s = fixtureSession();
  assert.equal(s.sessionId, SID);
  assert.equal(s.cwd, "/home/u/proj");
  assert.equal(s.meta.git?.branch, "main");
  assert.equal(s.title, "hello codex");
  // user(1) + assistant(2) messages
  assert.equal(s.messageCount, 3);
  assert.equal(s.firstTsMs, Date.parse("2026-07-24T05:38:12.000Z"));
});

test("mapSessionToClaudeLines produces a correct linked transcript", () => {
  const s = fixtureSession();
  const lines = mapSessionToClaudeLines(s);
  assert.equal(lines.length, 4);

  // 1) user text
  assert.equal(lines[0].type, "user");
  assert.equal(lines[0].parentUuid, null);
  assert.deepEqual(lines[0].message.content, [{ type: "text", text: "hello codex" }]);

  // 2) assistant: text + tool_use grouped in one message (reasoning excluded by default)
  assert.equal(lines[1].type, "assistant");
  assert.equal(lines[1].parentUuid, lines[0].uuid);
  assert.equal(lines[1].gitBranch, "main");
  const b = lines[1].message.content;
  assert.equal(b[0].type, "text");
  assert.equal(b[1].type, "tool_use");
  assert.equal((b[1] as { id: string }).id, "call_1");
  assert.equal((b[1] as { name: string }).name, "shell");
  assert.deepEqual((b[1] as { input: unknown }).input, { cmd: "ls" });

  // 3) tool_result as a user line, with toolUseResult carrying the raw output
  assert.equal(lines[2].type, "user");
  assert.equal(lines[2].parentUuid, lines[1].uuid);
  const tr = lines[2].message.content[0] as { type: string; tool_use_id: string; content: string };
  assert.equal(tr.type, "tool_result");
  assert.equal(tr.tool_use_id, "call_1");
  assert.match(tr.content, /file1/);
  assert.equal(lines[2].toolUseResult, "file1\nfile2");

  // 4) trailing assistant text
  assert.equal(lines[3].type, "assistant");
  assert.equal(lines[3].parentUuid, lines[2].uuid);
  assert.deepEqual(lines[3].message.content, [{ type: "text", text: "done" }]);
});

test("includeReasoning maps reasoning to a leading thinking block", () => {
  const s = fixtureSession();
  const lines = mapSessionToClaudeLines(s, { includeReasoning: true });
  const assistant = lines[1];
  assert.equal(assistant.message.content[0].type, "thinking");
  assert.equal((assistant.message.content[0] as { thinking: string }).thinking, "think about it");
});

test("applyFilter honors since-days, max, project, and id", () => {
  const mk = (id: string, lastTsMs: number, cwd: string): CodexSession => ({
    sessionId: id, rolloutPath: `/x/${id}.jsonl`, cwd, meta: {},
    firstTsMs: lastTsMs, lastTsMs, items: [{ tsMs: lastTsMs, payload: { type: "message", role: "user" } }],
    model: null, messageCount: 1, title: id, source: "cli", isChild: false, userMessageCount: 1,
  });
  const recent = mk("recent", Date.parse("2026-07-24T00:00:00Z"), "/a/webapp");
  const old = mk("old", Date.parse("2026-05-01T00:00:00Z"), "/a/webapp");
  const other = mk("other", Date.parse("2026-07-23T00:00:00Z"), "/b/api");
  const all = [recent, other, old];

  // since-days 30 drops the May session
  const within = applyFilter(all, { sinceDays: 30 }, NOW).map((s) => s.sessionId);
  assert.deepEqual(within.sort(), ["other", "recent"]);

  // max caps count
  assert.equal(applyFilter(all, { sinceDays: 0, max: 1 }, NOW).length, 1);

  // project substring
  assert.deepEqual(applyFilter(all, { sinceDays: 0, project: "webapp" }, NOW).map((s) => s.sessionId).sort(), ["old", "recent"]);

  // id exact
  assert.deepEqual(applyFilter(all, { sinceDays: 0, id: "other" }, NOW).map((s) => s.sessionId), ["other"]);
});

test("loadDesktopSessions (scan fallback) excludes subagent and child threads", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desk-"));
  const dir = path.join(home, "sessions", "2026", "07", "24");
  fs.mkdirSync(dir, { recursive: true });
  const mkRollout = (id: string, meta: Record<string, unknown>): void => {
    const lines = [
      { timestamp: "2026-07-24T10:00:00.000Z", type: "session_meta", payload: { id, cwd: "/p", ...meta } },
      { timestamp: "2026-07-24T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
    ];
    fs.writeFileSync(path.join(dir, `rollout-2026-07-24T10-00-00-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  const TOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SUB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const CHILD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  mkRollout(TOP, { source: "cli" });
  mkRollout(SUB, { source: { subagent: { other: "agent_job:x" } } });
  mkRollout(CHILD, { source: "cli", parent_thread_id: TOP });

  // no state DB in this temp home -> scan fallback
  const { via, sessions } = loadDesktopSessions(home, {});
  assert.equal(via, "scan");
  const ids = sessions.map((s) => s.sessionId).sort();
  assert.deepEqual(ids, [TOP]); // subagent + child excluded
});

test("targetPathFor encodes cwd the Claude Code way", () => {
  const s = fixtureSession();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-"));
  const { targetPath } = targetPathFor(tmp, s);
  assert.equal(encodeProjectDir("/home/u/proj"), "-home-u-proj");
  assert.equal(targetPath, path.join(tmp, "projects", "-home-u-proj", `${SID}.jsonl`));
});

test("Windows drive letter is lowercased to match Claude Code folders", () => {
  // real observation: Codex cwd "C:\\_projects\\Agentryx-ai" must map to the
  // same folder Claude Code created from "c:\\_projects\\Agentryx-ai".
  assert.equal(encodeProjectDir("C:\\_projects\\Agentryx-ai"), "c---projects-Agentryx-ai");
  assert.equal(encodeProjectDir("c:\\_projects\\Agentryx-ai"), "c---projects-Agentryx-ai");
});

test("end-to-end import writes a resumable transcript and dedups on re-run", () => {
  const codexHome = writeFixtureCodexHome();
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));

  const sessions = applyFilter(loadCodexSessions(codexHome), { sinceDays: 0 }, NOW);
  assert.equal(sessions.length, 1);
  const s = sessions[0];

  const history = loadImportHistory(claudeHome);
  const sha = sha256File(s.rolloutPath);
  assert.equal(alreadyImported(history, sha), false);

  const lines = mapSessionToClaudeLines(s);
  const res = writeTranscript(claudeHome, s, lines);
  history.records.push(makeHistoryRecord(s, sha, NOW));
  saveImportHistory(claudeHome, history);

  // file exists and every line round-trips as JSON
  assert.ok(fs.existsSync(res.targetPath));
  const written = fs.readFileSync(res.targetPath, "utf8").trim().split("\n");
  assert.equal(written.length, 4);
  for (const l of written) JSON.parse(l);
  assert.equal(res.targetPath, path.join(claudeHome, "projects", "-home-u-proj", `${SID}.jsonl`));

  // second run sees it as already imported
  const history2 = loadImportHistory(claudeHome);
  assert.equal(alreadyImported(history2, sha), true);
});

test("injected Codex context maps to isMeta, not to a plain user message", () => {
  const s = fixtureSession();
  // developer-role preamble + tag-wrapped user message + a real user message
  s.items = [
    { tsMs: 1, payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>...</skills_instructions>" }] } },
    { tsMs: 2, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins> Here is a list of plugins" }] } },
    { tsMs: 3, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "실제 사용자 질문" }] } },
    { tsMs: 4, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] } },
  ];
  const lines = mapSessionToClaudeLines(s, { titlePrefix: "[Codex] " });

  assert.equal(lines[0].isMeta, true, "developer preamble must be meta");
  assert.equal(lines[1].isMeta, true, "tag-wrapped injection must be meta");
  assert.equal(lines[2].isMeta, undefined, "real user message must not be meta");

  // title comes from the real user message, not the injected preamble
  assert.equal(lines[0].customTitle, "[Codex] 실제 사용자 질문");
});

test("isInjectedContext classifies Codex preamble tags", () => {
  assert.equal(isInjectedContext("developer", "anything"), true);
  assert.equal(isInjectedContext("user", "<environment_context>"), true);
  assert.equal(isInjectedContext("user", "<permissions instructions>"), true);
  assert.equal(isInjectedContext("user", "<codex_delegation>"), true);
  assert.equal(isInjectedContext("user", "just a question"), false);
  assert.equal(isInjectedContext("user", "<div> not a codex tag"), false);
});

test("AGENTS.md injection is meta whether or not the heading names a path", () => {
  const withPath = "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nbe brief\n</INSTRUCTIONS>";
  const bare = "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nbe brief\n</INSTRUCTIONS>";
  assert.equal(isInjectedContext("user", withPath), true);
  assert.equal(isInjectedContext("user", bare), true);
  // the heading on its own stays the user's, without Codex's structure
  assert.equal(isInjectedContext("user", "# AGENTS.md instructions\n\nwhat do they say?"), false);
});

test("a delegated thread keeps the delegated task as its user message", () => {
  const text =
    "<codex_delegation>\n  <source_thread_id>abc</source_thread_id>\n" +
    "  <input>MySQL 데이터 디렉터리를 복구해 주세요</input>\n</codex_delegation>";
  const { meta, request } = splitUserMessage("user", text);
  assert.equal(request, "MySQL 데이터 디렉터리를 복구해 주세요");
  assert.ok(meta != null && meta.includes("<input/>"), "wrapper is kept, task text is not repeated");
  assert.ok(!meta.includes("복구해"), "task text must not appear twice");

  // ...and that makes the thread importable, with a usable title.
  const s = fixtureSession();
  s.items = [
    { tsMs: 1, payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
    { tsMs: 2, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } },
  ];
  const lines = mapSessionToClaudeLines(s, { titlePrefix: "[Codex] " });
  assert.equal(lines[0].isMeta, true);
  assert.equal(lines[1].isMeta, undefined);
  assert.equal(lines[0].customTitle, "[Codex] MySQL 데이터 디렉터리를 복구해 주세요");
});

test("Claude Desktop's session-record root follows the platform", () => {
  const original = process.platform;
  const set = (p: string) => Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    set("darwin");
    assert.equal(
      resolveDesktopSessionsRoot(),
      path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
    );
    set("win32");
    assert.ok(
      resolveDesktopSessionsRoot().endsWith(path.join("Claude", "claude-code-sessions")),
    );
    assert.ok(resolveDesktopSessionsRoot().includes(process.env.APPDATA?.trim() || "AppData"));
    set("linux");
    const xdg = process.env.XDG_CONFIG_HOME?.trim();
    assert.equal(
      resolveDesktopSessionsRoot(),
      path.join(xdg && xdg !== "" ? xdg : path.join(os.homedir(), ".config"), "Claude", "claude-code-sessions"),
    );
  } finally {
    set(original);
  }
});

test("the signed-in account decides which session-record directory is used", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sessions-"));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-home-"));
  const stale = path.join(root, "stale-account", "stale-device");
  const mine = path.join(root, "my-account", "my-org");
  for (const d of [stale, mine]) fs.mkdirSync(d, { recursive: true });
  // The stale account has more records, so a count-based guess would pick it.
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(stale, `local_${i}.json`), JSON.stringify({ cliSessionId: `s${i}` }));
  }
  fs.writeFileSync(path.join(mine, "local_a.json"), JSON.stringify({ cliSessionId: "a" }));
  fs.writeFileSync(
    path.join(claudeHome, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "my-account", organizationUuid: "my-org" } }),
  );

  assert.equal(countWorkspaceDirs(root), 2);
  assert.equal(signedInWorkspaceDir(root, claudeHome), mine);
  assert.equal(findActiveWorkspaceDir(root), stale, "the guess alone would land on the wrong account");
});

test("current Codex Desktop state groups by project root, not by an assignment map", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-"));
  fs.writeFileSync(
    path.join(home, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": {
        p1: { id: "p1", name: "eagle", rootPaths: ["/home/u/work"] },
        p2: { id: "p2", name: "eagle-web", rootPaths: ["/home/u/work/web"] },
      },
      "project-order": ["p1", "p2"],
      "projectless-thread-ids": ["t-loose"],
    }),
  );
  const sel = loadDesktopSelection(home);
  assert.ok(sel);
  assert.equal(sel.mode, "derived", "no assignment map -> membership must come from the index");
  assert.equal(sel.projects.size, 2);
  assert.ok(sel.projectlessThreadIds.has("t-loose"));

  assert.equal(projectForCwd(sel, "/home/u/work")?.name, "eagle");
  assert.equal(projectForCwd(sel, "/home/u/work/src/app")?.name, "eagle");
  // nested roots: the longest match wins, as it does in the sidebar
  assert.equal(projectForCwd(sel, "/home/u/work/web/ui")?.name, "eagle-web");
  // a sibling directory that merely shares a prefix is not inside the project
  assert.equal(projectForCwd(sel, "/home/u/workshop"), null);
  assert.equal(projectForCwd(sel, "/home/u/other"), null);
  assert.equal(projectForCwd(sel, ""), null);
});

test("an older Desktop state with an assignment map still drives selection directly", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-"));
  fs.writeFileSync(
    path.join(home, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": { p1: { id: "p1", name: "eagle", rootPaths: ["c:\\work"] } },
      "thread-project-assignments": { "t-1": { projectId: "p1" } },
      "projectless-thread-ids": ["t-2"],
    }),
  );
  const sel = loadDesktopSelection(home);
  assert.ok(sel);
  assert.equal(sel.mode, "assigned");
  assert.equal(sel.threadProject.get("t-1")?.name, "eagle");
  assert.equal(sel.threadProject.get("t-2"), null);
  // Windows roots still match despite drive-letter case and separators
  assert.equal(projectForCwd(sel, "C:\\work\\repo")?.name, "eagle");
});

test("Codex's generated conversation name is read, newest entry winning", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-names-"));
  // Append-only: renaming a thread adds a line rather than rewriting one.
  // CRLF because the file is read on Windows too.
  const lines = [
    { id: "t-1", thread_name: "MySQL 손상 진단 및 복구", updated_at: "2026-07-15T20:04:24.959164Z" },
    { id: "t-1", thread_name: "MySQL 손상 복구 및 읽기 전용 데이터 회수", updated_at: "2026-07-15T20:05:42.216551Z" },
    { id: "t-2", thread_name: "  최신화하고 문서 읽기  ", updated_at: "2026-07-13T14:10:51.946387Z" },
    { id: "t-3", thread_name: "", updated_at: "2026-07-13T14:10:51.946387Z" },
    "{ not json",
    { thread_name: "no id", updated_at: "2026-07-13T14:10:51.946387Z" },
  ].map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
  fs.writeFileSync(path.join(home, "session_index.jsonl"), lines.join("\r\n") + "\r\n");

  const names = loadThreadNames(home);
  assert.equal(names.get("t-1"), "MySQL 손상 복구 및 읽기 전용 데이터 회수", "the later rename wins");
  assert.equal(names.get("t-2"), "최신화하고 문서 읽기");
  assert.equal(names.has("t-3"), false, "an empty name is not a name");
  assert.equal(names.size, 2, "malformed and id-less lines are skipped");

  // An install with no index file simply has no names, rather than failing.
  assert.equal(loadThreadNames(fs.mkdtempSync(path.join(os.tmpdir(), "codex-empty-"))).size, 0);
});

test("an out-of-order timestamp does not undo a later rename", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-names-"));
  fs.writeFileSync(
    path.join(home, "session_index.jsonl"),
    [
      JSON.stringify({ id: "t", thread_name: "new", updated_at: "2026-07-15T20:05:42Z" }),
      JSON.stringify({ id: "t", thread_name: "old", updated_at: "2026-07-15T20:04:24Z" }),
    ].join("\n"),
  );
  assert.equal(loadThreadNames(home).get("t"), "new");
});

test("the thread index is a fallback name source, but only when it can be told apart", () => {
  // `name` is authoritative.
  assert.equal(nameFromThreadRow({ name: "생성된 이름", title: "무엇이든", firstUserMessage: "무엇이든" }), "생성된 이름");
  // Codex seeds `title` with the first message; identical means it was never named.
  assert.equal(nameFromThreadRow({ name: null, title: "git pull 해주세요", firstUserMessage: "git pull 해주세요" }), null);
  // Diverging means Codex replaced it with a generated name.
  assert.equal(nameFromThreadRow({ name: null, title: "최신화하고 문서 읽기", firstUserMessage: "git pull 해주세요" }), "최신화하고 문서 읽기");
  assert.equal(nameFromThreadRow({ name: null, title: "", firstUserMessage: "" }), null);
  assert.equal(nameFromThreadRow({}), null);
});

test("an imported conversation is titled the way Codex titles it", () => {
  const named = fixtureSession();
  named.codexName = "최신화하고 문서 읽기";
  // Codex's name wins over the paragraph the conversation opened with.
  assert.equal(
    mapSessionToClaudeLines(named, { titlePrefix: "[Codex] " })[0].customTitle,
    "[Codex] 최신화하고 문서 읽기",
  );
  // ...and is worth a title on its own, or reading it off disk was pointless.
  assert.equal(mapSessionToClaudeLines(named)[0].customTitle, "최신화하고 문서 읽기");

  // Codex never names CLI threads, and shows their first message instead.
  const unnamed = fixtureSession();
  assert.equal(mapSessionToClaudeLines(unnamed, { titlePrefix: "[Codex] " })[0].customTitle, "[Codex] hello codex");
  assert.equal(mapSessionToClaudeLines(unnamed)[0].customTitle, undefined);
});
