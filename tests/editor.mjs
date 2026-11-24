// Tests the VS Code and Cursor extension (editor/extension.js) against a fake VS Code:
//   node tests/editor.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "steer-editor-"));
process.env.STEER_HOME = home;
const file = join(home, "editor", `${process.pid}.jsonl`);
const lines = () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

let clock = Date.parse("2026-11-24T18:00:00Z");
Date.now = () => clock;
const at = (secs) => new Date(Date.parse("2026-11-24T18:00:00Z") + secs * 1000).toISOString();

const listeners = {};
const on = (name) => (fn) => {
  listeners[name] = fn;
  return { dispose() {} };
};
const vscode = {
  env: { appName: "Visual Studio Code" },
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  window: {
    state: { focused: true },
    onDidChangeTextEditorSelection: on("selection"),
    onDidChangeTextEditorVisibleRanges: on("scroll"),
    onDidChangeActiveTextEditor: on("active"),
    onDidChangeWindowState: on("window"),
  },
  workspace: {
    getWorkspaceFolder: (uri) => (uri.scheme === "file" && uri.fsPath.startsWith("/home/x/game/") ? { uri: { fsPath: "/home/x/game" } } : undefined),
  },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscode : load.call(this, request, ...rest);
};
const require = createRequire(import.meta.url);

/** Loads the extension fresh (its editor name is read when it loads). */
function start() {
  delete require.cache[require.resolve("../editor/extension.js")];
  const ext = require("../editor/extension.js");
  const context = { subscriptions: [] };
  ext.activate(context);
  return () => context.subscriptions.forEach((s) => s.dispose());
}
const doc = (fsPath, scheme = "file") => ({ uri: { scheme, fsPath, with: (o) => ({ scheme: o.scheme ?? scheme, fsPath }) } });
const main = doc("/home/x/game/src/main.js");
const type = (d = main) => listeners.selection({ kind: 1, textEditor: { document: d } });
const click = (d = main) => listeners.selection({ kind: 2, textEditor: { document: d } });
const agentEdit = (d = main) => listeners.selection({ kind: 3, textEditor: { document: d } });
const scroll = (d = main) => listeners.scroll({ textEditor: { document: d } });
const tick = (secs) => (clock += secs * 1000);

try {
  let stop = start();

  // Scrolling alone (an agent showing its edits does that too) doesn't start anything.
  scroll();
  tick(5);
  listeners.window({ focused: false });
  assert.deepEqual(lines(), []);
  listeners.window({ focused: true });

  // Typing starts it, scrolling and clicking keep it going, an agent's edits (a
  // selection change from a command) don't, and another window in front ends it at the
  // last thing the person did.
  type();
  tick(30);
  scroll();
  tick(20);
  agentEdit();
  tick(20);
  vscode.window.state.focused = false;
  listeners.window({ focused: false });
  assert.deepEqual(lines(), [{ folder: "/home/x/game", start: at(5), end: at(35), app: "vscode" }]);

  // Nothing counts while the window isn't in front, or in files outside a project.
  click();
  vscode.window.state.focused = true;
  type(doc("/tmp/notes.txt"));
  type(doc("/home/x/game/x.ts", "git"));
  assert.equal(lines().length, 1);

  // A minute with nothing ends it; the next keypress starts a new one.
  tick(100);
  type();
  tick(61);
  click();
  tick(1);
  listeners.window({ focused: false });
  vscode.window.state.focused = true;
  const two = lines().slice(1);
  assert.deepEqual(
    two.map((l) => [l.start, l.end]),
    [
      [at(175), at(175)],
      [at(236), at(236)],
    ],
  );

  // Working nonstop gets written in 15 minute pieces.
  type();
  for (let i = 0; i < 40; i++) {
    tick(30);
    type();
  }
  listeners.window({ focused: false });
  vscode.window.state.focused = true;
  const long = lines().slice(3);
  assert.equal(long.length, 2, "one piece at 15 minutes, then the rest");
  assert.ok(Date.parse(long[0].end) - Date.parse(long[0].start) <= 15 * 60_000);
  assert.ok(Date.parse(long[1].start) - Date.parse(long[0].end) <= 30_000, "the next piece starts at the next keypress");

  // Notebook cells count as the notebook's file.
  type(doc("/home/x/game/analysis.ipynb", "vscode-notebook-cell"));
  tick(10);
  stop();
  assert.equal(lines().at(-1).folder, "/home/x/game", "closing the window writes what was open");

  // In Cursor it says so.
  vscode.env.appName = "Cursor";
  stop = start();
  type();
  stop();
  assert.equal(lines().at(-1).app, "cursor");

  // Only the folder, times and editor: nothing about files or what was typed.
  for (const l of lines()) assert.deepEqual(Object.keys(l).sort(), ["app", "end", "folder", "start"]);
  console.log("editor tests passed");
} finally {
  Module._load = load;
  rmSync(home, { recursive: true, force: true });
}
