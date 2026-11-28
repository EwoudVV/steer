// Tests the server's limits and checks: rate limits, the daily cap, request sizes,
// which events get refused, odd paths and cached pages.
//   node tests/server.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18973;
const STEER = `http://127.0.0.1:${PORT}`;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

// Close to midnight UTC the daily count could reset halfway through, so wait it out.
const toMidnight = 86_400_000 - (Date.now() % 86_400_000);
if (toMidnight < 120_000) await sleep(toMidnight + 1000);

const data = mkdtempSync(join(tmpdir(), "steer-server-"));
mkdirSync(join(data, "events"));
const users = {
  big: { keyHashes: [sha256("big-key")], created: "2026-11-01T00:00:00Z" },
  capped: { keyHashes: [sha256("capped-key")], created: "2026-11-01T00:00:00Z" },
};
writeFileSync(join(data, "users.json"), JSON.stringify(users));

// big: 1,200 sessions of 100 events in 3 projects, so its pages take a while to work out.
const lines = [];
const start = Date.parse("2026-10-01T00:00:00Z");
for (let s = 0; s < 1200; s++) {
  let t = start + s * 3_600_000;
  for (let i = 0; i < 100; i++) {
    t += 20_000;
    const kind = i % 5 === 0 ? "prompt" : i % 5 === 4 ? "stop" : "tool";
    const e = { id: `e${s}-${i}`, session: `s${s}`, project: `p${s % 3}`, via: "claude-code", kind, t: iso(t), got: iso(t), late: false };
    if (kind === "prompt") Object.assign(e, { words: 30, chars: 160, images: 0, specific: 2, observation: false, generic: false, repeat: false });
    if (kind === "tool") e.tool = "Edit";
    lines.push(JSON.stringify(e));
  }
}
writeFileSync(join(data, "events", "big.jsonl"), lines.join("\n") + "\n");

// capped: already sent 19,900 events today.
const now = iso(Date.now());
const today = Array.from({ length: 19_900 }, (_, i) =>
  JSON.stringify({ id: `c${i}`, session: "s", project: "x", via: "claude-code", kind: "stop", t: now, got: now, late: true }),
);
writeFileSync(join(data, "events", "capped.jsonl"), today.join("\n") + "\n");

// A fake GitHub for the commit lookups on review pages: knows the commits in `github`.
const github = new Map(); // hash -> committer date
const fakeGithub = createServer((req, res) => {
  const m = /^\/repos\/a\/b\/commits\/([0-9a-f]+)$/.exec(req.url);
  const date = m && github.get(m[1]);
  if (!date) return res.writeHead(404).end("{}");
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sha: m[1], author: { login: "rev-gh" }, commit: { committer: { date } } }));
});
await new Promise((ok) => fakeGithub.listen(PORT + 1, "127.0.0.1", ok));

const server = spawn("node", ["server/server.mjs"], {
  env: { ...process.env, PORT: String(PORT), STEER_DATA: data, PUBLIC_URL: STEER, GITHUB_API: `http://127.0.0.1:${PORT + 1}` },
  stdio: ["ignore", "ignore", "inherit"],
});
for (let i = 0; i < 50; i++) {
  try {
    await fetch(STEER + "/");
    break;
  } catch {
    await sleep(100);
  }
}

// Every request comes from 127.0.0.1, so X-Forwarded-For is believed, like behind the proxy.
const signup = async (name, ip = "10.0.0.1") => {
  const res = await fetch(STEER + "/api/signup", { method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify({ name }) });
  return { status: res.status, body: await res.json() };
};
const post = async (key, body) => {
  const res = await fetch(STEER + "/api/events", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, retry: res.headers.get("retry-after"), body: await res.json().catch(() => null) };
};
let n = 0;
const ev = (o = {}) => ({ id: `id-${n++}`, session: "sess", project: "game", via: "claude-code", kind: "tool", tool: "Edit", t: iso(Date.now()), ...o });
const prompt = (o = {}) =>
  ev({ kind: "prompt", tool: undefined, words: 12, chars: 60, images: 0, specific: 1, observation: false, generic: false, repeat: false, ...o });
/**
 * Posts 1.2 MB. With `declared` the size is in Content-Length and nothing more is sent
 * until the server answers; without it the body streams until the server hangs up.
 * Returns the status, or the error code if the connection was cut.
 */
const bigPost = (key, declared) =>
  new Promise((done) => {
    const headers = { authorization: `Bearer ${key}`, ...(declared ? { "content-length": "1200000" } : {}) };
    const req = request(`${STEER}/api/events`, { method: "POST", headers }, (res) => {
      res.resume();
      req.destroy();
      done(res.statusCode);
    });
    req.on("error", (err) => done(err.code));
    if (declared) req.flushHeaders();
    else for (let i = 0; i < 12; i++) req.write("x".repeat(100_000));
  });
const get = async (path) => {
  const a = Date.now();
  const res = await fetch(STEER + path);
  const text = await res.text();
  return { status: res.status, text, ms: Date.now() - a };
};

try {
  const alice = (await signup("alice")).body.key;
  assert.ok(alice);

  // 1. Request size and batch size.
  assert.equal(await bigPost(alice, true), 413, "a body that says it's over 1 MB is refused before it's sent");
  assert.ok(["413", "EPIPE", "ECONNRESET"].includes(String(await bigPost(alice, false))), "one that turns out over 1 MB gets cut off");
  assert.equal((await post(alice, { events: Array.from({ length: 501 }, () => ev()) })).status, 413, "more than 500 events at once is refused");
  assert.equal((await post(alice, { nope: 1 })).status, 400);
  const full = await post(alice, { events: Array.from({ length: 500 }, () => ev()) });
  assert.equal(full.status, 200);
  assert.equal(full.body.accepted, 500, "500 at once is fine, that's what the client sends");

  // 2. Which events get refused.
  const long = "x".repeat(300);
  const bad = [
    prompt({ words: "5" }),
    prompt({ chars: -1 }),
    prompt({ images: 1000 }),
    prompt({ words: 1.5 }),
    prompt({ words: 50, chars: 10 }),
    prompt({ specific: 40, words: 10 }),
    prompt({ observation: "yes" }),
    ev({ id: 123 }),
    ev({ id: long }),
    ev({ session: long }),
    ev({ project: long }),
    ev({ tool: long }),
    ev({ session: ["s"] }),
    ev({ via: "vim" }),
    ev({ via: "" }),
    ev({ kind: "hack" }),
    ev({ kind: "interrupt", via: "cursor" }),
    ev({ kind: "interrupt", via: "opencode" }),
    // Check-ins only come from steer, with one of the known answers.
    ev({ kind: "checkin", via: "claude-code", answer: "project" }),
    ev({ kind: "checkin", via: "steer", answer: "maybe" }),
    ev({ kind: "checkin", via: "steer", answer: "other", answered_after: -1 }),
    ev({ kind: "stop", via: "steer" }),
    // Evidence: only from steer, and only the safe fields.
    ev({ kind: "run", via: "claude-code", name: "npm" }),
    ev({ kind: "run", via: "steer", name: "npm test --watch" }),
    ev({ kind: "run", via: "steer", name: "cat", exit: 900 }),
    ev({ kind: "commit", via: "steer", hash: "not-a-hash" }),
    ev({ kind: "save", via: "steer", count: 0 }),
    // Editor stretches: only from steer, from a known editor, at most an hour.
    ev({ kind: "editor", via: "claude-code", app: "vscode", secs: 60 }),
    ev({ kind: "editor", via: "steer", app: "notepad", secs: 60 }),
    ev({ kind: "editor", via: "steer", app: "vscode", secs: 99_999 }),
    ev({ kind: "editor", via: "steer", app: "cursor", secs: 1.5 }),
    // The editor in front: the same rules.
    ev({ kind: "front", via: "copilot", app: "vscode", secs: 60 }),
    ev({ kind: "front", via: "steer", app: "zed", secs: 60 }),
    ev({ kind: "front", via: "steer", app: "cursor", secs: 3601 }),
    ev({ t: "1" }),
    ev({ t: 1763600000000 }),
    ev({ t: undefined }),
    null,
    [],
    "event",
  ];
  const good = [
    ev({ kind: "interrupt", via: "codex" }),
    ev({ kind: "interrupt", via: "copilot" }),
    ev({ t: iso(Date.now() + 20_000) }),
    ev({ t: iso(Date.now() - 10 * 60_000) }),
    prompt({ via: "cursor" }),
    prompt({ words: 0, chars: 0, images: 2, specific: 0, via: "opencode" }),
    // Copilot ids are longer than 64, they're cut like before.
    ev({ id: `cp-${"a".repeat(36)}-${"b".repeat(36)}`, via: "copilot" }),
    // Clients from before Codex support don't send via.
    ev({ via: undefined }),
    // From the future: kept, but late, so a wrong clock shows up instead of vanishing.
    ev({ t: iso(Date.now() + 60_000) }),
    ev({ t: iso(Date.now() + 3_600_000) }),
    // A check-in answer from steer itself.
    ev({ kind: "checkin", via: "steer", answer: "project-ai", answered_after: 4 }),
    // Evidence from the project, also only from steer itself.
    ev({ kind: "run", via: "steer", name: "npm", exit: 1, secs: 12 }),
    ev({ kind: "save", via: "steer", count: 3 }),
    ev({ kind: "commit", via: "steer", hash: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0" }),
    // Claude Code sends an interrupt when the person stops a running tool.
    ev({ kind: "interrupt", via: "claude-code" }),
    ev({ kind: "interrupt", via: undefined }),
    // The check-in buttons since 0.5.5.
    ev({ kind: "checkin", via: "steer", answer: "working", answered_after: 3 }),
    ev({ kind: "checkin", via: "steer", answer: "waiting", answered_after: 2 }),
    prompt({ via: "junie" }),
    // Junie writes down when the person stops it.
    ev({ kind: "interrupt", via: "junie" }),
    // The editor in front with the project open, from the same extension since 0.5.9.
    ev({ kind: "front", via: "steer", app: "cursor", secs: 90, t: iso(Date.now() - 3 * 60_000) }),
    // A stretch of working in the project's files, from the VS Code and Cursor extension.
    // (Earlier than the check-ins above, so it doesn't make them count as measured.)
    ev({ kind: "editor", via: "steer", app: "vscode", secs: 60, t: iso(Date.now() - 4 * 60_000), folder: "/home/someone/game" }),
  ];
  const mixed = await post(alice, { events: [...bad, ...good] });
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.body, { accepted: good.length, late: 3, dropped: bad.length, skew_secs: 0 });
  const stored = readFileSync(join(data, "events", "alice.jsonl"), "utf8").trim().split("\n").slice(500).map((l) => JSON.parse(l));
  assert.equal(stored.length, good.length, "nothing refused got stored");
  assert.equal(stored[6].id, good[6].id.slice(0, 64));
  assert.equal(stored[7].via, "claude-code");
  assert.equal(stored[2].late, false, "20 s ahead is clock drift, it still counts");
  assert.equal(stored[3].late, true, "10 minutes old arrives late");
  assert.equal(stored[8].late, true, "a minute ahead doesn't count");
  assert.equal(stored[9].late, true, "an hour ahead doesn't count");
  const front = stored.at(-2);
  assert.deepEqual([front.kind, front.app, front.secs], ["front", "cursor", 90]);
  const editor = stored.at(-1);
  assert.deepEqual([editor.kind, editor.app, editor.secs], ["editor", "vscode", 60]);
  assert.equal(editor.folder, undefined, "a folder path isn't kept even if something sends one");
  assert.equal((await post(alice, { events: good })).body.accepted, 0, "repeats are skipped");

  // 3. Rate limit per key: 5,000 at once, then 2 a second.
  const bob = (await signup("bob", "10.0.0.2")).body.key;
  for (let i = 0; i < 10; i++) assert.equal((await post(bob, { events: Array.from({ length: 500 }, () => ev()) })).status, 200);
  const limited = await post(bob, { events: Array.from({ length: 500 }, () => ev()) });
  assert.equal(limited.status, 429, "a key that sent 5,000 events in a few seconds has to wait");
  assert.ok(Number(limited.retry) > 0, "and is told how long");
  assert.equal((await post(alice, { events: [ev()] })).status, 200, "other keys aren't slowed down");

  // 4. At most 20,000 events per account per day.
  const capped = await post("capped-key", { events: Array.from({ length: 200 }, () => ev()) });
  assert.equal(capped.status, 429);
  assert.match(capped.body.error, /today/);
  assert.ok(Number(capped.retry) > 0 && Number(capped.retry) <= 86_400);
  assert.equal((await post("capped-key", { events: Array.from({ length: 100 }, () => ev()) })).body.accepted, 100, "up to the cap is fine");
  assert.equal((await post("capped-key", { events: [ev()] })).status, 429, "one more isn't");
  assert.equal((await post("capped-key", { events: [] })).status, 200, "checking the key still works");

  // 5. Per-IP signup limit.
  for (let i = 0; i < 10; i++) assert.equal((await signup(`many-${i}`, "10.0.0.9")).status, 201);
  assert.equal((await signup("many-10", "10.0.0.9")).status, 429);
  assert.equal((await signup("someone", "10.0.0.10")).status, 201, "other addresses can still sign up");

  // 6. Names that are Object properties, and broken % escapes.
  for (const path of ["/u/__proto__", "/u/constructor", "/u/toString", "/u/hasOwnProperty/x", "/u/__proto__/x"]) {
    assert.equal((await get(path)).status, 404, path);
  }
  for (const path of ["/api/u/toString", "/api/u/__proto__", "/api/u/constructor/x"]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(JSON.parse(res.text), { error: "no such user" });
  }
  for (const path of ["/u/%E0%A4%A", "/u/alice/%E0", "/api/u/%zz", "/api/u/alice/%E0", "/u/%"]) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
    assert.ok(!res.text.includes("URIError") && !res.text.includes(" at "), "no stack trace");
  }
  assert.equal((await signup("constructor", "10.0.0.11")).status, 201, "constructor is a normal name");
  assert.equal((await get("/u/constructor")).status, 200);

  // 7. Pages are cached, and working one out doesn't hold up events.
  const first = get("/u/big");
  await sleep(20);
  const a = Date.now();
  assert.equal((await post(alice, { events: [ev()] })).status, 200);
  const during = Date.now() - a;
  const cold = await first;
  assert.equal(cold.status, 200);
  assert.ok(during < 500, `events still go in while a big page is worked out (${during} ms)`);
  const warm = await get("/u/big");
  assert.equal(warm.text, cold.text);
  assert.ok(warm.ms < 150 && warm.ms < cold.ms / 2, `second view is cached (${cold.ms} ms, then ${warm.ms} ms)`);
  const api = await get("/api/u/big");
  assert.ok(api.ms < 150, `the api uses the same cache (${api.ms} ms)`);
  assert.equal(JSON.parse(api.text).projects.reduce((n, p) => n + p.sessions, 0), 1200);
  const views = await Promise.all(Array.from({ length: 10 }, () => get("/u/big")));
  assert.ok(views.every((v) => v.status === 200 && v.ms < 500), "10 views at once are fine");

  // 8. A project page draws only the newest sessions.
  const project = await get("/u/big/p0");
  assert.equal(project.status, 200);
  assert.match(project.text, /Showing the newest 100 of 400 sessions/);
  assert.equal(project.text.match(/<details>/g).length, 100);
  assert.equal((await get("/u/big/nope")).status, 404);

  // 9. Review pages: steer submit freezes a project's hours into a page of its own.
  {
    const key = (await signup("rev", "10.0.0.20")).body.key;
    const at = (secs) => iso(Date.now() - secs * 1000);
    const hash = "0123456789abcdef0123456789abcdef01234567";
    const moved = "1111111111111111111111111111111111111111"; // on GitHub, but made long before
    const madeUp = "2222222222222222222222222222222222222222"; // not on GitHub at all
    github.set(hash, at(115));
    github.set(moved, iso(Date.now() - 5 * 86_400_000));
    const sent = await post(key, {
      events: [
        prompt({ project: "game2", t: at(240), words: 40, chars: 200, specific: 3 }),
        ev({ project: "game2", t: at(230) }),
        ev({ project: "game2", kind: "stop", tool: undefined, t: at(200) }),
        { id: `id-${n++}`, session: "evidence", project: "game2", via: "steer", kind: "save", count: 2, t: at(150) },
        { id: `id-${n++}`, session: "evidence", project: "game2", via: "steer", kind: "commit", hash, t: at(120) },
        { id: `id-${n++}`, session: "evidence", project: "game2", via: "steer", kind: "commit", hash: moved, t: at(110) },
        { id: `id-${n++}`, session: "evidence", project: "game2", via: "steer", kind: "commit", hash: madeUp, t: at(100) },
        prompt({ project: "game2", t: at(60), observation: true }),
        ev({ project: "game2", kind: "stop", tool: undefined, t: at(30) }),
      ],
    });
    assert.equal(sent.body.accepted, 9);
    const submit = async (body, k = key) => {
      const res = await fetch(STEER + "/api/submit", { method: "POST", headers: k ? { authorization: `Bearer ${k}` } : {}, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await submit({ project: "game2" }, null)).status, 401);
    assert.equal((await submit({ project: "game2" }, "wrong")).status, 401);
    assert.equal((await submit({ project: "game2", from: "21 nov" })).status, 400);
    assert.equal((await submit({ project: "game2", from: "2026-11-21", to: "2026-11-01" })).status, 400);
    assert.equal((await submit({ project: "game2", repo: "https://evil.example/a/b" })).status, 400);
    assert.equal((await submit({ project: "nope" })).status, 404);
    const tomorrow = iso(Date.now() + 86_400_000).slice(0, 10);
    assert.equal((await submit({ project: "game2", from: tomorrow })).status, 404, "nothing in those days");

    const made = await submit({ project: "game2", repo: "https://github.com/a/b" });
    assert.equal(made.status, 201);
    assert.match(made.body.url, new RegExp(`^${STEER}/r/[A-Za-z0-9_-]{12}$`));
    assert.equal(made.body.line, `${made.body.hours}h tracked with steer, review: ${made.body.url}`);
    const path = new URL(made.body.url).pathname;
    const view = await get(path);
    assert.equal(view.status, 200);
    for (const part of [
      "Review:",
      "For Unified",
      "Justification",
      "By day",
      "Sessions",
      `https://github.com/a/b/commit/${hash}`,
      "steer saw 3 commits, 1 code change made by hand",
      "1 of the 3 commits looked up on GitHub is there with the time steer saw, 1 has a different time, 1 isn't on GitHub",
      "yes, same time (by @rev-gh)",
      "On GitHub they were made by @rev-gh.",
      "yes, but made",
      "not found",
      `/api/r/`,
    ]) {
      assert.ok(view.text.includes(part), `the review page has ${part}`);
    }
    assert.ok(!view.text.includes("<form"), "no review form unless a reviewer is signed in");
    const info = JSON.parse((await get(`/api${path}`)).text);
    assert.equal(info.user, "rev");
    assert.equal(info.project, "game2");
    assert.equal(info.hours, made.body.hours);
    assert.equal(info.html, undefined, "the api leaves out the page itself");
    assert.equal(info.commit_checks[madeUp].status, "missing");
    assert.equal(info.reviewed_hours, null);
    assert.deepEqual(info.decisions, []);

    // The events behind the page, and all of an account's events.
    const raw = (await get(`/api${path}/events`)).text.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(raw.length, 9, "every event of the project up to when the page was made");
    assert.ok(raw.every((e) => e.project === "game2" && e.got));
    const all = (await get("/api/u/rev/events?project=game2")).text.trim().split("\n");
    assert.equal(all.length, 9);
    assert.equal((await get("/api/u/nobody/events")).status, 404);
    assert.equal((await get("/api/slack/nope")).status, 400);
    assert.deepEqual(JSON.parse((await get("/api/slack/U0NOBODY1")).text).accounts, []);

    // Deciding needs a reviewer session.
    const res = await fetch(STEER + `${path}/decide`, { method: "POST", body: "action=approve" });
    assert.equal(res.status, 403);

    // A computer whose clock is 10 minutes slow: with sent_at, its events still count,
    // moved to the server's time. Without it they arrive "late" like before.
    const slow = (secs) => iso(Date.now() - 600_000 - secs * 1000);
    const fixed = await fetch(STEER + "/api/events", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({ sent_at: slow(0), events: [prompt({ project: "clock", t: slow(30) }), prompt({ project: "clock", t: slow(20 * 60) })] }),
    }).then((r) => r.json());
    assert.equal(fixed.accepted, 2);
    assert.equal(fixed.late, 1, "the one from 20 minutes before the send is still late");
    assert.ok(fixed.skew_secs >= 599 && fixed.skew_secs <= 602, `skew ${fixed.skew_secs}`);
    const old = await post(key, { events: [prompt({ project: "clock", t: slow(30) })] });
    assert.equal(old.body.late, 1, "without sent_at a slow clock's events are late");
    const stored = (await get("/api/u/rev/events?project=clock")).text.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(stored[0].shifted, Math.round(fixed.skew_secs));
    assert.ok(Math.abs(Date.parse(stored[0].t) - (Date.now() - 30_000)) < 10_000, "moved to about 30 s ago");

    // README badges: always an image, the person's own time.
    for (const [path, want] of [
      ["/badge/rev/game2.svg", /steered with ai: \d+[hms]/],
      ["/badge/rev.svg", /steered with ai: \d+[hms]/],
      ["/badge/rev/nope.svg", /steered with ai: not found/],
      ["/badge/nobody.svg", /steered with ai: not found/],
      ["/badge/%E0.svg", /steered with ai: not found/],
    ]) {
      const res = await fetch(STEER + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type"), /^image\/svg\+xml/);
      assert.match(await res.text(), want, path);
    }
    const profile = await get("/u/rev");
    assert.match(profile.text, /<h2>Last 7 days<\/h2>\n<p>\d+[hms][^<]* of your own time in the last 7 days\.<\/p>/, "the profile starts with the last 7 days");
    assert.ok(profile.text.indexOf("Last 7 days") < profile.text.indexOf("<h2>Totals</h2>"));
    const projectPage = await get("/u/rev/game2");
    assert.ok(projectPage.text.includes(`[![steered with ai](${STEER}/badge/rev/game2.svg)](${STEER}/u/rev/game2)`), "the project page has the line for a README");

    // More work afterwards doesn't change a page that was already submitted.
    await post(key, { events: [prompt({ project: "game2", t: iso(Date.now()) })] });
    assert.equal((await get(path)).text, view.text, "frozen");
    assert.equal((await get("/r/short")).status, 404);
    assert.equal((await get("/r/../users.json")).status, 404);
  }

  // One project whatever its folder is called on each computer.
  {
    const key = (await signup("vaulter", "10.0.0.32")).body.key;
    const at = (mins) => iso(Date.now() - mins * 60_000);
    const sent = await post(key, {
      events: [
        prompt({ session: "hand", project: "Vault Books", t: at(10) }),
        ev({ session: "hand", project: "Vault Books", t: at(9.5) }),
        ev({ kind: "stop", tool: undefined, session: "hand", project: "Vault Books", t: at(9) }),
        prompt({ session: "clone", project: "vault-books", t: at(4) }),
        ev({ session: "clone", project: "vault-books", via: "codex", t: at(3.5) }),
        ev({ kind: "stop", tool: undefined, session: "clone", project: "vault-books", via: "codex", t: at(3) }),
      ],
    });
    assert.equal(sent.body.accepted, 6);
    const hours = JSON.parse((await get("/api/u/vaulter")).text);
    assert.deepEqual(hours.projects.map((p) => p.name), ["vault-books"], "one project, named the way it was used last");
    const old = await fetch(`${STEER}/u/vaulter/${encodeURIComponent("Vault Books")}`, { redirect: "manual" });
    assert.equal(old.status, 302, "the other spelling goes to the one page");
    assert.equal(old.headers.get("location"), "/u/vaulter/vault-books");
    const page = await get("/u/vaulter/vault-books");
    assert.equal(page.status, 200);
    assert.match(page.text, /Tracked from claude-code, codex/, "tools from both folders");
    assert.doesNotMatch((await get(`/badge/vaulter/${encodeURIComponent("Vault Books")}.svg`)).text, /not found/, "old badge links keep working");
    const exported = (await get(`/api/u/vaulter/events?project=${encodeURIComponent("vault-books")}`)).text.trim().split("\n");
    assert.equal(exported.length, 6, "a project's events include both spellings");
  }

  // Signs of attention: kept and checked, not counted yet.
  {
    const key = (await signup("watcher", "10.0.0.31")).body.key;
    const fromSteer = (kind, o = {}) => ({ id: `id-${n++}`, session: "presence", project: "presence", via: "steer", kind, t: iso(Date.now()), ...o });
    const chat = (kind, o = {}) => ev({ kind, tool: undefined, via: "chatgpt", session: "chat1", ...o });
    const good = [
      ev({ kind: "wait", tool: undefined, reason: "permission" }),
      ev({ kind: "wait", tool: undefined, via: "junie", reason: "question" }),
      ev({ tool: "Bash", ms: 1234 }),
      ev({ kind: "interrupt", tool: undefined }),
      prompt({ mode: "acceptEdits" }),
      prompt({ via: "codex", mode: "on-request" }),
      chat("focus", { on: true }),
      chat("focus", { on: false }),
      chat("copy"),
      chat("typing"),
      fromSteer("away"),
      fromSteer("back", { away_secs: 910 }),
      fromSteer("here"),
    ];
    const bad = [
      ev({ kind: "wait", tool: undefined, reason: "Claude needs your permission to use Bash" }), // never the message
      ev({ kind: "wait", tool: undefined, via: "chatgpt", reason: "permission" }),
      ev({ tool: "Bash", ms: -5 }),
      prompt({ mode: "yolo" }),
      chat("focus", { on: "yes" }),
      chat("copy", { via: "claude-code" }), // only from the browser extension
      fromSteer("back", { away_secs: 30 * 86400 }),
      { ...fromSteer("here"), via: "claude-code" }, // only from steer itself
    ];
    const r = await post(key, { events: [...good, ...bad] });
    assert.equal(r.body.accepted, good.length);
    assert.equal(r.body.dropped, bad.length);
    const stored = (await get("/api/u/watcher/events")).text;
    for (const part of ['"reason":"permission"', '"reason":"question"', '"ms":1234', '"mode":"acceptEdits"', '"mode":"on-request"', '"on":true', '"away_secs":910', '"kind":"here"']) {
      assert.ok(stored.includes(part), `kept ${part}`);
    }
    assert.ok(!(await get("/u/watcher")).text.includes(">presence<"), "they don't make a project or count as time");
  }

  // The accuracy page adds up everyone's check-in answers, without names.
  {
    const key = (await signup("checker", "10.0.0.30")).body.key;
    const at = (mins) => iso(Date.now() - mins * 60_000);
    const answer = (a, mins) => ({ id: `id-${n++}`, session: "checkin", project: "checkin", via: "steer", kind: "checkin", answer: a, t: at(mins) });
    const sent = await post(key, {
      events: [
        prompt({ session: "c1", project: "acc", t: at(4) }),
        ev({ session: "c1", project: "acc", t: at(3.5) }),
        // The idle timer reporting someone at the computer, so the new signals count.
        { id: `id-${n++}`, session: "presence", project: "presence", via: "steer", kind: "here", t: at(3.2) },
        answer("project-ai", 3),
        prompt({ session: "c1", project: "acc", t: at(2) }),
        answer("other", 1),
      ],
    });
    assert.equal(sent.body.accepted, 6);
    const acc = await get("/accuracy");
    assert.equal(acc.status, 200);
    // Another account above sent a check-in too.
    const [, answers, people] = acc.text.match(/(\d+) answers from (\d+) (?:person|people)/);
    assert.ok(Number(answers) >= 2 && Number(people) >= 1);
    assert.match(acc.text, /1 doing something else/);
    assert.match(acc.text, /With the new signals/);
    assert.match(acc.text, /2 answers from 1 person<\/b> while they were being measured/, "only the answers with the idle timer reporting");
    assert.match(acc.text, /steer with the new signals/);
    assert.match(acc.text, /2 minute timeout \(Hackatime\)/);
    assert.ok(!acc.text.includes("checker"), "no names on it");
    assert.ok(existsSync(join(data, "checkin-accounts.json")), "the accounts with answers are remembered");
  }

  console.log(`server tests passed (big page ${cold.ms} ms, then ${warm.ms} ms cached)`);
} finally {
  fakeGithub.close();
  server.kill();
  rmSync(data, { recursive: true, force: true });
}
