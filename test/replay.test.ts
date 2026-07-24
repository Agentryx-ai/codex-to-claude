import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mapSessionToClaudeLines } from "../src/map.ts";
import { loadCodexSessions } from "../src/codex-source.ts";
import { validateTranscript } from "../src/validate.ts";
import { MISSING_RESULT_TEXT, repairTranscript } from "../src/repair.ts";
import type { CodexSession } from "../src/types.ts";

function session(items: CodexSession["items"]): CodexSession {
  return {
    sessionId: "33333333-3333-4333-8333-333333333333",
    rolloutPath: "/x.jsonl", cwd: "/p", cwdOriginal: "/p", meta: {},
    firstTsMs: 1, lastTsMs: 9, items, model: null, messageCount: 1,
    title: "t", source: "cli", isChild: false, userMessageCount: 1,
  };
}
const user = (text: string, ts = 1) => ({ tsMs: ts, payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

test("tool_use.input is always an object (API rejects strings)", () => {
  const lines = mapSessionToClaudeLines(session([
    user("go"),
    { tsMs: 2, payload: { type: "function_call", name: "shell", arguments: "not json at all", call_id: "c1" } },
    { tsMs: 3, payload: { type: "function_call_output", call_id: "c1", output: "ok" } },
  ]));
  const tu: any = (lines[1].message.content as any[]).find((b) => b.type === "tool_use");
  assert.equal(typeof tu.input, "object");
  assert.ok(!Array.isArray(tu.input));
  assert.deepEqual(tu.input, { input: "not json at all" });
  assert.deepEqual(validateTranscript(lines), []);
});

test("a tool_use with no recorded output gets a synthesized tool_result", () => {
  const lines = mapSessionToClaudeLines(session([
    user("go"),
    { tsMs: 2, payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "orphaned" } },
  ]));
  const last = lines[lines.length - 1];
  const tr: any = (last.message.content as any[])[0];
  assert.equal(last.type, "user");
  assert.equal(tr.type, "tool_result");
  assert.equal(tr.tool_use_id, "orphaned");
  assert.equal(tr.content, MISSING_RESULT_TEXT);
  assert.deepEqual(validateTranscript(lines), []);
});

test("several tool calls in one turn are answered in a single user message", () => {
  const lines = mapSessionToClaudeLines(session([
    user("go"),
    { tsMs: 2, payload: { type: "function_call", name: "a", arguments: "{}", call_id: "c1" } },
    { tsMs: 3, payload: { type: "function_call", name: "b", arguments: "{}", call_id: "c2" } },
    { tsMs: 4, payload: { type: "function_call_output", call_id: "c1", output: "r1" } },
    { tsMs: 5, payload: { type: "function_call_output", call_id: "c2", output: "r2" } },
  ]));
  const answer = lines[2].message.content as any[];
  assert.deepEqual(answer.map((b) => b.tool_use_id), ["c1", "c2"]);
  assert.deepEqual(validateTranscript(lines), []);
});

test("tool_search_call (no name) still produces a matching tool_use", () => {
  const lines = mapSessionToClaudeLines(session([
    user("go"),
    { tsMs: 2, payload: { type: "tool_search_call", call_id: "s1", arguments: "{}" } },
    { tsMs: 3, payload: { type: "tool_search_output", call_id: "s1", tools: [{ name: "x" }] } },
  ]));
  const tu: any = (lines[1].message.content as any[])[0];
  assert.equal(tu.type, "tool_use");
  assert.equal(tu.name, "tool_search");
  assert.deepEqual(validateTranscript(lines), []);
});

test("a tool_result with no matching call is demoted to text", () => {
  const lines = mapSessionToClaudeLines(session([
    user("go"),
    { tsMs: 2, payload: { type: "function_call_output", call_id: "never_called", output: "stray" } },
  ]));
  assert.deepEqual(validateTranscript(lines), []);
  const flat = JSON.stringify(lines);
  assert.ok(flat.includes("stray"), "content is preserved");
  assert.ok(!flat.includes("tool_result"), "no dangling tool_result remains");
});

test("validateTranscript detects a non-object tool_use input", () => {
  const bad = mapSessionToClaudeLines(session([user("hi")]));
  (bad[0].message.content as any) = [{ type: "tool_use", id: "x", name: "n", input: "oops" }];
  const issues = validateTranscript(bad);
  assert.ok(issues.some((i) => i.kind === "tool-use-input"));
});

// --- classification: injected context vs. what the user wrote ---
import { splitUserMessage } from "../src/preamble.ts";

test("user-authored markdown with the same heading is NOT treated as injected", () => {
  // no Codex structure and no request marker -> a real message
  const own = "# Files mentioned by the user:\n\nI am writing docs about this heading.";
  assert.deepEqual(splitUserMessage("user", own), { meta: null, request: own });

  const notes = "# Response annotations:\nmy own notes about annotating responses";
  assert.equal(splitUserMessage("user", notes).meta, null);
});

test("Codex file-attachment injection is split from the user's request", () => {
  const injected = [
    "# Files mentioned by the user:",
    "",
    "## shot.png: C:/Users/me/AppData/Local/Temp/shot.png",
    "",
    "## My request for Codex:",
    "why does this crash?",
  ].join("\n");
  const { meta, request } = splitUserMessage("user", injected);
  assert.ok(meta?.startsWith("# Files mentioned"));
  assert.ok(meta?.includes("shot.png"));
  assert.equal(request, "why does this crash?");
});

test("response annotations require the Codex block to count as injected", () => {
  const real = [
    "# Response annotations:",
    "Each item contains text selected from an earlier Codex response.",
    "<response-annotations>",
    '[{"text":"some quote"}]',
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "please expand on that",
  ].join("\n");
  const { meta, request } = splitUserMessage("user", real);
  assert.ok(meta?.includes("<response-annotations>"));
  assert.equal(request, "please expand on that");
});

test("generic tags a user might paste are not treated as injected", () => {
  for (const t of ["<instructions>do this</instructions>", "<root>xml</root>", "<div>hi</div>", "<payload>{}</payload>"]) {
    assert.equal(splitUserMessage("user", t).meta, null, `${t} must stay a user message`);
  }
  // Codex-specific ones still are
  assert.ok(splitUserMessage("user", "<environment_context><cwd>/p</cwd>").meta !== null);
  assert.ok(splitUserMessage("developer", "anything at all").meta !== null);
});

test("pasted images survive as Claude image blocks", () => {
  const png = "iVBORw0KGgoAAAANSUhEUg";
  const lines = mapSessionToClaudeLines(session([
    { tsMs: 1, payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "what is wrong here?" },
      { type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "high" },
    ] } },
  ]));
  const blocks: any[] = lines[0].message.content as any[];
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[1].type, "image");
  assert.deepEqual(blocks[1].source, { type: "base64", media_type: "image/png", data: png });
  assert.deepEqual(validateTranscript(lines), []);
});

// --- Codex execution policy -> Claude permission mode ---
import { mapPermissionMode, mapEffort, sandboxKind } from "../src/policy.ts";

test("Codex sandbox + approval map onto Claude permission modes", () => {
  const P = (s: string | null, a: string | null) => mapPermissionMode(s, a);
  // never asks + no restrictions -> bypass
  assert.equal(P('{"type":"danger-full-access"}', "never"), "bypassPermissions");
  assert.equal(P('{"type":"disabled"}', "never"), "bypassPermissions");
  // never asks but confined to a workspace -> auto-accept edits
  assert.equal(P('{"type":"workspace-write","writable_roots":[]}', "never"), "acceptEdits");
  assert.equal(P('{"type":"managed","file_system":{"type":"restricted"}}', "never"), "acceptEdits");
  // read-only -> plan
  assert.equal(P('{"type":"read-only"}', "never"), "plan");
  // Codex asks the user -> Claude asks the user, regardless of sandbox
  assert.equal(P('{"type":"danger-full-access"}', "on-request"), "default");
  assert.equal(P('{"type":"disabled"}', "untrusted"), "default");
  // nothing corresponds -> ask, never something more permissive
  assert.equal(P(null, null), "default");
  assert.equal(P("garbage", "never"), "default");
});

test("sandboxKind parses both JSON and bare values", () => {
  assert.equal(sandboxKind('{"type":"read-only"}'), "read-only");
  assert.equal(sandboxKind("workspace-write"), "workspace-write");
  assert.equal(sandboxKind(null), null);
  assert.equal(sandboxKind(""), null);
});

test("Codex reasoning effort maps to Claude effort", () => {
  assert.equal(mapEffort("low"), "low");
  assert.equal(mapEffort("xhigh"), "xhigh");
  assert.equal(mapEffort("ultra"), "max");   // no Claude peer
  assert.equal(mapEffort(null), "high");     // Codex left it unset
});

// --- scoping by project membership and archive state ---
import { applyFilter } from "../src/filter.ts";

test("conversations can be scoped by project membership", () => {
  const mk = (id: string, hasProject: boolean, projectName: string, isArchived = false) =>
    ({ ...session([]), sessionId: id, cwd: "/p", lastTsMs: 1, firstTsMs: 1,
       hasProject, projectName, isArchived });
  const all = [
    mk("a", true, "ReTalk"),
    mk("b", true, "Riddlemesh"),
    mk("c", false, "(no project)"),
    mk("d", false, "(no project)", true),
  ] as any[];
  const ids = (f: any) => applyFilter(all, f, 2).map((s) => s.sessionId).sort();

  assert.deepEqual(ids({}), ["a", "b", "c", "d"]);
  assert.deepEqual(ids({ projectsOnly: true }), ["a", "b"]);
  assert.deepEqual(ids({ projectlessOnly: true }), ["c", "d"]);
  assert.deepEqual(ids({ archivedOnly: true }), ["d"]);
  // --project matches the Codex project name, not just the cwd
  assert.deepEqual(ids({ project: "riddle" }), ["b"]);
});

// --- re-import conflict handling ---
import { inspectTarget } from "../src/claude-target.ts";

test("a transcript changed after import is detected, not silently overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-"));
  const p = path.join(dir, "t.jsonl");

  assert.equal(inspectTarget(p, undefined), "absent");

  fs.writeFileSync(p, "line one\n", "utf8");
  const ours = createHash("sha256").update("line one\n", "utf8").digest("hex");
  assert.equal(inspectTarget(p, ours), "ours");           // untouched since we wrote it

  fs.appendFileSync(p, "claude added this\n", "utf8");
  assert.equal(inspectTarget(p, ours), "modified");       // continued in Claude

  assert.equal(inspectTarget(p, undefined), "foreign");   // not written by us at all
});

test("oversized tool output is capped so an import can still be resumed", () => {
  const big = "x".repeat(50_000);
  const lines = mapSessionToClaudeLines(session([
    user("run it"),
    { tsMs: 2, payload: { type: "function_call", name: "sh", arguments: "{}", call_id: "c1" } },
    { tsMs: 3, payload: { type: "function_call_output", call_id: "c1", output: big } },
  ]), { maxToolChars: 100 });
  const tr: any = (lines[2].message.content as any[])[0];
  assert.ok(tr.content.length < 300, "tool_result is capped");
  assert.match(tr.content, /truncated 49900 characters/);
  assert.equal(lines[2].toolUseResult, tr.content, "the duplicate copy is capped too");
  assert.deepEqual(validateTranscript(lines), []);
});

test("a transcript too large for the context window is trimmed to recent history", () => {
  const items: any[] = [user("first question", 1)];
  for (let i = 0; i < 60; i++) {
    items.push({ tsMs: i + 2, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "y".repeat(3000) }] } });
    items.push({ tsMs: i + 2, payload: { type: "message", role: "user", content: [{ type: "input_text", text: `turn ${i}` }] } });
  }
  const lines = mapSessionToClaudeLines(session(items), { maxChars: 40_000 });
  const size = lines.reduce((a, l) => a + JSON.stringify(l).length + 1, 0);
  assert.ok(size <= 45_000, `trimmed to ${size}`);
  assert.equal(lines[0].isMeta, true);
  assert.match(String((lines[0].message.content as any[])[0].text), /earlier message\(s\) were omitted/);
  assert.deepEqual(validateTranscript(lines), []);
});

test("a history Claude replayed into the file is collapsed back to one copy", () => {
  const once = mapSessionToClaudeLines(session([
    user("hello", 1),
    { tsMs: 2, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } },
    user("again", 3),
  ]));
  // Claude re-appends the same conversation with fresh uuids
  const replayed = once.map((l) => ({ ...l, uuid: randomUUID() }));
  const doubled = [...once, ...replayed];
  assert.equal(doubled.length, once.length * 2);

  const cleaned = repairTranscript(doubled);
  assert.equal(cleaned.length, once.length, "duplicates collapsed");
  assert.deepEqual(validateTranscript(cleaned), []);
});

test("genuinely repeated messages are kept", () => {
  const lines = mapSessionToClaudeLines(session([
    user("resume", 1),
    { tsMs: 2, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } },
    user("resume", 3),
  ]));
  const texts = lines.filter((l) => l.type === "user").map((l) => (l.message.content as any[])[0].text);
  assert.deepEqual(texts, ["resume", "resume"], "same text at different times is not a duplicate");
});

test("Codex's own compacted context is used instead of the full history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-comp-"));
  const sdir = path.join(dir, "sessions", "2026", "07", "24");
  fs.mkdirSync(sdir, { recursive: true });
  const SID = "44444444-4444-4444-8444-444444444444";
  const line = (o: unknown) => JSON.stringify(o);
  const msg = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
  const rows = [
    { timestamp: "2026-07-24T00:00:00.000Z", type: "session_meta", payload: { id: SID, cwd: "/p" } },
    // history that Codex later compacted away
    ...Array.from({ length: 20 }, (_, i) => ({ timestamp: "2026-07-24T00:00:01.000Z", type: "response_item", payload: msg("user", `old ${i}`) })),
    { timestamp: "2026-07-24T00:00:02.000Z", type: "compacted", payload: {
        replacement_history: [msg("user", "kept question"), { type: "compaction", id: "cmp_1" }] } },
    { timestamp: "2026-07-24T00:00:03.000Z", type: "response_item", payload: msg("user", "after compaction") },
  ];
  fs.writeFileSync(path.join(sdir, `rollout-2026-07-24T00-00-00-${SID}.jsonl`), rows.map(line).join("\n") + "\n");

  const compacted = loadCodexSessions(dir, { useCodexCompaction: true })[0];
  const full = loadCodexSessions(dir, { useCodexCompaction: false })[0];

  assert.equal(full.items.length, 22, "full history keeps every turn plus a boundary marker");
  assert.equal(compacted.items.length, 3, "compacted keeps replacement + what followed");
  assert.equal(compacted.compactedAway, 20);

  const texts = mapSessionToClaudeLines(compacted)
    .filter((l) => !l.isMeta)
    .map((l) => (l.message.content as any[])[0].text);
  assert.deepEqual(texts, ["kept question", "after compaction"]);
  // the compaction boundary is surfaced, not silently dropped
  assert.ok(JSON.stringify(mapSessionToClaudeLines(compacted)).includes("Codex compacted the conversation here"));
});

test("full history mode marks the compaction point the way Claude expects", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bound-"));
  const sdir = path.join(dir, "sessions", "2026", "07", "24");
  fs.mkdirSync(sdir, { recursive: true });
  const SID = "55555555-5555-4555-8555-555555555555";
  const msg = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
  const rows = [
    { timestamp: "2026-07-24T00:00:00.000Z", type: "session_meta", payload: { id: SID, cwd: "/p" } },
    { timestamp: "2026-07-24T00:00:01.000Z", type: "response_item", payload: msg("user", "before compaction") },
    { timestamp: "2026-07-24T00:00:02.000Z", type: "compacted", payload: { replacement_history: [msg("user", "kept")] } },
    { timestamp: "2026-07-24T00:00:03.000Z", type: "response_item", payload: msg("user", "after compaction") },
  ];
  fs.writeFileSync(path.join(sdir, `rollout-2026-07-24T00-00-00-${SID}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const full = loadCodexSessions(dir, { useCodexCompaction: false })[0];
  const lines = mapSessionToClaudeLines(full);

  const boundary = lines.findIndex((l) => l.type === "system" && l.subtype === "compact_boundary");
  assert.ok(boundary > 0, "a compact boundary is emitted");
  // Claude keeps only what follows the last boundary
  const after = lines.slice(boundary + 1).map((l) => (l.message.content as any[])[0]?.text);
  assert.deepEqual(after, ["after compaction"]);
  assert.deepEqual(validateTranscript(lines), []);
  // the chain stays linked across the marker
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].parentUuid, lines[i - 1].uuid);
});
