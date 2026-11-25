// Installs steer into a throwaway home folder and runs it like a real user would:
// install, a Claude Code hook event reaching the server, the watcher, doctor, an update
// from a fake GitHub, and uninstall. Run it after a release build:
//   cargo build --release && node tests/install.mjs [path/to/steer]

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const windows = process.platform === "win32";
const built = resolve(process.argv[2] ?? `target/release/steer${windows ? ".exe" : ""}`);
const STEER_PORT = 18975;
const RELEASES_PORT = 18976;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = mkdtempSync(join(tmpdir(), "steer-home-"));
const data = mkdtempSync(join(tmpdir(), "steer-data-"));
const steerDir = join(home, ".steer");
const bin = join(steerDir, "bin", windows ? "steer.exe" : "steer");
mkdirSync(join(home, ".claude"));
mkdirSync(join(home, "proj"));

// STEER_SANDBOX keeps steer away from things that aren't under HOME (launchd, systemd,
// the registry, the Windows PATH).
const env = { ...process.env, HOME: home, USERPROFILE: home, STEER_NO_BROWSER: "1", STEER_SANDBOX: "1" };
for (const k of ["STEER_HOME", "CODEX_HOME", "COPILOT_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "ZDOTDIR", "STEER_NO_UPDATE", "HCA_CLIENT_ID", "HCA_CLIENT_SECRET"]) delete env[k];
env.STEER_RELEASES = `http://127.0.0.1:${RELEASES_PORT}/releases`;

// The fake release below is signed with a test key by the same script the release
// workflow uses. steer only takes this key because STEER_RELEASES is set too.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
env.STEER_RELEASE_KEY = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
const signed = mkdtempSync(join(tmpdir(), "steer-signed-"));
const names = ["steer-macos-arm64", "steer-macos-x64", "steer-linux-x64", "steer-linux-arm64", "steer-windows-x64.exe"];
for (const name of names) copyFileSync(built, join(signed, name));
const signing = spawnSync(process.execPath, ["tools/sign-release.mjs", "999.0.0", ...names.map((n) => join(signed, n))], {
  env: { ...process.env, STEER_SIGNING_KEY: privateKey.export({ type: "pkcs8", format: "pem" }) },
  encoding: "utf8",
});
assert.equal(signing.status, 0, signing.stderr);
let badSig = false;

// Chrome is "installed", so install registers steer for the browser extension. (Windows
// keeps that in the registry, which STEER_SANDBOX leaves alone.)
const EXTENSION = "chrome-extension://badjomjdmajniieefpgbnglnocamhmck/";
const chromeDir = process.platform === "darwin" ? join(home, "Library", "Application Support", "Google", "Chrome") : join(home, ".config", "google-chrome");
const hostManifest = join(chromeDir, "NativeMessagingHosts", "app.steer.native.json");
if (!windows) mkdirSync(chromeDir, { recursive: true });

// On Mac and Linux install adds steer to the PATH in the shell's startup file.
env.SHELL = "/bin/bash";
const startup = join(home, process.platform === "darwin" ? ".bash_profile" : ".bashrc");
writeFileSync(startup, "echo hi\n");

/** Runs steer and returns its output. Fails the test on a non-zero exit unless `allowFail`.
 * Not spawnSync: that would block the fake GitHub below, which runs in this process.
 * Also fails if steer's output pipe stays open after it exits, which means a background
 * process it started kept it. Claude Code would then wait on every hook. */
async function steer(exe, args, { input, allowFail } = {}) {
  console.log(`  steer ${args.join(" ")}`);
  const child = spawn(exe, args, { env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  // Commands that don't read stdin can exit before it's written. That's fine.
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
  const closed = new Promise((ok) => child.on("close", () => ok(true)));
  const timer = setTimeout(() => child.kill(), 60_000);
  const code = await new Promise((ok) => child.on("exit", ok));
  clearTimeout(timer);
  const pipeClosed = await Promise.race([closed, sleep(5_000).then(() => false)]);
  assert.ok(pipeClosed, `steer ${args.join(" ")} exited but something it started kept its output pipe open:\n${out}`);
  if (!allowFail) assert.equal(code, 0, `steer ${args.join(" ")} failed:\n${out}`);
  return out;
}

async function until(what, check, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await check()) return;
  assert.fail(`timed out waiting for ${what}`);
}

// A fake github.com/EwoudVV/steer/releases. The download is just this same build, with
// the signatures made above (or a wrong one while badSig is on).
let latest = null;
const releases = createServer((req, res) => {
  const name = req.url.split("/").pop();
  if (req.url === "/releases/latest") {
    res.writeHead(302, { location: `http://127.0.0.1:${RELEASES_PORT}/releases/tag/v${latest}` }).end();
  } else if (req.url.startsWith(`/releases/download/v${latest}/steer-`) && name.endsWith(".sig")) {
    const sig = join(signed, name);
    if (badSig) res.writeHead(200).end("ab".repeat(64));
    else if (latest === "999.0.0" && existsSync(sig)) res.writeHead(200).end(readFileSync(sig));
    else res.writeHead(404).end();
  } else if (req.url.startsWith(`/releases/download/v${latest}/steer-`)) {
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(built));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => releases.listen(RELEASES_PORT, ok));

// The real server, with name-only signup since there's no Hack Club login set up.
const server = spawn("node", ["server/server.mjs"], {
  env: { ...env, PORT: String(STEER_PORT), STEER_DATA: data, PUBLIC_URL: `http://127.0.0.1:${STEER_PORT}` },
  stdio: "ignore",
});
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`http://127.0.0.1:${STEER_PORT}/`);
    break;
  } catch {
    await sleep(100);
  }
}

let watcher;
try {
  const version = (await steer(built, ["version"])).trim();
  assert.match(version, /^steer \d+\.\d+\.\d+$/);
  latest = version.split(" ")[1];

  // 1. Install. Signing in through the browser can't happen here, so sign up first.
  console.log("step 1");
  await steer(built, ["signup", "ci", "--server", `http://127.0.0.1:${STEER_PORT}`]);
  // Typed answers: go ahead, then yes to check-ins (asked where a dialog can show).
  const installed = await steer(built, ["install"], { input: "y\ny\n" });
  const checkinFlag = join(steerDir, "checkin");
  if (installed.includes("turn on check-ins?")) {
    assert.match(installed, /check-ins are on, thanks!/);
    assert.ok(existsSync(checkinFlag));
    // Off again, so the watcher started below doesn't pop questions up during the test.
    assert.match(await steer(built, ["checkin", "off"]), /check-ins are off/);
  } else {
    assert.equal(process.platform, "linux", "mac and windows can always show the question");
  }
  assert.match(installed, /found: claude code/);
  assert.match(installed, /done! your page: http:\/\/127\.0\.0\.1:\d+\/u\/ci/);
  assert.ok(existsSync(bin), "steer was copied into ~/.steer/bin");
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.hooks.UserPromptSubmit[0].hooks[0].command.includes(join(".steer", "bin")));
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop", "UserPromptSubmit"]);
  assert.equal(settings.hooks.PermissionRequest[0].matcher, "*");
  assert.match(await steer(bin, []), /account: ci/, "plain steer shows the status once it's set up");
  if (!windows) {
    const host = JSON.parse(readFileSync(hostManifest, "utf8"));
    assert.equal(host.path, bin, "chrome starts the installed steer");
    assert.deepEqual(host.allowed_origins, ["chrome-extension://hbdpmjejoniaeejpnobbhpfbphppokgp/", EXTENSION], "and only for steer's extension");
  }
  if (!windows) assert.match(readFileSync(startup, "utf8"), /^echo hi\n\n# added by steer.*\nexport PATH=".*\.steer.bin:\$PATH"\n$/);

  // 2. A prompt in Claude Code reaches the server, with counts and no text.
  console.log("step 2");
  const prompt = "make the save button blue and show a message when it worked";
  const hookOut = await steer(bin, ["hook"], {
    input: JSON.stringify({ session_id: "s1", cwd: join(home, "proj"), hook_event_name: "UserPromptSubmit", prompt }),
  });
  assert.equal(hookOut, "", "the hook prints nothing, anything printed would be added to the prompt");
  const eventsFile = join(data, "events", "ci.jsonl");
  await until("the event to reach the server", async () => {
    if (!existsSync(eventsFile)) await steer(bin, ["flush"], { allowFail: true });
    return existsSync(eventsFile);
  });
  const sent = readFileSync(eventsFile, "utf8");
  assert.match(sent, /"project":"proj"/);
  assert.match(sent, /"words":12/);
  assert.ok(!sent.includes("blue"), "prompt text never leaves the computer");
  assert.match(await steer(bin, ["status"]), /last sent: just now/);

  // A message from another agent and a scheduled prompt come through the same hook as
  // typed ones. They're checked against Claude Code's log and only the typed one is sent.
  const log = join(home, ".claude", "projects", "proj", "s2.jsonl");
  mkdirSync(dirname(log), { recursive: true });
  const nowIso = new Date().toISOString();
  const said = {
    typed: "the jump feels floaty, lower the gravity in player.rs",
    peer: "Another session says the build finished",
    scheduled: "Check the inbox and summarize it",
  };
  writeFileSync(
    log,
    [
      { type: "user", timestamp: nowIso, origin: { kind: "human" }, message: { role: "user", content: said.typed } },
      { type: "user", timestamp: nowIso, origin: { kind: "peer" }, message: { role: "user", content: said.peer } },
      { type: "user", timestamp: nowIso, isMeta: true, promptSource: "system", turnOrigin: "scheduled", message: { role: "user", content: said.scheduled } },
    ].map((l) => JSON.stringify(l) + "\n").join(""),
  );
  for (const text of Object.values(said)) {
    await steer(bin, ["hook"], {
      input: JSON.stringify({ session_id: "s2", transcript_path: log, cwd: join(home, "proj"), hook_event_name: "UserPromptSubmit", prompt: text }),
    });
  }
  const s2Prompts = () => readFileSync(eventsFile, "utf8").split("\n").filter((l) => l.includes('"session":"s2"') && l.includes('"kind":"prompt"'));
  await until("the typed prompt to reach the server", async () => {
    await steer(bin, ["flush"], { allowFail: true });
    return s2Prompts().length > 0;
  });
  await steer(bin, ["flush"], { allowFail: true });
  assert.equal(s2Prompts().length, 1, "only the typed prompt is sent");
  assert.ok(!readFileSync(eventsFile, "utf8").includes(log), "the log's path never leaves the computer");

  // A permission prompt, a tool that ran 1.2 seconds, and one the person stopped. What
  // reaches the server says when, and nothing about the command.
  const hookIn = (o) => JSON.stringify({ session_id: "s3", cwd: join(home, "proj"), permission_mode: "default", ...o });
  await steer(bin, ["hook"], { input: hookIn({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf secret-folder" } }) });
  await steer(bin, ["hook"], { input: hookIn({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm -rf secret-folder" }, tool_response: {}, duration_ms: 1200 }) });
  await steer(bin, ["hook"], { input: hookIn({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: {}, error: "stopped", is_interrupt: true }) });
  const s3 = () => readFileSync(eventsFile, "utf8").split("\n").filter((l) => l.includes('"session":"s3"')).map((l) => JSON.parse(l));
  await until("the hook events to reach the server", async () => {
    await steer(bin, ["flush"], { allowFail: true });
    return s3().length >= 3;
  });
  assert.deepEqual(
    s3().map((e) => [e.kind, e.reason ?? e.ms ?? null]),
    [
      ["wait", "permission"],
      ["tool", 1200],
      ["interrupt", null],
    ],
  );
  assert.ok(!readFileSync(eventsFile, "utf8").includes("secret-folder"), "the command never leaves the computer");

  // A prompt on ChatGPT, through the browser extension. Chrome starts steer with the
  // extension's origin and they talk in messages of a 4-byte length and then JSON.
  async function fromBrowser(message) {
    const child = spawn(bin, [EXTENSION], { env });
    let out = Buffer.alloc(0);
    child.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
    const body = Buffer.from(JSON.stringify(message));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    child.stdin.end(Buffer.concat([length, body]));
    const code = await new Promise((ok) => child.on("close", ok));
    assert.equal(code, 0);
    assert.equal(out.readUInt32LE(0), out.length - 4, "one whole message back, nothing else on stdout");
    return JSON.parse(out.subarray(4).toString());
  }
  const shown = await fromBrowser({ kind: "projects" });
  assert.equal(shown.signed_in, true);
  assert.equal(shown.user, "ci");
  const counts = { via: "chatgpt", session: "chatgpt-t-7", words: 14, chars: 80, images: 1, specific: 2, observation: true, generic: false, repeat: false };
  assert.deepEqual(await fromBrowser({ kind: "prompt", ...counts }), { ok: true });
  const fromChatgpt = () => readFileSync(eventsFile, "utf8").split("\n").filter((l) => l.includes('"session":"chatgpt:chatgpt-t-7"'));
  // The host starts a flush itself, like the hooks do.
  await until("the chatgpt prompt to reach the server", () => fromChatgpt().length > 0);
  assert.match(fromChatgpt()[0], /"via":"chatgpt"/);
  assert.match(fromChatgpt()[0], /"words":14/);
  assert.deepEqual(await fromBrowser({ kind: "prompt", ...counts, via: "somewhere-else" }), { ok: false });

  // 3. The watcher starts and checks in.
  console.log("step 3");
  watcher = spawn(bin, ["watch"], { env, stdio: "ignore" });
  await until("the watcher to check in", () => existsSync(join(steerDir, "watch.lock")));

  // 4. Doctor is happy.
  console.log("step 4");
  assert.match(await steer(bin, ["doctor"]), /everything looks good/);

  // 5. A new version comes out. steer update swaps itself out while it runs, which on
  console.log("step 5");
  // Windows means renaming its own exe, and restarts the watcher.
  latest = "999.0.0";
  assert.match(await steer(bin, ["doctor"], { allowFail: true }), /steer 999\.0\.0 is out, run steer update/);
  // A download whose signature doesn't check out against the release key stays out.
  badSig = true;
  assert.match(await steer(bin, ["update"], { allowFail: true }), /isn't signed with steer's release key/);
  assert.equal((await steer(bin, ["version"])).trim(), version, "the old steer is still the one installed");
  badSig = false;
  assert.match(await steer(bin, ["update"]), new RegExp(`updated steer from ${version.split(" ")[1].replaceAll(".", "\\.")} to 999\\.0\\.0`));
  assert.equal((await steer(bin, ["version"])).trim(), version, "the swapped in steer runs");
  const leftovers = readdirSync(join(steerDir, "bin")).filter((f) => f.startsWith("steer-new-"));
  assert.deepEqual(leftovers, [], "no half finished downloads left behind");

  // 6. Uninstall takes the hooks out and deletes ~/.steer. Stop the watcher first, it
  console.log("step 6");
  // was started by this test rather than a login item. (On Windows the update just
  // restarted it, so wait for the new one to check in.)
  const lock = join(steerDir, "watch.lock");
  await until("the watcher after the update", () => existsSync(lock) && readFileSync(lock, "utf8").trim() !== "");
  const pid = readFileSync(lock, "utf8").trim();
  if (windows) spawnSync("taskkill", ["/PID", pid, "/F"]);
  else spawnSync("kill", [pid]);
  watcher.kill();
  const removed = await steer(bin, ["uninstall", "--yes"]);
  assert.match(removed, /took 5 steer hooks out/);
  if (!windows) assert.ok(!existsSync(hostManifest), "chrome can't start steer anymore");
  const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(after.hooks, undefined, "no steer hooks left in claude code settings");
  await until("~/.steer to be deleted", () => !existsSync(steerDir));
  assert.equal(readFileSync(startup, "utf8"), "echo hi\n", "the startup file is back to how it was");

  console.log("install tests passed");
} finally {
  watcher?.kill();
  // A watcher restarted by steer update isn't a child of this test.
  const lockFile = join(steerDir, "watch.lock");
  if (existsSync(lockFile)) {
    const left = readFileSync(lockFile, "utf8").trim();
    if (left) spawnSync(windows ? "taskkill" : "kill", windows ? ["/PID", left, "/F"] : [left]);
  }
  server.kill();
  releases.close();
  await sleep(500);
  rmSync(home, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  rmSync(signed, { recursive: true, force: true });
}
