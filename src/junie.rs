//! Reads Junie's sessions: ~/.junie/sessions/<session>/events.jsonl, or under
//! $JUNIE_HOME. The Junie CLI writes them, and so does Junie in JetBrains IDEs, which runs
//! on the same engine. One JSON record per line, added while the agent works:
//! {"kind", "timestampMs", ...}. The agent's steps come wrapped as
//! {"kind":"SessionA2uxEvent","event":{"state","agentEvent":{"kind","stepId","status",...}}},
//! and a step is written down again every time it changes, then once more when its task
//! ends.
//!
//! JetBrains doesn't document the format. Written from real sessions other projects keep
//! as test data (the Junie CLI and IntelliJ IDEA 2026.2 on Windows, and the plugin on
//! Linux, August and September 2026) and from their readers. Not tried against Junie
//! running here yet.

use crate::live::{event, home, project_name, prompt_event, tool_event};
use crate::prompt::PromptInfo;
use crate::tail;
use chrono::DateTime;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub const VIA: &str = "junie";

/// Steps that are never sent. Some are long (the whole environment, the agent's state,
/// the result with every changed file in it) and some come every second, so lines with
/// these aren't even parsed.
const IGNORED: [&str; 11] = [
    "EnvironmentVariablesUpdatedEvent",
    "AgentStateUpdatedEvent",
    "LlmResponseMetadataEvent",
    "AgentCurrentStatusUpdatedEvent",
    "AvailablePullRequestsEvent",
    "ContextWindowReportEvent",
    "ResultBlockUpdatedEvent",
    "AgentPatchCreatedEvent",
    "AgentThoughtBlockUpdatedEvent",
    "MarkdownBlockUpdatedEvent",
    "TipSuggestionCreatedEvent",
];
/// How much of the start of a line is looked at to tell whether to parse it.
const HEAD: usize = 1024;

/// ~/.junie, or $JUNIE_HOME.
pub(crate) fn home_dir() -> PathBuf {
    std::env::var_os("JUNIE_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".junie"))
}

/// Each session's events.jsonl. Its subagents and scratch files are in folders further
/// down, so only the first level is looked at.
fn session_files(sessions: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(sessions) else { return Vec::new() };
    entries.flatten().map(|e| e.path().join("events.jsonl")).filter(|p| p.is_file()).collect()
}

/// How many sessions Junie saved where steer reads them, or None if Junie isn't here.
pub(crate) fn saved_sessions() -> Option<usize> {
    let home = home_dir();
    home.exists().then(|| session_files(&home.join("sessions")).len())
}

/// Reads what's new in every session. See `tail::poll`. `sent` keeps a step from being
/// sent again each time Junie writes it down again.
pub fn poll(state: &mut Map<String, Value>, skip_existing: bool, sent: &mut HashSet<String>) -> Vec<Value> {
    poll_in(&home_dir().join("sessions"), state, skip_existing, sent)
}

fn poll_in(sessions: &Path, state: &mut Map<String, Value>, skip_existing: bool, sent: &mut HashSet<String>) -> Vec<Value> {
    if sent.len() > 200_000 {
        sent.clear();
    }
    tail::poll_lines(session_files(sessions), state, skip_existing, meta, |line, ctx, offset| {
        let no_folder = ctx.project == "unknown";
        if !worth_parsing(line, sent, no_folder) {
            return None;
        }
        let v: Value = serde_json::from_slice(line).ok()?;
        // Older Junie didn't put the folder in index.jsonl. Its steps say it, after a
        // while.
        if no_folder {
            if let Some(dir) = v.pointer("/event/agentEvent/currentDirectory").and_then(Value::as_str).filter(|d| !d.is_empty()) {
                ctx.project = project_name(dir);
            }
        }
        parse(&v, &ctx.session, &ctx.project, offset, sent)
    })
}

/// Whether a line might have something steer sends, going by its start: which kind of
/// step it is, and whether that step was sent already. Junie writes a step down again
/// every time it changes, some lines are megabytes (a command's whole output) and most
/// are bookkeeping, so this saves parsing nearly all of them. A line it can't tell about
/// gets parsed.
fn worth_parsing(line: &[u8], sent: &HashSet<String>, want_folder: bool) -> bool {
    let head = &line[..line.len().min(HEAD)];
    let Some(kind) = value_after(head, b"\"agentEvent\":{\"kind\":\"") else { return true };
    if IGNORED.contains(&kind) {
        return false;
    }
    if kind == "CurrentDirectoryUpdatedEvent" {
        return want_folder;
    }
    match value_after(head, b"\"stepId\":\"") {
        // A step that was sent can still start waiting for a yes.
        Some(step) => !sent.contains(&format!("jn-{step}")) || find(head, b"\"approvalRequest\"").is_some(),
        None => true,
    }
}

fn find(s: &[u8], what: &[u8]) -> Option<usize> {
    s.windows(what.len()).position(|w| w == what)
}

/// The string right after `key`, up to the next quote, if that's still in `s`.
fn value_after<'a>(s: &'a [u8], key: &[u8]) -> Option<&'a str> {
    let start = find(s, key)? + key.len();
    let len = s[start..].iter().position(|&b| b == b'"')?;
    std::str::from_utf8(&s[start..start + len]).ok()
}

/// The session is its folder's name. Its project is the folder Junie was started in.
fn meta(path: &Path) -> (String, String) {
    let folder = path.parent().unwrap_or(Path::new(""));
    let session = folder.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = started_in(folder, &session).unwrap_or_default();
    (session, project_name(&dir))
}

/// From index.jsonl next to the session folders, which gets a line each time a session
/// changes (the last one counts), or else the session's summary.json.
fn started_in(folder: &Path, session: &str) -> Option<String> {
    let dir = |v: &Value| v.get("projectDir").and_then(Value::as_str).filter(|d| !d.is_empty()).map(str::to_owned);
    let index = fs::read_to_string(folder.parent()?.join("index.jsonl")).unwrap_or_default();
    index
        .lines()
        .rev()
        .filter(|l| l.contains(session))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("sessionId").and_then(Value::as_str) == Some(session))
        .find_map(|v| dir(&v))
        .or_else(|| dir(&serde_json::from_slice(&fs::read(folder.join("summary.json")).ok()?).ok()?))
}

enum Found<'a> {
    Prompt(&'a str, usize),
    Tool(String),
    Wait(&'static str),
    Stop,
    Interrupt,
}

/// Turns one record into an event, if it's one steer sends and it isn't in `sent` yet.
pub fn parse(v: &Value, session: &str, project: &str, offset: u64, sent: &mut HashSet<String>) -> Option<Value> {
    let t = DateTime::from_timestamp_millis(v.get("timestampMs")?.as_i64()?)?;
    let (id, found) = find_event(v, session, offset)?;
    if !sent.insert(id.clone()) {
        return None;
    }
    Some(match found {
        Found::Prompt(text, images) => prompt_event(id, session, project, VIA, t, &PromptInfo::analyze(text, images)),
        Found::Tool(name) => tool_event(id, session, project, VIA, t, &name),
        Found::Wait(reason) => {
            let mut e = event(id, session, project, VIA, t, "wait");
            e["reason"] = reason.into();
            e
        }
        Found::Stop => event(id, session, project, VIA, t, "stop"),
        Found::Interrupt => event(id, session, project, VIA, t, "interrupt"),
    })
}

/// What a record is, and the id it's sent with. Steps have ids of their own (stepId) and
/// so do prompts (requestId). The rest go by where they are in the file.
fn find_event<'a>(v: &'a Value, session: &str, offset: u64) -> Option<(String, Found<'a>)> {
    let in_file = || format!("jn-{offset}-{session}");
    match v.get("kind")?.as_str()? {
        "UserPromptEvent" => {
            // presentablePrompt is what the person wrote, prompt can have more added to it.
            let text = ["presentablePrompt", "prompt"]
                .iter()
                .filter_map(|k| v.get(*k)?.as_str())
                .map(str::trim)
                .find(|s| !s.is_empty())
                .unwrap_or_default();
            let images = images(v);
            if text.is_empty() && images == 0 {
                return None;
            }
            let id = v.get("requestId").and_then(Value::as_str).filter(|r| !r.is_empty()).map_or_else(in_file, |r| format!("jn-{r}"));
            Some((id, Found::Prompt(text, images)))
        }
        // Once when a task ends, also after it failed or the person stopped it.
        "TaskState" => Some((in_file(), Found::Stop)),
        // The person stopped the agent.
        "CancelAgentEvent" => Some((in_file(), Found::Interrupt)),
        "SessionA2uxEvent" => step(v),
        // Not the person typing: UserResponseEvent is clicking an answer, like "always
        // allow", and UserAsyncResponseEvent answers the agent's question.
        _ => None,
    }
}

/// One of the agent's steps: a tool call, or the agent waiting on the person.
fn step(v: &Value) -> Option<(String, Found<'static>)> {
    let step = v.pointer("/event/agentEvent")?;
    let kind = step.get("kind")?.as_str()?;
    if IGNORED.contains(&kind) {
        return None;
    }
    let step_id = step.get("stepId").and_then(Value::as_str).filter(|s| !s.is_empty());
    // Waiting for the person to allow a command or tool. Once they do, the step is
    // written down again without it.
    if let Some(ask) = step.get("approvalRequest") {
        let id = ask.get("id").and_then(Value::as_str).or(step_id)?;
        return Some((format!("jn-{id}-ok"), Found::Wait("permission")));
    }
    // A question for the person, with or without choices.
    if kind.ends_with("RequestUpdatedEvent") {
        let waiting = v.pointer("/event/state").and_then(Value::as_str) == Some("INPUT_REQUIRED");
        let answered = step.get("status").and_then(Value::as_str) == Some("COMPLETED");
        let id = step_id.or_else(|| ["request", "choiceRequest", "askRequest"].iter().find_map(|k| step.get(*k)?.get("id")?.as_str()))?;
        return (waiting && !answered).then(|| (format!("jn-{id}-ask"), Found::Wait("question")));
    }
    if kind.ends_with("BlockUpdatedEvent") {
        return Some((format!("jn-{}", step_id?), Found::Tool(tool_name(kind, step))));
    }
    None
}

fn tool_name(kind: &str, step: &Value) -> String {
    match kind {
        "TerminalBlockUpdatedEvent" => "terminal".into(),
        "FileChangesBlockUpdatedEvent" => "edit".into(),
        "ViewFilesBlockUpdatedEvent" => "view".into(),
        "TestRunBlockUpdatedEvent" => "test".into(),
        "CustomAgentBlockUpdatedEvent" => "subagent".into(),
        // An MCP tool, like the IDE's own "idea/execute_terminal_command".
        "McpBlockUpdatedEvent" => step.get("toolName").and_then(Value::as_str).unwrap_or("mcp").chars().take(80).collect(),
        // Junie's other tools say what kind they are, like "Search" or "Skill". Its text
        // has file names in it, so that's never used.
        "ToolBlockUpdatedEvent" => step
            .get("toolType")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty() && t.len() <= 40 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or("tool")
            .to_ascii_lowercase(),
        other => other.trim_end_matches("BlockUpdatedEvent").to_ascii_lowercase(),
    }
}

/// Images attached to a prompt. No real session with one was seen yet, so anything in its
/// attachment lists that says it's an image counts: a kind or type with "image" in it, or
/// a path to an image file.
fn images(v: &Value) -> usize {
    ["attachments", "customAttachments", "extraAttachments"]
        .iter()
        .filter_map(|k| v.get(*k)?.as_array())
        .flatten()
        .filter(|a| match a {
            Value::String(s) => image_file(s),
            _ => {
                let any = |keys: &[&str], test: fn(&str) -> bool| keys.iter().filter_map(|k| a.get(*k)?.as_str()).any(test);
                any(&["kind", "type", "mimeType", "mime"], |s| s.to_ascii_lowercase().contains("image"))
                    || any(&["path", "name", "fileName", "uri"], image_file)
            }
        })
        .count()
}

fn image_file(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic"].iter().any(|x| s.ends_with(x))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::new_id;
    use serde_json::json;
    use std::io::Write;

    const AGENT: &str = r#""agent":{"kind":"MainAgent","id":"main","name":"main","type":"LINEAR"}"#;

    /// One of the agent's steps, laid out the way Junie writes it: kind first, the step
    /// inside event.agentEvent.
    fn step(state: &str, kind: &str, rest: &str, t: i64) -> String {
        format!(r#"{{"kind":"SessionA2uxEvent","event":{{"state":"{state}","agentEvent":{{"kind":"{kind}",{AGENT},{rest}}}}},"taskId":"task-1","timestampMs":{t}}}"#)
    }
    fn prompt(id: &str, text: &str, t: i64) -> String {
        format!(r#"{{"kind":"UserPromptEvent","requestId":"{id}","prompt":"{text}","presentablePrompt":"{text}","requiresConfirmation":true,"timestampMs":{t}}}"#)
    }
    fn append(file: &Path, lines: &[String]) {
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let mut f = fs::OpenOptions::new().create(true).append(true).open(file).unwrap();
        f.write_all(lines.iter().map(|l| format!("{l}\n")).collect::<String>().as_bytes()).unwrap();
    }
    fn kinds(events: &[Value]) -> Vec<&str> {
        events.iter().map(|e| e["kind"].as_str().unwrap()).collect()
    }

    #[test]
    fn reads_a_session_as_it_grows() {
        crate::live::use_temp_home();
        let root = std::env::temp_dir().join(format!("steer-junie-{}", new_id()));
        let sessions = root.join("sessions");
        let file = sessions.join("session-261127-101500-ab12").join("events.jsonl");
        // A line for each time the session changed. The last one with a folder counts.
        append(&sessions.join("index.jsonl"), &[
            r#"{"sessionId":"session-261127-101500-ab12","createdAt":1795774400000,"updatedAt":1795774400000,"projectDir":"/tmp/steer-junie/old"}"#.into(),
            r#"{"sessionId":"session-261127-090000-zz99","createdAt":1795774000000,"updatedAt":1795774000000,"projectDir":"/tmp/steer-junie/other"}"#.into(),
            r#"{"sessionId":"session-261127-101500-ab12","createdAt":1795774400000,"updatedAt":1795774500000,"projectDir":"/tmp/steer-junie/pong","taskName":"Fix the paddle"}"#.into(),
        ]);
        append(&file, &[prompt("prompt-261127-101000-aaaa", "make a pong game", 1_795_774_200_000)]);
        let mut state = Map::new();
        let mut sent = HashSet::new();
        // Already there when the watcher starts: nothing sent.
        assert!(poll_in(&sessions, &mut state, true, &mut sent).is_empty());

        let task = [
            prompt("prompt-261127-101500-bbbb", "the ball goes through the paddle in game.py when i move fast", 1_795_774_500_000),
            r#"{"kind":"TaskStartedEvent","taskId":"task-1","timestampMs":1795774500010}"#.into(),
            step("IN_PROGRESS", "EnvironmentVariablesUpdatedEvent", r#""env":[]"#, 1_795_774_500_100),
            step("IN_PROGRESS", "AgentCurrentStatusUpdatedEvent", r#""status":"Sending LLM request""#, 1_795_774_500_200),
            // Opening a file is a ToolBlock and a ViewFilesBlock with the same stepId.
            step("IN_PROGRESS", "ToolBlockUpdatedEvent", r#""stepId":"s1","text":"Open game.py","status":"IN_PROGRESS""#, 1_795_774_502_000),
            step("IN_PROGRESS", "ViewFilesBlockUpdatedEvent", r#""stepId":"s1","status":"COMPLETED","files":[{"relativePath":"game.py"}]"#, 1_795_774_502_500),
            step("IN_PROGRESS", "TerminalBlockUpdatedEvent", r#""stepId":"s2","status":"IN_PROGRESS","command":"python game.py""#, 1_795_774_504_000),
            r#"{"kind":"UserMessagesCommittedToHistory","userMessageIds":["prompt-261127-101500-bbbb"],"timestampMs":1795774504100}"#.into(),
            step("IN_PROGRESS", "TerminalBlockUpdatedEvent", r#""stepId":"s2","cancelRequest":{"id":"c1"},"status":"IN_PROGRESS","command":"python game.py""#, 1_795_774_505_000),
            step("IN_PROGRESS", "TerminalBlockUpdatedEvent", r#""stepId":"s2","status":"COMPLETED","command":"python game.py","output":"ok","exitCode":0"#, 1_795_774_506_000),
            step("IN_PROGRESS", "ToolBlockUpdatedEvent", r#""stepId":"s3","text":"Found \"*.py\" ","status":"COMPLETED","toolType":"Search""#, 1_795_774_507_000),
        ];
        append(&file, &task);
        let e = poll_in(&sessions, &mut state, false, &mut sent);
        assert_eq!(kinds(&e), ["prompt", "tool", "tool", "tool"]);
        assert_eq!(e[0]["via"], "junie");
        assert_eq!(e[0]["session"], "session-261127-101500-ab12");
        assert_eq!(e[0]["project"], "pong");
        assert_eq!(e[0]["words"], 12);
        assert_eq!(e[0]["observation"], true);
        assert_eq!(e[0]["t"], "2026-11-27T10:15:00.000Z");
        let tools: Vec<&str> = e[1..].iter().map(|e| e["tool"].as_str().unwrap()).collect();
        assert_eq!(tools, ["tool", "terminal", "search"]);
        assert_eq!(e[2]["t"], "2026-11-27T10:15:04.000Z", "when the step started, not when it finished");
        assert!(e.iter().all(|e| e.get("text").is_none() && e.get("command").is_none()));

        // The task ends: the result, every step written once more, then TaskState.
        let end = [
            step("IN_PROGRESS", "ResultBlockUpdatedEvent", r#""stepId":"s4","cancelled":false,"result":"fixed it","changes":[],"errorCode":"Submit""#, 1_795_774_510_000),
            step("COMPLETED", "ViewFilesBlockUpdatedEvent", r#""stepId":"s1","status":"COMPLETED","files":[{"relativePath":"game.py"}]"#, 1_795_774_510_010),
            step("COMPLETED", "TerminalBlockUpdatedEvent", r#""stepId":"s2","status":"COMPLETED","command":"python game.py","output":"ok","exitCode":0"#, 1_795_774_510_020),
            r#"{"kind":"TaskState","state":"COMPLETED","timestampMs":1795774510050}"#.into(),
            step("COMPLETED", "NextPromptSuggestionEvent", r#""suggestion":[{"text":"add a score"}]"#, 1_795_774_511_000),
            // The same prompt written down twice counts once.
            prompt("prompt-261127-101600-cccc", "now add a score counter", 1_795_774_560_000),
            prompt("prompt-261127-101600-cccc", "now add a score counter", 1_795_774_560_100),
        ];
        append(&file, &end);
        let e = poll_in(&sessions, &mut state, false, &mut sent);
        assert_eq!(kinds(&e), ["stop", "prompt"]);
        assert_eq!(e[0]["t"], "2026-11-27T10:15:10.050Z");
        assert!(poll_in(&sessions, &mut state, false, &mut sent).is_empty(), "nothing new");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn waits_answers_and_stops() {
        crate::live::use_temp_home();
        let mut sent = HashSet::new();
        let mut read = |line: String| -> Option<Value> { parse(&serde_json::from_str(&line).unwrap(), "s", "app", 0, &mut sent) };
        // In the IDE the step shows up first, then asks to be allowed.
        let call = read(step("IN_PROGRESS", "McpBlockUpdatedEvent", r#""stepId":"m1","toolName":"idea/list_directory_tree","input":"{}","status":"IN_PROGRESS""#, 1_000)).unwrap();
        assert_eq!((call["kind"].as_str(), call["tool"].as_str()), (Some("tool"), Some("idea/list_directory_tree")));
        let ask = r#""stepId":"m1","approvalRequest":{"id":"a1","allowListOptions":[{"label":"Always allow (\"idea:*\")","patternsToAdd":["idea:*"]}]},"toolName":"idea/list_directory_tree","status":"IN_PROGRESS""#;
        let wait = read(step("INPUT_REQUIRED", "McpBlockUpdatedEvent", ask, 1_020)).unwrap();
        assert_eq!((wait["kind"].as_str(), wait["reason"].as_str()), (Some("wait"), Some("permission")));
        // Clicking "always allow" isn't a prompt, and the step running after that isn't
        // a second call.
        assert!(read(r#"{"kind":"UserResponseEvent","prompt":"Always allow (\"idea:*\")","timestampMs":5000}"#.into()).is_none());
        assert!(read(step("IN_PROGRESS", "McpBlockUpdatedEvent", r#""stepId":"m1","toolName":"idea/list_directory_tree","status":"COMPLETED""#, 5_100)).is_none());

        // In the cli a command can ask first. It counts as a call once it's allowed.
        let ask = r#""stepId":"t1","approvalRequest":{"id":"a2","allowListOptions":[]},"status":"IN_PROGRESS","command":"cat schema.sql""#;
        assert_eq!(read(step("INPUT_REQUIRED", "TerminalBlockUpdatedEvent", ask, 6_000)).unwrap()["kind"], "wait");
        assert_eq!(read(step("IN_PROGRESS", "TerminalBlockUpdatedEvent", r#""stepId":"t1","status":"IN_PROGRESS","command":"cat schema.sql""#, 9_000)).unwrap()["tool"], "terminal");

        // A question for the person, then their answer, which isn't a prompt either.
        let question = r#""stepId":"q1","title":"Which audience?","request":{"id":"r1","name":"Audience","options":[{"id":"Kotlin","title":"Kotlin"}],"question":"Which audience?","isRequired":false},"status":"IN_PROGRESS""#;
        let wait = read(step("INPUT_REQUIRED", "AskAsyncRequestUpdatedEvent", question, 10_000)).unwrap();
        assert_eq!(wait["reason"], "question");
        assert!(read(r#"{"kind":"UserAsyncResponseEvent","entries":[{"question":"Which audience?","answer":"Kotlin"}],"timestampMs":14000}"#.into()).is_none());
        assert!(read(step("IN_PROGRESS", "AskAsyncRequestUpdatedEvent", &question.replace("IN_PROGRESS", "COMPLETED"), 14_001)).is_none());

        // The person stopping the agent, and the task ending after that.
        assert_eq!(read(r#"{"kind":"CancelAgentEvent","timestampMs":20000}"#.into()).unwrap()["kind"], "interrupt");
        let mut sent = HashSet::new();
        let stop = parse(&serde_json::from_str(r#"{"kind":"TaskState","state":"CANCELED","timestampMs":20050}"#).unwrap(), "s", "app", 77, &mut sent).unwrap();
        assert_eq!((stop["kind"].as_str(), stop["id"].as_str()), (Some("stop"), Some("jn-77-s")));
        // A failed task ends with TaskState too, and the failure itself isn't sent.
        assert!(parse(&serde_json::from_str(r#"{"kind":"AgentTaskFailedEvent","timestampMs":20100}"#).unwrap(), "s", "app", 0, &mut sent).is_none());
    }

    #[test]
    fn only_parses_lines_that_can_have_something_new() {
        let mut sent = HashSet::new();
        let env = step("IN_PROGRESS", "EnvironmentVariablesUpdatedEvent", r#""env":[{"key":"HOME","value":"..."}]"#, 1);
        assert!(!worth_parsing(env.as_bytes(), &sent, true));
        let terminal = step("IN_PROGRESS", "TerminalBlockUpdatedEvent", &format!(r#""stepId":"s2","status":"IN_PROGRESS","command":"yes","output":"{}""#, "y\\n".repeat(5000)), 2);
        assert!(worth_parsing(terminal.as_bytes(), &sent, false));
        sent.insert("jn-s2".into());
        assert!(!worth_parsing(terminal.as_bytes(), &sent, false), "the same step again, with more output");
        let ask = step("INPUT_REQUIRED", "TerminalBlockUpdatedEvent", r#""stepId":"s2","approvalRequest":{"id":"a1"},"status":"IN_PROGRESS""#, 3);
        assert!(worth_parsing(ask.as_bytes(), &sent, false), "a step that was sent can still ask to be allowed");
        let folder = step("IN_PROGRESS", "CurrentDirectoryUpdatedEvent", r#""currentDirectory":"/tmp/pong""#, 4);
        assert!(worth_parsing(folder.as_bytes(), &sent, true));
        assert!(!worth_parsing(folder.as_bytes(), &sent, false), "only while the project isn't known");
        // Anything it can't tell about gets parsed.
        assert!(worth_parsing(br#"{"kind":"TaskState","state":"COMPLETED","timestampMs":5}"#, &sent, false));
        assert!(worth_parsing(br#"{"event":{"agentEvent":{"stepId":"s2","kind":"TerminalBlockUpdatedEvent"}}}"#, &sent, false));
    }

    #[test]
    fn project_from_the_steps_when_index_has_none() {
        crate::live::use_temp_home();
        let root = std::env::temp_dir().join(format!("steer-junie-{}", new_id()));
        let sessions = root.join("sessions");
        let file = sessions.join("session-261127-120000-xy12").join("events.jsonl");
        append(&file, &[
            prompt("prompt-261127-120000-dddd", "add a pause menu", 1_795_780_000_000),
            step("IN_PROGRESS", "CurrentDirectoryUpdatedEvent", r#""currentDirectory":"""#, 1_795_780_000_100),
            step("IN_PROGRESS", "CurrentDirectoryUpdatedEvent", r#""currentDirectory":"/tmp/steer-junie/snake""#, 1_795_780_001_000),
            step("IN_PROGRESS", "FileChangesBlockUpdatedEvent", r#""stepId":"f1","status":"IN_PROGRESS","changes":[]"#, 1_795_780_002_000),
        ]);
        let e = poll_in(&sessions, &mut Map::new(), false, &mut HashSet::new());
        assert_eq!(kinds(&e), ["prompt", "tool"]);
        assert_eq!(e[0]["project"], "unknown");
        assert_eq!((e[1]["project"].as_str(), e[1]["tool"].as_str()), (Some("snake"), Some("edit")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn images_and_tool_names() {
        let v: Value = serde_json::from_str(r#"{"kind":"UserPromptEvent","prompt":"like this","attachments":["/Users/x/Desktop/shot.PNG","notes.txt"],"customAttachments":[{"kind":"ImageAttachment"},{"kind":"PlanAgentAttachment"}],"timestampMs":1}"#).unwrap();
        assert_eq!(images(&v), 2);
        let odd = json!({ "toolType": "Search everything in /Users/x" });
        assert_eq!(tool_name("ToolBlockUpdatedEvent", &odd), "tool", "never text that could have a path in it");
        assert_eq!(tool_name("TestRunBlockUpdatedEvent", &Value::Null), "test");
        assert_eq!(tool_name("WebSearchBlockUpdatedEvent", &Value::Null), "websearch");
    }
}
