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
import { isInjectedContext } from "../src/preamble.ts";
import {
  alreadyImported,
  loadImportHistory,
  makeHistoryRecord,
  saveImportHistory,
  sha256File,
  targetPathFor,
  writeTranscript,
} from "../src/claude-target.ts";
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
    model: null, messageCount: 1, title: id, source: "cli", isChild: false,
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
