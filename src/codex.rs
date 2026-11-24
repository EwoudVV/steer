//! Reads Codex session files as they're written: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//! (or under $CODEX_HOME). One JSON record per line, each with a timestamp.

use crate::live::{event, home, project_name, prompt_event, tool_event};
use crate::prompt::PromptInfo;
use crate::tail;
use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

pub const VIA: &str = "codex";
/// Codex's approval policies: when it stops to ask before running something.
const POLICIES: [&str; 4] = ["never", "on-request", "on-failure", "untrusted"];

fn root() -> PathBuf {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".codex")).join("sessions")
}

/// Reads what's new in every session file. See `tail::poll`.
pub fn poll(state: &mut Map<String, Value>, skip_existing: bool) -> Vec<Value> {
    let mut files = Vec::new();
    tail::jsonl_files(&root(), &mut files);
    tail::poll(
        files,
        state,
        skip_existing,
        |path| {
            let (session, cwd) = read_meta(path).unwrap_or_else(|| (stem(path), String::new()));
            (session, project_name(&cwd))
        },
        read_record,
    )
}

/// One record of a session file: notes the folder and approval policy from each turn's
/// context, and turns the rest into events.
fn read_record(v: &Value, ctx: &mut tail::Ctx, line_offset: u64) -> Option<Value> {
    if v.get("type").and_then(Value::as_str) == Some("turn_context") {
        if let Some(cwd) = v.pointer("/payload/cwd").and_then(Value::as_str) {
            ctx.project = project_name(cwd);
        }
        if let Some(policy) = v.pointer("/payload/approval_policy").and_then(Value::as_str).filter(|p| POLICIES.contains(p)) {
            ctx.mode = Some(policy.to_owned());
        }
    }
    let mut e = parse(v, &ctx.session, &ctx.project, line_offset)?;
    // Whether Codex could stop to ask the person, so the counting knows.
    if e["kind"] == "prompt" {
        if let Some(mode) = &ctx.mode {
            e["mode"] = mode.as_str().into();
        }
    }
    Some(e)
}

fn stem(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Session id and working folder from the session_meta record on the first line.
fn read_meta(path: &Path) -> Option<(String, String)> {
    let mut first = String::new();
    BufReader::new(File::open(path).ok()?).take(4 * 1024 * 1024).read_line(&mut first).ok()?;
    let v: Value = serde_json::from_str(&first).ok()?;
    let p = v.get("payload")?;
    let session = p.get("id").or_else(|| p.get("session_id"))?.as_str()?.to_owned();
    let cwd = p.get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned();
    Some((session, cwd))
}

/// Turns one Codex record into an event, if it's one we count.
pub fn parse(v: &Value, session: &str, project: &str, line_offset: u64) -> Option<Value> {
    let t: DateTime<Utc> = DateTime::parse_from_rfc3339(v.get("timestamp")?.as_str()?).ok()?.with_timezone(&Utc);
    let n = v.get("ordinal").and_then(Value::as_u64).unwrap_or(line_offset);
    let id = format!("cx-{session}-{n}");
    let p = v.get("payload")?;
    let kind = p.get("type").and_then(Value::as_str).unwrap_or_default();
    match v.get("type")?.as_str()? {
        "response_item" if kind == "message" && p.get("role").and_then(Value::as_str) == Some("user") => {
            let (text, images) = human_input(p)?;
            Some(prompt_event(id, session, project, VIA, t, &PromptInfo::analyze(text.trim(), images)))
        }
        "response_item" if kind.ends_with("call") => {
            let name = p.get("name").and_then(Value::as_str).unwrap_or(kind);
            let model = p.get("model").and_then(Value::as_str);
            let tokens = p.get("usage").and_then(|u| u.get("output_tokens")).and_then(Value::as_u64);
            Some(tool_event(id, session, project, VIA, t, name, model, tokens))
        }
        "event_msg" if kind == "task_complete" => Some(event(id, session, project, VIA, t, "stop")),
        "event_msg" if kind == "turn_aborted" => Some(event(id, session, project, VIA, t, "interrupt")),
        _ => None,
    }
}

/// The text and image count of a user message, or None if Codex wrote it itself
/// (AGENTS.md instructions, environment context). Newer Codex labels every content
/// item; things the person typed are labelled "user.*".
fn human_input(p: &Value) -> Option<(String, usize)> {
    let items = p.get("content")?.as_array()?;
    let kinds: Option<Vec<&str>> = p
        .pointer("/internal_chat_message_metadata_passthrough/content_item_kinds")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|k| k.as_str().unwrap_or_default()).collect());

    let mut text = String::new();
    let mut images = 0;
    for (i, item) in items.iter().enumerate() {
        let typed_by_person = match &kinds {
            Some(k) => k.get(i).is_some_and(|k| k.starts_with("user.")),
            None => true,
        };
        if !typed_by_person {
            continue;
        }
        match item.get("type").and_then(Value::as_str) {
            Some("input_text") => {
                let s = item.get("text").and_then(Value::as_str).unwrap_or_default();
                if kinds.is_none() && (s.trim_start().starts_with('<') || s.trim_start().starts_with("# AGENTS")) {
                    continue; // older Codex without labels: skip what looks injected
                }
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(s);
            }
            Some("input_image") => images += 1,
            _ => {}
        }
    }
    (!text.trim().is_empty() || images > 0).then_some((text, images))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rec(kind: &str, payload: Value) -> Value {
        json!({ "timestamp": "2026-11-14T23:16:51.123Z", "ordinal": 7, "type": kind, "payload": payload })
    }

    #[test]
    fn prompts_carry_the_approval_policy() {
        crate::live::use_temp_home();
        let mut ctx = tail::Ctx { session: "s".into(), project: "unknown".into(), mode: None };
        let context = rec("turn_context", json!({ "cwd": "/tmp/steer-codex-test", "approval_policy": "on-request" }));
        assert!(read_record(&context, &mut ctx, 0).is_none());
        assert_eq!(ctx.mode.as_deref(), Some("on-request"));
        let typed = rec("response_item", json!({
            "type": "message", "role": "user",
            "content": [{ "type": "input_text", "text": "why does the build fail on windows" }],
            "internal_chat_message_metadata_passthrough": { "content_item_kinds": ["user.text"] }
        }));
        assert_eq!(read_record(&typed, &mut ctx, 1).unwrap()["mode"], "on-request");
        let odd = rec("turn_context", json!({ "approval_policy": "whatever" }));
        read_record(&odd, &mut ctx, 2);
        assert_eq!(ctx.mode.as_deref(), Some("on-request"), "unknown policies are ignored");
    }

    #[test]
    fn reads_prompts_tools_and_turn_ends() {
        crate::live::use_temp_home();
        let typed = rec("response_item", json!({
            "type": "message", "role": "user",
            "content": [{ "type": "input_text", "text": "the jump in player.rs feels floaty" }, { "type": "input_image" }],
            "internal_chat_message_metadata_passthrough": { "content_item_kinds": ["user.text", "user.image"] }
        }));
        let e = parse(&typed, "s", "game", 0).unwrap();
        assert_eq!(e["kind"], "prompt");
        assert_eq!(e["images"], 1);
        assert_eq!(e["observation"], true);
        assert!(e.get("text").is_none());

        let injected = rec("response_item", json!({
            "type": "message", "role": "user",
            "content": [{ "type": "input_text", "text": "# AGENTS.md ..." }, { "type": "input_text", "text": "<environment_context>" }],
            "internal_chat_message_metadata_passthrough": { "content_item_kinds": ["agents_md.instructions", "environments.environment_context"] }
        }));
        assert!(parse(&injected, "s", "game", 0).is_none());

        let call = rec("response_item", json!({ "type": "function_call", "name": "shell" }));
        assert_eq!(parse(&call, "s", "game", 0).unwrap()["tool"], "shell");
        assert_eq!(parse(&rec("event_msg", json!({ "type": "task_complete" })), "s", "g", 0).unwrap()["kind"], "stop");
        let aborted = rec("event_msg", json!({ "type": "turn_aborted", "reason": "interrupted" }));
        assert_eq!(parse(&aborted, "s", "g", 0).unwrap()["kind"], "interrupt");
        assert!(parse(&rec("event_msg", json!({ "type": "token_count" })), "s", "g", 0).is_none());
    }
}
