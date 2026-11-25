// steer for VS Code and Cursor. Notes two things and writes them to ~/.steer, where the
// steer app picks them up:
// - stretches of time someone is working in a project's files (typing, clicking or
//   scrolling in a file while the window is in front), in ~/.steer/editor
// - stretches of time the window is in front with a project open, in ~/.steer/editor-front.
//   Reading an agent's answer in its chat or in the terminal happens there without
//   touching a file. steer only counts these between the agent stopping and the next
//   prompt, and not while nobody's touching the computer.
// Each one is the project folder, when it started and ended, and which editor. steer only
// sends the project's name and the times. No file names, no code, nothing about what was
// typed or read.
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = process.env.STEER_HOME || path.join(os.homedir(), ".steer");
// One file per editor window, so two windows never write into the same file.
const FILE = path.join(HOME, "editor", `${process.pid}.jsonl`);
// Its own folder, so a steer from before 0.5.9 never reads these as typing.
const FRONT_FILE = path.join(HOME, "editor-front", `${process.pid}.jsonl`);
const APP = /cursor/i.test(vscode.env.appName) ? "cursor" : "vscode";
/** A stretch ends after this long with nothing from the person. */
const QUIET = 60_000;
/** Long stretches are written out in pieces, so closing the editor loses at most one. */
const PIECE = 15 * 60_000;
/** How often the window being in front is checked. */
const TICK = 15_000;

let span = null; // { folder, start, last }: working in a file
let front = null; // { folder, start, last }: the window in front with a project open

const iso = (t) => new Date(t).toISOString();

function write(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + "\n");
  } catch {}
}

/** The workspace folder a file (or a notebook cell) is in, or null if it's not in one. */
function folderOf(doc) {
  if (!doc) return null;
  let uri = doc.uri;
  if (uri.scheme === "vscode-notebook-cell") uri = uri.with({ scheme: "file", fragment: "" });
  if (uri.scheme !== "file") return null;
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? null;
}

function end() {
  if (!span) return;
  const { folder, start, last } = span;
  span = null;
  write(FILE, { folder, start: iso(start), end: iso(last), app: APP });
}

/** Something from the person in a file. `starts` is false for things that also happen
 * without them, like a file scrolling or opening when an agent shows what it changed:
 * those keep a stretch going but can't start one. */
function touch(doc, starts) {
  if (!vscode.window.state.focused) return;
  const folder = folderOf(doc);
  if (!folder) return;
  const now = Date.now();
  if (span && (span.folder !== folder || now - span.last > QUIET)) end();
  if (span && now - span.start > PIECE) {
    end();
    starts = true;
  }
  if (!span) {
    if (!starts) return;
    span = { folder, start: now, last: now };
  }
  span.last = now;
}

/** The project in front: the one of the file last worked on, or the only folder open. */
function folderInFront() {
  const folder = folderOf(vscode.window.activeTextEditor?.document);
  if (folder) return folder;
  const open = vscode.workspace.workspaceFolders ?? [];
  return open.length === 1 ? open[0].uri.fsPath : null;
}

function endFront() {
  if (!front) return;
  const { folder, start, last } = front;
  front = null;
  if (last > start) write(FRONT_FILE, { folder, start: iso(start), end: iso(last), app: APP });
}

/** Checked every TICK, and when the window or the file in front changes. */
function inFront() {
  const now = Date.now();
  if (!vscode.window.state.focused) return endFront();
  const folder = folderInFront();
  if (front) {
    // Much longer than a check since the last one: the computer slept, so that time
    // isn't counted.
    const slept = now - front.last > 2 * TICK;
    if (!slept) front.last = now;
    if (slept || front.folder !== folder || now - front.start >= PIECE) endFront();
  }
  if (folder && !front) front = { folder, start: now, last: now };
}

/** Another window came to the front, or the editor is closing. */
function leftFront() {
  if (front && Date.now() - front.last <= 2 * TICK) front.last = Date.now();
  endFront();
}

function activate(context) {
  const { Keyboard, Mouse } = vscode.TextEditorSelectionChangeKind;
  const timer = setInterval(() => {
    if (span && Date.now() - span.last > QUIET) end();
    inFront();
  }, TICK);
  inFront();
  context.subscriptions.push(
    // Typing, or moving the cursor or selecting with the keyboard or mouse. An agent's
    // edits change a file without any of these, so they don't count.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.kind === Keyboard || e.kind === Mouse) touch(e.textEditor.document, true);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => touch(e.textEditor.document, false)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) touch(editor.document, false);
      inFront();
    }),
    // Another window in front ends both.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) return inFront();
      end();
      leftFront();
    }),
    { dispose: () => (clearInterval(timer), end(), leftFront()) },
  );
}

function deactivate() {
  end();
  leftFront();
}

module.exports = { activate, deactivate };
