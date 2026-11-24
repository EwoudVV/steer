// Tests "sign in with Hack Club" against a fake Hack Club Auth, end to end:
//   node tests/login.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_PORT = 18971;
const STEER_PORT = 18972;
const STEER = `http://127.0.0.1:${STEER_PORT}`;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** One cookie a response sets, as "name=value", or undefined. */
const cookieFrom = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0];

// Who the fake Hack Club says is logging in next.
let nextUser = {};
const fake = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/oauth/authorize") {
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "authcode");
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() }).end();
  } else if (url.pathname === "/oauth/token" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "tok" }));
  } else if (url.pathname === "/oauth/userinfo" && req.headers.authorization === "Bearer tok") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(nextUser));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => fake.listen(FAKE_PORT, ok));

// An existing name-only account in the old one-key format, and one that belongs to
// someone trying to phish others.
const data = mkdtempSync(join(tmpdir(), "steer-login-"));
mkdirSync(join(data, "events"));
writeFileSync(
  join(data, "users.json"),
  JSON.stringify({
    duck: { keyHash: sha256("oldkey"), created: "2026-11-19T00:00:00Z" },
    evil: { keyHashes: [sha256("evilkey")], created: "2026-11-19T00:00:00Z" },
  }),
);

const server = spawn("node", ["server/server.mjs"], {
  env: {
    ...process.env,
    PORT: String(STEER_PORT),
    STEER_DATA: data,
    PUBLIC_URL: STEER,
    HCA_CLIENT_ID: "test-client",
    HCA_CLIENT_SECRET: "test-secret",
    HCA_BASE: `http://127.0.0.1:${FAKE_PORT}`,
    // U123 is also the account the review below belongs to.
    STEER_REVIEWERS: "UREVIEW1, UREVIEW2, U123",
  },
  stdio: "ignore",
});
for (let i = 0; i < 50; i++) {
  try {
    await fetch(STEER + "/");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const json = async (path, opts = {}) => {
  const res = await fetch(STEER + path, opts);
  return { status: res.status, body: await res.json() };
};

/** The terminal's side: starts a login, like `steer login` does. */
async function start(key, ip = "10.0.0.1") {
  const headers = { "x-forwarded-for": ip, ...(key ? { authorization: `Bearer ${key}` } : {}) };
  const res = await json("/api/cli-login", { method: "POST", headers });
  assert.equal(res.status, 200);
  return res.body;
}

/** The browser sending the login form, with the code typed in. A header set to undefined is left out. */
const typeCode = (code, userCode, headers = {}) =>
  fetch(`${STEER}/login/go`, {
    method: "POST",
    headers: Object.fromEntries(
      Object.entries({ origin: STEER, "sec-fetch-site": "same-origin", ...headers }).filter(([, v]) => v !== undefined),
    ),
    body: new URLSearchParams({ code, user_code: userCode }),
    redirect: "manual",
  });

/** Runs one whole login like `steer login` and the browser would. */
async function login(key) {
  const started = await start(key);
  const page = await (await fetch(started.url)).text();
  assert.ok(!page.includes(started.user_code), "the page doesn't show the code, it has to be typed from the terminal");
  assert.ok(page.includes('name="user_code"'));
  assert.equal((await json(`/api/cli-login/${started.code}`)).body.status, "pending");

  const go = await typeCode(started.code, started.user_code.toLowerCase().replace("-", " "));
  assert.equal(go.status, 303, "the right code goes on to hack club, typed in any case");
  const authorize = new URL(go.headers.get("location"));
  assert.equal(authorize.searchParams.get("client_id"), "test-client");
  assert.equal(authorize.searchParams.get("scope"), "openid profile slack_id verification_status");
  const cookie = go.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^steer_login=/, "the browser that typed the code gets a cookie");
  const back = await fetch(authorize, { redirect: "manual" });
  const doneRes = await fetch(back.headers.get("location"), { headers: { cookie } });
  assert.ok(cookieFrom(doneRes, "steer_session"), "the browser is signed in on the website too");
  const done = await doneRes.text();
  assert.ok(done.includes("Signed in as"), done);

  const result = (await json(`/api/cli-login/${started.code}`)).body;
  assert.equal(result.status, "done");
  assert.equal((await json(`/api/cli-login/${started.code}`)).status, 404, "the key is only handed out once");
  return result;
}

try {
  // 1. Existing account: logging in with its key links it instead of making a new one,
  // and the page says which account that is.
  nextUser = { sub: "ident!aaa", nickname: "Duck", slack_id: "U123", verification_status: "verified", ysws_eligible: true };
  const duckStart = await start("oldkey");
  assert.match(await (await fetch(duckStart.url)).text(), /uses the steer account <b>duck<\/b>/);
  const linked = await login("oldkey");
  assert.equal(linked.name, "duck");
  const events = (key) => json("/api/events", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: '{"events":[]}' });
  assert.equal((await events(linked.key)).status, 200, "new key works");
  assert.equal((await events("oldkey")).status, 200, "old key still works");
  const api = (await json("/api/u/duck")).body;
  assert.deepEqual(api.hackclub, { slack_id: "U123", verification_status: "verified", ysws_eligible: true });

  // 2. Same Hack Club account on another computer (no key): same account.
  assert.equal((await login(null)).name, "duck");

  // 3. Someone new gets a name from their nickname.
  nextUser = { sub: "ident!bbb", nickname: "Orpheus the Dino", slack_id: "U456", verification_status: "pending", ysws_eligible: false };
  assert.equal((await login(null)).name, "orpheus-the-dino");

  // 4. A different Hack Clubber can't take over a linked account, even with its key.
  nextUser = { sub: "ident!ccc", nickname: "duck", slack_id: "U789" };
  const other = await login(linked.key);
  assert.notEqual(other.name, "duck");
  assert.equal(other.name, "duck-2");

  // 5. Name-only signup is off, and bad links fail politely.
  assert.equal((await json("/api/signup", { method: "POST", body: '{"name":"sneaky"}' })).status, 410);
  assert.ok((await (await fetch(`${STEER}/auth/callback?code=x&state=nope`)).text()).includes("didn't work or expired"));
  assert.ok((await (await fetch(`${STEER}/login?code=nope`)).text()).includes("expired"));
  assert.equal((await json("/api/cli-login/nope")).body.status, "expired");

  // 6. Phishing: someone starts a login with the key of their own unlinked account and
  // sends the link to someone else. Opening it and clicking on doesn't get them anywhere.
  nextUser = { sub: "ident!victim", nickname: "victim", slack_id: "UVICTIM", verification_status: "verified", ysws_eligible: true };
  const phish = await start("evilkey", "10.6.6.6");
  const victim = { "x-forwarded-for": "10.0.0.7" };
  const lure = await (await fetch(phish.url, { headers: victim })).text();
  assert.match(lure, /uses the steer account <b>evil<\/b>/, "the page says which account gets linked");
  assert.ok(!lure.includes(phish.user_code), "and doesn't show the code to copy");
  const oldLink = await fetch(`${STEER}/login/go?code=${phish.code}`, { headers: victim, redirect: "manual" });
  assert.equal(oldLink.status, 303);
  assert.equal(oldLink.headers.get("location"), `/login?code=${phish.code}`, "the old link goes back to the code form");
  const noCode = await fetch(`${STEER}/login/go`, {
    method: "POST",
    headers: { origin: STEER, ...victim },
    body: new URLSearchParams({ code: phish.code }),
    redirect: "manual",
  });
  assert.equal(noCode.status, 400, "no code, no hack club");
  assert.equal((await typeCode(phish.code, "0000-0000", victim)).status, 400, "a wrong code doesn't go on");
  // A page on another site (or a sibling site on the same domain) that sends the form
  // with the code filled in.
  assert.equal((await typeCode(phish.code, phish.user_code, { ...victim, origin: "https://evil.example" })).status, 403);
  assert.equal((await typeCode(phish.code, phish.user_code, { ...victim, origin: "null" })).status, 403);
  assert.equal((await typeCode(phish.code, phish.user_code, { ...victim, origin: undefined, "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await json(`/api/cli-login/${phish.code}`)).body.status, "pending", "the phisher's terminal got nothing");
  assert.equal((await json("/api/u/evil")).body.hackclub, null, "and their account didn't get the victim's hack club");
  // Guessing the code: a few wrong tries and the login is gone.
  for (let i = 0; i < 4; i++) await typeCode(phish.code, `AAAA-000${i}`, { "x-forwarded-for": "10.6.6.6" });
  assert.equal((await json(`/api/cli-login/${phish.code}`)).status, 404, "5 wrong codes and the login is thrown away");
  assert.equal((await typeCode(phish.code, phish.user_code)).status, 400, "even the right code is too late then");

  // 6b. The other way round: the phisher types their own code in their own browser and
  // sends the Hack Club link on. Whoever opens it is signed in to Hack Club, but the
  // callback lands in their browser, which doesn't have the cookie, so the phisher's
  // terminal gets nothing.
  nextUser = { sub: "ident!victim2", nickname: "victim2", slack_id: "UVICTIM2", verification_status: "verified" };
  const lure2 = await start(null, "10.6.6.8");
  const go2 = await typeCode(lure2.code, lure2.user_code, { "x-forwarded-for": "10.6.6.8" });
  assert.equal(go2.status, 303);
  const back2 = await fetch(new URL(go2.headers.get("location")), { redirect: "manual" });
  const victimView = await fetch(back2.headers.get("location"), { headers: { "x-forwarded-for": "10.0.0.9" } });
  assert.equal(victimView.status, 403);
  assert.match(await victimView.text(), /has to finish in the browser where the code was typed/);
  assert.equal((await json(`/api/cli-login/${lure2.code}`)).body.status, "pending", "the phisher's terminal got nothing");

  // 7. Logins per address are limited, and none of it piles up.
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    const res = await fetch(`${STEER}/api/cli-login`, { method: "POST", headers: { "x-forwarded-for": "10.9.9.9" } });
    if (res.status === 429) limited++;
  }
  assert.equal(limited, 5, "20 logins from one address, then it has to wait");
  assert.equal((await fetch(`${STEER}/api/cli-login`, { method: "POST", headers: { "x-forwarded-for": "10.9.9.10" } })).status, 200);

  // 8. Reviewers: fraud squad or program reviewers sign in with Hack Club on a review
  // page and approve, cut or reject its hours. Anyone else can only look.
  {
    const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
    const base = { session: "s1", project: "kart", via: "claude-code" };
    const prompt = { kind: "prompt", words: 20, chars: 100, images: 0, specific: 2, observation: false, generic: false, repeat: false };
    const sent = await json("/api/events", {
      method: "POST",
      headers: { authorization: `Bearer ${linked.key}` },
      body: JSON.stringify({
        events: [
          { ...base, ...prompt, id: "k1", t: iso(200) },
          { ...base, id: "k2", kind: "tool", tool: "Edit", t: iso(190) },
          { ...base, id: "k3", kind: "stop", t: iso(150) },
          { ...base, ...prompt, id: "k4", t: iso(60) },
          { ...base, id: "k5", kind: "stop", t: iso(30) },
        ],
      }),
    });
    assert.equal(sent.body.accepted, 5);
    const made = await json("/api/submit", { method: "POST", headers: { authorization: `Bearer ${linked.key}` }, body: '{"project":"kart"}' });
    assert.equal(made.status, 201);
    const path = new URL(made.body.url).pathname;
    const id = path.slice(3);

    // Programs and fraud squad can find everything by Slack id.
    const lookupRes = await json("/api/slack/U123");
    assert.equal(lookupRes.status, 200, JSON.stringify(lookupRes.body));
    const lookup = lookupRes.body;
    assert.equal(lookup.accounts.length, 1);
    assert.equal(lookup.accounts[0].user, "duck");
    assert.equal(lookup.accounts[0].reviews[0].id, id);
    assert.equal(lookup.accounts[0].reviews[0].reviewed_hours, null);

    /** Signs in through the fake Hack Club as nextUser, returns the callback's answer. */
    const signIn = async () => {
      const go = await fetch(`${STEER}/reviewer/login?r=${id}`, { redirect: "manual", headers: { "x-forwarded-for": "10.4.4.4" } });
      assert.equal(go.status, 303);
      const started = cookieFrom(go, "steer_signin");
      const back = await fetch(go.headers.get("location"), { redirect: "manual" });
      return fetch(back.headers.get("location"), { redirect: "manual", headers: { cookie: started } });
    };
    // Someone who isn't a reviewer is signed in, but gets no form.
    nextUser = { sub: "ident!nope", nickname: "rando", slack_id: "U999" };
    const nope = await signIn();
    assert.match(await nope.text(), /isn't on this server's list of reviewers/);
    assert.ok(!(await (await fetch(STEER + path, { headers: { cookie: cookieFrom(nope, "steer_session") } })).text()).includes("<form"));

    nextUser = { sub: "ident!udo", nickname: "udo", slack_id: "UREVIEW1" };
    const yes = await signIn();
    assert.equal(yes.status, 303);
    assert.equal(yes.headers.get("location"), path);
    const cookie = cookieFrom(yes, "steer_session");
    assert.ok(cookie);
    const view = await (await fetch(STEER + path, { headers: { cookie } })).text();
    assert.ok(view.includes("<form"), "a reviewer gets the form");
    const csrf = /name="csrf" value="([^"]+)"/.exec(view)[1];
    const decide = (fields, headers = {}) =>
      fetch(`${STEER}${path}/decide`, {
        method: "POST",
        headers: { cookie, origin: STEER, "sec-fetch-site": "same-origin", ...headers },
        body: new URLSearchParams(fields),
        redirect: "manual",
      });
    assert.equal((await decide({ csrf: "wrong", action: "approve" })).status, 403, "the form's token has to match");
    assert.equal((await decide({ csrf, action: "approve" }, { origin: "https://evil.example" })).status, 403, "only from the page itself");
    assert.equal((await decide({ csrf, action: "reject" })).status, 400, "rejecting needs a note");
    assert.equal((await decide({ csrf, action: "cut", hours: "99", note: "x" })).status, 400, "can't cut to more than it was");
    assert.equal((await decide({ csrf, action: "reject", note: "no commits, nothing in the repo" })).status, 303);
    const after = await (await fetch(STEER + path)).text();
    assert.ok(after.includes("udo (UREVIEW1) rejected the hours"));
    assert.ok(after.includes("Hours after review: 0.0h"));
    assert.ok(!after.includes("<form"), "without the cookie it's just the page");
    const info = (await json(`/api${path}`)).body;
    assert.equal(info.reviewed_hours, "0.0");
    assert.equal(info.decisions[0].by, "UREVIEW1");
    assert.equal((await json("/api/slack/U123")).body.accounts[0].reviews[0].reviewed_hours, "0.0");
    assert.ok(!after.includes("</h1>\n<h2>Reviewed"), "the sign in link comes first for someone not signed in");
    assert.match(after, /<\/h1>\n<p class="muted">Fraud squad or a program reviewer\?/);

    // A reviewer can't review hours from their own Hack Club account.
    nextUser = { sub: "ident!self", nickname: "duck", slack_id: "U123" };
    const own = await signIn();
    assert.equal(own.status, 303);
    const ownCookie = cookieFrom(own, "steer_session");
    const ownView = await (await fetch(STEER + path, { headers: { cookie: ownCookie } })).text();
    assert.ok(!ownView.includes("<form"), "no form on your own hours");
    assert.match(ownView, /These are your own hours, so someone else has to review them/);
    const ownTry = await fetch(`${STEER}${path}/decide`, {
      method: "POST",
      headers: { cookie: ownCookie, origin: STEER, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ csrf: "x", action: "approve" }),
      redirect: "manual",
    });
    assert.equal(ownTry.status, 403);
    assert.equal((await json(`/api${path}`)).body.decisions.length, 1, "nothing got added");
  }

  // 9. The same server at its other address (steer.dino.icu): someone who comes in there
  // signs in there and gets install commands for it, so nothing sends them to the main one.
  {
    // fetch can't set Host, so this goes through node's http.
    const onHost = (host, path, method = "GET") =>
      new Promise((ok, fail) => {
        const req = request({ host: "127.0.0.1", port: STEER_PORT, path, method, headers: { host, "x-forwarded-for": "10.7.7.7" } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on("error", fail);
        req.end();
      });
    const started = await onHost("steer.dino.icu", "/api/cli-login", "POST");
    assert.match(JSON.parse(started.body).url, /^https:\/\/steer\.dino\.icu\/login\?code=/, "the login link stays on that address");
    const script = (await onHost("steer.dino.icu", "/install.sh")).body;
    assert.match(script, /export STEER_SERVER=https:\/\/steer\.dino\.icu\r?\n/, "and so does the account the install makes");
    assert.ok(!script.includes("hackclub.app"), "nothing in it points at the main address");
    assert.match((await onHost("steer.dino.icu", "/install.ps1")).body, /\$env:STEER_SERVER = "https:\/\/steer\.dino\.icu"/);
    assert.match((await onHost("steer.dino.icu", "/")).body, /curl -fsSL https:\/\/steer\.dino\.icu\/install\.sh \| sh/);
    const reviewer = await onHost("steer.dino.icu", "/reviewer/login?r=abcdefghijkl");
    assert.equal(new URL(reviewer.headers.location).searchParams.get("redirect_uri"), "https://steer.dino.icu/auth/callback");
    // The main address and any other host are untouched.
    assert.match(await (await fetch(`${STEER}/install.sh`)).text(), /export STEER_SERVER=https:\/\/steer\.duck\.hackclub\.app\r?\n/);
    const other = await onHost("evil.example", "/api/cli-login", "POST");
    assert.ok(JSON.parse(other.body).url.startsWith(`${STEER}/login?code=`), "a made-up Host header gets the main address");
  }

  // 10. Your steer: signing in on the website to see your projects, submit one for
  // review and delete your account, without the terminal.
  {
    const ip = { "x-forwarded-for": "10.5.5.5" };
    /** Signs in on the website as nextUser and returns the session cookie. */
    const webSignIn = async () => {
      const go = await fetch(`${STEER}/me/login`, { redirect: "manual", headers: ip });
      assert.equal(go.status, 303);
      const back = await fetch(go.headers.get("location"), { redirect: "manual" });
      const done = await fetch(back.headers.get("location"), { redirect: "manual", headers: { cookie: cookieFrom(go, "steer_signin") } });
      assert.equal(done.status, 303);
      assert.equal(done.headers.get("location"), "/me");
      return cookieFrom(done, "steer_session");
    };
    const get = async (path, cookie) => (await fetch(STEER + path, { headers: { cookie } })).text();
    const post = (path, cookie, fields, headers = {}) =>
      fetch(STEER + path, {
        method: "POST",
        headers: { cookie, origin: STEER, "sec-fetch-site": "same-origin", ...headers },
        body: new URLSearchParams(fields),
        redirect: "manual",
      });

    assert.match(await get("/me", ""), /Sign in with Hack Club/, "signed out, it asks you to sign in");

    // A sign-in that comes back in another browser doesn't sign that browser in.
    nextUser = { sub: "ident!aaa", nickname: "Duck", slack_id: "U123", verification_status: "verified", ysws_eligible: true };
    const go = await fetch(`${STEER}/me/login`, { redirect: "manual", headers: ip });
    const back = await fetch(go.headers.get("location"), { redirect: "manual" });
    const elsewhere = await fetch(back.headers.get("location"), { redirect: "manual" });
    assert.equal(elsewhere.status, 403);
    assert.equal(cookieFrom(elsewhere, "steer_session"), undefined);

    const cookie = await webSignIn();
    const home = await get("/me", cookie);
    assert.match(home, /steer account <a href="\/u\/duck">duck<\/a>/);
    assert.match(home, /href="\/me\/submit\?project=kart"/, "the project from the terminal tests is there");
    assert.match(home, /rejected<\/span> by udo/, "with what the reviewer decided on its review page");
    assert.match(home, /You're on the reviewer list/, "U123 is a reviewer in these tests");

    // Submitting from the website.
    const form = await get("/me/submit?project=kart", cookie);
    const csrf = /name="csrf" value="([^"]+)"/.exec(form)[1];
    assert.equal((await post("/me/submit", cookie, { csrf: "nope", project: "kart" })).status, 403, "needs the form's token");
    assert.equal((await post("/me/submit", cookie, { csrf, project: "kart" }, { origin: "https://evil.example" })).status, 403, "only from steer itself");
    const badRepo = await post("/me/submit", cookie, { csrf, project: "kart", repo: "https://gitlab.com/duck/kart" });
    assert.equal(badRepo.status, 400);
    assert.match(await badRepo.text(), /The repo should look like/);
    const made = await post("/me/submit", cookie, { csrf, project: "kart", repo: "github.com/duck/kart.git", from: "", to: "" });
    assert.equal(made.status, 303);
    const id = /^\/me\?made=([A-Za-z0-9_-]{12})$/.exec(made.headers.get("location"))[1];
    const review = (await json(`/api/r/${id}`)).body;
    assert.equal(review.user, "duck");
    assert.equal(review.repo, "https://github.com/duck/kart", "the repo gets cleaned up");
    assert.ok((await get(`/me?made=${id}`, cookie)).includes(review.line), "the line to paste is on the page");
    assert.match(await get("/me/submit?project=kart", cookie), /value="https:\/\/github\.com\/duck\/kart"/, "next time the repo is filled in");

    // Signing out.
    const out = await post("/me/logout", cookie, { csrf });
    assert.equal(out.headers.get("location"), "/");
    assert.match(await get("/me", cookie), /Sign in with Hack Club/, "the old cookie doesn't work after that");

    // A Hack Club account without steer gets the install commands.
    nextUser = { sub: "ident!new", nickname: "newbie", slack_id: "UNEW" };
    const newbie = await webSignIn();
    const empty = await get("/me", newbie);
    assert.match(empty, /doesn't have steer yet/);
    assert.match(empty, /install\.sh \| sh/);
    assert.equal((await fetch(`${STEER}/me/submit?project=kart`, { headers: { cookie: newbie }, redirect: "manual" })).status, 303, "nothing to submit");

    // Deleting the account takes everything with it.
    nextUser = { sub: "ident!aaa", nickname: "Duck", slack_id: "U123", verification_status: "verified", ysws_eligible: true };
    const again = await webSignIn();
    const sure = await get("/me/delete", again);
    assert.match(sure, /Type duck to confirm/);
    const csrf2 = /name="csrf" value="([^"]+)"/.exec(sure)[1];
    const reviews = (await json("/api/slack/U123")).body.accounts[0].reviews.map((r) => r.id);
    assert.equal(reviews.length, 2);
    assert.equal((await post("/me/delete", again, { csrf: csrf2, confirm: "dcuk" })).status, 400, "the name has to match");
    assert.equal((await json("/api/u/duck")).status, 200);
    const gone = await post("/me/delete", again, { csrf: csrf2, confirm: " Duck " });
    assert.equal(gone.status, 200);
    assert.match(await gone.text(), /is gone from the server/);
    assert.equal((await json("/api/u/duck")).status, 404);
    for (const r of reviews) assert.equal((await fetch(`${STEER}/r/${r}`)).status, 404);
    assert.equal((await events(linked.key)).status, 401, "its keys stop working");
    assert.equal((await events("oldkey")).status, 401);
    assert.deepEqual((await json("/api/slack/U123")).body.accounts, []);
    assert.ok(!existsSync(join(data, "events", "duck.jsonl")), "the events file is gone");
    assert.match(await get("/me", again), /Sign in with Hack Club/, "and that browser is signed out");
  }

  console.log("login tests passed");
} finally {
  server.kill();
  fake.close();
  rmSync(data, { recursive: true, force: true });
}
