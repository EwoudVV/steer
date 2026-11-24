//! Reads GitHub Copilot sessions: ~/.copilot/session-state/<id>/events.jsonl (or under
//! $COPILOT_HOME). The Copilot CLI writes these, and so does Copilot chat in VS Code
//! since it moved onto the same engine (VS Code 1.143). One JSON record per line:
//! {id, parentId, timestamp, type, data}.
//!
//! Not tried against real Copilot use yet: written from the format as documented in
//! VS Code's source and GitHub's docs.

use crate::live::{event, home, project_name, prompt_event, tool_event};
use crate::prompt::PromptInfo;
use crate::tail;
use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub const VIA: &str = "copilot";

fn root() -> PathBuf {
    std::env::var_os("COPILOT_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".copilot")).join("session-state")
}

/// Reads what's new in every session's events.jsonl. See `tail::poll`.
pub fn poll(state: &mut Map<String, Value>, skip_existing: bool) -> Vec<Value> {
    let mut files = Vec::new();
    tail::jsonl_files(&root(), &mut files);
    files.retain(|p| p.file_name().is_some_and(|n| n == "events.jsonl"));
    tail::poll(
        files,
        state,
        skip_existing,
        |path| (session_of(path), project_name(&read_cwd(path).unwrap_or_default())),
        |v, ctx, line_offset| {
            if v.get("type").and_then(Value::as_str) == Some("session.start") {
                if let Some(cwd) = cwd_of(v) {
                    ctx.project = project_name(cwd);
                }
            }
            parse(v, &ctx.session, &ctx.project, line_offset)
        },
    )
}

/// The session id is the folder name.
fn session_of(path: &Path) -> String {
    path.parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn cwd_of(v: &Value) -> Option<&str> {
    v.pointer("/data/context/cwd").or_else(|| v.pointer("/data/cwd")).and_then(Value::as_str)
}

/// The working folder from the session.start record near the top of the file.
fn read_cwd(path: &Path) -> Option<String> {
    let reader = BufReader::new(File::open(path).ok()?);
    for line in reader.lines().take(20).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(Value::as_str) == Some("session.start") {
            return cwd_of(&v).map(str::to_owned);
        }
    }
    None
}

fn time_of(v: &Value) -> Option<DateTime<Utc>> {
    match v.get("timestamp")? {
        Value::String(s) => DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc)),
        Value::Number(n) => DateTime::from_timestamp_millis(n.as_i64()?),
        _ => None,
    }
}

/// Turns one Copilot record into an event, if it's one we count.
pub fn parse(v: &Value, session: &str, project: &str, line_offset: u64) -> Option<Value> {
    let t = time_of(v)?;
    let n = v.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| line_offset.to_string());
    let id = format!("cp-{session}-{n}");
    let d = v.get("data").unwrap_or(&Value::Null);
    match v.get("type")?.as_str()? {
        "user.message" => {
            let text = d.get("content").or_else(|| d.get("text")).and_then(Value::as_str).unwrap_or_default();
            let images = d
                .get("attachments")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter(|a| is_image(a)).count())
                .unwrap_or(0);
            let model = d.get("model").and_then(Value::as_str);
            let tokens = d.get("usage").and_then(|u| u.get("output_tokens")).and_then(Value::as_u64);
            (!text.trim().is_empty() || images > 0)
                .then(|| prompt_event(id, session, project, VIA, t, &PromptInfo::analyze_with(text.trim(), images, model, tokens)))
        }
        "tool.execution_start" => {
            let name = ["toolName", "name", "tool"].iter().find_map(|k| d.get(*k).and_then(Value::as_str)).unwrap_or("tool");
            let model = d.get("model").and_then(Value::as_str);
            let tokens = d.get("usage").and_then(|u| u.get("output_tokens")).and_then(Value::as_u64);
            Some(tool_event(id, session, project, VIA, t, name, model, tokens))
        }
        "assistant.turn_end" => Some(event(id, session, project, VIA, t, "stop")),
        kind if kind.contains("abort") => Some(event(id, session, project, VIA, t, "interrupt")),
        _ => None,
    }
}

fn is_image(attachment: &Value) -> bool {
    ["type", "mimeType", "mime_type", "kind"]
        .iter()
        .filter_map(|k| attachment.get(*k).and_then(Value::as_str))
        .any(|s| s.contains("image"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_prompts_tools_and_turn_ends() {
        crate::live::use_temp_home();
        let rec = |kind: &str, data: Value| json!({ "id": "e1", "timestamp": "2026-11-20T10:00:00.000Z", "type": kind, "data": data });
        let prompt = rec("user.message", json!({
            "content": "the login button in auth.ts does nothing when i click it",
            "attachments": [{ "type": "image", "path": "shot.png" }, { "type": "file", "path": "auth.ts" }]
        }));
        let e = parse(&prompt, "s", "app", 0).unwrap();
        assert_eq!(e["kind"], "prompt");
        assert_eq!(e["via"], "copilot");
        assert_eq!(e["images"], 1);
        assert_eq!(e["observation"], true);
        assert!(e.get("text").is_none());

        assert_eq!(parse(&rec("tool.execution_start", json!({ "toolName": "bash" })), "s", "app", 0).unwrap()["tool"], "bash");
        assert_eq!(parse(&rec("assistant.turn_end", json!({})), "s", "app", 0).unwrap()["kind"], "stop");
        assert!(parse(&rec("assistant.message", json!({ "content": "done" })), "s", "app", 0).is_none());
        assert!(parse(&rec("user.message", json!({ "content": "  " })), "s", "app", 0).is_none());
    }
}
