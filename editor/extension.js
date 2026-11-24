// steer for VS Code and Cursor. Notes the stretches of time someone is working in a
// project's files (typing, clicking or scrolling in a file while the window is in front)
// and writes them to ~/.steer/editor, where the steer app picks them up. Each one is the
// project folder, when it started and ended, and which editor. steer only sends the
// project's name and the times. No file names, no code, nothing about what was typed.
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = path.join(process.env.STEER_HOME || path.join(os.homedir(), ".steer"), "editor");
// One file per editor window, so two windows never write into the same file.
const FILE = path.join(DIR, `${process.pid}.jsonl`);
const APP = /cursor/i.test(vscode.env.appName) ? "cursor" : "vscode";
/** A stretch ends after this long with nothing from the person. */
const QUIET = 60_000;
/** Long stretches are written out in pieces, so closing the editor loses at most one. */
const PIECE = 15 * 60_000;

let span = null; // { folder, start, last }

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
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify({ folder, start: new Date(start).toISOString(), end: new Date(last).toISOString(), app: APP }) + "\n");
  } catch {}
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

function activate(context) {
  const { Keyboard, Mouse } = vscode.TextEditorSelectionChangeKind;
  const timer = setInterval(() => span && Date.now() - span.last > QUIET && end(), 15_000);
  context.subscriptions.push(
    // Typing, or moving the cursor or selecting with the keyboard or mouse. An agent's
    // edits change a file without any of these, so they don't count.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.kind === Keyboard || e.kind === Mouse) touch(e.textEditor.document, true);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => touch(e.textEditor.document, false)),
    vscode.window.onDidChangeActiveTextEditor((editor) => editor && touch(editor.document, false)),
    // Another window in front ends it.
    vscode.window.onDidChangeWindowState((state) => state.focused || end()),
    { dispose: () => (clearInterval(timer), end()) },
  );
}

function deactivate() {
  end();
}

module.exports = { activate, deactivate };
