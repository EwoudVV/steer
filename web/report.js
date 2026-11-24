import { SessionReader, buildReport, renderDocument, renderReport } from "./steer.js";

const $ = (id) => document.getElementById(id);

// The saved report carries a copy of this page's stylesheet so it looks the same offline.
const pageCss = () =>
  [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n");

let sessions = [];
let current = null;

// Works whether someone picks ~/.claude, ~/.claude/projects or a single project
// folder. If there's a projects folder, only files right inside its project folders
// count, so other files in ~/.claude (like history.jsonl) never get read. Subagent
// logs are skipped, same as the CLI.
function wanted(path, underProjects) {
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || !parts[parts.length - 1].endsWith(".jsonl")) return false;
  const i = parts.lastIndexOf("projects");
  if (underProjects) return i >= 0 && parts.length - i === 3;
  return parts.length <= 2;
}

// Reads a file a chunk at a time. Some session files are hundreds of MB.
async function readLines(file, onLine) {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let pending = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const pieces = value.split("\n");
    if (pieces.length === 1) {
      pending.push(value);
      continue;
    }
    pending.push(pieces[0]);
    onLine(pending.join(""));
    for (let k = 1; k < pieces.length - 1; k++) onLine(pieces[k]);
    pending = [pieces[pieces.length - 1]];
  }
  const last = pending.join("");
  if (last) onLine(last);
}

const mb = (n) => (n / 1e6).toFixed(0);

/** entries: [{ path, file }] */
export async function load(entries) {
  const underProjects = entries.some((e) => e.path.split("/").includes("projects"));
  const files = entries.filter((e) => wanted(e.path, underProjects));
  if (!files.length) {
    $("status").textContent = "No session files in there. Pick the projects folder inside .claude.";
    return;
  }
  sessions = [];
  const total = files.reduce((n, e) => n + e.file.size, 0);
  let done = 0;
  for (const [i, { path, file }] of files.entries()) {
    $("status").textContent = `Reading file ${i + 1} of ${files.length} (${mb(done)} of ${mb(total)} MB)`;
    const reader = new SessionReader(path);
    await readLines(file, (line) => reader.line(line));
    const session = reader.finish();
    if (session) sessions.push(session);
    done += file.size;
  }
  $("status").textContent = `Read ${files.length === 1 ? "1 file" : `${files.length} files`}, ${mb(total)} MB.`;
  show();
}

function show() {
  if (!sessions.length) return;
  const value = $("days").value;
  const days = value === "all" ? null : Number(value);
  const opts = {
    window: days == null ? "all time" : days === 1 ? "last day" : `last ${days} days`,
    hideTitles: $("hide").checked,
  };
  const projects = buildReport(sessions, { days });
  if (!projects.length) {
    $("report").innerHTML = "<p>No sessions in that time range.</p>";
    $("save").classList.add("hidden");
    current = null;
    return;
  }
  $("report").innerHTML = renderReport(projects, opts);
  $("save").classList.remove("hidden");
  current = { projects, opts };
}

async function walk(entry, out) {
  if (entry.isFile) {
    if (entry.name.endsWith(".jsonl")) {
      const file = await new Promise((ok, fail) => entry.file(ok, fail));
      out.push({ path: entry.fullPath.replace(/^\/+/, ""), file });
    }
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) break;
    for (const child of batch) await walk(child, out);
  }
}

$("choose").addEventListener("click", () => $("pick").click());
$("pick").addEventListener("change", () => {
  const picked = [...$("pick").files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
  load(picked);
});

const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const roots = [...e.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  $("status").textContent = "Looking for session files...";
  const entries = [];
  for (const root of roots) await walk(root, entries);
  load(entries);
});

$("days").addEventListener("change", show);
$("hide").addEventListener("change", show);
$("save").addEventListener("click", () => {
  if (!current) return;
  const blob = new Blob([renderDocument(current.projects, current.opts, pageCss())], { type: "text/html" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "steer-report.html";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
