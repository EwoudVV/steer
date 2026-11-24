// Replays the ways people tried to get time they didn't earn (from the red team on
// 2026-11-20) against the counting code the server and the website use, and checks an
// honest session still counts normally:
//   node tests/counting.mjs

import assert from "node:assert/strict";
import { accuracy, analyzePrompt, applyCaps, buildReport, checkinMoments, checks, gapCredit, projectHuman, projectKey, projectOverlap, renderAccuracy, rulesFrom, signalsOf } from "../web/steer.js";

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

// One project whatever its folder is called on each computer.
{
  for (const [name, key] of [
    ["Vault Books", "vault-books"],
    ["vault-books", "vault-books"],
    ["vault_books", "vault-books"],
    ["  VAULT  books ", "vault-books"],
    ["vaultbooks", "vaultbooks"],
    ["ai_tracker", "ai-tracker"],
    ["-x--y_", "-x-y-"],
  ]) {
    assert.equal(projectKey(name), key, name); // the same cases as project_key in src/report.rs
  }
  const handMade = session("a", [prompt(0, 200), agent(30), agent(60)], "Vault Books");
  const cloned = session("b", [prompt(7200, 200), agent(7230), agent(7260)], "vault-books");
  // A file saved in the hand-made folder's spelling, right after the clone's session.
  const saved = { path: "evidence:Vault Books", cwd: "Vault Books", title: null, evidence: true, events: [{ id: "sv1", t: sec(7300), kind: "save", count: 2 }] };
  const projects = buildReport([handMade, cloned, saved], { days: null, now: sec(10 * 86400) });
  assert.equal(projects.length, 1, "one project");
  assert.equal(projects[0].name, "vault-books", "named the way it was used last");
  assert.equal(projects[0].sessions.length, 2, "the save joined a session instead of standing alone");
  assert.ok(projects[0].sessions.some((x) => x.turns.some((t) => t.kind === "save")));
  const apart = buildReport([handMade, session("c", [prompt(7200, 200), agent(7230)], "vaultbooks")], { days: null, now: sec(10 * 86400) });
  assert.equal(apart.length, 2, "a different name is a different project");
}

// The accuracy page: each check-in answer against what each way of counting counted.
{
  // steer counted the 300s before sec(600). Events at 0, 60, 600 and 700s.
  const projects = [{ sessions: [{ turns: [{ t: sec(600), human: 300 }] }] }];
  const sessions = [{ events: [0, 60, 600, 700].map((s) => ({ t: sec(s) })) }];
  const m = checkinMoments(projects, sessions, [
    { t: sec(30), answer: "project-ai" }, // a 1 minute gap: both timeouts count it, steer doesn't
    { t: sec(400), answer: "project" }, // a 9 minute gap: only the 15 minute timeout, and steer
    { t: sec(2000), answer: "none" }, // after the last event, nothing counts it
  ]);
  assert.deepEqual(
    m.map((x) => [x.on, x.steer, x.two, x.fifteen]),
    [
      [true, 0, 1, 1],
      [true, 1, 0, 1],
      [false, 0, 0, 0],
    ],
  );
  assert.equal(m[0].third, 1 / 3, "a flat 1/3 is a third of the 2 minute timeout");
  const a = accuracy([m, []]);
  assert.equal(a.people, 1, "people without answers aren't counted");
  assert.equal(a.answers, 3);
  assert.equal(a.truth, 2 / 3);
  const steer = a.ways.find((w) => w.key === "steer");
  assert.equal(steer.share, 1 / 3);
  assert.equal(steer.whenOn, 1 / 2);
  assert.equal(steer.whenOff, 0);
  assert.equal(steer.offEach, null, "nobody has 10 answers yet");
  const html = renderAccuracy(a);
  assert.match(html, /3 answers from 1 person/);
  assert.match(html, /too few people/);
  // The buttons since 0.5.5: "working" is working, "waiting" on the ai isn't.
  const after = checkinMoments(projects, sessions, [
    { t: sec(400), answer: "working" },
    { t: sec(650), answer: "waiting" }, // the agent's turn after the prompt: the timeouts count it, steer doesn't
  ]);
  assert.deepEqual(
    after.map((x) => [x.on, x.steer, x.two]),
    [
      [true, 1, 0],
      [false, 0, 1],
    ],
  );
  assert.match(renderAccuracy(accuracy([after])), /1 working on their project, 1 waiting on the AI/);
  // Ten answers from one person: their own total gets compared too.
  const ten = Array.from({ length: 10 }, (_, i) => ({ answer: i < 5 ? "project" : "other", on: i < 5, steer: i < 4 ? 1 : 0, third: 0, two: 0, fifteen: 1 }));
  const b = accuracy([ten]);
  assert.equal(b.judged, 1);
  assert.equal(Math.round(b.ways.find((w) => w.key === "steer").offEach * 100), 10, "steer counted 40%, they worked 50%");
  assert.equal(Math.round(b.ways.find((w) => w.key === "fifteen").offEach * 100), 50);
  assert.match(renderAccuracy(accuracy([])), /No answers yet/);
}

// Counting with the attention signals, next to the counting above.
{
  const min = (m) => sec(m * 60);
  // A Claude Code turn: prompt at 0, a tool that needed permission (asked at 1 min,
  // started at 3 min, ran 30 s), the agent done at 4 min, the next prompt at 12 min.
  const code = {
    path: "cc1",
    cwd: "/home/x/game",
    title: null,
    events: [
      { id: "p1", t: min(0), kind: "prompt", prompt: { words: 20, chars: 100, images: 0, specific: 2, observation: false, generic: false, repeat: false } },
      { id: "a1", t: min(3.5), kind: "agent", tools: ["Bash"], ms: 30_000 },
      { id: "s1", t: min(4), kind: "agent", tools: [], stop: true },
      { id: "p2", t: min(12), kind: "prompt", prompt: { words: 20, chars: 100, images: 0, specific: 2, observation: false, generic: false, repeat: false } },
      { id: "s2", t: min(13), kind: "agent", tools: [], stop: true },
    ],
  };
  // A ChatGPT chat: typing from 20 to 21 min, sent at 21, answered by 21.5.
  const chat = {
    path: "chatgpt:c1",
    cwd: "game",
    title: null,
    events: [
      { id: "cp", t: min(21), kind: "prompt", prompt: { words: 8, chars: 40, images: 0, specific: 1, observation: true, generic: false, repeat: false } },
      { id: "cs", t: min(21.5), kind: "agent", tools: [], stop: true },
    ],
  };
  const attention = [
    { t: min(0), kind: "here" },
    { t: min(1), kind: "wait", session: "cc1" },
    { t: min(5), kind: "here" },
    { t: min(6), kind: "away" }, // walked off at 6 ...
    { t: min(9), kind: "back", away_secs: 180 }, // ... back at 9
    { t: min(14), kind: "here" },
    { t: min(19), kind: "here" },
    { t: min(19.5), kind: "focus", session: "chatgpt:c1", on: true },
    { t: min(20), kind: "typing", session: "chatgpt:c1" },
    { t: min(23), kind: "focus", session: "chatgpt:c1", on: false },
  ];
  const sig = signalsOf(attention, [code, chat]);
  assert.deepEqual(sig.away, [[min(6), min(9)]]);
  assert.ok(sig.extra.some(([a, b]) => a === min(1) && b === min(3)), "deciding: from the prompt showing to the tool starting");
  assert.ok(sig.extra.some(([a, b]) => a <= min(19.5) && b >= min(23)), "the chat tab in front");
  assert.ok(sig.chats.has("chatgpt:c1"));
  assert.deepEqual(sig.agentRuns, [[min(0), min(4)], [min(12), min(13)], [min(21), min(21.5)]]);

  const projects = buildReport([code, chat], { days: null, now: sec(10 * 86400) });
  const answers = [
    { t: min(2), answer: "project" }, // deciding on the permission prompt
    { t: min(7), answer: "other" }, // away from the computer
    { t: min(22), answer: "project" }, // reading the chat answer
    { t: min(3.2), answer: "project-ai" }, // watching the agent run the tool
    { t: min(40), answer: "other" }, // nothing measured anymore
  ];
  const m = checkinMoments(projects, [code, chat], answers, sig);
  assert.deepEqual(
    m.map((x) => [x.covered ?? false, x.signals ?? null, x.running ?? null]),
    [
      [true, 1, true],
      [true, 0, false],
      [true, 1, false],
      [true, 0, true],
      [false, null, null],
    ],
  );
  const a = accuracy([m]);
  assert.equal(a.signals.answers, 4, "only answers from while signals were measured");
  const withSignals = a.signals.ways.find((w) => w.key === "signals");
  assert.equal(withSignals.whenOn, 2 / 3);
  assert.equal(withSignals.whenOff, 0);
  assert.deepEqual(a.signals.missedWhileRunning, { of: 1, share: 1 });
  const html = renderAccuracy(a);
  assert.match(html, /With the new signals/);
  assert.match(html, /4 answers from 1 person<\/b> while they were being measured/);
  assert.match(html, /100% were while an agent was working/);
  assert.match(renderAccuracy(accuracy([checkinMoments(projects, [code, chat], answers)])), /No answers yet from while these were being measured/);
}

// Steering from a phone (remote control, T3 Code): nobody touches the computer, but the
// prompts and permission answers still come.
{
  const min = (m) => sec(m * 60);
  const words = { words: 20, chars: 100, images: 0, specific: 2, observation: false, generic: false, repeat: false };
  const code = {
    path: "cc2",
    cwd: "/home/x/game",
    title: null,
    events: [
      { id: "q1", t: min(0), kind: "prompt", prompt: words }, // at the computer
      { id: "r1", t: min(2), kind: "agent", tools: [], stop: true },
      { id: "q2", t: min(10), kind: "prompt", prompt: words }, // from the phone
      { id: "r2", t: min(12.5), kind: "agent", tools: ["Bash"], ms: 30_000 }, // allowed from the phone at 12
      { id: "r3", t: min(14), kind: "agent", tools: [], stop: true },
      { id: "q3", t: sec(30 * 60 + 10), kind: "prompt", prompt: words }, // back at the computer, sent right away
      { id: "r4", t: min(31), kind: "agent", tools: [], stop: true },
    ],
  };
  const attention = [
    { t: min(0), kind: "here" },
    { t: min(2.5), kind: "away" }, // the last touch
    { t: min(11), kind: "wait", session: "cc2" },
    // Noticed at the next check, stamped at the last touch before it: the key that sent q3.
    { t: sec(30 * 60 + 10), kind: "back", away_secs: 30 * 60 + 10 - 150 },
  ];
  const sig = signalsOf(attention, [code]);
  assert.deepEqual(sig.away, [[min(2.5), sec(30 * 60 + 10)]]);
  assert.deepEqual(sig.remote, [[min(11), min(12)]], "allowing the tool from the phone");
  assert.deepEqual(sig.extra, [], "not counted as deciding at the computer");

  const projects = buildReport([code], { days: null, now: sec(10 * 86400) });
  const m = checkinMoments(projects, [code], [
    { t: min(9.5), answer: "working" }, // writing the phone prompt
    { t: min(9.6), answer: "none" }, // the question showed on the computer, nobody saw it
    { t: min(11.5), answer: "working" }, // deciding on the phone
    { t: min(27), answer: "other" }, // really away: q3 was typed at the computer
  ], sig);
  assert.deepEqual(
    m.map((x) => [x.covered ?? false, x.signals ?? null]),
    [
      [true, 1],
      [false, null],
      [true, 1],
      [true, 0],
    ],
  );
  assert.deepEqual(m.map((x) => x.steer), [1, 1, 0, 1], "steer now counts the phone prompt and the time away alike");
  const a = accuracy([m]);
  assert.equal(a.signals.answers, 3, "the check-in nobody could answer is left out");
  assert.equal(a.signals.ways.find((w) => w.key === "signals").whenOn, 1);
  assert.equal(a.signals.ways.find((w) => w.key === "signals").whenOff, 0);
  assert.match(renderAccuracy(a), /from a phone or another computer still count/);
}

// Working in the project's files in VS Code or Cursor (steer's editor extension): time
// around the agent that steer couldn't see before, like fixing its code by hand.
{
  const min = (m) => sec(m * 60);
  const words = { words: 20, chars: 100, images: 0, specific: 2, observation: false, generic: false, repeat: false };
  const code = {
    path: "cc3",
    cwd: "/home/x/game",
    title: null,
    events: [
      { id: "w1", t: min(0), kind: "prompt", prompt: words },
      { id: "w2", t: min(2), kind: "agent", tools: [], stop: true },
      { id: "w3", t: min(40), kind: "prompt", prompt: words },
      { id: "w4", t: min(41), kind: "agent", tools: [], stop: true },
    ],
  };
  const sig = signalsOf([{ t: min(10), kind: "editor", secs: 600 }], [code]);
  assert.ok(sig.extra.some(([a, b]) => a === min(10) && b === min(20)), "fixing the code from 10 to 20 minutes");
  assert.ok(sig.known.some(([a, b]) => a <= min(10) && b >= min(20)), "and someone was at the computer then");
  const projects = buildReport([code], { days: null, now: sec(10 * 86400) });
  const m = checkinMoments(projects, [code], [{ t: min(15), answer: "working" }], sig);
  assert.deepEqual(
    m.map((x) => [x.covered, x.steer, x.signals]),
    [[true, 0, 1]],
    "steer now misses it (the next prompt is too far off), the new counting has it",
  );
}

console.log("counting tests passed");
