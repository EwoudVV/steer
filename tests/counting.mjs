// Replays the ways people tried to get time they didn't earn (from the red team on
// 2026-11-20) against the counting code the server and the website use, and checks an
// honest session still counts normally:
//   node tests/counting.mjs

import assert from "node:assert/strict";
import { SessionReader, analyzePrompt, applyCaps, buildReport, checks, gapCredit, projectHuman, projectOverlap, rulesFrom } from "../web/steer.js";

const T0 = Date.UTC(2026, 10, 20, 15, 0, 0);
const sec = (s) => T0 + s * 1000;
let ids = 0;
const prompt = (s, chars, extra = {}) => ({
  id: `e${ids++}`,
  t: sec(s),
  kind: "prompt",
  prompt: { words: Math.round(chars / 5), chars, images: 0, specific: 2, observation: false, generic: false, repeat: false, ...extra },
});
const agent = (s, tools = ["Edit"]) => ({ id: `e${ids++}`, t: sec(s), kind: "agent", tools });
const session = (name, events, project = "game") => ({ path: `p/${name}.jsonl`, cwd: `/home/x/${project}`, title: null, events });
const total = (sessions) => buildReport(sessions, { days: null, now: sec(10 * 86400) }).reduce((n, p) => n + projectHuman(p), 0);

// 1. 1000 long prompts sent at the same moment used to count 5 min each (83 hours).
{
  const events = [];
  for (let i = 0; i < 1000; i++) events.push(prompt(0, 1300));
  assert.ok(total([session("burst", events)]) <= 120, "a burst of prompts can't count more than the time that passed");
}

// 2. The same burst spread over 1000 separate sessions.
{
  const sessions = [];
  for (let i = 0; i < 1000; i++) sessions.push(session(`fan${i}`, [prompt(0, 1300), agent(5)]));
  assert.ok(total(sessions) <= 120, "1000 sessions at once count the same minutes once");
}

// 3. Pasting a long prompt every second for 30 s used to count 5 min each.
{
  const events = [prompt(0, 1300), agent(1)];
  for (let s = 2; s <= 30; s += 2) events.push(prompt(s, 1300), agent(s + 1));
  assert.ok(total([session("paste", events)]) <= 31 + 120, "pasting fast counts no more than the real time");
}

// 4. Prompts only, no agent ever answering, one every 10 min for a day.
{
  const events = [];
  for (let s = 0; s < 86400; s += 600) events.push(prompt(s, 1300));
  assert.ok(total([session("lazy", events)]) <= 144 * 120, "unanswered prompts only count typing time");
}

// 5. The same honest work in 4 parallel sessions counts once.
const honest = () => {
  const events = [];
  for (let k = 0; k < 6; k++) {
    const s = k * 840;
    events.push(prompt(s, 300));
    for (let a = 10; a <= 300; a += 30) events.push(agent(s + a));
  }
  return events;
};
{
  const one = total([session("solo", honest())]);
  const four = buildReport(["a", "b", "c", "d"].map((n) => session(n, honest(), `proj-${n}`)), { days: null, now: sec(10 * 86400) });
  assert.equal(four.reduce((n, p) => n + projectHuman(p), 0), one, "parallel sessions count once");
  assert.ok(four.reduce((n, p) => n + projectOverlap(p), 0) >= 3 * one - 10, "the rest shows up as overlap");
}

// 6. Dark flow: a run of short "continue"s keeps at most 30s each.
{
  const events = [];
  for (let k = 0; k < 6; k++) {
    events.push(prompt(k * 60, 1300, { generic: true, specific: 0 }));
    events.push(agent(k * 60 + 30));
  }
  const p = buildReport([session("loop", events)], { days: null, now: sec(10 * 86400) })[0];
  for (const t of p.sessions[0].turns.slice(1)) assert.ok(t.human <= 30, `dark flow kept ${t.human}s`);
}

// 7. An honest session still counts what it should: 6 prompts 14 min apart, the agent
// works about 5 min after each and you read and test for the 560 s after that.
{
  const r = total([session("normal", honest())]);
  // first prompt: 75 s of typing, then 5 gaps of 560 s after the agent stops, each
  // counted by rule v1's curve (the first minute in full, then less and less)
  assert.equal(r, 75 + 5 * gapCredit(560, 60), `honest session counted ${r}s`);
}

// 8. Checks a reviewer sees. A script that runs for 2 days with a real looking rhythm
// (prompt, agent works 1 to 2 min, 2 to 9 min of "review") gets flagged.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const reportOf = (sessions) => buildReport(sessions, { days: null, now: sec(10 * 86400) });
{
  const events = [];
  for (let s = 0; s < 2 * 86400; ) {
    events.push(prompt(s, 200 + Math.round(rand() * 400)));
    const work = 60 + Math.round(rand() * 60);
    for (let a = 10; a < work; a += 20) events.push(agent(s + a));
    events.push(agent(s + work));
    s += work + 120 + Math.round(rand() * 420);
  }
  const notes = checks(reportOf([session("script", events)])).flatMap((d) => d.notes).join(" | ");
  assert.match(notes, /counted in one day/);
  assert.match(notes, /no break longer than/);
}
// An auto-prompter answering a few seconds after every stop.
{
  const events = [];
  for (let k = 0, s = 0; k < 40; k++) {
    events.push(prompt(s, 400));
    const work = 120 + Math.round(rand() * 180);
    for (let a = 15; a < work; a += 30) events.push(agent(s + a));
    events.push(agent(s + work));
    s += work + 3 + Math.round(rand() * 10);
  }
  const notes = checks(reportOf([session("bot", events)])).flatMap((d) => d.notes).join(" | ");
  assert.match(notes, /replies usually came \d+s after the agent stopped/);
}
// 9. Payable caps: a script running for a week keeps at most 12h a UTC day and 60h a UTC
// week, while the checks still point out what it tried to claim.
{
  const events = [];
  for (let s = 0; s < 7 * 86400; ) {
    events.push(prompt(s, 400));
    events.push(agent(s + 60));
    s += 60 + 200 + Math.round(rand() * 120);
  }
  const report = reportOf([session("week", events)]);
  const before = report.reduce((n, p) => n + projectHuman(p), 0);
  applyCaps(report, rulesFrom());
  assert.ok(report.some((p) => p.sessions.some((x) => x.turns.some((t) => t.capped > 0))), "the caps cut something");
  const turns = report.flatMap((p) => p.sessions.flatMap((s) => s.turns));
  const perDay = new Map();
  for (const t of turns) perDay.set(new Date(t.t).toISOString().slice(0, 10), (perDay.get(new Date(t.t).toISOString().slice(0, 10)) ?? 0) + t.human);
  for (const [day, secs] of perDay) assert.ok(secs <= 12 * 3600, `${day} kept ${secs}s`);
  const monday = (t) => {
    const d = new Date(t);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const perWeek = new Map();
  for (const t of turns) perWeek.set(monday(t.t), (perWeek.get(monday(t.t)) ?? 0) + t.human);
  for (const [week, secs] of perWeek) assert.ok(secs <= 60 * 3600, `week of ${week} kept ${secs}s`);
  const after = report.reduce((n, p) => n + projectHuman(p), 0);
  assert.equal(after + turns.reduce((n, t) => n + t.capped, 0), before, "what's cut shows up as capped");
  assert.match(checks(report).flatMap((d) => d.notes).join(" | "), /counted in one day/);
  // A program running a hackathon can raise them.
  const loose = reportOf([session("week", events)]);
  applyCaps(loose, rulesFrom({ dailyCapHours: 24, weeklyCapHours: 168 }));
  assert.equal(loose.reduce((n, p) => n + projectHuman(p), 0), before);
}
// The honest session from 7 has nothing to look at.
assert.deepEqual(checks(reportOf([session("normal", honest())])), []);

// 10. A bare "ok" right after a long agent run is an approval: no watching time.
{
  const events = [prompt(0, 300)];
  for (let a = 60; a <= 1200; a += 60) events.push(agent(a));
  events.push(prompt(1220, 2, { generic: true, specific: 0 }));
  const okTurn = reportOf([session("ok", events)])[0].sessions[0].turns[1];
  assert.ok(okTurn.human <= 25, `a bare ok got ${okTurn.human}s`);
}

// 11. Pasted text (marked by Claude Code's hook) isn't typing.
{
  const trace = "Traceback src/main.py line 4 src/db.py line 9 ".repeat(30);
  const p = analyzePrompt(`why does this crash <pasted_content id="1">${trace}</pasted_content>`, 0);
  assert.equal(p.words, 4);
  assert.ok(p.specific <= p.words + 2);
  assert.equal(analyzePrompt("fix the jump", 0).words, 3);
}

// 12. Evidence from the project. The same honest session, but in each gap you ran tests
// and saved files every couple of minutes: now nearly all of it counts. Evidence with no
// AI session nearby still counts the time between its pieces.
{
  const evidence = [];
  for (let k = 0; k < 5; k++) {
    const stop = k * 840 + 280;
    for (let a = 120; a < 560; a += 120) {
      evidence.push({ id: `ev${k}-${a}`, t: sec(stop + a), kind: a % 240 ? "save" : "run", name: "npm", exit: 0 });
    }
  }
  const withEvidence = total([session("normal", honest()), { path: "evidence:game", cwd: "/home/x/game", title: null, evidence: true, events: evidence }]);
  const without = total([session("normal", honest())]);
  assert.ok(withEvidence > without + 5 * 120, `evidence added only ${withEvidence - without}s`);
  // 20 gaps of 840 s each, so nothing in between: 2 h 20 min of wall time.
  assert.ok(withEvidence <= 75 + 5 * 840, "never more than the real time");

  // Saves alone, 3 minutes apart for an hour, with no AI tool used nearby: that's
  // coding without AI, Hackatime's job, so it shows up but doesn't count.
  const saves = [];
  for (let m = 0; m <= 60; m += 3) saves.push({ id: `s${m}`, t: sec(10 * 86400 - 7200 + m * 60), kind: "save" });
  const alone = total([{ path: "evidence:other", cwd: "/home/x/other", title: null, evidence: true, events: saves }]);
  assert.equal(alone, 0, `saves with no ai use nearby counted ${alone}s`);
}

// 13. Red team, 2026-11-22: tricks with evidence and interrupts.
{
  // One prompt, then saves every 5 minutes all day. Saves only join the AI session
  // within 30 minutes of something from the AI tool, measured from that, not from the
  // last save, so the chain can't keep itself going.
  const events = [prompt(0, 300), agent(30), agent(60)];
  const saves = [];
  for (let m = 5; m <= 12 * 60; m += 5) saves.push({ id: `c${m}`, t: sec(m * 60), kind: "save" });
  const got = total([session("one", events), { path: "evidence:game", cwd: "/home/x/game", title: null, evidence: true, events: saves }]);
  assert.ok(got <= 35 * 60, `one prompt and a day of saves counted ${got}s`);

  // Interrupts every 5 minutes with no agent working: a moment each, not 5 minutes.
  const stops = [prompt(0, 300), agent(30)];
  for (let m = 5; m <= 12 * 60; m += 5) stops.push({ id: `i${m}`, t: sec(m * 60), kind: "interrupt" });
  const stopped = total([session("stops", stops)]);
  assert.ok(stopped <= 20 * 60, `a day of interrupts with no agent running counted ${stopped}s`);

  // A whole day that's mostly saves next to a few prompts gets pointed out.
  const day = [];
  const ev = [];
  for (let h = 0; h < 10; h++) {
    day.push(prompt(h * 3600, 300), agent(h * 3600 + 30), agent(h * 3600 + 60));
    for (let m = 2; m < 30; m += 2) ev.push({ id: `d${h}-${m}`, t: sec(h * 3600 + m * 60), kind: "save" });
  }
  const report = reportOf([session("mostly", day), { path: "evidence:game", cwd: "/home/x/game", title: null, evidence: true, events: ev }]);
  assert.match(checks(report).flatMap((d) => d.notes).join(" | "), /came from code changes and commands/);

  // 15 hours straight across midnight UTC: each day alone is under 12h, but the 24
  // hours around it are pointed out.
  const long = [];
  const start = Date.UTC(2026, 10, 20, 17, 0, 0);
  for (let s = 0; s < 15 * 3600; s += 150) {
    long.push({ id: `l${s}`, t: start + s * 1000, kind: "prompt", prompt: { words: 40, chars: 200, images: 0, specific: 2, observation: true, generic: false, repeat: false } });
    long.push({ id: `la${s}`, t: start + (s + 30) * 1000, kind: "agent", tools: ["Edit"] });
  }
  const night = buildReport([session("night", long)], { days: null, now: start + 30 * 86400000 });
  const nightNotes = checks(night).flatMap((d) => d.notes).join(" | ");
  assert.match(nightNotes, /counted in 24 hours/);
  assert.doesNotMatch(nightNotes, /counted in one day/, "each day alone is under 12h");
}

// 14. Agents in T3 Code that prompt each other (a task one hands another, a message to
// another thread, a scheduled task) show up in Claude Code's log as "sdk", the same as
// the person typing in T3 or in any other app on the Agent SDK. Only T3's database can
// tell them apart, so from the log alone T3's "sdk" turns don't count.
{
  const line = (uuid, extra) =>
    JSON.stringify({ type: "user", uuid, timestamp: "2026-11-22T20:00:00.000Z", promptSource: "sdk", turnOrigin: "sdk", message: { role: "user", content: "add a pause menu to main.rs" }, ...extra });
  const prompts = (...entrypoints) => {
    const reader = new SessionReader("p/t3.jsonl");
    entrypoints.forEach((entrypoint, i) => reader.line(line(`p${i}`, { entrypoint })));
    return (reader.finish()?.events ?? []).filter((e) => e.kind === "prompt").length;
  };
  assert.equal(prompts("sdk-ts", "sdk-ts"), 2, "other apps on the sdk count like before");
  // `claude -p` is how scripts and agents run Claude Code (T3 names its threads with it).
  assert.equal(prompts("sdk-cli"), 0);
  assert.equal(prompts("t3-code"), 0);
  // Before November 2026 T3's lines said "sdk-ts". One "t3-code" line makes it T3's,
  // and so does T3's own tools showing up in the log.
  assert.equal(prompts("sdk-ts", "t3-code"), 0);
  const tools = new SessionReader("p/old-t3.jsonl");
  tools.line(line("q0", { entrypoint: "sdk-ts" }));
  tools.line(JSON.stringify({ type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: ["Read", "mcp__t3-code__delegate_task"] } }));
  assert.equal(tools.finish(), null);
  // Tool results and rejections are the agent's turn, not something T3 sent, so they stay.
  const turns = new SessionReader("p/t3-tools.jsonl");
  turns.line(line("r0", { entrypoint: "t3-code" }));
  turns.line(JSON.stringify({ type: "user", uuid: "r1", timestamp: "2026-11-22T20:00:05.000Z", entrypoint: "sdk-ts", turnOrigin: "sdk", toolDenialKind: "user-rejected", message: { role: "user", content: [{ type: "tool_result", content: "no" }] } }));
  assert.deepEqual(turns.finish().events.map((e) => e.kind), ["rejected"]);
}

console.log("counting tests passed");
