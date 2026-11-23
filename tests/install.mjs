// Installs steer into a throwaway home folder and runs it like a real user would:
// install, a Claude Code hook event reaching the server, the watcher, doctor, an update
// from a fake GitHub, and uninstall. Run it after a release build:
//   cargo build --release && node tests/install.mjs [path/to/steer]

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
for (const k of ["STEER_HOME", "CODEX_HOME", "COPILOT_HOME", "XDG_DATA_HOME", "ZDOTDIR", "STEER_NO_UPDATE", "HCA_CLIENT_ID", "HCA_CLIENT_SECRET", "T3CODE_HOME", "T3CODE_THREAD_ID"]) delete env[k];
env.STEER_RELEASES = `http://127.0.0.1:${RELEASES_PORT}/releases`;

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

// A fake github.com/EwoudVV/steer/releases. The download is just this same build.
let latest = null;
const releases = createServer((req, res) => {
  if (req.url === "/releases/latest") {
    res.writeHead(302, { location: `http://127.0.0.1:${RELEASES_PORT}/releases/tag/v${latest}` }).end();
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
  const installed = await steer(built, ["install", "--yes"]);
  assert.match(installed, /found: claude code/);
  assert.match(installed, /done! your page: http:\/\/127\.0\.0\.1:\d+\/u\/ci/);
  assert.ok(existsSync(bin), "steer was copied into ~/.steer/bin");
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.hooks.UserPromptSubmit[0].hooks[0].command.includes(join(".steer", "bin")));
  assert.match(await steer(bin, []), /account: ci/, "plain steer shows the status once it's set up");
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
  assert.match(removed, /took 3 steer hooks out/);
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
}
