import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSessionToClaudeLines } from "../src/map.ts";
import { validateTranscript } from "../src/validate.ts";
import { MISSING_RESULT_TEXT } from "../src/repair.ts";
import type { CodexSession } from "../src/types.ts";

function session(items: CodexSession["items"]): CodexSession {
  return {
    sessionId: "33333333-3333-4333-8333-333333333333",
    rolloutPath: "/x.jsonl", cwd: "/p", cwdOriginal: "/p", meta: {},
    firstTsMs: 1, lastTsMs: 9, items, model: null, messageCount: 1,
    title: "t", source: "cli", isChild: false,
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
