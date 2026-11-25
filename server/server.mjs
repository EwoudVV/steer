// steer server: takes events from the steer client while people work, stores them,
// and shows live profile and project pages. Uses the same counting code as the
// website (web/steer.js). No dependencies, just Node.
//
//   PORT=8790 STEER_DATA=./data node server/server.mjs
//
// Pages are worked out in a worker thread (this same file), so a big account can't
// hold up the events everyone else is sending.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import {
  accuracy,
  applyCaps,
  buildReport,
  checkinMoments,
  checks,
  fmtDur,
  hoursOf,
  projectAgent,
  projectBetween,
  projectHuman,
  projectKey,
  renderAccuracy,
  renderReport,
  renderReview,
  renderWeekly,
  signalsOf,
  signalTotals,
  reviewFacts,
  rulesFrom,
  weekly,
} from "../web/steer.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8790);
// Payable caps and check thresholds, e.g. STEER_RULES='{"dailyCapHours":16}' for an event
// that runs longer days. Anything left out keeps its default (DEFAULT_RULES in steer.js).
const RULES = rulesFrom(JSON.parse(process.env.STEER_RULES || "{}"));
const DATA = process.env.STEER_DATA ?? join(here, "data");
const WEB = process.env.STEER_WEB ?? join(here, "..", "web");
// Events whose time is further than this from when the server got them don't count.
// That's what stops someone from making up old sessions later.
const LATE_SECS = 300;
// Events from further ahead than this don't count either. Clocks drift a bit, but
// nothing real happens in the future. They're still kept, so a person whose clock is
// wrong can see why time is missing.
const FUTURE_SECS = 30;
// A computer's clock can be this far off before its events get moved (see postEvents).
const CLOCK_SLACK = 2000;
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "https://steer.duck.hackclub.app").replace(/\/$/, "");
// The same server also answers at these addresses (each one added in Nest's dashboard and
// as a redirect URL in the Hack Club login app), for people whose antivirus or school
// blocks the main one. Someone who comes in on one of them gets sign-in, login links and
// install commands for that address, so they never get sent to the blocked one.
const ALSO_AT = new Set(
  (process.env.ALSO_AT ?? "steer.dino.icu")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
// The address written in web/'s pages and install scripts.
const WEB_HOST = "steer.duck.hackclub.app";
/** The address this request came in on if it's one of the others, else the main one. */
function baseFor(req) {
  const host = String(req.headers.host ?? "").toLowerCase();
  return ALSO_AT.has(host) ? `https://${host}` : PUBLIC_URL;
}
// Sign in with Hack Club. Without these, the server falls back to name-only signup
// (handy for running your own).
const HCA =
  process.env.HCA_CLIENT_ID && process.env.HCA_CLIENT_SECRET
    ? { id: process.env.HCA_CLIENT_ID, secret: process.env.HCA_CLIENT_SECRET }
    : null;
const HCA_BASE = process.env.HCA_BASE ?? "https://auth.hackclub.com"; // changeable for tests
const HCA_SCOPES = "openid profile slack_id verification_status";

// ---------- limits ----------
// A busy day with a few agents running at once is about 5,000 events (prompts, tool
// calls and turn ends) and a busy minute about 130, so real use stays far under these.

const BODY_MAX = 1_000_000; // bytes in one request
const BATCH_MAX = 500; // events in one request, the client sends 500 at a time
const BURST = 5_000; // events one key can send at once, enough for a long offline queue
const REFILL = 2; // events per second a key gets back after that
const DAY_MAX = 20_000; // events stored per account per day (UTC, by when they arrived)
const REPORT_EVERY = 10_000; // ms, pages are worked out again at most this often
const STALE_WAIT = 1_500; // ms to wait for a new page before showing the last one
const PAGE_SESSIONS = 100; // sessions a project page shows
const PAGE_TURNS = 3_000; // rows across those sessions
const JOB_SECS = 30; // a page that takes longer is given up on for a while

// ---------- storage ----------

const usersFile = join(DATA, "users.json");
// Accounts that ever sent a check-in answer, so /accuracy only reads those.
const checkinersFile = join(DATA, "checkin-accounts.json");
const ACCURACY_EVERY = 15 * 60_000; // ms, /accuracy is worked out again at most this often
// Review pages, one file each, never changed once written.
const REVIEWS = join(DATA, "reviews");
const reviewFile = (id) => join(REVIEWS, `${id}.json`);
const REVIEW_ID = /^[A-Za-z0-9_-]{12}$/;
const REVIEW_SESSIONS = 500; // sessions a review page draws, the totals count all of them
const REVIEW_TURNS = 5_000; // rows across those sessions
const GITHUB_REPO = /^https:\/\/github\.com\/[\w.-]{1,100}\/[\w.-]{1,100}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Commits on a review page get looked up on GitHub. A token raises GitHub's limit from
// 60 lookups an hour to 5,000.
const GITHUB_API = (process.env.GITHUB_API ?? "https://api.github.com").replace(/\/$/, "");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const COMMIT_CHECKS = 40; // commits looked up per review page, the newest ones
const COMMIT_CLOSE = 15 * 60 * 1000; // a commit's time on GitHub this close to when steer saw it matches
// Slack ids of people who can approve, cut or reject review pages: fraud squad and
// program reviewers. Set on the server, comma separated.
const REVIEWERS = new Set((process.env.STEER_REVIEWERS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const SLACK_ID = /^[UW][A-Z0-9]{2,20}$/;
const eventsFile = (name) => join(DATA, "events", `${name}.jsonl`);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Accounts by name. No prototype, so names like "constructor" are just names. */
function loadUsers() {
  const users = Object.assign(Object.create(null), existsSync(usersFile) ? JSON.parse(readFileSync(usersFile, "utf8")) : {});
  // Accounts used to have one key; now each device gets its own.
  for (const u of Object.values(users)) {
    if (u.keyHash && !u.keyHashes) {
      u.keyHashes = [u.keyHash];
      delete u.keyHash;
    }
  }
  return users;
}

if (isMainThread) mkdirSync(join(DATA, "events"), { recursive: true });
const users = isMainThread ? loadUsers() : Object.create(null);
const hasUser = (name) => name !== null && Object.hasOwn(users, name);
const byKey = new Map();
for (const [name, u] of Object.entries(users)) for (const h of u.keyHashes ?? []) byKey.set(h, name);

function saveUsers() {
  writeFileSync(usersFile + ".tmp", JSON.stringify(users, null, 1));
  renameSync(usersFile + ".tmp", usersFile);
}

/** Makes a new key for an account and returns it. Only its hash is stored. */
function addKey(name) {
  const key = randomBytes(24).toString("base64url");
  const hash = sha256(key);
  users[name].keyHashes = [...(users[name].keyHashes ?? []), hash];
  byKey.set(hash, name);
  saveUsers();
  return key;
}

/** Calls fn with each stored event of an account, reading the file bit by bit. */
async function eachEvent(name, fn) {
  const file = eventsFile(name);
  if (!existsSync(file)) return;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a line cut off by a crash
    }
    fn(e);
  }
}

// What the main thread keeps per account: ids of recent events to skip repeats, and
// the few numbers the pages show next to the report. The events themselves stay on
// disk. Only recent ids are kept: a repeat sent later than that arrives late and
// doesn't count anyway, and reports skip repeated ids too. Keeping every id ever sent
// took about 6 MB per person with a month of history (tools/load/loadtest.mjs).
const stores = new Map(); // name -> { ready, store, used }
const STORE_IDLE = 30 * 60 * 1000;
const RECENT_IDS = 2 * 60 * 60 * 1000;

function storeOf(name) {
  let s = stores.get(name);
  if (!s) {
    s = { ready: null, store: null, used: Date.now() };
    s.ready = loadStore(name).then((store) => (s.store = store));
    s.ready.catch(() => stores.delete(name));
    stores.set(name, s);
  }
  s.used = Date.now();
  return s.ready;
}

async function loadStore(name) {
  const store = { ids: new Map(), counted: 0, late: 0, last: null, vias: new Map(), day: "", today: 0 };
  await eachEvent(name, (e) => note(store, e));
  return store;
}

/** Adds one stored event to the numbers kept in memory. */
function note(store, e) {
  const got = Date.parse(e.got);
  if (Date.now() - got < RECENT_IDS) store.ids.set(e.id, got);
  if (e.late) store.late++;
  else store.counted++;
  if (!store.last || e.got > store.last) store.last = e.got;
  let vias = store.vias.get(e.project);
  if (!vias) store.vias.set(e.project, (vias = new Set()));
  vias.add(e.via ?? "claude-code");
  const day = String(e.got).slice(0, 10);
  if (day === store.day) store.today++;
  else if (day > store.day) {
    store.day = day;
    store.today = 1;
  }
}

// ---------- events ----------

const NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const clean = (s, max) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, "").slice(0, max) : "");
const KINDS = new Set(["prompt", "tool", "stop", "interrupt", "checkin", "run", "save", "commit", "wait", "focus", "copy", "typing", "away", "back", "here", "editor", "front"]);
// Evidence from the project, sent by steer's watcher and terminal lines: a command you ran
// (its first word and exit code), that files were saved, a commit's hash.
const EVIDENCE = new Set(["run", "save", "commit"]);
// The tools steer tracks. Only Codex and Copilot write down a stopped turn; the
// Claude Code and Cursor hooks and OpenCode never send an interrupt.
const VIAS = new Set(["claude-code", "cursor", "codex", "opencode", "copilot", "freebuff", "chatgpt", "claude-ai", "steer"]);
// Check-ins (`steer checkin on`): the person's answer to "what are you doing right now?",
// used to fit the credit curve. They come from steer itself and never count as time.
// "project" and "project-ai" are the two working buttons from before 0.5.5, which split
// working into "working" and "waiting" (on the ai).
const ANSWERS = new Set(["working", "waiting", "project-ai", "project", "other", "none"]);
// Claude Code sends interrupts from its tool hooks (a tool the person stopped).
const INTERRUPTS = new Set(["codex", "copilot", "claude-code"]);
// Signs of attention, collected so time can be counted from what the person does
// instead of from gaps. Not counted yet:
// - "wait": the agent is waiting on the person (a permission prompt showed)
// - "focus" (on or off), "copy", "typing": a ChatGPT or Claude tab came to the front or
//   left it, something was copied out of it, writing the next message started
// - "away", "back", "here": from the computer's idle timer. Nobody touched the keyboard
//   or mouse for 2 minutes, someone did again (with how long they were gone), and every
//   5 minutes while someone's there, so a stretch with none of these is unknown
// - "editor": from steer's VS Code and Cursor extension, a stretch of `secs` seconds from
//   `t` someone was typing, clicking or scrolling in the project's files
// - "front": from the same extension, a stretch of `secs` seconds from `t` the editor
//   window was in front with the project open
const ATTENTION = new Set(["wait", "focus", "copy", "typing", "away", "back", "here", "editor", "front"]);
const WAITS = { via: new Set(["claude-code", "codex", "cursor"]), reasons: new Set(["permission", "question"]) };
const CHATS = new Set(["chatgpt", "claude-ai"]);
const EDITORS = new Set(["vscode", "cursor"]);
// Sent by steer itself rather than an AI tool.
const FROM_STEER = new Set(["checkin", "run", "save", "commit", "away", "back", "here", "editor", "front"]);
// Permission settings a prompt can carry: Claude Code's modes and Codex's approval
// policies. Says whether the agent could stop to ask the person at all.
const MODES = new Set(["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "never", "on-request", "on-failure", "untrusted"]);
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const LONGEST = 256; // strings longer than this didn't come from steer
// Upper bounds for prompt counts. Anything over these is made up.
const COUNTS = { words: 100_000, chars: 1_000_000, images: 100, specific: 100_002 };

/** Checks one event from a client. Returns the stored form or null. */
function accept(raw, now) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = raw.kind;
  if (!KINDS.has(kind)) return null;
  for (const k of ["id", "session", "project", "tool"]) {
    const v = raw[k];
    if (v != null && (typeof v !== "string" || v.length > LONGEST)) return null;
  }
  // Clients from before Codex support didn't send via.
  const via = raw.via ?? "claude-code";
  if (!VIAS.has(via)) return null;
  if (kind === "interrupt" && !INTERRUPTS.has(via)) return null;
  if (FROM_STEER.has(kind) !== (via === "steer")) return null;
  if (kind === "wait" && (!WAITS.via.has(via) || !WAITS.reasons.has(raw.reason))) return null;
  if ((kind === "focus" || kind === "copy" || kind === "typing") && !CHATS.has(via)) return null;
  if (kind === "focus" && typeof raw.on !== "boolean") return null;
  if ((kind === "editor" || kind === "front") && (!EDITORS.has(raw.app) || !Number.isInteger(raw.secs) || raw.secs < 0 || raw.secs > 3600)) return null;
  if (kind === "checkin" && !ANSWERS.has(raw.answer)) return null;
  const t = typeof raw.t === "string" && TIME.test(raw.t) ? Date.parse(raw.t) : NaN;
  if (Number.isNaN(t)) return null;
  const id = clean(raw.id, 64);
  const session = clean(raw.session, 100);
  if (!id || !session) return null;

  const e = {
    id,
    session,
    project: clean(raw.project, 100) || "unknown",
    via,
    kind,
    t: new Date(t).toISOString(),
    got: new Date(now).toISOString(),
    late: now - t > LATE_SECS * 1000 || t - now > FUTURE_SECS * 1000,
  };
  if (kind === "prompt") {
    const n = {};
    for (const [k, max] of Object.entries(COUNTS)) {
      const v = raw[k] ?? 0;
      if (!Number.isInteger(v) || v < 0 || v > max) return null;
      n[k] = v;
    }
    // Every word has a letter in it, and "specific" counts words plus at most two extras.
    if (n.words > n.chars || n.specific > n.words + 2) return null;
    for (const k of ["observation", "generic", "repeat"]) if (raw[k] != null && typeof raw[k] !== "boolean") return null;
    e.words = n.words;
    e.chars = n.chars;
    e.images = n.images;
    e.specific = n.specific;
    e.observation = raw.observation === true;
    e.generic = raw.generic === true;
    e.repeat = raw.repeat === true;
    if (raw.mode != null) {
      if (!MODES.has(raw.mode)) return null;
      e.mode = raw.mode;
    }
  }
  if (kind === "tool") {
    e.tool = clean(raw.tool, 80);
    // How long it ran, so its start is known.
    if (raw.ms != null) {
      if (!Number.isInteger(raw.ms) || raw.ms < 0 || raw.ms > 86_400_000) return null;
      e.ms = raw.ms;
    }
  }
  if (kind === "run") {
    if (typeof raw.name !== "string" || !/^[A-Za-z0-9._+-]{1,40}$/.test(raw.name)) return null;
    if (raw.exit != null && (!Number.isInteger(raw.exit) || raw.exit < -1 || raw.exit > 255)) return null;
    if (raw.secs != null && (!Number.isInteger(raw.secs) || raw.secs < 0 || raw.secs > 86400)) return null;
    e.name = raw.name;
    e.exit = raw.exit ?? null;
    e.secs = raw.secs ?? null;
  }
  if (kind === "save") {
    const n = raw.count ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > 10000) return null;
    e.count = n;
  }
  if (kind === "commit") {
    if (typeof raw.hash !== "string" || !/^[0-9a-f]{7,40}$/.test(raw.hash)) return null;
    e.hash = raw.hash;
  }
  if (kind === "wait") e.reason = raw.reason;
  if (kind === "focus") e.on = raw.on;
  if (kind === "editor" || kind === "front") {
    e.secs = raw.secs;
    e.app = raw.app;
  }
  if (kind === "back") {
    const secs = raw.away_secs;
    if (secs != null && (!Number.isInteger(secs) || secs < 0 || secs > 7 * 86400)) return null;
    e.away_secs = secs ?? null;
  }
  if (kind === "checkin") {
    e.answer = raw.answer;
    const waited = raw.answered_after;
    if (waited != null && (!Number.isInteger(waited) || waited < 0 || waited > 3600)) return null;
    e.answered_after = waited ?? null;
  }
  return e;
}

/** Turns stored events into the sessions shape web/steer.js works with. Late events are left out. */
async function sessionsOf(name) {
  const bySession = new Map();
  await eachEvent(name, (e) => {
    if (e.late || e.kind === "checkin" || ATTENTION.has(e.kind)) return;
    // Evidence goes in one session per project; web/steer.js merges it into the AI
    // session it belongs to.
    const evidence = EVIDENCE.has(e.kind);
    const key = evidence ? `evidence:${e.project}` : e.session;
    let s = bySession.get(key);
    if (!s) {
      s = { path: key, cwd: e.project, title: null, events: [], evidence };
      bySession.set(key, s);
    }
    const t = Date.parse(e.t);
    if (evidence) {
      s.events.push({ id: e.id, t, kind: e.kind, name: e.name, exit: e.exit, count: e.count, hash: e.hash });
    } else if (e.kind === "prompt") {
      const prompt = {
        chars: e.chars,
        words: e.words,
        images: e.images,
        specific: e.specific,
        observation: e.observation,
        generic: e.generic,
        repeat: e.repeat,
      };
      s.events.push({ id: e.id, t, kind: "prompt", prompt });
    } else if (e.kind === "interrupt") {
      s.events.push({ id: e.id, t, kind: "interrupt" });
    } else {
      const a = { id: e.id, t, kind: "agent", tools: e.kind === "tool" && e.tool ? [e.tool] : [] };
      // How long a tool ran (so its start is known), and which events end a turn. The
      // counting ignores both; the attention signals use them.
      if (Number.isInteger(e.ms)) a.ms = e.ms;
      if (e.kind === "stop") a.stop = true;
      s.events.push(a);
    }
  });
  const sessions = [...bySession.values()];
  for (const s of sessions) s.events.sort((a, b) => a.t - b.t);
  return sessions;
}

// ---------- rate limits ----------

/** Token buckets: each key (an account key or an IP) can spend `size` at once and gets `perSec` back. */
class Buckets {
  constructor(size, perSec, max = 100_000) {
    this.size = size;
    this.perSec = perSec;
    this.max = max;
    this.map = new Map();
  }

  bucket(key, now) {
    let b = this.map.get(key);
    if (!b) {
      if (this.map.size >= this.max) this.sweep(now, true);
      b = { tokens: this.size, at: now };
      this.map.set(key, b);
    }
    b.tokens = Math.min(this.size, b.tokens + ((now - b.at) / 1000) * this.perSec);
    b.at = now;
    return b;
  }

  has(key, n = 1, now = Date.now()) {
    return this.bucket(key, now).tokens >= n;
  }

  /** Spends n if there's that much. A failed try still costs 1, so hammering doesn't help. */
  take(key, n = 1, now = Date.now()) {
    const b = this.bucket(key, now);
    if (b.tokens >= n) {
      b.tokens -= n;
      return true;
    }
    b.tokens = Math.max(0, b.tokens - 1);
    return false;
  }

  /** Seconds until n can be spent. */
  wait(key, n = 1, now = Date.now()) {
    return Math.max(1, Math.ceil((n - this.bucket(key, now).tokens) / this.perSec));
  }

  /** Forgets full buckets, they'd start full anyway. When there are too many, the oldest go. */
  sweep(now = Date.now(), full = false) {
    for (const [k, b] of this.map) if (b.tokens + ((now - b.at) / 1000) * this.perSec >= this.size) this.map.delete(k);
    if (full) for (const k of [...this.map.keys()].slice(0, Math.ceil(this.max / 10))) this.map.delete(k);
  }
}

const sendLimit = new Buckets(BURST, REFILL); // per account key
const loginStarts = new Buckets(20, 1 / 30); // per IP: 20 logins, then one every 30 s
const codeTries = new Buckets(20, 1 / 30); // per IP, typing the code from the terminal
const signups = new Buckets(10, 1 / 360); // per IP: 10, then one every 6 minutes
const submits = new Buckets(5, 1 / 600); // per account: 5 review pages, then one every 10 minutes
const exportsPerIp = new Buckets(10, 1 / 10); // per IP: 10 event downloads, then one every 10 s
const lookupsPerIp = new Buckets(30, 1 / 2); // per IP: 30 /api/slack lookups, then one every 2 s
const githubPerAccount = new Buckets(40, 40 / 3600); // per account: 40 GitHub lookups an hour
const EXPORTS_AT_ONCE = 8;
let exporting = 0;

// Proxies whose X-Forwarded-For is believed: this machine, plus TRUSTED_PROXIES (comma
// separated). On Nest the proxy isn't on this machine, it connects from 10.60.1.2, so
// that address goes in TRUSTED_PROXIES there.
const TRUSTED = new Set(["127.0.0.1", "::1", ...(process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);
const trusted = (ip) => TRUSTED.has(ip) || (ip.startsWith("::ffff:") && TRUSTED.has(ip.slice(7)));

/**
 * Who's asking, for the per-IP limits. Behind a proxy every connection comes from the
 * proxy, which puts the real address last in X-Forwarded-For. That header is only
 * believed from a trusted proxy, anyone else could make it up. IPv6 addresses are
 * grouped by /64, since one person usually has a whole /64.
 */
function clientIp(req) {
  let ip = req.socket.remoteAddress ?? "";
  const fwd = req.headers["x-forwarded-for"];
  if (trusted(ip) && typeof fwd === "string" && fwd.trim()) ip = fwd.split(",").at(-1).trim().slice(0, 64);
  if (ip.startsWith("::ffff:") && ip.includes(".")) return ip.slice(7);
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("%")[0].toLowerCase().split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const groups = tail === undefined ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// ---------- the report worker ----------

/** A page couldn't be worked out right now. */
class Busy extends Error {}

let worker = null;
const jobs = new Map(); // id -> { resolve, reject, timer, name }, oldest first
let lastJob = 0;
const tooBig = new Map(); // name -> ms until its pages are tried again

function startWorker() {
  // A report that needs more memory than this stops the worker, not the server.
  const w = new Worker(new URL(import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
  w.on("message", ({ id, result, error }) => {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    clearTimeout(job.timer);
    if (error) job.reject(new Busy(error));
    else job.resolve(result);
  });
  const gone = (err) => {
    if (worker === w) stopWorker(err?.message ?? "it stopped");
  };
  w.on("error", gone);
  w.on("exit", gone);
  worker = w;
}

/** Stops the worker and fails what's waiting on it. Jobs run in order, so the oldest one was running. */
function stopWorker(why) {
  const w = worker;
  worker = null;
  w?.terminate();
  const running = jobs.values().next().value;
  if (running) tooBig.set(running.name, Date.now() + 10 * 60 * 1000);
  for (const job of jobs.values()) {
    clearTimeout(job.timer);
    job.reject(new Busy(why));
  }
  jobs.clear();
  console.error("report worker stopped:", why);
}

function work(msg) {
  if ((tooBig.get(msg.name) ?? 0) > Date.now()) return Promise.reject(new Busy("too big for now"));
  if (jobs.size >= 200) return Promise.reject(new Busy("too many pages at once"));
  if (!worker) startWorker();
  const id = ++lastJob;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => stopWorker(`${msg.name}'s page took over ${JOB_SECS}s`), JOB_SECS * 1000);
    jobs.set(id, { resolve, reject, timer, name: msg.name });
    worker.postMessage({ id, ...msg });
  });
}

/** The worker side: works out reports and renders them, one job at a time. */
function workerMain() {
  const kept = new Map(); // name -> { version, projects }, the last few accounts
  let queue = Promise.resolve();
  parentPort.on("message", (msg) => {
    queue = queue
      .then(() => job(msg))
      .then(
        (result) => parentPort.postMessage({ id: msg.id, result }),
        (err) => parentPort.postMessage({ id: msg.id, error: String(err?.message ?? err) }),
      );
  });

  async function projectsOf(name, version) {
    let r = kept.get(name);
    if (!r || r.version !== version) {
      const projects = buildReport(await sessionsOf(name), { days: null });
      applyCaps(projects, RULES);
      r = { version, projects };
    }
    kept.delete(name);
    kept.set(name, r);
    if (kept.size > 3) kept.delete(kept.keys().next().value);
    return r.projects;
  }

  /** A person's check-in answers and attention signals. */
  async function signalEvents(name) {
    const answers = [];
    const attention = [];
    await eachEvent(name, (e) => {
      if (e.late) return;
      if (e.kind === "checkin" && typeof e.answer === "string") answers.push({ t: Date.parse(e.t), answer: e.answer });
      else if (ATTENTION.has(e.kind)) {
        attention.push({ t: Date.parse(e.t), kind: e.kind, session: e.session, project: e.project, on: e.on, away_secs: e.away_secs, secs: e.secs });
      }
    });
    return { answers, attention };
  }

  async function job({ op, name, version, project, from, to, info }) {
    if (op === "forget") return void kept.delete(name); // the account was deleted
    const projects = await projectsOf(name, version);
    if (op === "checkins") {
      const { answers, attention } = await signalEvents(name);
      if (!answers.length) return { moments: [], measured: null };
      const sessions = await sessionsOf(name);
      const signals = signalsOf(attention, sessions);
      return { moments: checkinMoments(projects, sessions, answers, signals), measured: signalTotals(projects, signals).measured };
    }
    // The counting steer is trying next, next to what it counts now. Null without signals.
    if (op === "signals") {
      const { attention } = await signalEvents(name);
      if (!attention.length) return null;
      return signalTotals(projects, signalsOf(attention, await sessionsOf(name)));
    }
    // Found by key, so the same project under another folder name is found too.
    const named = (x) => projectKey(x.name) === projectKey(project);
    if (op === "commits") {
      const whole = projects.find(named);
      return whole ? reviewFacts(projectBetween(whole, from, to)).commits : [];
    }
    if (op === "review") {
      const whole = projects.find(named);
      if (!whole) return null;
      const p = projectBetween(whole, from, to);
      if (!p.sessions.length) return { empty: true };
      const days = new Set(p.sessions.flatMap((s) => s.turns.map((t) => new Date(t.t).toISOString().slice(0, 10))));
      const found = checks(projects, RULES).filter((c) => days.has(c.day));
      const f = reviewFacts(p);
      let shown = 0;
      let rows = 0;
      for (const s of p.sessions) {
        if (shown > 0 && (shown >= REVIEW_SESSIONS || rows + s.turns.length > REVIEW_TURNS)) break;
        shown++;
        rows += s.turns.length;
      }
      let html = renderReview({ ...p, sessions: p.sessions.slice(0, shown) }, info, found, RULES, f);
      if (shown < p.sessions.length) {
        html = html.replace("<h2>Sessions</h2>\n", `<h2>Sessions</h2>\n<p class="muted">Showing the newest ${shown} of ${p.sessions.length} sessions. The hours above count all of them, and every event is in the download below.</p>\n`);
      }
      return { name: whole.name, html, secs: f.you, agent: f.agent, first: f.first, last: f.last, hours: hoursOf(f.you), line: `${hoursOf(f.you)}h tracked with steer, review: ${info.url}` };
    }
    if (op === "report") {
      return {
        profile: projects.length
          ? renderWeekly(weekly(projects)) +
            renderReport(projects, {
              window: "all time",
              source: "events the steer client sent while working",
              sessions: false,
              projectLink: (p) => `/u/${encodeURIComponent(name)}/${encodeURIComponent(p)}`,
              rules: RULES,
            })
          : "",
        hours: projects.map((p) => ({
          name: p.name,
          sessions: p.sessions.length,
          your_secs: projectHuman(p),
          agent_secs: projectAgent(p),
          your_time: fmtDur(projectHuman(p)),
        })),
      };
    }
    const p = projects.find(named);
    return p ? projectHtml(p) : null;
  }
}

/** A project's report. Only the newest sessions get drawn, the totals count all of them. */
function projectHtml(p) {
  const opts = { window: "all time", source: "events the steer client sent while working", rules: RULES };
  let shown = 0;
  let rows = 0;
  for (const s of p.sessions) {
    if (shown > 0 && (shown >= PAGE_SESSIONS || rows + s.turns.length > PAGE_TURNS)) break;
    shown++;
    rows += s.turns.length;
  }
  if (shown === p.sessions.length) return renderReport([p], opts);
  const note = `<p class="muted">Showing the newest ${shown} of ${p.sessions.length} sessions.</p>\n`;
  const totals = renderReport([p], { ...opts, sessions: false });
  const part = renderReport([{ ...p, sessions: p.sessions.slice(0, shown) }], { ...opts, checks: false });
  const at = part.indexOf("<h2>Sessions</h2>");
  if (at < 0) return totals + note;
  // The project heading in that part only adds up the sessions shown, so it goes.
  return totals + part.slice(at).replace(/<h3>[^\n]*<\/h3>\n/, note);
}

// ---------- page cache ----------

/** Least recently used first, dropped once they add up to more than maxBytes. */
class Lru {
  constructor(maxBytes) {
    this.max = maxBytes;
    this.bytes = 0;
    this.map = new Map();
  }
  get(key) {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key, v, size) {
    this.delete(key);
    v.size = size;
    this.map.set(key, v);
    this.bytes += size;
    while (this.bytes > this.max && this.map.size > 1) this.delete(this.map.keys().next().value);
  }
  delete(key) {
    const v = this.map.get(key);
    if (v) {
      this.bytes -= v.size;
      this.map.delete(key);
    }
  }
}

const pages = new Lru(64 * 1024 * 1024); // key -> { version, at, value }
// Which copy of an account's events something was worked out from. With the account's
// creation time in it, the worker never mixes up a deleted account and a new one.
const versionOf = (name, store) => `${users[name]?.created ?? ""}|${store.counted}`;
const working = new Map(); // key -> promise

/**
 * Something the worker makes, kept until new events arrive for that account, and
 * then still for REPORT_EVERY. If an older copy exists and the new one is slow, the
 * older one is shown.
 */
function cached(key, name, store, msg, sizeOf) {
  // The account's creation time goes in the key too, so pages of a deleted account never
  // show up for a new account that gets the same name.
  const born = users[name]?.created ?? "";
  key += `\n${born}`;
  const version = versionOf(name, store);
  const hit = pages.get(key);
  if (hit && (hit.version === version || Date.now() - hit.at < REPORT_EVERY)) return Promise.resolve(hit.value);
  let p = working.get(key);
  if (!p) {
    p = work({ ...msg, name, version })
      .then((value) => {
        if ((users[name]?.created ?? "") === born) pages.set(key, { version, at: Date.now(), value }, sizeOf(value) + key.length + 64);
        return value;
      })
      .finally(() => working.delete(key));
    working.set(key, p);
  }
  if (!hit) return p;
  return Promise.race([p.catch(() => hit.value), new Promise((ok) => setTimeout(() => ok(hit.value), STALE_WAIT))]);
}

const reportOf = (name, store) =>
  store.counted === 0
    ? Promise.resolve({ profile: "", hours: [] })
    : cached(`r\n${name}`, name, store, { op: "report" }, (v) => v.profile.length + JSON.stringify(v.hours).length);

/** The counting with the attention signals, per project, or null without signals. */
const signalTimeOf = (name, store) =>
  store.counted === 0 ? Promise.resolve(null) : cached(`s\n${name}`, name, store, { op: "signals" }, (v) => JSON.stringify(v).length);

const projectOf = (name, store, project) =>
  cached(`p\n${name}\n${project}`, name, store, { op: "project", project }, (v) => v?.length ?? 0);

// ---------- accuracy ----------

let checkiners = null; // Set of account names, read or found on first use

/** Accounts that sent check-in answers. The first time, without the file, it looks
 * through everyone's events once. */
async function checkinAccounts() {
  if (!checkiners) {
    if (existsSync(checkinersFile)) {
      checkiners = new Set(JSON.parse(readFileSync(checkinersFile, "utf8")));
    } else {
      const found = new Set();
      for (const name of Object.keys(users)) {
        let any = false;
        await eachEvent(name, (e) => {
          if (e.kind === "checkin") any = true;
        });
        if (any) found.add(name);
      }
      checkiners = found;
      saveCheckiners();
    }
  }
  return [...checkiners].filter(hasUser);
}

function saveCheckiners() {
  writeFileSync(checkinersFile + ".tmp", JSON.stringify([...checkiners]));
  renameSync(checkinersFile + ".tmp", checkinersFile);
}

let accuracyPage = null; // { at, html }
let accuracyWorking = null;

/** The /accuracy page, from everyone's check-ins, worked out at most every ACCURACY_EVERY. */
function accuracyHtml() {
  if (accuracyPage && Date.now() - accuracyPage.at < ACCURACY_EVERY) return Promise.resolve(accuracyPage.html);
  if (!accuracyWorking) {
    accuracyWorking = (async () => {
      const people = [];
      const measured = [];
      for (const name of await checkinAccounts()) {
        const store = await storeOf(name);
        const v = await cached(`c\n${name}`, name, store, { op: "checkins" }, (x) => x.moments.length * 80 + 64);
        people.push(v.moments);
        measured.push(v.measured);
      }
      const updated = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
      const html = renderAccuracy(accuracy(people, measured), { updated });
      accuracyPage = { at: Date.now(), html };
      return html;
    })().finally(() => (accuracyWorking = null));
  }
  // Show the last one while a new one is worked out.
  return accuracyPage ? Promise.resolve(accuracyPage.html) : accuracyWorking;
}

// ---------- http ----------

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/copy.js": ["copy.js", "text/javascript; charset=utf-8"],
  "/report": ["report.html", "text/html; charset=utf-8"],
  "/report.js": ["report.js", "text/javascript; charset=utf-8"],
  "/steer.js": ["steer.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/trust": ["trust.html", "text/html; charset=utf-8"],
  "/privacy": ["privacy.html", "text/html; charset=utf-8"],
  "/install.sh": ["install.sh", "text/plain; charset=utf-8"],
  "/install.ps1": ["install.ps1", "text/plain; charset=utf-8"],
};

const PAGE_CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
// The login form posts here and then goes on to Hack Club.
const LOGIN_CSP = PAGE_CSP.replace("form-action 'none'", `form-action 'self' ${new URL(HCA_BASE).origin}`);

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", ...extra });
  res.end(body);
}
const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), "application/json", extra);
const tooMany = (res, secs, error) => json(res, 429, { error }, { "retry-after": String(secs) });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(res, title, body, { refresh, status = 200, csp = PAGE_CSP, headers = {}, script } = {}) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">\n` : ""}<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
${script ? `<script type="module" src="${script}"></script>\n` : ""}</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
  send(res, status, html, "text/html; charset=utf-8", { "content-security-policy": csp, ...headers });
}

const redirect = (res, location, headers = {}) => {
  res.writeHead(303, { location, ...headers });
  res.end();
};

const TOO_BIG = Symbol("too big");

/** The request body as text, or TOO_BIG once it goes over limit. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > limit) return resolve(TOO_BIG);
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        req.removeAllListeners("data");
        resolve(TOO_BIG);
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req, limit) {
  const body = await readBody(req, limit);
  if (body === TOO_BIG) return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Answers 413 and hangs up instead of reading the rest. */
function tooLarge(req, res) {
  res.on("finish", () => req.destroy());
  json(res, 413, { error: `requests can be at most ${BODY_MAX} bytes` }, { connection: "close" });
}

function keyOf(req) {
  const m = /^Bearer (\S{1,200})$/.exec(req.headers.authorization ?? "");
  return m ? sha256(m[1]) : null;
}
function userFromKey(req) {
  const h = keyOf(req);
  return h ? byKey.get(h) ?? null : null;
}

/** decodeURIComponent, or null for a broken % escape. */
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

async function profilePage(res, name) {
  const store = await storeOf(name);
  const report = await reportOf(name, store);
  const hc = users[name].hc;
  const linked = hc
    ? `Linked to a Hack Club account${hc.verification_status === "verified" ? " (verified)" : ""}.`
    : "Not linked to a Hack Club account.";
  let body = `<h1>steer · ${esc(name)}</h1>
<p class="muted">Live. This page reloads every 30 seconds. ${store.last ? `Last activity ${esc(new Date(store.last).toUTCString())}.` : "Nothing tracked yet."} ${linked}</p>
`;
  body += report.profile;
  const late = store.late;
  if (late) {
    const what = late === 1 ? "1 event has a time" : `${late} events have times`;
    body += `<p class="muted">${what} too far from when the server got them, so they aren't counted. Usually that means they were sent more than 5 minutes late, or this computer's clock is wrong.</p>\n`;
  }
  page(res, `steer · ${name}`, body, { refresh: 30 });
}

async function projectPage(res, name, project) {
  const store = await storeOf(name);
  const report = await reportOf(name, store);
  const found = report.hours.find((p) => projectKey(p.name) === projectKey(project));
  if (!found) return send(res, 404, "No such project");
  // The same project under another spelling (an old link, another computer's folder
  // name): send it to the one page. Not a permanent redirect, since the name shown is
  // whichever was used last and can change back.
  if (found.name !== project) {
    res.writeHead(302, { location: `/u/${encodeURIComponent(name)}/${encodeURIComponent(found.name)}` });
    return res.end();
  }
  const html = await projectOf(name, store, project);
  if (html == null) return send(res, 404, "No such project");
  const key = projectKey(project);
  const tools = [...new Set([...store.vias].filter(([p]) => projectKey(p) === key).flatMap(([, vias]) => [...vias]))];
  const u = encodeURIComponent(name);
  const pr = encodeURIComponent(project);
  const badgeLine = `[![steered with ai](${PUBLIC_URL}/badge/${u}/${pr}.svg)](${PUBLIC_URL}/u/${u}/${pr})`;
  const body = `<h1><a href="/u/${u}">${esc(name)}</a> / ${esc(project)}</h1>
<p class="muted">Tracked from ${esc(tools.join(", "))}. To freeze these hours into a page for a reviewer, submit the project from <a href="/me">your steer</a>, or run <code>steer submit</code> in its folder.</p>
<p><img src="/badge/${u}/${pr}.svg" alt="steered with ai"> <span class="muted">for your README, it updates by itself:</span> <code>${esc(badgeLine)}</code></p>
${html}`;
  page(res, `${project} · steer`, body);
}

// ---------- README badges ----------
// /badge/NAME.svg and /badge/NAME/PROJECT.svg: "steered with ai | 12h 30m", the
// person's own time, for a README. Always an image, so a broken link still shows.

function badgeSvg(label, value) {
  // Roughly how wide Verdana 11px is, which is what badges usually use.
  const width = (t) => Math.ceil([...t].reduce((w, c) => w + (c === " " ? 3.9 : /[mwMW]/.test(c) ? 9.5 : /[iljtf.:']/.test(c) ? 3.6 : 6.9), 0)) + 12;
  const lw = width(label);
  const vw = width(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
<title>${esc(label)}: ${esc(value)}</title>
<rect width="${lw}" height="20" fill="#555"/>
<rect x="${lw}" width="${vw}" height="20" fill="#000"/>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${esc(label)}</text>
<text x="${lw + vw / 2}" y="14">${esc(value)}</text>
</g>
</svg>
`;
}

async function badge(res, name, project) {
  let value = "not found";
  try {
    if (name !== null && project !== null && hasUser(name)) {
      const hours = (await reportOf(name, await storeOf(name))).hours;
      const secs =
        project === undefined ? hours.reduce((n, p) => n + p.your_secs, 0) : hours.find((p) => projectKey(p.name) === projectKey(project))?.your_secs;
      if (secs != null) value = fmtDur(secs);
    }
  } catch {
    value = "busy, try later";
  }
  send(res, 200, badgeSvg("steered with ai", value), "image/svg+xml; charset=utf-8", {
    "cache-control": "max-age=300",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
}

async function hoursJson(res, name, project) {
  const store = await storeOf(name);
  const projects = (await reportOf(name, store)).hours.filter((p) => !project || projectKey(p.name) === projectKey(project));
  if (project && !projects.length) return json(res, 404, { error: "no such project" });
  const hc = users[name].hc;
  json(res, 200, {
    user: name,
    // So programs can match hours to the person who submitted. Null if not linked.
    hackclub: hc ? { slack_id: hc.slack_id, verification_status: hc.verification_status, ysws_eligible: hc.ysws_eligible } : null,
    projects,
  });
}

// ---------- review pages ----------
// `steer submit` freezes a project's hours (all of them, or between two days) into a
// page with its own link. A reviewer opens that link instead of the live page, so the
// hours they check can't change after the project was submitted.

/**
 * Freezes a project's hours into a review page. `steer submit` and the submit form on
 * /me both end up here. Returns { review }, or { status, error } to show the person.
 */
async function makeReview(name, { project, from = null, to = null, repo = null }) {
  if (typeof project !== "string" || !project || project.length > 100) return { status: 400, error: "say which project" };
  for (const d of [from, to]) {
    if (d !== null && (typeof d !== "string" || !DAY.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) {
      return { status: 400, error: "days look like 2026-11-21" };
    }
  }
  if (from && to && from > to) return { status: 400, error: "the first day is after the last one" };
  if (repo !== null && (typeof repo !== "string" || !GITHUB_REPO.test(repo) || /\/\.{1,2}(\/|$)/.test(repo))) {
    return { status: 400, error: "the repo should look like https://github.com/you/project" };
  }
  if (!submits.take(name)) return { status: 429, error: "too many review pages at once, try again in a few minutes", wait: submits.wait(name) };

  const store = await storeOf(name);
  const version = versionOf(name, store);
  const id = randomBytes(9).toString("base64url");
  const hc = users[name].hc ?? null;
  const frozen = new Date().toISOString();
  const url = `${PUBLIC_URL}/r/${id}`;
  const info = { name, slack: hc?.slack_id ?? null, verified: hc?.verification_status === "verified", from, to, frozen, url, repo, checks: null };
  if (repo && store.counted) {
    const commits = await work({ op: "commits", name, version, project, from, to });
    if (commits.length) info.checks = await checkCommits(repo, commits, name);
  }
  const r = store.counted ? await work({ op: "review", name, version, project, from, to, info }) : null;
  if (!r) return { status: 404, error: `nothing tracked in a project called ${project}` };
  if (r.empty) return { status: 404, error: `nothing tracked in ${project} in those days` };
  if (!hasUser(name)) return { status: 410, error: "this account was just deleted" };
  const review = {
    id,
    user: name,
    project: r.name ?? project,
    from,
    to,
    first: r.first,
    last: r.last,
    frozen,
    repo,
    slack_id: info.slack,
    verified: info.verified,
    secs: r.secs,
    agent_secs: r.agent,
    hours: r.hours,
    url,
    line: r.line,
    commit_checks: info.checks,
    html: r.html,
  };
  mkdirSync(REVIEWS, { recursive: true });
  writeFileSync(reviewFile(id), JSON.stringify(review), { flag: "wx" });
  users[name].reviews = [...(users[name].reviews ?? []), { id, project: review.project, hours: r.hours, frozen }].slice(-500);
  saveUsers();
  return { review };
}

async function submitReview(req, res) {
  const name = userFromKey(req);
  if (!name) return json(res, 401, { error: "that key isn't signed in, run steer login" });
  if (!submits.has(name)) return tooMany(res, submits.wait(name), "too many review pages at once, try again in a few minutes");
  const body = await readJson(req, 10_000);
  if (body === TOO_BIG) return tooLarge(req, res);
  const made = await makeReview(name, { project: body?.project, from: body?.from ?? null, to: body?.to ?? null, repo: body?.repo ?? null });
  if (made.error) return made.wait ? tooMany(res, made.wait, made.error) : json(res, made.status, { error: made.error });
  const r = made.review;
  json(res, 201, { id: r.id, url: r.url, hours: r.hours, your_time: fmtDur(r.secs), line: r.line });
}

/**
 * Looks each commit up on GitHub: "ok" when it's there and GitHub's commit time is
 * within 15 minutes of when steer saw it, "time" when it's there with a different
 * time, "missing" when GitHub doesn't have it (not pushed, or made up), "unchecked"
 * when GitHub didn't answer.
 */
async function checkCommits(repo, commits, account) {
  const [owner, name] = new URL(repo).pathname.slice(1).split("/");
  const headers = { accept: "application/vnd.github+json", "user-agent": "steer-review-pages", ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}) };
  const out = {};
  const list = commits.filter((c) => c.hash).slice(-COMMIT_CHECKS);
  const one = async (c) => {
    if (!githubPerAccount.take(account)) return { status: "unchecked" };
    try {
      const r = await fetch(`${GITHUB_API}/repos/${owner}/${name}/commits/${c.hash}`, { headers, signal: AbortSignal.timeout(8_000) });
      if (r.status === 404 || r.status === 422) return { status: "missing" };
      if (!r.ok) return { status: "unchecked" };
      const j = await r.json();
      const when = Date.parse(j?.commit?.committer?.date ?? "");
      if (Number.isNaN(when)) return { status: "unchecked" };
      // Who made it on GitHub, so a reviewer can see it's the person and not someone
      // else's commit in a busy repo.
      const login = typeof j?.author?.login === "string" ? j.author.login.slice(0, 40) : null;
      return { status: Math.abs(when - c.t) <= COMMIT_CLOSE ? "ok" : "time", date: new Date(when).toISOString(), login };
    } catch {
      return { status: "unchecked" };
    }
  };
  for (let i = 0; i < list.length; i += 8) {
    const batch = list.slice(i, i + 8);
    const results = await Promise.all(batch.map(one));
    batch.forEach((c, k) => (out[c.hash] = results[k]));
  }
  return out;
}

// ----- reviewers: approve, cut hours or reject a review page -----

const decisionsFile = (id) => join(REVIEWS, `${id}.decisions.jsonl`);

function decisionsOf(id) {
  if (!existsSync(decisionsFile(id))) return [];
  return readFileSync(decisionsFile(id), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The hours a review page ends up with after its latest decision, or null if nobody decided yet. */
function reviewedHours(r, decisions) {
  const last = decisions[decisions.length - 1];
  if (!last) return null;
  return last.action === "reject" ? "0.0" : last.action === "cut" ? last.hours : r.hours;
}

// ----- signing in on the website -----
// One Hack Club sign-in for everyone. People see their own projects on /me, and
// reviewers (STEER_REVIEWERS) can also approve, cut or reject review pages. Sessions
// only live in memory, so a restart signs everyone out.

const SESSION_TTL = 12 * 60 * 60 * 1000;
const sessions = new Map(); // cookie token -> { token, sub, slack, name, csrf, until }
const signIns = new Map(); // oauth state -> { back, browser, created }

/** A cookie's value, or "". */
function cookieOf(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]{10,64})`).exec(req.headers.cookie ?? "");
  return m ? m[1] : "";
}

/** Compares two secrets without giving away how much of them matched. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

const secureFor = (base) => (base.startsWith("https://") ? "; Secure" : "");

function sessionOf(req) {
  const s = sessions.get(cookieOf(req, "steer_session"));
  return s && s.until > Date.now() ? s : null;
}

function reviewerOf(req) {
  const s = sessionOf(req);
  return s && REVIEWERS.has(s.slack) ? s : null;
}

/** The steer account linked to a Hack Club account, or null. */
const accountOf = (sub) => Object.keys(users).find((n) => users[n].hc?.sub === sub) ?? null;

/** Only what programs need to match hours to people. No email, name or address. */
const hcFields = (info) => ({
  sub: info.sub,
  slack_id: info.slack_id ?? null,
  verification_status: info.verification_status ?? null,
  ysws_eligible: info.ysws_eligible ?? null,
  updated: new Date().toISOString(),
});

/** Signs this browser in as whoever Hack Club said it is. Returns the cookie to set. */
function startSession(req, info) {
  const token = randomBytes(24).toString("base64url");
  const slack = typeof info.slack_id === "string" ? info.slack_id : null;
  sessions.set(token, {
    token,
    sub: String(info.sub),
    slack,
    name: String(info.nickname || info.name || slack || "you").slice(0, 60),
    csrf: randomBytes(16).toString("base64url"),
    until: Date.now() + SESSION_TTL,
  });
  return `steer_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secureFor(baseFor(req))}`;
}

const endSession = (req) => `steer_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFor(baseFor(req))}`;

/** Sends someone to Hack Club to sign in, and back to `back`, a path on this site. */
function signIn(req, res, back) {
  if (!HCA) return page(res, "steer", "<h1>steer</h1>\n<p>This server doesn't have Hack Club login set up.</p>", { status: 503 });
  const ip = clientIp(req);
  if (!loginStarts.take(ip)) return page(res, "steer", "<h1>steer</h1>\n<p>Too many logins from here, wait a few minutes.</p>", { status: 429 });
  if (signIns.size >= LOGINS_MAX) return page(res, "steer", "<h1>steer</h1>\n<p>Too many logins right now, try again in a few minutes.</p>", { status: 503 });
  const state = randomBytes(16).toString("base64url");
  // The sign-in has to come back to this same browser. Otherwise someone could finish a
  // sign-in of their own in someone else's browser by sending them the link.
  const browser = randomBytes(18).toString("base64url");
  signIns.set(state, { back, browser, created: Date.now() });
  const base = baseFor(req);
  const q = new URLSearchParams({ client_id: HCA.id, redirect_uri: `${base}/auth/callback`, response_type: "code", scope: HCA_SCOPES, state });
  redirect(res, `${HCA_BASE}/oauth/authorize?${q}`, {
    "set-cookie": `steer_signin=${browser}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_TTL / 1000}${secureFor(base)}`,
  });
}

async function signInDone(req, res, authCode, state) {
  const { back, browser } = signIns.get(state);
  signIns.delete(state);
  if (!sameSecret(cookieOf(req, "steer_signin"), browser)) {
    return page(
      res,
      "steer",
      `<h1>steer</h1>\n<p>This sign-in has to finish in the browser it started in. If someone sent you this link, close it. Otherwise <a href="${esc(back)}">try again</a>.</p>`,
      { status: 403 },
    );
  }
  const info = authCode ? await hcaUser(authCode, `${baseFor(req)}/auth/callback`) : null;
  if (!info?.sub) return page(res, "steer", `<h1>steer</h1>\n<p>Hack Club didn't confirm the sign-in. <a href="${esc(back)}">Try again</a>.</p>`);
  const slack = typeof info.slack_id === "string" ? info.slack_id : null;
  // Whatever Hack Club says now, like a verification that went through since last time.
  const account = accountOf(info.sub);
  if (account) {
    users[account].hc = hcFields(info);
    saveUsers();
  }
  const cookies = [startSession(req, info), `steer_signin=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${secureFor(baseFor(req))}`];
  const review = /^\/r\/([A-Za-z0-9_-]{12})$/.exec(back)?.[1];
  if (review && !REVIEWERS.has(slack)) {
    return page(
      res,
      "steer",
      `<h1>Not a reviewer</h1>\n<p>Your Hack Club account (${esc(slack ?? "no Slack id")}) isn't on this server's list of reviewers. Fraud squad and program reviewers get added on request.</p>\n<p><a href="/r/${review}">Back to the review page</a> or <a href="/me">to your own steer</a></p>`,
      { headers: { "set-cookie": cookies } },
    );
  }
  redirect(res, back, { "set-cookie": cookies });
}

function reviewerLogin(req, res, review) {
  if (!REVIEW_ID.test(review)) return send(res, 400, "Bad review page");
  signIn(req, res, `/r/${review}`);
}

async function decide(req, res, id) {
  const who = reviewerOf(req);
  if (!who) return send(res, 403, "Sign in as a reviewer first.");
  if (!fromHere(req)) return send(res, 403, "This form only works from the review page.");
  const r = readReview(id);
  if (!r) return send(res, 404, "No such review page");
  if (ownHours(r, who)) return send(res, 403, "These are your own hours, someone else has to review them.");
  const body = await readBody(req, 10_000);
  if (body === TOO_BIG) return tooLarge(req, res);
  const form = new URLSearchParams(body);
  const csrf = Buffer.from(form.get("csrf") ?? "");
  if (csrf.length !== who.csrf.length || !timingSafeEqual(csrf, Buffer.from(who.csrf))) return send(res, 403, "This form expired, reload the page.");
  const action = form.get("action");
  const note = clean(form.get("note") ?? "", 1000).trim();
  let hours = null;
  if (!["approve", "cut", "reject"].includes(action)) return send(res, 400, "Pick approve, cut or reject.");
  if (action === "cut") {
    const h = Number(form.get("hours"));
    if (!Number.isFinite(h) || h < 0 || h >= Number(r.hours)) return send(res, 400, `Cut hours to a number from 0 to under ${r.hours}.`);
    hours = h.toFixed(1);
  }
  if (action !== "approve" && !note) return send(res, 400, "Say why in the note, the person sees it.");
  const d = { at: new Date().toISOString(), by: who.slack, name: who.name, action, hours, note };
  appendFileSync(decisionsFile(id), JSON.stringify(d) + "\n");
  res.writeHead(303, { location: `/r/${id}` });
  res.end();
}

/** A reviewer looking at hours from their own Hack Club account, which they can't review. */
function ownHours(r, who) {
  return Boolean(r.slack_id) && r.slack_id === who?.slack;
}

function decisionsHtml(r, decisions, who) {
  let h = "";
  if (decisions.length) {
    h += `<h2>Reviewed</h2>\n<ul>\n`;
    for (const d of decisions) {
      const what = d.action === "approve" ? `approved ${esc(r.hours)}h` : d.action === "cut" ? `cut ${esc(r.hours)}h to ${esc(d.hours)}h` : "rejected the hours";
      h += `<li>${esc(new Date(d.at).toUTCString())}: ${esc(d.name)} (${esc(d.by)}) ${what}${d.note ? `: "${esc(d.note)}"` : ""}</li>\n`;
    }
    h += `</ul>\n<p><b>Hours after review: ${esc(reviewedHours(r, decisions))}h</b></p>\n`;
  }
  if (who && ownHours(r, who)) {
    h += `<h2>Your review</h2>\n<p class="muted">Signed in as ${esc(who.name)} (${esc(who.slack)}). These are your own hours, so someone else has to review them.</p>\n`;
  } else if (who) {
    h += `<h2>Your review</h2>
<p class="muted">Signed in as ${esc(who.name)} (${esc(who.slack)}). The person sees what you pick and your note.</p>
<form method="post" action="/r/${r.id}/decide">
<input type="hidden" name="csrf" value="${esc(who.csrf)}">
<p><label><input type="radio" name="action" value="approve" checked> approve ${esc(r.hours)}h</label><br>
<label><input type="radio" name="action" value="cut"> cut to <input name="hours" type="number" min="0" step="0.1" max="${esc(r.hours)}" style="width:5em"> hours</label><br>
<label><input type="radio" name="action" value="reject"> reject the hours</label></p>
<p><label>Note (needed to cut or reject)<br><textarea name="note" rows="3" cols="60" maxlength="1000"></textarea></label></p>
<p><button>Save</button></p>
</form>
`;
  }
  return h;
}

// Review files never change, so the last few read stay parsed.
const reviewCache = new Map();
function readReview(id) {
  if (reviewCache.has(id)) {
    const r = reviewCache.get(id);
    reviewCache.delete(id);
    reviewCache.set(id, r);
    return r;
  }
  let r;
  try {
    r = JSON.parse(readFileSync(reviewFile(id), "utf8"));
  } catch {
    return null;
  }
  reviewCache.set(id, r);
  if (reviewCache.size > 50) reviewCache.delete(reviewCache.keys().next().value);
  return r;
}

function reviewPage(req, res, id) {
  const r = readReview(id);
  if (!r) return send(res, 404, "No such review page");
  const who = reviewerOf(req);
  const u = encodeURIComponent(r.user);
  // The sign-in goes at the top: a review page is long, and reviewers are who it's for.
  const signIn = who ? "" : `<p class="muted">Fraud squad or a program reviewer? <a href="/reviewer/login?r=${id}">Sign in to approve, cut or reject these hours</a>.</p>\n`;
  const body = `<h1>Review: <a href="/u/${u}">${esc(r.user)}</a> / <a href="/u/${u}/${encodeURIComponent(r.project)}">${esc(r.project)}</a></h1>
${signIn}${decisionsHtml(r, decisionsOf(id), who)}${r.html}
<p class="muted">Every event behind this page, with when the server got it: <a href="/api/r/${id}/events">/api/r/${id}/events</a>. How steer catches faked time: <a href="/trust">/trust</a>.</p>`;
  page(res, `review · ${r.user} / ${r.project}`, body, who ? { csp: PAGE_CSP.replace("form-action 'none'", "form-action 'self'") } : {});
}

function reviewJson(res, id) {
  const r = readReview(id);
  if (!r) return json(res, 404, { error: "no such review page" });
  const { html, ...rest } = r;
  const decisions = decisionsOf(id);
  json(res, 200, { ...rest, decisions, reviewed_hours: reviewedHours(r, decisions) });
}

/**
 * Every stored event of one account as JSON lines, optionally for one project between
 * two times. Streams the file, waiting whenever the reader is slow, so a client that
 * never reads can't make the server hold the whole file in memory.
 */
async function eventsJsonl(req, res, name, { project = null, lo = -Infinity, hi = Infinity } = {}) {
  const ip = clientIp(req);
  if (!exportsPerIp.take(ip)) return tooMany(res, exportsPerIp.wait(ip), "too many downloads from here, wait a bit");
  if (exporting >= EXPORTS_AT_ONCE) return json(res, 503, { error: "busy, try again in a minute" }, { "retry-after": "60" });
  exporting++;
  try {
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="${name}${project ? `-${project.replace(/[^\w.-]/g, "_")}` : ""}.jsonl"`,
    });
    const file = eventsFile(name);
    if (!existsSync(file)) return res.end();
    const input = createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
    let rest = "";
    await new Promise((done) => {
      const finish = () => {
        input.destroy();
        done();
      };
      res.on("close", finish);
      input.on("error", finish);
      input.on("data", (chunk) => {
        const lines = (rest + chunk).split("\n");
        rest = lines.pop();
        let out = "";
        for (const line of lines) {
          if (!line) continue;
          let e;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (project !== null && projectKey(e.project) !== projectKey(project)) continue;
          const t = Date.parse(e.t);
          if (t < lo || t >= hi) continue;
          out += line + "\n";
        }
        if (out && !res.write(out)) {
          input.pause();
          res.once("drain", () => input.resume());
        }
      });
      input.on("end", () => {
        res.end();
        done();
      });
    });
  } finally {
    exporting--;
  }
}

function reviewEvents(req, res, id) {
  const r = readReview(id);
  if (!r) return json(res, 404, { error: "no such review page" });
  const lo = r.from ? Date.parse(`${r.from}T00:00:00Z`) : -Infinity;
  const hi = r.to ? Date.parse(`${r.to}T00:00:00Z`) + 86_400_000 : Date.parse(r.frozen);
  return eventsJsonl(req, res, r.user, { project: r.project, lo, hi });
}

/** Everything steer has for one Slack account, for fraud squad and programs. */
async function slackLookup(res, slack) {
  const names = Object.keys(users).filter((n) => users[n].hc?.slack_id === slack);
  const accounts = [];
  for (const name of names) {
    const store = await storeOf(name);
    const hc = users[name].hc;
    accounts.push({
      user: name,
      page: `${PUBLIC_URL}/u/${encodeURIComponent(name)}`,
      events: `${PUBLIC_URL}/api/u/${encodeURIComponent(name)}/events`,
      verification_status: hc.verification_status,
      ysws_eligible: hc.ysws_eligible,
      last_activity: store.last,
      projects: (await reportOf(name, store)).hours,
      reviews: (users[name].reviews ?? []).map((r) => {
        const decisions = decisionsOf(r.id);
        return { ...r, url: `${PUBLIC_URL}/r/${r.id}`, reviewed_hours: reviewedHours(r, decisions), decisions: decisions.length };
      }),
    });
  }
  json(res, 200, { slack_id: slack, accounts });
}

// ---------- your steer (/me) ----------
// Signed in with Hack Club, people see their projects, submit one for review without
// the terminal, see what reviewers decided, and can delete their account.

const ME_CSP = PAGE_CSP.replace("default-src 'none';", "default-src 'none'; script-src 'self';").replace("form-action 'none'", "form-action 'self'");
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const day = (iso) => new Date(iso).toISOString().slice(0, 10);

/** The install commands for the address someone is on. /copy.js adds the copy buttons. */
function installBox(req) {
  const base = esc(baseFor(req));
  return `<div id="install">
<p data-os="unix">Mac and Linux (Terminal):</p>
<div class="cmd" data-os="unix"><pre><code>curl -fsSL ${base}/install.sh | sh</code></pre></div>
<p data-os="windows">Windows (PowerShell):</p>
<div class="cmd" data-os="windows"><pre><code>irm ${base}/install.ps1 | iex</code></pre></div>
</div>
`;
}

/** Who's signed in, with a sign out button. */
function meTop(s, name) {
  const account = name ? `, steer account <a href="/u/${encodeURIComponent(name)}">${esc(name)}</a>` : "";
  return `<form method="post" action="/me/logout"><p class="muted">Signed in with Hack Club as ${esc(s.name)}${s.slack ? ` (${esc(s.slack)})` : ""}${account}. <input type="hidden" name="csrf" value="${esc(s.csrf)}"><button class="link">Sign out</button></p></form>\n`;
}

/** What reviewers decided on a review page, last decision first. */
function reviewStatus(id) {
  const d = decisionsOf(id).at(-1);
  if (!d) return `<span class="muted">not reviewed on steer yet</span>`;
  const what = d.action === "approve" ? "approved" : d.action === "cut" ? `cut to ${esc(d.hours)}h` : `<span class="red">rejected</span>`;
  return `${what} by ${esc(d.name)}${d.note ? `: "${esc(d.note)}"` : ""}`;
}

/** After making a review page: its link and the line to paste. */
function madeNotice(name, id) {
  const r = id && REVIEW_ID.test(id) ? readReview(id) : null;
  if (!r || r.user !== name) return "";
  return `<h2>Review page made</h2>
<p>${esc(r.project)}, ${esc(r.hours)} hours: <a href="/r/${r.id}">${esc(r.url)}</a></p>
<p>When you submit the project to a program, paste this into the hours field, or wherever they ask how you spent the time:</p>
<div class="cmd"><pre><code>${esc(r.line)}</code></pre></div>
<p class="muted">The page doesn't change after this, even if you keep working. Submit again later to get a new one.</p>
`;
}

async function mePage(req, res, url) {
  const s = sessionOf(req);
  if (!s) {
    return page(
      res,
      "your steer",
      `<h1><a href="/">steer</a> / your steer</h1>
<p>Sign in with your Hack Club account to see your projects and submit them for review.</p>
<p><a class="button" href="/me/login">Sign in with Hack Club</a></p>
<p class="muted">From your Hack Club account steer only keeps your Slack id and whether you're verified and eligible for YSWS. The rest is on <a href="/privacy">/privacy</a>.</p>`,
      { csp: ME_CSP },
    );
  }
  const name = accountOf(s.sub);
  let body = `<h1><a href="/">steer</a> / your steer</h1>\n${meTop(s, name)}`;
  if (REVIEWERS.has(s.slack)) body += `<p>You're on the reviewer list, so you can approve, cut or reject the hours on any review page.</p>\n`;
  if (!name) {
    body += `<p>Your Hack Club account doesn't have steer yet. Install it on the computer you code on. It asks you to sign in with Hack Club once, then your projects show up here while you work.</p>
${installBox(req)}<p class="muted">Made a steer account before you could sign in with Hack Club? Run <code>steer login</code> on that computer once and it gets linked to this one.</p>`;
    return page(res, "your steer", body, { csp: ME_CSP, script: "/copy.js" });
  }
  body += madeNotice(name, url.searchParams.get("made"));
  const store = await storeOf(name);
  const { hours } = await reportOf(name, store);
  // The counting steer is testing, shown next to the real one once steer has signals.
  const tested = await signalTimeOf(name, store).catch(() => null);
  const testedSecs = (p) => tested?.projects.find((x) => projectKey(x.name) === projectKey(p.name))?.secs ?? p.your_secs;
  const both = Boolean(tested?.measured);
  const u = encodeURIComponent(name);
  body += `<h2>Projects</h2>\n`;
  if (!hours.length) {
    body += `<p>Nothing tracked yet. Once you work with an AI tool in a project it shows up here, usually within a minute. If steer isn't on this computer yet:</p>\n${installBox(req)}`;
  } else {
    body += `<table class="list">\n<tr><th>Project</th><th class="r">Your time</th>${both ? `<th class="r">New counting</th>` : ""}<th class="r">Agent time</th><th class="r">Sessions</th><th></th></tr>\n`;
    for (const p of hours) {
      const q = encodeURIComponent(p.name);
      body += `<tr><td><a href="/u/${u}/${q}">${esc(p.name)}</a></td><td class="r">${esc(p.your_time)}</td>${both ? `<td class="r">${esc(fmtDur(testedSecs(p)))}</td>` : ""}<td class="r">${esc(fmtDur(p.agent_secs))}</td><td class="r">${p.sessions}</td><td><a href="/me/submit?project=${q}">submit for review</a></td></tr>\n`;
    }
    body += `</table>\n<p class="muted">Your time is what counts: writing prompts, reading what the agent did, testing and fixing things. Agent time is when it ran by itself.</p>\n`;
    if (both) {
      body += `<p class="muted">New counting is what steer is testing next. It takes out time you were away from the computer, and adds time the VS Code or Cursor extension saw you working in the project's files or reading with the editor in front between agent runs, deciding on permission prompts, and ChatGPT or Claude chats. It doesn't count toward anything yet. If one of the two is closer to what you actually did, tell duck on Slack, that helps decide which one steer keeps. How close each one is to people's check-ins is on <a href="/accuracy">/accuracy</a>.</p>\n`;
    }
  }
  const reviews = [...(users[name].reviews ?? [])].reverse();
  if (reviews.length) {
    body += `<h2>Submitted</h2>\n<table class="list">\n<tr><th>Made</th><th>Project</th><th class="r">Hours</th><th>Review</th><th>Page</th></tr>\n`;
    for (const r of reviews) {
      body += `<tr><td>${esc(day(r.frozen))}</td><td>${esc(r.project)}</td><td class="r">${esc(r.hours)}</td><td>${reviewStatus(r.id)}</td><td><a href="/r/${r.id}">/r/${r.id}</a></td></tr>\n`;
    }
    body += `</table>\n`;
  }
  body += `<h2>Your account</h2>
<p>Your page at <a href="/u/${u}">${esc(new URL(baseFor(req)).host)}/u/${esc(name)}</a> is public, like a Hackatime profile. <a href="/me/delete">Delete your account</a> to take everything off the server.</p>`;
  page(res, "your steer", body, { csp: ME_CSP, script: "/copy.js" });
}

/** The signed-in person and their steer account, or null after sending them to /me. */
function meAccount(req, res) {
  const s = sessionOf(req);
  const name = s && accountOf(s.sub);
  if (!name) {
    redirect(res, "/me");
    return null;
  }
  return { s, name };
}

/** Checks a form sent from a /me page. Returns the session and the fields, or null after answering. */
async function meForm(req, res) {
  const s = sessionOf(req);
  if (!s) {
    redirect(res, "/me");
    return null;
  }
  if (!fromHere(req)) {
    send(res, 403, "This form only works from your steer page.");
    return null;
  }
  const body = await readBody(req, 10_000);
  if (body === TOO_BIG) {
    tooLarge(req, res);
    return null;
  }
  const form = new URLSearchParams(body);
  if (!sameSecret(form.get("csrf"), s.csrf)) {
    send(res, 403, "This form expired, go back and reload the page.");
    return null;
  }
  return { s, form };
}

/** github.com/you/project, with or without https:// or .git, as https://github.com/you/project. */
function cleanRepo(raw) {
  const r = String(raw ?? "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  return r ? r.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "https://github.com/") : null;
}

/** The repo the project's last review pages had, to fill in the form. */
function lastRepo(name, project) {
  const mine = (users[name].reviews ?? []).filter((r) => projectKey(r.project) === projectKey(project)).slice(-5).reverse();
  for (const r of mine) {
    const repo = readReview(r.id)?.repo;
    if (repo) return repo;
  }
  return "";
}

async function submitForm(res, s, name, project, { error, from, to, repo, status = 200 } = {}) {
  const { hours } = await reportOf(name, await storeOf(name));
  const p = hours.find((x) => projectKey(x.name) === projectKey(project));
  if (!p) return page(res, "steer", `<h1>No project called ${esc(project)}</h1>\n<p><a href="/me">Back to your steer</a></p>`, { csp: ME_CSP, status: 404 });
  repo ??= lastRepo(name, p.name);
  page(
    res,
    `submit ${p.name}`,
    `<h1><a href="/me">your steer</a> / submit ${esc(p.name)}</h1>
<p>This freezes the project's hours into a review page with its own link, which you give the program you're submitting to. The page doesn't change after that, even if you keep working.</p>
${error ? `<p class="red">${esc(capital(error))}.</p>\n` : ""}<form method="post" action="/me/submit">
<input type="hidden" name="csrf" value="${esc(s.csrf)}">
<input type="hidden" name="project" value="${esc(p.name)}">
<p><label>GitHub repo<br><input class="field" name="repo" value="${esc(repo)}" placeholder="https://github.com/you/project" size="45" spellcheck="false"></label></p>
<p class="muted">So the commits on the page get checked against GitHub. Leave it empty if the code isn't on GitHub.</p>
<p>Only some days? <label>from <input class="field" type="date" name="from" value="${esc(from ?? "")}"></label> <label>to <input class="field" type="date" name="to" value="${esc(to ?? "")}"></label></p>
<p class="muted">Leave the days empty for all of it, ${esc(p.your_time)} so far. Only pick days if part of this project was already submitted before.</p>
<p><button>Make the review page</button> &nbsp; <a href="/me">cancel</a></p>
</form>
<p class="muted">It can take a few seconds, it works out all your hours and looks your commits up on GitHub.</p>`,
    { csp: ME_CSP, status },
  );
}

async function meSubmit(req, res) {
  const got = await meForm(req, res);
  if (!got) return;
  const { s, form } = got;
  const name = accountOf(s.sub);
  if (!name) return redirect(res, "/me");
  const project = form.get("project") ?? "";
  const from = form.get("from") || null;
  const to = form.get("to") || null;
  const made = await makeReview(name, { project, from, to, repo: cleanRepo(form.get("repo")) });
  if (made.error) return submitForm(res, s, name, project, { error: made.error, from, to, repo: form.get("repo") ?? "", status: made.status });
  redirect(res, `/me?made=${made.review.id}`);
}

async function meDeletePage(res, s, name, { error, status = 200 } = {}) {
  const store = await storeOf(name);
  const events = store.counted + store.late;
  const reviews = (users[name].reviews ?? []).length;
  const what = [`the account ${name}`];
  if (events) what.push(events === 1 ? "its 1 event" : `all ${events.toLocaleString("en-US")} of its events`);
  if (reviews) what.push(reviews === 1 ? "its review page with what reviewers wrote on it" : `its ${reviews} review pages with what reviewers wrote on them`);
  what.push("the link to your Hack Club account");
  page(
    res,
    "delete your steer account",
    `<h1><a href="/me">your steer</a> / delete your account</h1>
<p>This deletes ${esc(what.slice(0, -1).join(", "))} and ${esc(what.at(-1))} from the server. ${reviews ? "Links to your review pages stop working, so a program that hasn't checked your hours yet can't anymore. " : ""}It can't be undone.</p>
<p>steer on your computer keeps running until you run <code>steer uninstall</code>, but it can't send anything after this.</p>
${error ? `<p class="red">${esc(error)}</p>\n` : ""}<form method="post" action="/me/delete">
<input type="hidden" name="csrf" value="${esc(s.csrf)}">
<p><label>Type ${esc(name)} to confirm<br><input class="field" name="confirm" autocomplete="off" spellcheck="false" required></label></p>
<p><button>Delete everything</button> &nbsp; <a href="/me">cancel</a></p>
</form>`,
    { csp: ME_CSP, status },
  );
}

async function meDelete(req, res) {
  const got = await meForm(req, res);
  if (!got) return;
  const { s, form } = got;
  const name = accountOf(s.sub);
  if (!name) return redirect(res, "/me");
  if ((form.get("confirm") ?? "").trim().toLowerCase() !== name) {
    return meDeletePage(res, s, name, { error: `That doesn't match, type ${name} to delete it.`, status: 400 });
  }
  deleteAccount(name);
  sessions.delete(s.token);
  page(
    res,
    "deleted",
    `<h1>Deleted</h1>\n<p>The steer account ${esc(name)} and everything in it is gone from the server.</p>\n<p>To take steer off your computer too, run <code>steer uninstall</code>.</p>\n<p><a href="/">steer</a></p>`,
    { headers: { "set-cookie": endSession(req) } },
  );
}

/** Takes an account off the server: the account and its keys, its events, its review
 * pages with what reviewers decided, and what's kept in memory about it. */
function deleteAccount(name) {
  const u = users[name];
  for (const h of u.keyHashes ?? []) byKey.delete(h);
  for (const r of u.reviews ?? []) {
    rmSync(reviewFile(r.id), { force: true });
    rmSync(decisionsFile(r.id), { force: true });
    reviewCache.delete(r.id);
  }
  rmSync(eventsFile(name), { force: true });
  delete users[name];
  saveUsers();
  stores.delete(name);
  tooBig.delete(name);
  for (const key of [...pages.map.keys()]) if (key.split("\n")[1] === name) pages.delete(key);
  worker?.postMessage({ id: ++lastJob, op: "forget", name });
  const checked = checkiners ?? (existsSync(checkinersFile) ? new Set(JSON.parse(readFileSync(checkinersFile, "utf8"))) : null);
  if (checked?.delete(name)) {
    checkiners = checked;
    saveCheckiners();
    accuracyPage = null;
  }
}

async function meLogout(req, res) {
  const got = await meForm(req, res);
  if (!got) return;
  sessions.delete(got.s.token);
  redirect(res, "/", { "set-cookie": endSession(req) });
}

// ---------- sign in with Hack Club ----------
// The terminal asks for a login code, opens /login?code=..., and polls until the
// browser side is done. The terminal also prints a short user code, and the page only
// goes on once that code is typed in. So a login link someone else started is no use
// to them: whoever opens it doesn't have their terminal.

const LOGIN_TTL = 10 * 60 * 1000;
const LOGINS_MAX = 5_000; // logins waiting at once
const CODE_TRIES = 5; // wrong codes before a login is thrown away
const logins = new Map(); // login code -> { userCode, created, link, state, tries, result }
const byState = new Map(); // oauth state -> login code, at most one per login

function dropLogin(code) {
  const l = logins.get(code);
  if (l?.state) byState.delete(l.state);
  logins.delete(code);
}

function sweepLogins() {
  const now = Date.now();
  for (const [code, l] of logins) if (now - l.created > LOGIN_TTL) dropLogin(code);
}

/** The account this login would link a Hack Club account to, if any. */
const linkTarget = (l) => (l.link && hasUser(l.link) && !users[l.link].hc ? l.link : null);

const gonePage = (res, status = 200) =>
  page(res, "steer login", `<h1>steer</h1>\n<p>This login link expired. Run <code>steer login</code> again.</p>`, { status });

function loginPage(res, code, { error, status = 200 } = {}) {
  const l = logins.get(code);
  if (!l) return gonePage(res, status);
  if (l.result) return page(res, "steer login", `<h1>steer</h1>\n<p>This login is done. Go back to your terminal.</p>`);
  const link = linkTarget(l);
  const what = link
    ? `<p>The terminal that started this uses the steer account <b>${esc(link)}</b>. If your Hack Club account isn't on steer yet, it gets linked to ${esc(link)}.</p>`
    : `<p>If your Hack Club account is already on steer, you sign in to that account. If not, you get a new one.</p>`;
  page(
    res,
    "steer login",
    `<h1>Sign in to steer</h1>
<p>Type the code your terminal shows after "your code":</p>
<form method="post" action="/login/go">
<input type="hidden" name="code" value="${esc(code)}">
<p><input name="user_code" required autofocus autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" placeholder="XXXX-XXXX" style="font:bold 20px Menlo,Consolas,monospace;letter-spacing:2px;width:8em;padding:4px 6px;border:1px solid #000;border-radius:0">
<button>Continue with Hack Club</button></p>
</form>
${error ? `<p class="red">${error}</p>\n` : ""}${what}
<p class="muted">Only do this if you just ran steer login on your own computer. That terminal gets signed in as you. If someone sent you this link or told you what to type, close this page.</p>`,
    { csp: LOGIN_CSP, status },
  );
}

function sameCode(typed, userCode) {
  const a = Buffer.from(String(typed ?? "").toUpperCase().replace(/[^0-9A-Z]/g, ""));
  const b = Buffer.from(userCode.replace(/-/g, ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True unless a browser says the form was sent from another site. */
function fromHere(req) {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers.host;
  return origin === new URL(PUBLIC_URL).origin || origin === `https://${host}` || origin === `http://${host}`;
}

/** The form on the login page: checks the typed code, then off to Hack Club. */
async function loginGo(req, res) {
  if (!codeTries.take(clientIp(req))) {
    return page(res, "steer login", `<h1>steer</h1>\n<p>Too many tries from here. Wait a few minutes and try again.</p>`, { status: 429 });
  }
  if (!fromHere(req)) return send(res, 403, "This form only works from the steer login page.");
  const body = await readBody(req, 10_000);
  if (body === TOO_BIG) return tooLarge(req, res);
  const form = new URLSearchParams(body);
  const code = form.get("code") ?? "";
  const l = logins.get(code);
  if (!l || !HCA) return gonePage(res, 400);
  if (l.result) return loginPage(res, code);
  if (!sameCode(form.get("user_code"), l.userCode)) {
    l.tries = (l.tries ?? 0) + 1;
    if (l.tries >= CODE_TRIES) {
      dropLogin(code);
      return page(res, "steer login", `<h1>steer</h1>\n<p>That was the wrong code too many times. Run <code>steer login</code> again.</p>`, { status: 400 });
    }
    return loginPage(res, code, { error: "That code doesn't match. Check your terminal and try again.", status: 400 });
  }
  if (l.state) byState.delete(l.state);
  l.state = randomBytes(16).toString("base64url");
  byState.set(l.state, code);
  // The login has to come back to this same browser. Otherwise someone could type their
  // own code, send the Hack Club link to someone else, and get that person's account.
  l.browser = randomBytes(18).toString("base64url");
  const base = baseFor(req);
  const q = new URLSearchParams({
    client_id: HCA.id,
    redirect_uri: `${base}/auth/callback`,
    response_type: "code",
    scope: HCA_SCOPES,
    state: l.state,
  });
  const secure = base.startsWith("https://") ? "; Secure" : "";
  res.writeHead(303, {
    location: `${HCA_BASE}/oauth/authorize?${q}`,
    "set-cookie": `steer_login=${l.browser}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_TTL / 1000}${secure}`,
  });
  res.end();
}

/** A free profile name based on someone's Hack Club nickname. */
function freeName(raw) {
  let base = String(raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 28);
  if (!NAME.test(base)) base = "hackclubber";
  let name = base;
  for (let i = 2; hasUser(name); i++) name = `${base}-${i}`;
  return name;
}

/** Swaps a Hack Club login code for who it is, or null. `redirectUri` is the one the
 * login started with. */
async function hcaUser(authCode, redirectUri) {
  try {
    const tokenRes = await fetch(`${HCA_BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: HCA.id,
        client_secret: HCA.secret,
        redirect_uri: redirectUri,
        code: authCode,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();
    const infoRes = await fetch(`${HCA_BASE}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!infoRes.ok) throw new Error(`userinfo ${infoRes.status}`);
    return await infoRes.json();
  } catch (err) {
    console.error("hack club login failed:", err.message);
    return null;
  }
}

async function authCallback(req, res, authCode, state) {
  if (signIns.has(state)) return signInDone(req, res, authCode, state);
  const code = byState.get(state);
  const l = code && logins.get(code);
  if (!l || !HCA || !authCode) {
    return page(res, "steer login", `<h1>steer</h1>\n<p>This login didn't work or expired. Run <code>steer login</code> again.</p>`);
  }
  const cookie = /(?:^|;\s*)steer_login=([A-Za-z0-9_-]{10,64})/.exec(req.headers.cookie ?? "")?.[1] ?? "";
  const same = Buffer.from(cookie);
  if (!l.browser || same.length !== Buffer.byteLength(l.browser) || !timingSafeEqual(same, Buffer.from(l.browser))) {
    return page(
      res,
      "steer login",
      `<h1>steer</h1>\n<p>This login has to finish in the browser where the code was typed. If someone sent you this link, close it, it would have signed their terminal in as you.</p>`,
      { status: 403 },
    );
  }
  byState.delete(state);
  l.state = null;
  const info = await hcaUser(authCode, `${baseFor(req)}/auth/callback`);
  if (!info) return page(res, "steer login", `<h1>steer</h1>\n<p>Hack Club didn't confirm the login. Run <code>steer login</code> again.</p>`);
  if (!info?.sub) return page(res, "steer login", `<h1>steer</h1>\n<p>Hack Club didn't send an account id.</p>`);

  // Same Hack Club account as before, or link the account the terminal was already
  // using, or make a new one.
  const now = new Date().toISOString();
  let name = accountOf(info.sub);
  if (!name) name = linkTarget(l);
  if (!name) {
    name = freeName(info.nickname || info.given_name || info.name);
    users[name] = { keyHashes: [], created: now };
  }
  users[name].hc = hcFields(info);
  l.result = { name, key: addKey(name) };
  // This browser just proved who it is too, so it's signed in on the website as well.
  page(
    res,
    "steer login",
    `<h1>Signed in as ${esc(name)}</h1>
<p>Go back to your terminal, it finishes by itself.</p>
<p>Your projects show up on <a href="/me">your steer</a> while you work, and that's where you submit them for review.</p>`,
    { headers: { "set-cookie": startSession(req, info) } },
  );
}

// ---------- requests ----------

function secsToMidnight(now) {
  const d = new Date(now);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

async function postEvents(req, res) {
  const key = keyOf(req);
  const name = key && byKey.get(key);
  if (!name) return json(res, 401, { error: "bad key" });
  const slow = "too many events at once, the rest can come in a bit";
  if (!sendLimit.has(key)) return tooMany(res, sendLimit.wait(key), slow);
  const body = await readJson(req, BODY_MAX);
  const bad = body === TOO_BIG || !Array.isArray(body?.events) || body.events.length > BATCH_MAX;
  if (bad) sendLimit.take(key, 1); // so sending junk over and over runs out too
  if (body === TOO_BIG) return tooLarge(req, res);
  if (!Array.isArray(body?.events)) return json(res, 400, { error: "send {events: [...]}" });
  if (body.events.length > BATCH_MAX) return json(res, 413, { error: `send at most ${BATCH_MAX} events at a time` });
  const cost = Math.max(1, body.events.length);
  if (!sendLimit.take(key, cost)) return tooMany(res, sendLimit.wait(key, cost), slow);

  const now = Date.now();
  // The computer's clock when it sent this batch. If it's off from the server's, every
  // event in the batch moves by the same amount before it's checked, so a computer with
  // a wrong clock doesn't lose its events. Old events still don't count: what's checked
  // is how long before the send each event happened, which the shift doesn't change.
  const sentAt = typeof body.sent_at === "string" && TIME.test(body.sent_at) ? Date.parse(body.sent_at) : NaN;
  const skew = Number.isNaN(sentAt) ? 0 : now - sentAt;
  const shift = Math.abs(skew) > CLOCK_SLACK ? skew : 0;
  const store = await storeOf(name);
  const fresh = [];
  const ids = new Set();
  let dropped = 0;
  for (const raw of body.events) {
    const moved =
      shift && raw && typeof raw === "object" && typeof raw.t === "string" && TIME.test(raw.t)
        ? { ...raw, t: new Date(Date.parse(raw.t) + shift).toISOString() }
        : raw;
    const e = accept(moved, now);
    if (e && shift) e.shifted = Math.round(shift / 1000);
    if (!e) dropped++;
    else if (!store.ids.has(e.id) && !ids.has(e.id)) {
      ids.add(e.id);
      fresh.push(e);
    }
  }
  const day = new Date(now).toISOString().slice(0, 10);
  if (store.day !== day) {
    store.day = day;
    store.today = 0;
  }
  if (fresh.length && store.today + fresh.length > DAY_MAX) {
    return tooMany(res, secsToMidnight(now), `this account sent ${DAY_MAX} events today, the rest has to wait until tomorrow (utc)`);
  }
  if (fresh.length) {
    appendFileSync(eventsFile(name), fresh.map((e) => JSON.stringify(e) + "\n").join(""));
    for (const e of fresh) note(store, e);
    if (checkiners && !checkiners.has(name) && fresh.some((e) => e.kind === "checkin")) {
      checkiners.add(name);
      saveCheckiners();
    }
  }
  return json(res, 200, { accepted: fresh.length, late: fresh.filter((e) => e.late).length, dropped, skew_secs: Math.round(skew / 1000) });
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://x");
  } catch {
    return send(res, 400, "Bad request");
  }
  const path = url.pathname;
  let m;

  if (req.method === "GET" && Object.hasOwn(STATIC, path)) {
    const [file, type] = STATIC[path];
    let body = readFileSync(join(WEB, file));
    // On one of the other addresses, the pages and install commands use that address.
    const base = baseFor(req);
    if (base !== PUBLIC_URL && /\.(html|sh|ps1)$/.test(file)) body = body.toString("utf8").replaceAll(WEB_HOST, new URL(base).host);
    return send(res, 200, body, type);
  }

  if (req.method === "GET" && path === "/accuracy") {
    return page(res, "steer · accuracy", await accuracyHtml());
  }

  if (req.method === "POST" && path === "/api/signup") {
    if (HCA) return json(res, 410, { error: "this server uses hack club accounts, run steer login instead" });
    if (!signups.has(clientIp(req))) return tooMany(res, signups.wait(clientIp(req)), "too many new accounts from here, try again later");
    const body = await readJson(req, 10_000);
    if (body === TOO_BIG) return tooLarge(req, res);
    const name = typeof body?.name === "string" ? body.name.toLowerCase() : "";
    if (!NAME.test(name)) return json(res, 400, { error: "names are 2-32 letters, numbers, - or _" });
    if (hasUser(name)) return json(res, 409, { error: "that name is taken" });
    signups.take(clientIp(req));
    users[name] = { keyHashes: [], created: new Date().toISOString() };
    return json(res, 201, { name, key: addKey(name) });
  }

  // ----- sign in with Hack Club -----
  if (req.method === "POST" && path === "/api/cli-login") {
    if (!HCA) return json(res, 503, { error: "this server doesn't have hack club login set up, use steer signup" });
    const ip = clientIp(req);
    if (!loginStarts.take(ip)) return tooMany(res, loginStarts.wait(ip), "too many logins from here, wait a few minutes");
    sweepLogins();
    if (logins.size >= LOGINS_MAX) return json(res, 503, { error: "too many people are logging in right now, try again in a few minutes" }, { "retry-after": "60" });
    const code = randomBytes(16).toString("base64url");
    const hex = randomBytes(4).toString("hex").toUpperCase();
    const userCode = `${hex.slice(0, 4)}-${hex.slice(4)}`;
    logins.set(code, { userCode, created: Date.now(), link: userFromKey(req), state: null, tries: 0, result: null });
    return json(res, 200, { code, user_code: userCode, url: `${baseFor(req)}/login?code=${code}` });
  }
  if (req.method === "GET" && (m = /^\/api\/cli-login\/([A-Za-z0-9_-]+)$/.exec(path))) {
    const l = logins.get(m[1]);
    if (!l) return json(res, 404, { status: "expired" });
    if (!l.result) return json(res, 200, { status: "pending" });
    dropLogin(m[1]);
    return json(res, 200, { status: "done", ...l.result });
  }
  if (req.method === "GET" && path === "/login") return loginPage(res, url.searchParams.get("code") ?? "");
  if (path === "/login/go") {
    if (req.method === "POST") return loginGo(req, res);
    // Old links and anyone skipping the code go back to the page that asks for it.
    res.writeHead(303, { location: `/login?code=${encodeURIComponent(url.searchParams.get("code") ?? "")}` });
    return res.end();
  }
  if (req.method === "GET" && path === "/auth/callback") {
    return authCallback(req, res, url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
  }

  // ----- your steer -----
  if (path.startsWith("/me")) {
    if (req.method === "GET" && path === "/me") return mePage(req, res, url);
    if (req.method === "GET" && path === "/me/login") return sessionOf(req) ? redirect(res, "/me") : signIn(req, res, "/me");
    if (req.method === "POST" && path === "/me/submit") return meSubmit(req, res);
    if (req.method === "POST" && path === "/me/delete") return meDelete(req, res);
    if (req.method === "POST" && path === "/me/logout") return meLogout(req, res);
    if (req.method === "GET" && (path === "/me/submit" || path === "/me/delete")) {
      const me = meAccount(req, res);
      if (!me) return;
      return path === "/me/submit" ? submitForm(res, me.s, me.name, url.searchParams.get("project") ?? "") : meDeletePage(res, me.s, me.name);
    }
  }

  if (req.method === "POST" && path === "/api/events") return postEvents(req, res);
  if (req.method === "POST" && path === "/api/submit") return submitReview(req, res);
  if (req.method === "GET" && (m = /^\/r\/([^/]+)$/.exec(path)) && REVIEW_ID.test(m[1])) return reviewPage(req, res, m[1]);
  if (req.method === "POST" && (m = /^\/r\/([^/]+)\/decide$/.exec(path)) && REVIEW_ID.test(m[1])) return decide(req, res, m[1]);
  if (req.method === "GET" && (m = /^\/api\/r\/([^/]+)$/.exec(path)) && REVIEW_ID.test(m[1])) return reviewJson(res, m[1]);
  if (req.method === "GET" && (m = /^\/api\/r\/([^/]+)\/events$/.exec(path)) && REVIEW_ID.test(m[1])) return reviewEvents(req, res, m[1]);
  if (req.method === "GET" && (m = /^\/badge\/([^/]+?)(?:\/([^/]+?))?\.svg$/.exec(path))) {
    return badge(res, decode(m[1]), m[2] === undefined ? undefined : decode(m[2]));
  }
  if (req.method === "GET" && path === "/reviewer/login") return reviewerLogin(req, res, url.searchParams.get("r") ?? "");
  if (req.method === "GET" && (m = /^\/api\/slack\/([^/]+)$/.exec(path))) {
    if (!SLACK_ID.test(m[1])) return json(res, 400, { error: "slack ids look like U0123ABCD" });
    if (!lookupsPerIp.take(clientIp(req))) return tooMany(res, lookupsPerIp.wait(clientIp(req)), "too many lookups from here, wait a bit");
    return slackLookup(res, m[1]);
  }
  if (req.method === "GET" && (m = /^\/api\/u\/([^/]+)\/events$/.exec(path))) {
    const name = decode(m[1]);
    if (name === null || !hasUser(name)) return json(res, 404, { error: "no such user" });
    const project = url.searchParams.get("project");
    return eventsJsonl(req, res, name, { project: project === null ? null : project.slice(0, 100) });
  }

  if (req.method === "GET" && (m = /^\/u\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path))) {
    const name = decode(m[1]);
    const project = m[2] === undefined ? undefined : decode(m[2]);
    if (name === null || project === null) return send(res, 400, "Bad path");
    if (!hasUser(name)) return send(res, 404, "No such user");
    return project === undefined ? profilePage(res, name) : projectPage(res, name, project);
  }
  if (req.method === "GET" && (m = /^\/api\/u\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path))) {
    const name = decode(m[1]);
    const project = m[2] === undefined ? null : decode(m[2]);
    if (name === null || (project === null && m[2] !== undefined)) return json(res, 400, { error: "bad path" });
    if (!hasUser(name)) return json(res, 404, { error: "no such user" });
    return hoursJson(res, name, project);
  }

  send(res, 404, "Not found");
}

/** Every minute: forget expired logins, full buckets and accounts nobody used for a while. */
function sweep() {
  const now = Date.now();
  sweepLogins();
  for (const { store } of stores.values()) {
    if (store) for (const [id, got] of store.ids) if (now - got >= RECENT_IDS) store.ids.delete(id);
  }
  for (const [t, s] of sessions) if (s.until < now) sessions.delete(t);
  for (const [k, v] of signIns) if (now - v.created > LOGIN_TTL) signIns.delete(k);
  for (const b of [sendLimit, loginStarts, codeTries, signups, submits, exportsPerIp, lookupsPerIp, githubPerAccount]) b.sweep(now);
  for (const [name, until] of tooBig) if (until < now) tooBig.delete(name);
  for (const [name, s] of stores) if (s.store && now - s.used > STORE_IDLE) stores.delete(name);
}

if (isMainThread) {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return;
      if (err instanceof Busy) {
        const msg = "This page is busy, try again in a minute.";
        return req.url.startsWith("/api/")
          ? json(res, 503, { error: msg }, { "retry-after": "60" })
          : send(res, 503, msg, undefined, { "retry-after": "60" });
      }
      console.error(err);
      send(res, 500, "Something broke");
    });
  });
  // Slow senders don't get to hold a connection open for long.
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  setInterval(sweep, 60_000).unref();
  server.listen(PORT, () => console.log(`steer server on :${PORT}, data in ${DATA}`));
} else {
  workerMain();
}
