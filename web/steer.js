// Reads Claude Code session logs and works out your time vs agent time.
// Same rules as src/claude.rs, src/prompt.rs and src/analyze.rs. Works in the
// browser and in Node. Nothing in here sends data anywhere.

// ---------- prompts (src/prompt.rs) ----------

const GENERIC = new Set([
  "continue", "go", "go on", "go ahead", "yes", "y", "yep", "yeah", "ok", "okay", "k",
  "do it", "fix it", "fix", "fix this", "keep going", "proceed", "try again", "again",
  "next", "sure", "lgtm", "looks good", "retry", "more", "same", "please", "pls",
]);

const OBSERVATION = [
  "when i", "it shows", "it says", "doesn't", "doesnt", "does not", "didn't", "didnt",
  "not working", "isn't", "isnt", "broken", "broke", "i clicked", "i tried", "i see",
  "i get", "i got", "instead of", "still", "now it", "works now", "it works", "crash",
  "error", "fails", "failed", "freez", "stuck", "wrong", "nothing happens", "blank",
  "undefined", "exception", "traceback", "warning", "bug", "glitch", "flicker", "lag",
];

const ALNUM = /[\p{Alphabetic}\p{N}]/u;
const KEEP = /[\p{Alphabetic}\p{N}_/.:()]/u;
const utf8 = new TextEncoder();
const words = (s) => s.split(/\s+/).filter(Boolean);

/**
 * Claude Code's hook wraps pasted text in <pasted_content ...>...</pasted_content>.
 * Pasting takes no typing, so only the rest counts for words and typing time. Same as
 * typed_part in src/prompt.rs.
 */
export function typedPart(text) {
  let out = "";
  let rest = text;
  for (;;) {
    const start = rest.indexOf("<pasted_content");
    if (start < 0) break;
    const end = rest.indexOf("</pasted_content>", start);
    if (end < 0) break;
    out += rest.slice(0, start);
    rest = rest.slice(end + "</pasted_content>".length);
  }
  return out + rest;
}

export function analyzePrompt(text, images) {
  const typed = typedPart(text);
  const lower = text.toLowerCase();
  let normalized = "";
  for (const c of lower) normalized += ALNUM.test(c) || c === "'" ? c : " ";
  const normWords = words(normalized);
  const joined = normWords.join(" ");
  const raw = words(text);

  let specific = raw.filter(isSpecific).length;
  if (text.includes("`")) specific++;
  if (text.split("\n").filter((l) => l.trim() !== "").length > 3) specific++;
  const observation = images > 0 || OBSERVATION.some((p) => lower.includes(p));
  const generic =
    images === 0 && (GENERIC.has(joined) || (normWords.length <= 3 && specific === 0 && !observation));

  const typedWords = words(typed).length;
  return {
    chars: [...typed].length,
    words: typedWords,
    images,
    // A paste can name more files than the typed words, which no typed prompt can.
    specific: Math.min(specific, typedWords + 2),
    observation,
    generic,
    wordSet: new Set(normWords.filter((w) => utf8.encode(w).length > 2)),
  };
}

const typingSecs = (p) => Math.min(300, Math.max(5, Math.round(p.chars / 4)));

function similarity(a, b) {
  if (!a.wordSet || !b.wordSet || a.wordSet.size === 0 || b.wordSet.size === 0) return 0;
  let shared = 0;
  for (const w of a.wordSet) if (b.wordSet.has(w)) shared++;
  return shared / (a.wordSet.size + b.wordSet.size - shared);
}

function isSpecific(token) {
  const cs = [...token];
  let a = 0;
  let b = cs.length;
  while (a < b && !KEEP.test(cs[a])) a++;
  while (b > a && !KEEP.test(cs[b - 1])) b--;
  const w = cs.slice(a, b).join("").replace(/\.+$/, "");
  if ([...w].length < 2) return false;
  const digit = /[0-9]/.test(w);
  const path = w.includes("/") || hasExtension(w);
  const ident = w.includes("_") || w.includes("::") || w.endsWith("()") || /\p{Ll}\p{Lu}/u.test(w);
  return digit || path || ident;
}

function hasExtension(w) {
  const i = w.lastIndexOf(".");
  if (i < 0) return false;
  const ext = w.slice(i + 1);
  return i > 0 && /^[A-Za-z0-9]{1,5}$/.test(ext) && /[A-Za-z]/.test(ext);
}

// ---------- reading logs (src/claude.rs) ----------

const str = (v) => (typeof v === "string" ? v : null);

const SKIP = [
  "<task-notification>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<bash-stdout>",
  "<bash-stderr>",
  "Caveat:",
  // The summary Claude Code puts in after squeezing a long conversation down.
  "This session is being continued from a previous conversation",
];

// Lines that can't be a user, assistant or title entry get skipped without parsing.
// Claude Code writes compact JSON, so the type always looks like "type":"user".
const WANTED = ['"type":"user"', '"type":"assistant"', '"type":"custom-title"', '"type":"ai-title"'];

/** Feed one session file line by line, then call finish(). */
export class SessionReader {
  constructor(path) {
    this.path = path;
    this.events = [];
    this.cwd = null;
    this.customTitle = null;
    this.aiTitle = null;
  }

  line(s) {
    if (!s || !WANTED.some((w) => s.includes(w))) return;
    let v;
    try {
      v = JSON.parse(s);
    } catch {
      return;
    }
    if (!v || typeof v !== "object") return;
    const ty = str(v.type) ?? "";
    if (ty === "custom-title") return void (this.customTitle = str(v.customTitle));
    if (ty === "ai-title") return void (this.aiTitle = str(v.aiTitle));
    if (ty !== "user" && ty !== "assistant") return;
    if (v.isSidechain === true) return;
    const t = typeof v.timestamp === "string" ? Date.parse(v.timestamp) : NaN;
    if (Number.isNaN(t)) return;
    if (this.cwd === null) this.cwd = str(v.cwd);
    const e = ty === "assistant" ? assistantEvent(v, t) : userEvent(v, t);
    if (e) {
      e.id = str(v.uuid);
      this.events.push(e);
    }
  }

  finish() {
    if (this.events.length === 0) return null;
    this.events.sort((a, b) => a.t - b.t);
    return { path: this.path, cwd: this.cwd, title: this.customTitle ?? this.aiTitle, events: this.events };
  }
}

function assistantEvent(v, t) {
  if (v.isApiErrorMessage === true) return null;
  const content = v.message?.content;
  const tools = Array.isArray(content)
    ? content.filter((b) => b?.type === "tool_use" && typeof b.name === "string").map((b) => b.name)
    : [];
  return { t, kind: "agent", tools };
}

function userEvent(v, t) {
  for (const f of ["isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "isVirtual"]) {
    if (v[f] === true) return null;
  }
  const content = v.message?.content;
  if (content === undefined) return null;

  if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) {
    return v.toolDenialKind === "user-rejected" ? { t, kind: "rejected" } : { t, kind: "agent", tools: [] };
  }

  const originKind = v.origin && typeof v.origin === "object" ? v.origin.kind : undefined;
  // "sdk" is a person typing in an app built on the Claude Agent SDK, like T3 Code.
  const fromPerson = (s) => s === "human" || s === "sdk";
  if (typeof originKind === "string" && !fromPerson(originKind)) return null;
  if (typeof v.turnOrigin === "string" && !fromPerson(v.turnOrigin)) return null;
  if (v.promptSource === "system") return null;

  const [raw, images] = extractText(content);
  const text = stripTag(raw, "system-reminder").trim();
  if (SKIP.some((p) => text.startsWith(p))) return null;
  if (text.startsWith("[Request interrupted by user")) return { t, kind: "interrupt" };
  if (text.startsWith("<bash-input>")) return { t, kind: "shell" };
  if (text.startsWith("<command-name>")) return { t, kind: "command" };
  if (text === "" && images === 0) return null;
  return { t, kind: "prompt", prompt: analyzePrompt(text, images) };
}

function extractText(content) {
  if (typeof content === "string") return [content, 0];
  if (!Array.isArray(content)) return ["", 0];
  let text = "";
  let images = 0;
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string") {
      if (text !== "") text += "\n";
      text += b.text;
    } else if (b?.type === "image") {
      images++;
    }
  }
  return [text, images];
}

function stripTag(s, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let out = "";
  let rest = s;
  for (;;) {
    const start = rest.indexOf(open);
    if (start < 0) break;
    out += rest.slice(0, start);
    const end = rest.indexOf(close, start);
    rest = end < 0 ? "" : rest.slice(end + close.length);
  }
  return out + rest;
}

// ---------- counting (src/analyze.rs) ----------

const AGENT_TIMEOUT = 600;
const WATCH_WINDOW = 120;
// The gap rule: the first FULL_AGENT seconds after the agent stops count in full, then
// less and less, fading over FADE, so a gap never earns more than about FULL_AGENT +
// FADE. A gap that starts with something you did, or a prompt that says you tested
// something, keeps FULL_YOU in full. A gap over BREAK_AFTER is a break: BREAK_BACK to
// catch up (BREAK_BACK_TESTED if you tested) plus typing. Picked with tools/sim, which
// was matched to real logs, and it was the closest of 14 rules for every kind of person
// (2026-11-21). To be fitted from check-ins. Same numbers as src/analyze.rs.
const FULL_AGENT = 60;
const FULL_YOU = 300;
const FADE = 240;
const LOW_INFO_CAP = 120;
const BREAK_AFTER = 1800;
const BREAK_BACK = 120;
const BREAK_BACK_TESTED = 300;

/** The counting rule's numbers, so tools/sim can try other values on exactly this code. */
export const RULE = {
  fullAgent: FULL_AGENT,
  fullYou: FULL_YOU,
  fade: FADE,
  lowInfoCap: LOW_INFO_CAP,
  breakAfter: BREAK_AFTER,
  breakBack: BREAK_BACK,
  breakBackTested: BREAK_BACK_TESTED,
};

/** How much of a gap counts by the curve. Same as gap_credit in src/analyze.rs. */
export function gapCredit(gap, full, fade = FADE) {
  if (gap <= full) return Math.max(0, gap);
  return full + Math.round(fade * (1 - Math.exp(-(gap - full) / fade)));
}
const LOOP_GAP = 900;
const LOOP_MIN = 3;
const FIRST_PROMPT_MAX = 120;
const DARK_FLOW_KEEP = 30;

export const TOOL_GROUPS = ["edit", "command", "read", "browser action", "web search", "subagent", "other call"];

function toolGroup(name) {
  switch (name) {
    case "Edit": case "Write": case "MultiEdit": case "NotebookEdit": return 0;
    case "Bash": case "BashOutput": case "KillShell": case "PowerShell": return 1;
    case "Read": case "Grep": case "Glob": case "LS": return 2;
    case "WebSearch": case "WebFetch": return 4;
    case "Task": case "Agent": case "SendMessage": return 5;
  }
  if (name.includes("rowser") || name.includes("chrome") || name.includes("computer")) return 3;
  return 6;
}

// First model name that appeared during an agent segment, or null.
function segModels(seg) {
  for (const m of seg.models ?? []) return m;
  return null;
}

const secs = (a, b) => Math.trunc((a - b) / 1000);
const isHuman = (e) => e.kind !== "agent";

function segment(ev, from, to, start) {
  const seg = { agent: 0, last: null, tools: [0, 0, 0, 0, 0, 0, 0], models: [], tokens: 0 };
  let prev = start;
  for (let i = from; i < to; i++) {
    const e = ev[i];
    if (e.kind !== "agent") continue;
    const d = secs(e.t, prev);
    if (d >= 0 && d <= AGENT_TIMEOUT) seg.agent += d;
    prev = e.t;
    seg.last = e.t;
    for (const n of e.tools) seg.tools[toolGroup(n)]++;
    if (e.model) seg.models.push(e.model);
    if (typeof e.tokens === "number" && Number.isFinite(e.tokens)) seg.tokens += e.tokens;
  }
  return seg;
}

export function analyzeSession(session, rule = RULE) {
  const ev = session.events;
  const start = ev.length ? ev[0].t : Date.now();
  const humans = [];
  for (let i = 0; i < ev.length; i++) if (isHuman(ev[i])) humans.push(i);
  const segs = humans.map((i, k) => segment(ev, i + 1, k + 1 < humans.length ? humans[k + 1] : ev.length, ev[i].t));

  const turns = [];
  const loopy = [];
  const typing = [];
  let lastPrompt = null;
  let ranCommand = false;

  humans.forEach((i, k) => {
    const e = ev[i];
    let prev = null;
    if (k > 0) {
      const prevT = ev[humans[k - 1]].t;
      const seg = segs[k - 1];
      const anchor = seg.last ?? prevT;
      prev = {
        gap: Math.max(0, secs(e.t, anchor)),
        agentPrev: seg.agent,
        wall: Math.max(0, secs(e.t, prevT)),
        fromAgent: seg.last !== null,
      };
    }
    const tags = [];
    let isLoopy = false;
    let typed = 0;
    let human;
    let why;
    let fromAgent = prev !== null && prev.fromAgent;
    const afterPrompt = k > 0 && ev[humans[k - 1]].kind === "prompt";
    let words = 0;

    switch (e.kind) {
      case "prompt": {
        const p = e.prompt;
        const tested = p.observation || ranCommand;
        // Live events don't carry the words, so the client works out "repeat" itself.
        const repeat =
          typeof p.repeat === "boolean" ? p.repeat : lastPrompt !== null && p.words >= 3 && similarity(p, lastPrompt) >= 0.6;
        if (p.images > 0) tags.push("screenshot");
        else if (p.observation) tags.push("reported a result");
        if (ranCommand) tags.push("ran a command first");
        if (p.specific >= 2) tags.push("specific");
        if (p.generic) tags.push("low info");
        if (repeat) tags.push("repeat");

        typed = typingSecs(p);
        // Every prompt is capped at the time since your last action, so pasting long
        // prompts back to back can't count more than the time that passed.
        if (!prev) {
          human = Math.min(typed, FIRST_PROMPT_MAX);
          why = { rule: "first" };
        } else if (afterPrompt && !prev.fromAgent) {
          // The agent never answered the last prompt, so only typing counts.
          human = Math.min(typed, FIRST_PROMPT_MAX, prev.wall);
          why = { rule: "noreply", wall: prev.wall };
        } else {
          const { gap, wall } = prev;
          if (gap > rule.breakAfter) {
            const back = tested ? rule.breakBackTested : rule.breakBack;
            human = Math.min(typed + back, wall);
            why = { rule: "break", gap, back };
          } else {
            const full = tested || !prev.fromAgent ? rule.fullYou : rule.fullAgent;
            // Replying fast means you watched the agent work, but not for a bare "ok".
            const watch = gap <= WATCH_WINDOW && !p.generic ? Math.min(prev.agentPrev, WATCH_WINDOW) : 0;
            let credit = gapCredit(gap, full, rule.fade) + watch;
            if (p.generic) credit = Math.min(credit, rule.lowInfoCap);
            const want = Math.max(credit, typed);
            human = Math.min(want, wall);
            if (human < want) why = { rule: "wall", wall };
            else if (typed > credit) why = { rule: "typing", gap, watch };
            else why = { rule: "gap", gap, watch, full, lowInfo: p.generic };
          }
        }
        isLoopy = (p.generic || repeat) && !tested;
        lastPrompt = p;
        ranCommand = false;
        words = p.words;
        break;
      }
      case "interrupt":
        // Measured from your last action, whatever the agent did since. Stopping an
        // agent that wasn't doing anything counts only a moment.
        fromAgent = false;
        [human, why] = clamped(prev ? prev.wall : null, 10, 5, prev && !prev.fromAgent ? 5 : 300);
        break;
      case "shell":
        ranCommand = true;
        [human, why] = clamped(prev ? prev.gap : null, 10, 10, 300);
        break;
      case "command":
        [human, why] = clamped(prev ? prev.gap : null, 5, 5, 30);
        break;
      case "rejected":
        [human, why] = clamped(prev ? prev.gap : null, 10, 10, 60);
        break;
      // Evidence from the project (steer's watcher and terminal lines): a command you
      // ran, files saved while the agent wasn't editing, a commit. The gap before it
      // counts by the same curve; if it started with something you did, the first
      // FULL_YOU in full.
      case "run":
      case "save":
      case "commit":
        if (e.kind === "run") ranCommand = true;
        if (session.evidence) {
          // Nothing from an AI tool within EVIDENCE_REACH: that's coding without AI,
          // which is Hackatime's job. Shown, not counted.
          human = 0;
          why = { rule: "alone" };
        } else if (!prev) {
          human = 10;
          why = { rule: "first" };
        } else {
          // steer can't check a save or a command the way it can a prompt, so only the
          // first minute of the gap before one counts in full.
          const full = rule.fullAgent;
          if (prev.gap > rule.breakAfter) {
            human = Math.min(rule.breakBack, prev.gap);
            why = { rule: "break", gap: prev.gap, back: rule.breakBack };
          } else {
            human = gapCredit(prev.gap, full, rule.fade);
            why = { rule: "evidence", gap: prev.gap, full };
          }
        }
        break;
    }

    turns.push({
      t: e.t,
      kind: e.kind,
      words,
      tags,
      human,
      flagged: 0,
      agent: segs[k].agent,
      tools: segs[k].tools,
      darkFlow: false,
      // Which rule set `human`, for the notes. Doesn't change any counting.
      why,
      fromAgent,
      typed,
      run: 0,
      // Time another session at the same moment already counted. Set by countOverlapOnce.
      overlap: 0,
      // Time past the daily or weekly payable cap, and which one. Set by applyCaps.
      capped: 0,
      cap: null,
      // For evidence: the command's name and exit code, or how many files were saved.
      detail:
        e.kind === "run" ? { name: e.name, exit: e.exit } : e.kind === "save" ? { count: e.count ?? 1 } : e.kind === "commit" ? { hash: e.hash ?? null } : null,
      // Which model ran the agent, and how many tokens it used (input + output).
      model: segModels(segs[k]) ?? e.prompt?.model ?? null,
      tokens: segs[k].tokens || (e.prompt?.tokens ?? 0),
    });
    loopy.push(isLoopy);
    typing.push(typed);
  });

  markDarkFlow(turns, loopy, typing);
  return { title: session.title, start, turns };
}

// Time for actions other than prompts: `since` kept between min and max, or a flat
// `first` if it's the first thing in the session.
function clamped(since, first, min, max) {
  if (since === null) return [Math.max(first, min), { rule: "first" }];
  return [Math.max(Math.min(since, max), min), { rule: "clamped", secs: since, min, max }];
}

function markDarkFlow(turns, loopy, typing) {
  const prompts = [];
  turns.forEach((t, i) => t.kind === "prompt" && prompts.push(i));
  let a = 0;
  while (a < prompts.length) {
    if (!loopy[prompts[a]]) {
      a++;
      continue;
    }
    let b = a;
    while (b + 1 < prompts.length && loopy[prompts[b + 1]] && secs(turns[prompts[b + 1]].t, turns[prompts[b]].t) <= LOOP_GAP) {
      b++;
    }
    if (b - a + 1 >= LOOP_MIN) {
      for (const i of prompts.slice(a, b + 1)) {
        const t = turns[i];
        const keep = Math.min(typing[i], DARK_FLOW_KEEP, t.human);
        t.flagged = t.human - keep;
        t.human = keep;
        t.darkFlow = true;
        t.run = b - a + 1;
      }
    }
    a = b + 1;
  }
}

export const sessionHuman = (s) => s.turns.reduce((n, t) => n + t.human, 0);
export const sessionAgent = (s) => s.turns.reduce((n, t) => n + t.agent, 0);
export const sessionFlagged = (s) => s.turns.reduce((n, t) => n + t.flagged, 0);
export const sessionOverlap = (s) => s.turns.reduce((n, t) => n + t.overlap, 0);
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
export const projectHuman = (p) => sum(p.sessions, sessionHuman);
export const projectAgent = (p) => sum(p.sessions, sessionAgent);
export const projectFlagged = (p) => sum(p.sessions, sessionFlagged);
export const projectOverlap = (p) => sum(p.sessions, sessionOverlap);
export const projectTokens = (p) => sum(p.sessions, (s) => s.turns.reduce((n, t) => n + (t.tokens || 0), 0));

/** Models used in a project, and how many tokens each one used. Map of name -> tokens. */
export function projectModels(p) {
  const by = new Map();
  for (const s of p.sessions) for (const t of s.turns) if (t.model) by.set(t.model, (by.get(t.model) ?? 0) + (t.tokens || 0));
  return by;
}

/** Compact token count: "1.2M", "345k", or the number itself. */
export function fmtTokens(n) {
  n = n || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Several sessions at once (two windows, two tools, two computers) would each count the
 * same minutes. A turn's time covers the stretch right before it, so going through every
 * turn of every session in time order, only the part no earlier turn already covered
 * counts. The rest moves to `overlap`. Same as count_overlap_once in src/analyze.rs.
 */
export function countOverlapOnce(turns) {
  const all = turns.filter((t) => t.human > 0).sort((a, b) => a.t - b.t);
  const covered = []; // [start, end] in ms, merged and in order
  for (const turn of all) {
    const end = turn.t;
    const start = end - turn.human * 1000;
    let already = 0;
    for (let i = covered.length - 1; i >= 0 && covered[i][1] > start; i--) {
      already += covered[i][1] - Math.max(covered[i][0], start);
    }
    const fresh = Math.floor((end - start - already) / 1000);
    turn.overlap = turn.human - fresh;
    turn.human = fresh;
    let mergedStart = start;
    while (covered.length && covered[covered.length - 1][1] >= start) mergedStart = Math.min(mergedStart, covered.pop()[0]);
    covered.push([mergedStart, end]);
  }
}

// Same order as Rust sorting PathBufs: compare folder by folder.
function comparePaths(a, b) {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}

function projectName(cwd) {
  if (!cwd) return "unknown";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  let name = parts.length ? parts[parts.length - 1] : cwd;
  // Normalize: lowercase, replace dashes with spaces, collapse whitespace
  name = name.toLowerCase().replace(/-/g, ' ');  // dashes to spaces
  name = name.replace(/\s+/g, ' ');  // collapse multiple spaces
  return name.trim();
}

/**
 * Which project a name belongs to, whatever its folder is called on each computer: a
 * folder made by hand as "Vault Books" and a clone called "vault-books" (or
 * "vault_books") are one project. Capitals don't matter, and spaces, dashes and
 * underscores between words all count the same.
 */
export function projectKey(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");
}

// Evidence counts as part of the AI session it happened during or right after: within
// this long after something from the AI tool (a prompt, a tool call, a stop), not after
// other evidence, so a stream of saves can't keep itself going.
const EVIDENCE_REACH = 30 * 60 * 1000;
const EVIDENCE_KINDS = new Set(["run", "save", "commit"]);

/**
 * Evidence from the project (sessions marked `evidence`, one per project, from the
 * server) goes into the AI session of the same project that was most recently active
 * when it happened, so it splits that session's gaps. Evidence with no AI session
 * nearby stays in its own session. Doesn't change the sessions passed in.
 */
function mergeEvidence(sessions) {
  const ai = sessions.filter((s) => !s.evidence).map((s) => ({ ...s, events: [...s.events] }));
  const out = [...ai];
  for (const ev of sessions.filter((s) => s.evidence)) {
    const key = projectKey(projectName(ev.cwd));
    const mine = ai.filter((s) => projectKey(projectName(s.cwd)) === key && s.events.length);
    const alone = [];
    for (const e of ev.events) {
      let best = null;
      for (const s of mine) {
        const before = s.events.filter((x) => x.kind !== "run" && x.kind !== "save" && x.kind !== "commit" && x.t <= e.t);
        if (!before.length) continue;
        const last = before[before.length - 1].t;
        if (e.t > last + EVIDENCE_REACH) continue;
        if (!best || last > best.last) best = { s, last };
      }
      if (best) best.s.events.push(e);
      else alone.push(e);
    }
    if (alone.length) out.push({ ...ev, events: alone });
  }
  for (const s of out) s.events.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * sessions: output of SessionReader.finish(). Doesn't change them.
 * Resumed or forked sessions copy old entries into a new file, so sessions are
 * gone through oldest first and each entry only counts the first time it shows up.
 */
export function buildReport(sessions, { days = 30, now = Date.now(), rule = RULE } = {}) {
  sessions = mergeEvidence(sessions);
  const ordered = [...sessions]
    .sort((a, b) => comparePaths(a.path, b.path))
    .sort((a, b) => a.events[0].t - b.events[0].t);
  const cutoff = days == null ? null : now - days * 86400000;
  const seen = new Set();
  const byName = new Map();

  for (const s of ordered) {
    const events = s.events.filter((e) => e.id === null || (!seen.has(e.id) && seen.add(e.id)));
    if (events.length === 0) continue;
    if (cutoff !== null && events[events.length - 1].t < cutoff) continue;
    const rep = analyzeSession({ ...s, events }, rule);
    if (rep.turns.length === 0) continue;
    rep.path = s.path;
    // One project per key, named the way it was most recently (sessions go oldest first).
    const name = projectName(s.cwd);
    const key = projectKey(name);
    if (!byName.has(key)) byName.set(key, { name, sessions: [] });
    const p = byName.get(key);
    p.name = name;
    p.sessions.push(rep);
  }

  const projects = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  countOverlapOnce(projects.flatMap((p) => p.sessions.flatMap((s) => s.turns)));
  for (const p of projects) p.sessions.sort((a, b) => b.start - a.start);
  projects.sort((a, b) => projectHuman(b) - projectHuman(a));
  return projects;
}

// ---------- report (src/report.rs) ----------

export function fmtDur(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  if (s > 0) return `${s}s`;
  return "0m";
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plural = (n, w) => (n === 1 ? `1 ${w}` : `${n} ${w}s`);
const pct = (part, whole) => (whole <= 0 ? 0 : Math.min(100, Math.max(0, (part / whole) * 100)));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const fullDate = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm(d)}`;

const ACTIONS = {
  interrupt: "Stopped agent",
  shell: "Ran command",
  command: "Slash command",
  rejected: "Rejected tool call",
  save: "Saved files",
  commit: "Committed",
};
const actionOf = (t) => {
  if (t.kind === "prompt") return `Prompt (${plural(t.words, "word")})`;
  if (t.kind === "run") return `Ran ${esc(t.detail?.name ?? "a command")}${t.detail?.exit ? " (failed)" : ""}`;
  return ACTIONS[t.kind] ?? t.kind;
};

// ---------- rules a server can change ----------

/**
 * Settings a server can change without a new release (the steer server reads them from
 * STEER_RULES). Caps limit what counts toward programs. Checks are when a day gets
 * pointed out to reviewers.
 */
export const DEFAULT_RULES = {
  dailyCapHours: 12,
  weeklyCapHours: 60,
  check: {
    dayHours: 12,
    activeSpanHours: 16,
    breakHours: 2,
    minPrompts: 10,
    unansweredShare: 0.25,
    tooFastShare: 0.3,
    minReplies: 30,
    replySecs: 15,
    minEvenPrompts: 30,
    evenCv: 0.5,
    overlapMins: 30,
    evidenceHours: 2,
    evidenceShare: 0.5,
    typingHours: 2,
    longDayHours: 8,
    shortBreakMins: 20,
    rollingHours: 14,
  },
};

/** DEFAULT_RULES with anything in `custom` on top. */
export function rulesFrom(custom = {}) {
  return { ...DEFAULT_RULES, ...custom, check: { ...DEFAULT_RULES.check, ...(custom.check ?? {}) } };
}

const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
// The Monday a UTC week starts on.
const utcWeek = (t) => {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/**
 * Payable caps. Past dailyCapHours in a UTC day, or weeklyCapHours in a UTC week, time
 * stops counting toward programs, so even a perfect script can't earn more than that.
 * Goes through every turn in time order after overlap is counted and moves what's past
 * the cap to `capped`. Only the server uses this; your own report shows your real time.
 */
export function applyCaps(projects, rules = DEFAULT_RULES) {
  const day = rules.dailyCapHours * 3600;
  const week = rules.weeklyCapHours * 3600;
  const turns = projects.flatMap((p) => p.sessions.flatMap((s) => s.turns)).sort((a, b) => a.t - b.t);
  const perDay = new Map();
  const perWeek = new Map();
  for (const t of turns) {
    if (t.human <= 0) continue;
    const d = utcDay(t.t);
    const w = utcWeek(t.t);
    const usedDay = perDay.get(d) ?? 0;
    const usedWeek = perWeek.get(w) ?? 0;
    const keep = Math.max(0, Math.min(t.human, day - usedDay, week - usedWeek));
    if (keep < t.human) {
      t.capped = t.human - keep;
      t.cap = day - usedDay <= week - usedWeek ? "day" : "week";
      t.human = keep;
    }
    perDay.set(d, usedDay + keep);
    perWeek.set(w, usedWeek + keep);
  }
}

// ---------- checks for reviewers ----------

/**
 * Things about a day that a reviewer might want to look at, worked out from the same
 * turns the totals come from. Someone can script fake events with their own key, so
 * these are how it would show. Most have honest reasons too, so they're worded as things
 * to look at. Days are UTC. Returns [{ day: "2026-11-20", notes: ["..."] }], newest first.
 */
export function checks(projects, rules = DEFAULT_RULES) {
  const c = rules.check;
  const days = new Map();
  const all = [];
  for (const p of projects) {
    for (const s of p.sessions) {
      for (const t of s.turns) {
        const day = utcDay(t.t);
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(t);
        all.push(t);
      }
    }
  }
  // The most counted in any 24 hours, by the day that window ends on, so a marathon
  // across midnight UTC shows up even though each day alone looks fine.
  all.sort((a, b) => a.t - b.t);
  const rollingMax = new Map();
  let sum = 0;
  for (let i = 0, j = 0; i < all.length; i++) {
    sum += all[i].human + (all[i].capped ?? 0);
    while (all[i].t - all[j].t >= 86400000) sum -= all[j].human + (all[j++].capped ?? 0);
    const day = utcDay(all[i].t);
    rollingMax.set(day, Math.max(rollingMax.get(day) ?? 0, sum));
  }
  const out = [];
  for (const [day, turns] of days) {
    turns.sort((a, b) => a.t - b.t);
    const notes = [];
    // Before the payable cap, so a capped day still gets pointed out.
    const human = turns.reduce((n, t) => n + t.human + (t.capped ?? 0), 0);
    const overlap = turns.reduce((n, t) => n + t.overlap, 0);
    if (human > c.dayHours * 3600) notes.push(`${fmtDur(human)} counted in one day`);

    const span = (turns[turns.length - 1].t - turns[0].t) / 1000;
    let longestBreak = 0;
    for (let i = 1; i < turns.length; i++) longestBreak = Math.max(longestBreak, (turns[i].t - turns[i - 1].t) / 1000);
    if (span > c.activeSpanHours * 3600 && longestBreak < c.breakHours * 3600) {
      notes.push(`active for ${fmtDur(span)} with no break longer than ${fmtDur(Math.round(longestBreak))}`);
    }

    const prompts = turns.filter((t) => t.kind === "prompt");
    const answered = (t) => t.agent > 0 || t.tools.some((n) => n > 0);
    const unanswered = prompts.filter((t) => !answered(t)).length;
    if (prompts.length >= c.minPrompts && unanswered > prompts.length * c.unansweredShare) {
      notes.push(`${unanswered} of ${prompts.length} prompts got no answer from an agent`);
    }
    const tooFast = prompts.filter((t) => t.why.rule === "wall").length;
    if (prompts.length >= c.minPrompts && tooFast > prompts.length * c.tooFastShare) {
      notes.push(`${tooFast} of ${prompts.length} prompts came faster than they could be typed`);
    }

    const replies = prompts.filter((t) => t.fromAgent && (t.why.rule === "gap" || t.why.rule === "typing")).map((t) => t.why.gap);
    if (replies.length >= c.minReplies) {
      replies.sort((a, b) => a - b);
      const median = replies[Math.floor(replies.length / 2)];
      if (median < c.replySecs) notes.push(`replies usually came ${median}s after the agent stopped`);
    }
    if (prompts.length >= c.minEvenPrompts) {
      const gaps = prompts.slice(1).map((t, i) => (t.t - prompts[i].t) / 1000);
      const mean = gaps.reduce((n, g) => n + g, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((n, g) => n + (g - mean) ** 2, 0) / gaps.length);
      if (mean > 0 && sd / mean < c.evenCv) notes.push("prompts came at very even intervals");
    }
    if (overlap > c.overlapMins * 60) notes.push(`${fmtDur(overlap)} in sessions at the same time, counted once`);

    // Saves and commands can't be checked like prompts can, so a day that's mostly
    // them gets pointed out.
    const fromEvidence = turns.filter((t) => EVIDENCE_KINDS.has(t.kind)).reduce((n, t) => n + t.human + (t.capped ?? 0), 0);
    if (fromEvidence > c.evidenceHours * 3600 && fromEvidence > human * c.evidenceShare) {
      notes.push(`${fmtDur(fromEvidence)} of the ${fmtDur(human)} came from code changes and commands, with ${prompts.length} prompts`);
    }
    // Typing time is worked out from how long a prompt is, which the client reports.
    const typingOnly = prompts.filter((t) => ["first", "noreply", "typing"].includes(t.why.rule)).reduce((n, t) => n + t.human + (t.capped ?? 0), 0);
    if (typingOnly > c.typingHours * 3600) notes.push(`${fmtDur(typingOnly)} counted just from typing prompts`);
    if (human > c.longDayHours * 3600 && longestBreak < c.shortBreakMins * 60) {
      notes.push(`${fmtDur(human)} counted with no break longer than ${fmtDur(Math.round(longestBreak))}`);
    }
    const rolling = rollingMax.get(day);
    if (rolling && rolling > c.rollingHours * 3600 && human <= c.dayHours * 3600) {
      notes.push(`${fmtDur(rolling)} counted in 24 hours`);
    }
    if (notes.length) out.push({ day, notes });
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : -1));
}

// ---------- the last 7 days, at the top of someone's page ----------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Numbers for the 7 days before `now` and the 7 days before that. */
export function weekly(projects, now = Date.now()) {
  const span = 7 * 86400000;
  const blank = () => ({ you: 0, agent: 0, flagged: 0, prompts: 0, tested: 0, days: new Map(), projects: new Map() });
  const weeks = [blank(), blank()];
  for (const p of projects) {
    for (const s of p.sessions) {
      for (const t of s.turns) {
        const ago = now - t.t;
        if (ago < 0 || ago >= 2 * span) continue;
        const w = weeks[ago < span ? 0 : 1];
        w.you += t.human;
        w.agent += t.agent;
        w.flagged += t.flagged;
        if (t.kind === "prompt") {
          w.prompts++;
          if (testedHow(t) !== null) w.tested++;
        }
        const day = utcDate(t.t);
        w.days.set(day, (w.days.get(day) ?? 0) + t.human);
        w.projects.set(p.name, (w.projects.get(p.name) ?? 0) + t.human);
      }
    }
  }
  return weeks.map((w) => {
    const days = [...w.days].filter(([, secs]) => secs > 0);
    const best = days.sort((a, b) => b[1] - a[1])[0] ?? null;
    const top = [...w.projects].sort((a, b) => b[1] - a[1])[0] ?? null;
    return {
      you: w.you,
      agent: w.agent,
      flagged: w.flagged,
      prompts: w.prompts,
      tested: w.tested,
      days: days.length,
      best: best && { day: best[0], secs: best[1] },
      top: top && top[1] > 0 ? { name: top[0], secs: top[1] } : null,
    };
  });
}

/** The last 7 days next to the 7 before, as an HTML fragment. */
export function renderWeekly([now, before]) {
  if (!now.you && !before.you) return "";
  const day = (b) => (b ? `${WEEKDAYS[new Date(`${b.day}T12:00:00Z`).getUTCDay()]} ${niceDay(b.day).replace(/, \d+$/, "")}, ${fmtDur(b.secs)}` : "-");
  const pctOf = (w) => (w.prompts ? share(w.tested, w.prompts) : "-");
  let line;
  if (!now.you) line = "Nothing in the last 7 days.";
  else if (!before.you) line = `${fmtDur(now.you)} of your own time in the last 7 days.`;
  else {
    const diff = now.you - before.you;
    const than = Math.abs(diff) < 60 ? "about the same as" : diff > 0 ? `${fmtDur(diff)} more than` : `${fmtDur(-diff)} less than`;
    line = `${fmtDur(now.you)} of your own time in the last 7 days, ${than} the 7 days before.`;
  }
  return `<h2>Last 7 days</h2>
<p>${line}</p>
<table class="list" style="width:auto">
<tr><th></th><th class="r">Last 7 days</th><th class="r">7 days before</th></tr>
<tr><td>Your time</td><td class="r">${fmtDur(now.you)}</td><td class="r">${fmtDur(before.you)}</td></tr>
<tr><td>Agent running by itself</td><td class="r">${fmtDur(now.agent)}</td><td class="r">${fmtDur(before.agent)}</td></tr>
<tr><td>Days you worked</td><td class="r">${now.days}</td><td class="r">${before.days}</td></tr>
<tr><td>Best day</td><td class="r">${day(now.best)}</td><td class="r">${day(before.best)}</td></tr>
<tr><td>Most time on</td><td class="r">${now.top ? esc(now.top.name) : "-"}</td><td class="r">${before.top ? esc(before.top.name) : "-"}</td></tr>
<tr><td>Prompts after you tested something</td><td class="r">${pctOf(now)}</td><td class="r">${pctOf(before)}</td></tr>
<tr><td>"Continue" loops (not counted)</td><td class="r">${fmtDur(now.flagged)}</td><td class="r">${fmtDur(before.flagged)}</td></tr>
</table>
`;
}

function renderChecks(projects, rules) {
  const found = checks(projects, rules);
  let h = `<h2>Checks</h2>\n`;
  if (!found.length) return h + "<p>Nothing stood out.</p>\n";
  h += `<p class="muted">Things a reviewer might want to look at. Most have honest reasons, like a long hackathon day or running two agents at once.</p>\n<ul>\n`;
  for (const { day, notes } of found) h += `<li>${day}: ${notes.map(esc).join(", ")}</li>\n`;
  return h + "</ul>\n";
}

// ---------- review page ----------

const utcDate = (t) => new Date(t).toISOString().slice(0, 10);
const niceDay = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

/**
 * A project cut down to the turns between two UTC days, both included ("YYYY-MM-DD",
 * or null for no limit). Run applyCaps on the whole report first, since the caps are
 * per person and day.
 */
export function projectBetween(p, from, to) {
  const lo = from ? Date.parse(`${from}T00:00:00Z`) : -Infinity;
  const hi = to ? Date.parse(`${to}T00:00:00Z`) + 86400000 : Infinity;
  const sessions = [];
  for (const s of p.sessions) {
    const turns = s.turns.filter((t) => t.t >= lo && t.t < hi);
    if (turns.length) sessions.push({ ...s, turns, start: turns[0].t });
  }
  return { ...p, sessions };
}

/** The numbers a review page is made of. */
export function reviewFacts(p) {
  const turns = p.sessions.flatMap((s) => s.turns);
  const prompts = turns.filter((t) => t.kind === "prompt");
  const days = new Map();
  for (const t of turns) {
    const day = utcDate(t.t);
    if (!days.has(day)) days.set(day, { day, you: 0, agent: 0, prompts: 0, commits: 0, changes: 0, runs: 0 });
    const d = days.get(day);
    d.you += t.human;
    d.agent += t.agent;
    if (t.kind === "prompt") d.prompts++;
    if (t.kind === "commit") d.commits++;
    if (t.kind === "save") d.changes++;
    if (t.kind === "run") d.runs++;
  }
  const byDay = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  return {
    you: projectHuman(p),
    agent: projectAgent(p),
    flagged: projectFlagged(p),
    overlap: projectOverlap(p),
    capped: sum(p.sessions, (s) => s.turns.reduce((n, t) => n + (t.capped ?? 0), 0)),
    sessions: p.sessions.filter((s) => s.turns.some((t) => t.kind === "prompt")).length,
    days: byDay.filter((d) => d.you > 0).length,
    first: byDay.length ? byDay[0].day : null,
    last: byDay.length ? byDay[byDay.length - 1].day : null,
    prompts: prompts.length,
    specific: prompts.filter((t) => t.tags.includes("specific")).length,
    tested: prompts.filter((t) => testedHow(t) !== null).length,
    lowInfo: prompts.filter((t) => t.tags.includes("low info")).length,
    tokens: sum(p.sessions, projectTokens),
    models: projectModels(p).size,
    commits: turns
      .filter((t) => t.kind === "commit")
      .map((t) => ({ t: t.t, hash: t.detail?.hash ?? null }))
      .sort((a, b) => a.t - b.t),
    changes: turns.filter((t) => t.kind === "save").length,
    runs: turns.filter((t) => t.kind === "run").length,
    byDay,
  };
}

const share = (n, of) => `${of ? Math.round((100 * n) / of) : 0}%`;
/** Hours with one decimal, the way programs write them down. */
export const hoursOf = (secs) => (Math.round(secs / 360) / 10).toFixed(1);

/** How many of the commits GitHub confirmed, from the server's lookups. */
export function commitTally(checks) {
  const n = { ok: 0, time: 0, missing: 0, unchecked: 0 };
  for (const c of Object.values(checks ?? {})) n[c.status] = (n[c.status] ?? 0) + 1;
  return n;
}

/** The written justification for a review, as plain text. */
export function justification(name, project, f, found, checks = null) {
  const span = f.first ? (f.first === f.last ? `on ${niceDay(f.first)}` : `from ${niceDay(f.first)} to ${niceDay(f.last)}`) : "";
  const lines = [];
  lines.push(
    `steer counted ${fmtDur(f.you)} of ${name}'s own time on ${project} ${span}, over ${plural(f.days, "day")} and ${plural(f.sessions, "session")} with an AI agent. ` +
      `That's the time spent writing ${plural(f.prompts, "prompt")}, reading and testing what the agent did, and changing code by hand. ` +
      `The ${fmtDur(f.agent)} the agent ran by itself isn't counted.` +
      (f.tokens ? ` Across ${f.sessions} session${f.sessions === 1 ? "" : "s"}, ${f.prompts} prompt${f.prompts === 1 ? "" : "s"} used ${fmtTokens(f.tokens)} tokens across ${f.models} model${f.models === 1 ? "" : "s"}.` : "")
  );
  if (f.prompts) {
    let l = `${share(f.specific, f.prompts)} of the prompts named files or code, and ${share(f.tested, f.prompts)} came after testing (a screenshot, a description of what happened, or a command run first).`;
    if (f.lowInfo) l += ` ${share(f.lowInfo, f.prompts)} were short ones like "continue", which count at most 2 minutes each.`;
    lines.push(l);
  }
  const seen = [];
  if (f.commits.length) seen.push(plural(f.commits.length, "commit"));
  if (f.changes) seen.push(`${plural(f.changes, "code change")} made by hand`);
  if (f.runs) seen.push(plural(f.runs, "command") + " run in a terminal");
  if (seen.length) {
    let l = `steer saw ${seen.join(", ")} as they happened.`;
    if (checks && Object.keys(checks).length) {
      const n = commitTally(checks);
      const looked = n.ok + n.time + n.missing;
      if (looked) l += ` ${n.ok} of the ${plural(looked, "commit")} looked up on GitHub ${n.ok === 1 ? "is" : "are"} there with the time steer saw${n.time ? `, ${n.time} ${n.time === 1 ? "has" : "have"} a different time` : ""}${n.missing ? `, ${n.missing} ${n.missing === 1 ? "isn't" : "aren't"} on GitHub` : ""}.`;
      const logins = [...new Set(Object.values(checks).map((c) => c.login).filter(Boolean))];
      if (logins.length) l += ` On GitHub they were made by ${logins.slice(0, 5).map((x) => `@${x}`).join(", ")}${logins.length > 5 ? " and others" : ""}.`;
    }
    lines.push(l);
  }
  const left = [];
  if (f.flagged) left.push(`${fmtDur(f.flagged)} of "continue" loops without testing`);
  if (f.overlap) left.push(`${fmtDur(f.overlap)} that overlapped another session and was counted once`);
  if (f.capped) left.push(`${fmtDur(f.capped)} past the daily or weekly cap`);
  if (left.length) lines.push(`Left out: ${left.join(", ")}.`);
  lines.push(
    found.length
      ? `Checks: ${found.map(({ day, notes }) => `${day}: ${notes.join(", ")}`).join("; ")}.`
      : "Checks: nothing stood out.",
  );
  return lines.join("\n\n");
}

/**
 * A frozen review page for one project. `info`: { name, slack, verified, from, to,
 * frozen, url, repo }. `found` is checks() for the days in the review. `facts` is
 * reviewFacts of the whole project, when only some of its sessions are passed in to draw.
 */
export function renderReview(p, info, found, rules = DEFAULT_RULES, facts = null) {
  const f = facts ?? reviewFacts(p);
  const repo = typeof info.repo === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(info.repo) ? info.repo : null;
  const text = justification(info.name, p.name, f, found, info.checks);
  const line = `${hoursOf(f.you)}h tracked with steer, review: ${info.url}`;
  const who = info.slack ? `Hack Club account ${esc(info.slack)}${info.verified ? " (verified)" : ""}` : "not linked to a Hack Club account";
  const range = `${info.from ? niceDay(info.from) : "the start"} to ${info.to ? niceDay(info.to) : niceDay(utcDate(info.frozen))}`;
  let h = `<p class="muted">Frozen ${esc(new Date(info.frozen).toUTCString())}, so it won't change. Hours from ${range} (UTC), ${who}.</p>
<h2>Hours</h2>
<table class="totals">
<tr><th>Counted</th><td>${fmtDur(f.you)} (${hoursOf(f.you)}h)</td></tr>
<tr><th>Agent ran by itself (not counted)</th><td>${fmtDur(f.agent)}</td></tr>
<tr><th>"Continue" loops (not counted)</th><td>${fmtDur(f.flagged)}</td></tr>
<tr><th>Sessions at the same time (counted once)</th><td>${fmtDur(f.overlap)}</td></tr>
${f.capped ? `<tr><th>Past the ${rules.dailyCapHours}h a day or ${rules.weeklyCapHours}h a week cap (not counted)</th><td>${fmtDur(f.capped)}</td></tr>\n` : ""}</table>
<h2>For Unified</h2>
<p><code>${esc(line)}</code></p>
<h2>Justification</h2>
${text.split("\n\n").map((l) => `<p>${esc(l)}</p>`).join("\n")}
<h2>Checks</h2>
`;
  if (!found.length) h += "<p>Nothing stood out.</p>\n";
  else {
    h += `<p class="muted">Things to look at. Most have honest reasons, like a long hackathon day or two agents at once.</p>\n<ul>\n`;
    for (const { day, notes } of found) h += `<li>${day}: ${notes.map(esc).join(", ")}</li>\n`;
    h += "</ul>\n";
  }
  h += `<h2>By day</h2>
<div class="scroll"><table class="list">
<tr><th>Day (UTC)</th><th class="r">Counted</th><th class="r">Agent</th><th class="r">Prompts</th><th class="r">Commits</th><th class="r">Code changes</th><th class="r">Commands</th></tr>
`;
  for (const d of f.byDay) {
    h += `<tr><td>${niceDay(d.day)}</td><td class="r">${fmtDur(d.you)}</td><td class="r">${fmtDur(d.agent)}</td><td class="r">${d.prompts}</td><td class="r">${d.commits}</td><td class="r">${d.changes}</td><td class="r">${d.runs}</td></tr>\n`;
  }
  h += "</table></div>\n";
  if (f.commits.length) {
    const checks = info.checks ?? null;
    const about = repo
      ? checks
        ? ` Each one was looked up on GitHub when this page was made: is it there, and does GitHub's time match when steer saw it.`
        : " Each links to it on GitHub, so you can check it's there and what it changed."
      : " No GitHub repo was given, so compare these with the project's git log.";
    h += `<h2>Commits</h2>\n<p class="muted">Seen by steer when they were made.${about}</p>\n<div class="scroll"><table class="list">\n<tr><th>When steer saw it (UTC)</th><th>Commit</th>${checks ? "<th>On GitHub</th>" : ""}</tr>\n`;
    const shown = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
    for (const c of f.commits) {
      const hash = c.hash ? (repo ? `<a href="${esc(`${repo}/commit/${c.hash}`)}">${esc(c.hash.slice(0, 12))}</a>` : `<code>${esc(c.hash.slice(0, 12))}</code>`) : "";
      let gh = "";
      if (checks) {
        const k = c.hash ? checks[c.hash] : null;
        gh = !k
          ? '<span class="muted">not looked up</span>'
          : k.status === "ok"
            ? `yes, same time${k.login ? ` (by @${esc(k.login)})` : ""}`
            : k.status === "time"
              ? `<span class="red">yes, but made ${esc(shown(k.date))}${k.login ? ` (by @${esc(k.login)})` : ""}</span>`
              : k.status === "missing"
                ? '<span class="red">not found</span>'
                : '<span class="muted">GitHub didn\'t answer</span>';
        gh = `<td>${gh}</td>`;
      }
      h += `<tr><td>${shown(c.t)}</td><td>${hash}</td>${gh}</tr>\n`;
    }
    h += "</table></div>\n";
  }
  h += `<h2>Sessions</h2>\n<p class="muted">Every action steer saw, and why it got its time (hover a note for the whole reason). In each bar, black is the person's time, gray is agent time and red is a "continue" loop.</p>\n`;
  for (const s of p.sessions) h += renderSession(s, false);
  return h + HOW;
}

/** The report itself, as an HTML fragment. */
export function renderReport(
  projects,
  {
    window: span,
    hideTitles = false,
    source = "your Claude Code logs",
    sessions: showSessions = true,
    projectLink = null,
    checks: showChecks = true,
    rules = DEFAULT_RULES,
  },
) {
  const human = sum(projects, projectHuman);
  const agent = sum(projects, projectAgent);
  const flagged = sum(projects, projectFlagged);
  const overlap = sum(projects, projectOverlap);
  const capped = sum(projects, (p) => sum(p.sessions, (s) => s.turns.reduce((n, t) => n + (t.capped ?? 0), 0)));
  const tokens = sum(projects, projectTokens);
  const models = new Map();
  for (const p of projects) for (const [m, n] of projectModels(p)) models.set(m, (models.get(m) ?? 0) + n);
  const sessions = sum(projects, (p) => p.sessions.length);
  let h = "";

  h += `<h2>Totals</h2>
<p>${plural(sessions, "session")} in ${plural(projects.length, "project")}, ${esc(span)}. Made from ${esc(source)}. Prompt text isn't included.</p>
<table class="totals">
<tr><th>Your time</th><td>${fmtDur(human)}</td></tr>
<tr><th>Agent time</th><td>${fmtDur(agent)}</td></tr>
<tr><th>1/3 rule</th><td>${fmtDur(Math.trunc(agent / 3))}</td></tr>
<tr><th>Dark flow (not counted)</th><td>${fmtDur(flagged)}</td></tr>
<tr><th>Sessions at the same time (counted once)</th><td>${fmtDur(overlap)}</td></tr>
${tokens > 0 ? `<tr><th>Tokens (input + output)</th><td>${fmtTokens(tokens)}${models.size ? ` across ${models.size} ${models.size === 1 ? "model" : "models"}` : ""}</td></tr>\n` : ""}${capped > 0 ? `<tr><th>Past the ${rules.dailyCapHours}h a day or ${rules.weeklyCapHours}h a week cap (not counted)</th><td>${fmtDur(capped)}</td></tr>\n` : ""}</table>
`;

  const scale = Math.max(1, ...projects.map((p) => Math.max(projectHuman(p), projectAgent(p))));
  if (showChecks) h += renderChecks(projects, rules);

  h += `<h2>Projects</h2>
<div class="scroll"><table class="list">
<tr><th>Project</th><th class="r">Sessions</th><th class="r">Your time</th><th class="r">Agent time</th><th class="r">1/3 rule</th><th class="bars">Black: you, gray: agent</th><th class="r">Tokens</th></tr>
`;
  for (const p of projects) {
    const ph = projectHuman(p);
    const pa = projectAgent(p);
    const name = projectLink ? `<a href="${esc(projectLink(p.name))}">${esc(p.name)}</a>` : esc(p.name);
    h += `<tr><td>${name}</td><td class="r">${p.sessions.length}</td><td class="r">${fmtDur(ph)}</td><td class="r">${fmtDur(pa)}</td><td class="r">${fmtDur(Math.trunc(pa / 3))}</td><td class="bars"><div class="bar you" style="width:${pct(ph, scale).toFixed(2)}%"></div><div class="bar agent" style="width:${pct(pa, scale).toFixed(2)}%"></div></td><td class="r">${fmtTokens(projectTokens(p))}</td></tr>\n`;
  }
  h += "</table></div>\n";
  if (!showSessions) return h;

  h += `<h2>Sessions</h2>\n<p class="muted">In each bar, black is your time, gray is agent time and red is dark flow. Breaks are left out.</p>\n`;
  for (const p of projects) {
    h += `<h3>${esc(p.name)} <span class="muted">(you ${fmtDur(projectHuman(p))}, agent ${fmtDur(projectAgent(p))})</span></h3>\n`;
    for (const s of p.sessions) h += renderSession(s, hideTitles);
  }
  return h + HOW;
}

function renderSession(s, hideTitles) {
  const title = s.title && !hideTitles ? esc(s.title) : "Session";
  const start = new Date(s.start);
  let h = `<details><summary>${fullDate(start)} &nbsp; ${title} &nbsp; <span class="muted">you ${fmtDur(sessionHuman(s))}, agent ${fmtDur(sessionAgent(s))}, ${plural(s.turns.length, "action")}</span></summary>\n`;

  h += '<div class="strip">';
  for (const t of s.turns) {
    const total = t.human + t.flagged + t.agent;
    if (total <= 0) continue;
    const you = t.darkFlow ? t.human + t.flagged : t.human;
    h += `<span class="blk" style="flex-grow:${total}"><i class="${t.darkFlow ? "h flow" : "h"}" style="flex-grow:${you}"></i><i class="a" style="flex-grow:${t.agent}"></i></span>`;
  }
  h += "</div>\n";

  h += '<div class="scroll"><table class="list turns">\n<tr><th>Time</th><th>Action</th><th>Notes</th><th class="r">Your time</th><th class="r">Agent time after</th><th>Agent did</th></tr>\n';
  const startDay = dayKey(start);
  for (const t of s.turns) {
    const d = new Date(t.t);
    const when = dayKey(d) === startDay ? hm(d) : fullDate(d);
    const action = actionOf(t);
    const note = turnNote(t);
    const before = t.human + t.flagged + t.overlap + (t.capped ?? 0);
    const you = before !== t.human ? `${fmtDur(t.human)} (was ${fmtDur(before)})` : fmtDur(t.human);
    const did = TOOL_GROUPS.map((g, i) => [g, t.tools[i]]).filter(([, n]) => n > 0).map(([g, n]) => plural(n, g));
    h += `<tr${t.darkFlow ? ' class="flow"' : ""}><td>${when}</td><td>${action}</td><td title="${esc(note.long)}">${note.short}</td><td class="r">${you}</td><td class="r">${t.agent > 0 ? fmtDur(t.agent) : ""}</td><td class="r">${did.join(", ")}</td><td class="r">${fmtTokens(t.tokens)}${t.model ? ` (${esc(t.model)})` : ""}</td></tr>\n`;
  }
  return h + "</table></div>\n</details>\n";
}

// Seconds for the hover text: "40s", "9m 12s", "1h 05m".
function exact(n) {
  n = Math.max(0, n);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

// Like fmtDur, but 0 is "0s".
const ago = (n) => (n <= 0 ? "0s" : fmtDur(n));

const TAG_WORDS = {
  screenshot: "has a screenshot",
  "reported a result": "says what happened",
  "ran a command first": "you ran a command first",
  specific: "names files or code",
  "low info": 'short, like "continue"',
  repeat: "almost the same as your last prompt",
};

// How the prompt shows you tested something, if it does. Same as `tested` above.
function testedHow(t) {
  if (t.tags.includes("screenshot")) return "you sent a screenshot";
  if (t.tags.includes("reported a result")) return "you said what happened";
  if (t.tags.includes("ran a command first")) return "you ran a command first";
  return null;
}

/**
 * Why a turn got the time it did: `short` for the notes column (HTML), `long` for
 * hovering over it (plain text). src/report.rs has the same words in note().
 */
export function turnNote(t) {
  // Time before dark flow or another session cut it down.
  const base = t.human + t.flagged + t.overlap;
  const since = t.fromAgent ? "after the agent stopped" : "after your last action";
  const shortPrompt = t.tags.includes("low info");
  const tested = testedHow(t);
  const w = t.why;
  let short;
  let long;

  if (w.rule === "first" && t.kind === "prompt") {
    short = "first prompt, just typing time";
    long = `nothing before it to measure from, so only typing time counts (${exact(t.typed)}), up to ${exact(FIRST_PROMPT_MAX)}.`;
  } else if (w.rule === "noreply") {
    short = "no reply to your last prompt, just typing time";
    long = `the agent didn't answer your last prompt, so there was nothing to read or test. only typing time counts (${exact(t.typed)}), up to ${exact(FIRST_PROMPT_MAX)} and never more than the ${exact(w.wall)} since your last prompt.`;
  } else if (w.rule === "first") {
    short = `first action, counts ${ago(base)}`;
    long = `nothing before it to measure from, so it gets a flat ${exact(base)}.`;
  } else if (w.rule === "break") {
    const isPrompt = t.kind === "prompt";
    const what = isPrompt ? "your prompt" : ({ run: "the command", save: "the save", commit: "the commit" }[t.kind] ?? "this");
    short = isPrompt ? `back after a break: ${ago(w.back)} + typing` : `back after a break: ${ago(w.back)}`;
    long = `${what} came ${exact(w.gap)} ${since}, over ${exact(BREAK_AFTER)}, so it counts as a break. we can't tell when you came back, so ${exact(w.back)} to catch up${isPrompt ? ` plus typing (${exact(t.typed)})` : ""} counts.`;
  } else if (w.rule === "gap" && w.watch > 0) {
    short = `replied ${ago(w.gap)} ${since} + ${ago(w.watch)} watching`;
    long = `you replied ${exact(w.gap)} ${since}. that's within ${exact(WATCH_WINDOW)}, so you were probably watching it work, and ${exact(w.watch)} of its run time counts too.`;
  } else if (w.rule === "gap") {
    if (base >= w.gap) short = `replied ${ago(w.gap)} ${since}`;
    else if (w.lowInfo) short = `short prompt ${ago(w.gap)} ${since}, counts ${ago(base)}`;
    else if (tested) short = `tested, ${ago(w.gap)} ${since}, counts ${ago(base)}`;
    else short = `${ago(w.gap)} ${since}, counts ${ago(base)}`;
    long = `you replied ${exact(w.gap)} ${since}. the longer a gap, the less of it counts: the first ${exact(w.full)} in full, then less and less, so ${exact(base)} of it counts.`;
    if (w.full === FULL_YOU) {
      long += tested
        ? ` it's ${exact(w.full)} in full because ${tested}.`
        : ` it's ${exact(w.full)} in full because the gap started with something you did.`;
    }
    if (w.lowInfo) long += ` short prompts like "continue" count at most ${exact(LOW_INFO_CAP)}.`;
    long += " these numbers come from a simulation matched to real logs, and will be fitted from check-in answers.";
  } else if (w.rule === "alone") {
    short = "no ai tool used near this, not counted";
    long = `nothing from an ai tool within ${exact(EVIDENCE_REACH / 1000)} of this, so it's coding without ai, which steer leaves to hackatime.`;
  } else if (w.rule === "evidence") {
    const what = { run: "you ran a command in the project", save: "you saved files in the project", commit: "you committed" }[t.kind];
    short = base >= w.gap ? `${ago(w.gap)} ${since}` : `${ago(w.gap)} ${since}, counts ${ago(base)}`;
    long = `${what} ${exact(w.gap)} ${since}. the first ${exact(w.full)} of a gap count in full, then less and less, so ${exact(base)} counts.`;
  } else if (w.rule === "typing") {
    short = "typing time, longer than the wait";
    long = `you replied ${exact(w.gap)} ${since}${w.watch > 0 ? ` (+${exact(w.watch)} watching)` : ""}, but typing it takes about ${exact(t.typed)}, so typing time counts.`;
  } else if (w.rule === "wall") {
    short = `${ago(w.wall)} since your last action`;
    long = "a prompt never counts more than the time since your last action.";
  } else {
    const asked = t.kind === "rejected" && t.fromAgent;
    const after = asked ? "after the agent asked" : since;
    const from = asked ? "since the agent asked" : t.fromAgent ? "since the agent stopped" : "since your last action";
    if (w.secs > w.max) short = `${exact(w.secs)} ${after}, capped at ${ago(w.max)}`;
    else if (w.secs < w.min) short = `under ${ago(w.min)}, counts as ${ago(w.min)}`;
    else short = `${ago(w.secs)} ${after}`;
    const range = `${exact(w.min)} to ${exact(w.max)}`;
    long = {
      interrupt: `stopping the agent means you were watching it, so the time since your last action counts, ${range}.`,
      shell: `you ran a command yourself, so the time ${from} counts, ${range}. your next prompt counts as tested.`,
      command: `slash commands count the time ${from}, ${range}.`,
      rejected: `you read what the agent wanted to do and said no. the time ${from} counts, ${range}.`,
    }[t.kind] ?? `the time ${from} counts, ${range}.`;
  }

  if (t.darkFlow) {
    const was = t.flagged > 0 ? ` it would have been ${exact(base)}: ${short}.` : "";
    short = `<span class="red">dark flow</span>: ${shortPrompt ? "short" : "repeat"} prompt in a run of ${t.run}, typing only`;
    long = `${t.run} short or repeat prompts in a row, each within ${exact(LOOP_GAP)} of the last, and none show testing. that looks like hitting retry, so only typing time counts, up to ${exact(DARK_FLOW_KEEP)}.${was}`;
  }
  if (t.capped > 0) {
    short += t.cap === "week" ? ", past the weekly cap" : ", past the daily cap";
    long += `\n${exact(t.capped)} of this is past the ${t.cap === "week" ? "weekly" : "daily"} cap, so it doesn't count toward programs.`;
  }
  if (t.overlap > 0) {
    short += ", overlaps another session";
    long += `\nanother session was already counting ${exact(t.overlap)} of this same time, so that part counts there and not here.`;
  }
  if (t.kind === "prompt" && t.tags.length > 0) long += `\nprompt: ${t.tags.map((g) => TAG_WORDS[g] ?? g).join(", ")}`;
  return { short, long };
}

const HOW = `<h2>How it counts</h2>
<ul>
<li>Your time comes from things you do: prompts, stopping the agent, rejecting a tool call, running a command.</li>
<li>Time between the agent finishing and your next prompt counts, but the longer the gap, the less of it counts: the first minute in full, then less and less, up to about 5 min. If the gap started with something you did, or the prompt has a screenshot, describes what happened, or you ran a command first, the first 5 min count in full (up to about 9 min). A gap over 30 min is a break: 2 min to catch up (5 min if you tested) plus typing.</li>
<li>Short prompts like "continue" (3 words or less with no file names, numbers or code) count at most 2 min.</li>
<li>Code you change by hand while the agent isn't editing, and your commits, count as things you did: the first minute before one in full, then less and less. Only within 30 min of using an AI tool, since coding without one is Hackatime's job.</li>
<li>These numbers were picked by simulating thousands of days of work, matched to real logs, and taking the rule that came closest to the real time. They'll be fitted from check-in answers (steer checkin on).</li>
<li>If you reply within 2 min of the agent finishing, up to 2 min of agent time counts too.</li>
<li>Typing time is guessed from how long the prompt is, about 48 words a minute, between 5s and 5 min.</li>
<li>A prompt never counts more than the time since your last action. The first prompt of a session, or one right after a prompt the agent never answered, only counts typing time, up to 2 min.</li>
<li>Stopping the agent counts the time since your last action, up to 5 min. A command you run counts up to 5 min, a slash command up to 30s and a rejected tool call up to 1 min.</li>
<li>Agent time never counts as your time.</li>
<li>3 or more short or repeated prompts in a row, each within 15 min of the last and without testing, is dark flow. Only typing time counts for those, up to 30s each.</li>
<li>Sessions running at the same time (two windows, two tools or two computers) only count the same minutes once.</li>
<li>If a session was resumed or forked, the copied messages only count once.</li>
<li>The notes say why each row got its time. Hover over a note for the numbers.</li>
<li>Prompts are only used for word counts and notes. The text isn't saved.</li>
<li>1/3 rule is agent time divided by 3, which is roughly what reviewers do now with Hackatime AI time.</li>
</ul>
`;


/** A standalone HTML file of the report, for saving. */
export function renderDocument(projects, opts, css) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>steer report</title>
<style>
${css}
</style>
</head>
<body>
<main>
<h1>steer report</h1>
${renderReport(projects, opts)}</main>
</body>
</html>
`;
}

// ---------- accuracy against check-ins ----------

/** The ways of counting the accuracy page compares. The timeouts only get to see the
 * AI tool activity steer sees, not the editor, so they show what Hackatime's and
 * WakaTime's rules would count around AI work. */
export const COUNTING_WAYS = [
  { key: "steer", name: "steer" },
  { key: "third", name: "a flat 1/3" },
  { key: "two", name: "2 minute timeout (Hackatime)" },
  { key: "fifteen", name: "15 minute timeout (WakaTime)" },
];

/** Answers a person needs before their own total is compared with their answers. */
export const MIN_ANSWERS_EACH = 10;

/** The check-in answers that mean the person was working on their project. "project"
 * and "project-ai" are the buttons from before steer 0.5.5. Waiting on the ai isn't
 * working, since the hours are meant to be the person's own work, not the agent's. */
const WORKING = new Set(["working", "project", "project-ai"]);

/**
 * For each check-in answer ("what are you doing right now?"), whether the person was on
 * their project, and how much of that moment each way of counting would have counted,
 * 0 to 1. `projects` comes from buildReport (caps applied), `sessions` is what it was
 * given, and `checkins` is [{ t, answer }].
 */
export function checkinMoments(projects, sessions, checkins, signals = null) {
  // Each turn counts the time just before the person's action.
  const counted = projects
    .flatMap((p) => p.sessions.flatMap((s) => s.turns.map((u) => ({ u, path: s.path }))))
    .filter(({ u }) => u.human > 0)
    .map(({ u, path }) => [u.t - u.human * 1000, u.t, path]);
  const times = sessions.flatMap((s) => s.events.map((e) => e.t)).sort((a, b) => a - b);
  /** How many event times are at or before t. */
  const upTo = (t) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return checkins.map((c) => {
    const i = upTo(c.t);
    const gap = i > 0 && i < times.length ? times[i] - times[i - 1] : Infinity;
    const two = gap <= 2 * 60_000 ? 1 : 0;
    const m = {
      answer: c.answer,
      on: WORKING.has(c.answer),
      steer: counted.some(([from, to]) => c.t >= from && c.t <= to) ? 1 : 0,
      third: two / 3,
      two,
      fifteen: gap <= 15 * 60_000 ? 1 : 0,
    };
    // The counting that uses the attention signals, only where they were being measured.
    if (signals && inside(signals.known, c.t)) {
      m.covered = true;
      const before = counted.some(([from, to, path]) => !signals.chats.has(path) && c.t >= from && c.t <= to);
      m.signals = !inside(signals.away, c.t) && (before || inside(signals.extra, c.t)) ? 1 : 0;
      m.running = inside(signals.agentRuns, c.t);
    }
    return m;
  });
}

// ---------- counting from attention signals (tried next to the counting above) ----------

/** "here" comes every 5 minutes while someone's at the computer. */
const PRESENCE_REACH = 6 * 60_000;
/** An "away" with no "back" after it (the watcher stopped): at most this long. */
const AWAY_OPEN = 60 * 60_000;
/** A permission prompt left longer than this wasn't being decided on the whole time. */
const DECIDE_MAX = 10 * 60_000;
/** A chat tab in front this long without anything else happening stops counting. */
const FOCUS_MAX = 30 * 60_000;
/** Writing one message for longer than this isn't all writing. */
const TYPING_MAX = 15 * 60_000;
/** A turn with no end in the log: the agent counts as working at most this long. */
const TURN_MAX = 30 * 60_000;

/** [from, to] ranges sorted and joined where they overlap. */
function mergeRanges(ranges) {
  const out = [];
  for (const [a, b] of [...ranges].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function inside(ranges, t) {
  return ranges.some(([a, b]) => t >= a && t <= b);
}

/**
 * What the attention signals say, as time ranges, from a person's stored signal events
 * (away, back, here, wait, focus, typing) and their sessions:
 * - known: when steer could tell whether they were at the computer
 * - away: when they weren't
 * - extra: time the signals show was theirs (deciding on a permission prompt, a chat tab
 *   in front, writing a chat message)
 * - chats: the browser chat sessions, which are counted from their signals alone
 * - agentRuns: when an agent was working on something they asked for
 */
export function signalsOf(events, sessions) {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const away = [];
  const known = [];
  let awayFrom = null;
  for (const e of sorted) {
    if (e.kind === "away") {
      awayFrom = e.t;
    } else if (e.kind === "back") {
      // How long they were gone comes with "back", so a lost "away" doesn't matter.
      const from = Number.isFinite(e.away_secs) ? e.t - e.away_secs * 1000 : awayFrom;
      if (from !== null && from < e.t) away.push([from, e.t]);
      awayFrom = null;
      known.push([e.t, e.t + PRESENCE_REACH]);
    } else if (e.kind === "here") {
      known.push([e.t, e.t + PRESENCE_REACH]);
    }
  }
  if (awayFrom !== null) away.push([awayFrom, awayFrom + AWAY_OPEN]);

  const bySession = new Map(sessions.map((s) => [s.path, s]));
  const extra = [];
  const chats = new Set();
  for (const e of sorted) {
    if (e.kind === "wait") {
      // Deciding: until the tool started (the yes), or whatever the session did next.
      const next = bySession.get(e.session)?.events.find((x) => x.t > e.t);
      const end = next ? (Number.isFinite(next.ms) ? next.t - next.ms : next.t) : e.t;
      extra.push([e.t, Math.min(Math.max(end, e.t), e.t + DECIDE_MAX)]);
    } else if (e.kind === "typing") {
      chats.add(e.session);
      const sent = bySession.get(e.session)?.events.find((x) => x.kind === "prompt" && x.t >= e.t);
      if (sent) extra.push([e.t, Math.min(sent.t, e.t + TYPING_MAX)]);
    }
  }
  // A chat tab in front: from "on" until "off" (or at most FOCUS_MAX).
  const open = new Map();
  for (const e of sorted.filter((x) => x.kind === "focus")) {
    chats.add(e.session);
    const from = open.get(e.session);
    if (e.on && from === undefined) open.set(e.session, e.t);
    else if (!e.on && from !== undefined) {
      extra.push([from, Math.min(e.t, from + FOCUS_MAX)]);
      open.delete(e.session);
    }
  }
  for (const from of open.values()) extra.push([from, from + FOCUS_MAX]);

  // An agent working: from a prompt to the end of that turn.
  const agentRuns = [];
  for (const s of sessions) {
    if (s.evidence) continue;
    let from = null;
    for (const e of s.events) {
      if (e.kind === "prompt") {
        if (from !== null) agentRuns.push([from, e.t]);
        from = e.t;
      } else if (from !== null && (e.stop || e.kind === "interrupt")) {
        agentRuns.push([from, e.t]);
        from = null;
      }
    }
    if (from !== null) agentRuns.push([from, Math.min(from + TURN_MAX, s.events[s.events.length - 1].t)]);
  }

  const awayRanges = mergeRanges(away);
  return {
    known: mergeRanges([...known, ...awayRanges]),
    away: awayRanges,
    extra: mergeRanges(extra),
    chats,
    agentRuns: mergeRanges(agentRuns),
  };
}

/** Adds up checkinMoments for several people (one list each). */
export function accuracy(people) {
  people = people.filter((p) => p.length);
  const all = people.flat();
  const mean = (xs, f) => (xs.length ? xs.reduce((n, x) => n + f(x), 0) / xs.length : null);
  const working = (m) => (m.on ? 1 : 0);
  const on = all.filter((m) => m.on);
  const off = all.filter((m) => !m.on);
  const truth = mean(all, working);
  const judged = people.filter((p) => p.length >= MIN_ANSWERS_EACH);
  const byAnswer = {};
  for (const m of all) byAnswer[m.answer] = (byAnswer[m.answer] ?? 0) + 1;
  // Only the answers from while the attention signals were measured, so both countings
  // are scored on the same moments.
  const measured = all.filter((m) => m.covered);
  const signals = measured.length
    ? {
        answers: measured.length,
        people: people.filter((p) => p.some((m) => m.covered)).length,
        truth: mean(measured, working),
        ways: [
          { key: "steer", name: "steer, as it counts now" },
          { key: "signals", name: "steer with the new signals" },
        ].map((w) => {
          const share = mean(measured, (m) => m[w.key]);
          return {
            ...w,
            share,
            whenOn: mean(measured.filter((m) => m.on), (m) => m[w.key]),
            whenOff: mean(measured.filter((m) => !m.on), (m) => m[w.key]),
            off: share - mean(measured, working),
          };
        }),
        // Of the working moments the new counting still missed, how many were while an
        // agent was working, which steer leaves out on purpose.
        missedWhileRunning: (() => {
          const missed = measured.filter((m) => m.on && !m.signals);
          return missed.length ? { of: missed.length, share: mean(missed, (m) => (m.running ? 1 : 0)) } : null;
        })(),
      }
    : null;
  return {
    people: people.length,
    judged: judged.length,
    answers: all.length,
    byAnswer,
    truth,
    signals,
    ways: COUNTING_WAYS.map((w) => {
      const share = mean(all, (m) => m[w.key]);
      return {
        ...w,
        share,
        whenOn: mean(on, (m) => m[w.key]),
        whenOff: mean(off, (m) => m[w.key]),
        off: share === null ? null : share - truth,
        // A way of counting can be right on average and still give some people too much
        // and others too little. This is how far each person's own total is off.
        offEach: judged.length ? mean(judged, (p) => Math.abs(mean(p, (m) => m[w.key]) - mean(p, working))) : null,
      };
    }),
  };
}

/** The accuracy page's body. */
export function renderAccuracy(a, { updated = null } = {}) {
  const pct = (x) => (x === null ? "-" : `${Math.round(x * 100)}%`);
  const points = (x, signed) => {
    if (x === null) return "-";
    const n = Math.round(x * 100);
    return `${signed && n > 0 ? "+" : ""}${n} points`;
  };
  const kinds = [
    ["working", "working on their project"],
    ["project-ai", "on their project with the AI"],
    ["project", "on their project on their own"],
    ["waiting", "waiting on the AI"],
    ["other", "doing something else"],
    ["none", "no answer"],
  ]
    .filter(([k]) => a.byAnswer[k])
    .map(([k, label]) => `${a.byAnswer[k]} ${label}`)
    .join(", ");
  let html = `<h1><a href="/">steer</a> / accuracy</h1>
<p>How close steer's numbers are to what people say they were doing. With check-ins on (<code>steer checkin on</code>), steer asks "what are you doing right now?" at random moments while someone uses an AI tool. Each answer is checked against what each way of counting would have counted at that moment. This page updates by itself as answers come in.</p>
<p><b>${a.answers} answers from ${a.people} ${a.people === 1 ? "person" : "people"}</b>${kinds ? ` (${kinds})` : ""}.${a.people < 15 ? " That's too few people to say how well it works for everyone, so these are early numbers." : ""}</p>
`;
  if (!a.answers) return html + `<p>No answers yet.</p>\n` + howAccuracy();
  html += `<h2>Results</h2>
<p>People said they were working on their project at ${pct(a.truth)} of these moments.</p>
<table class="list">
<tr><th>Way of counting</th><th>Counted</th><th>When they were working</th><th>When they weren't</th><th>Total off by</th><th>Each person off by</th></tr>
${a.ways
  .map(
    (w) =>
      `<tr><td>${esc(w.name)}</td><td>${pct(w.share)}</td><td>${pct(w.whenOn)}</td><td>${pct(w.whenOff)}</td><td>${points(w.off, true)}</td><td>${points(w.offEach, false)}</td></tr>`,
  )
  .join("\n")}
</table>
<ul>
<li><b>Counted</b>: how much of these moments it counted. The closer to ${pct(a.truth)}, the better.</li>
<li><b>When they were working</b>: of the moments people were on their project, how much it counted. Higher is better.</li>
<li><b>When they weren't</b>: of the moments they were waiting on the AI, doing something else or away, how much it counted. Lower is better.</li>
<li><b>Each person off by</b>: how far each person's own total is from their own answers, on average, for the ${a.judged} ${a.judged === 1 ? "person" : "people"} with ${MIN_ANSWERS_EACH} or more answers. This is what decides whether someone gets their real hours, since a way of counting can be right on average and still give some people too much and others too little.</li>
</ul>
`;
  html += renderSignals(a.signals, pct, points);
  if (updated) html += `<p class="muted">Worked out ${esc(updated)}.</p>\n`;
  return html + howAccuracy();
}

/** The part of the accuracy page about counting with the attention signals. */
function renderSignals(sig, pct, points) {
  let html = `<h2>With the new signals</h2>
<p>Since steer 0.5.4, steer also knows when nobody's at the computer (its idle timer), when a permission prompt is waiting on the person, and when a ChatGPT or Claude tab is in front. Counted with those: the same as now, minus time away from the computer, plus deciding on permission prompts, and browser chats counted from the tab being in front and from writing each message. The agent working by itself still counts zero. It isn't what steer counts yet. It's here to see whether it's closer.</p>
`;
  if (!sig) return html + `<p>No answers yet from while these were being measured.</p>\n`;
  html += `<p><b>${sig.answers} ${sig.answers === 1 ? "answer" : "answers"} from ${sig.people} ${sig.people === 1 ? "person" : "people"}</b> while they were being measured. People said they were working at ${pct(sig.truth)} of these moments.${sig.people < 15 ? " That's too few to tell which one is closer yet." : ""}</p>
<table class="list">
<tr><th>Way of counting</th><th>Counted</th><th>When they were working</th><th>When they weren't</th><th>Total off by</th></tr>
${sig.ways.map((w) => `<tr><td>${esc(w.name)}</td><td>${pct(w.share)}</td><td>${pct(w.whenOn)}</td><td>${pct(w.whenOff)}</td><td>${points(w.off, true)}</td></tr>`).join("\n")}
</table>
`;
  if (sig.missedWhileRunning) {
    html += `<p>Of the ${sig.missedWhileRunning.of} working ${sig.missedWhileRunning.of === 1 ? "moment" : "moments"} the new counting still missed, ${pct(sig.missedWhileRunning.share)} were while an agent was working, which steer leaves out on purpose. That's the open question: whether watching the agent work is your time.</p>\n`;
  }
  return html;
}

function howAccuracy() {
  return `<h2>How it's worked out</h2>
<ul>
<li>Check-ins only happen while someone used an AI tool in the last hour, so this is all about time around AI work.</li>
<li>Working means they picked "working on my project". "Waiting on the ai", "something else" and no answer count as not working, since the hours are meant to be the person's own work, not the agent's. The question closes by itself after 90 seconds, which usually means they were away.</li>
<li>Before steer 0.5.5 the buttons were "my project, on my own" and "my project, with the ai", and both count as working. "With the ai" could also mean waiting on it, so on those answers steer, which leaves out the agent's time, looks like it missed more than it did, and the timeouts look better than they are.</li>
<li>steer: whether the moment falls in time steer counted, with the counting steer uses today.</li>
<li>The timeouts count a moment if steer saw activity within that many minutes before and after it, which is how Hackatime and WakaTime count editor activity. Here they only see AI tool activity, not the editor.</li>
<li>A flat 1/3 is a third of what the 2 minute timeout counts, like programs that cut AI hours to a third.</li>
<li>Answers never count as time, and no names are shown. The code is <code>checkinMoments</code> and <code>accuracy</code> in <a href="https://github.com/EwoudVV/steer/blob/main/web/steer.js">web/steer.js</a>.</li>
</ul>
<p>To help, turn on check-ins: <code>steer checkin on</code></p>
`;
}
