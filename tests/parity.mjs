// Runs web/steer.js on a Claude Code projects folder and prints the same totals as
// the Rust CLI, so the two can be compared:
//   node tests/parity.mjs [folder] [days|all]
//   ./target/release/steer --days 30
// The CLI also counts the prompts from T3 Code that T3's database says the person
// wrote, and the browser can't read that. On a computer with T3, give the CLI
// T3CODE_HOME=/nowhere so both go by the logs alone.

import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionReader, buildReport, fmtDur, projectAgent, projectFlagged, projectHuman, projectOverlap } from "../web/steer.js";

const root = process.argv[2] ?? join(homedir(), ".claude", "projects");
const days = process.argv[3] === "all" ? null : Number(process.argv[3] ?? 30);

const sessions = [];
for (const dir of readdirSync(root)) {
  const folder = join(root, dir);
  if (!statSync(folder).isDirectory()) continue;
  for (const name of readdirSync(folder)) {
    const file = join(folder, name);
    if (!name.endsWith(".jsonl") || !statSync(file).isFile()) continue;
    const reader = new SessionReader(`projects/${dir}/${name}`);
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) reader.line(line);
    const session = reader.finish();
    if (session) sessions.push(session);
  }
}

const projects = buildReport(sessions, { days });
const total = (f) => projects.reduce((n, p) => n + f(p), 0);
const agent = total(projectAgent);
console.log(`${total((p) => p.sessions.length)} sessions in ${projects.length} projects`);
console.log(`  your time            ${fmtDur(total(projectHuman))}`);
console.log(`  agent time           ${fmtDur(agent)}`);
console.log(`  1/3 rule             ${fmtDur(Math.trunc(agent / 3))}`);
console.log(`  dark flow (ignored)  ${fmtDur(total(projectFlagged))}`);
console.log(`  overlap (once)       ${fmtDur(total(projectOverlap))}`);
