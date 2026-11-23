//! Reads Codex session files as they're written: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//! (or under $CODEX_HOME). One JSON record per line, each with a timestamp.

use crate::live::{event, home, project_name, prompt_event_as, tool_event, words};
use crate::prompt::PromptInfo;
use crate::tail;
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

pub const VIA: &str = "codex";

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
            let (session, cwd, tags) = read_meta(path)?.unwrap_or_else(|| (stem(path), String::new(), Value::Null));
            Some((session, project_name(&cwd), tags))
        },
        |v, ctx, line_offset| {
            if v.get("type").and_then(Value::as_str) == Some("turn_context") {
                if let Some(cwd) = v.pointer("/payload/cwd").and_then(Value::as_str) {
                    ctx.project = project_name(cwd);
                }
            }
            parse(v, &ctx.session, &ctx.project, line_offset, &ctx.tags)
        },
    )
}

fn stem(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Session id and working folder from the session_meta record on the first line, and
/// what started the session: T3 Code ("T3 Code", or "t3code_desktop" in older versions)
/// and whether it's a subagent that another agent started. None while that line is
/// still being written, so it gets read again next time, and Some(None) if it can't be
/// read at all.
fn read_meta(path: &Path) -> Option<Option<(String, String, Value)>> {
    const MAX: u64 = 4 * 1024 * 1024;
    let mut first = String::new();
    BufReader::new(File::open(path).ok()?).take(MAX).read_line(&mut first).ok()?;
    if !first.ends_with('\n') && (first.len() as u64) < MAX {
        return None;
    }
    Some(parse_meta(&first))
}

fn parse_meta(first: &str) -> Option<(String, String, Value)> {
    let v: Value = serde_json::from_str(first).ok()?;
    let p = v.get("payload")?;
    let session = p.get("id").or_else(|| p.get("session_id"))?.as_str()?.to_owned();
    let cwd = p.get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned();
    let originator = p.get("originator").and_then(Value::as_str).unwrap_or_default();
    let t3 = originator == "T3 Code" || originator.starts_with("t3code");
    let subagent = p.pointer("/source/subagent").is_some();
    Some((session, cwd, json!({ "t3": t3, "subagent": subagent })))
}

/// Turns one Codex record into an event, if it's one we count. `tags` are from `read_meta`.
pub fn parse(v: &Value, session: &str, project: &str, line_offset: u64, tags: &Value) -> Option<Value> {
    let t: DateTime<Utc> = DateTime::parse_from_rfc3339(v.get("timestamp")?.as_str()?).ok()?.with_timezone(&Utc);
    let n = v.get("ordinal").and_then(Value::as_u64).unwrap_or(line_offset);
    let id = format!("cx-{session}-{n}");
    let p = v.get("payload")?;
    let kind = p.get("type").and_then(Value::as_str).unwrap_or_default();
    match v.get("type")?.as_str()? {
        // A subagent's prompts are written by the agent that started it. Its tool calls
        // still count as agent activity.
        "response_item" if kind == "message" && p.get("role").and_then(Value::as_str) == Some("user") && tags["subagent"] != true => {
            let (text, images) = human_input(p)?;
            // T3 Code runs Codex too, and marks everything it sends as typed by the
            // person, even what its agents wrote. If T3 is on this computer, the flush
            // asks its database who wrote this one (see t3.rs). Sessions T3 started are
            // only sent if it says the person did, so they don't count as typed yet.
            let from_t3 = tags["t3"] == true;
            let (typed, attached) = if from_t3 { crate::t3::typed_part(text.trim()) } else { (text.trim(), 0) };
            let info = PromptInfo::analyze(typed, images.max(attached));
            let mut e = prompt_event_as(id, session, project, VIA, t, &info, !from_t3);
            let db = crate::t3::db_path();
            if from_t3 || db.is_some() {
                let db = db.map(|d| d.to_string_lossy().into_owned());
                let key = crate::claude::prompt_key(crate::t3::typed_part(&text).0);
                e["check"] = json!({ "key": key, "t3": { "db": db } });
                if from_t3 {
                    e["check"]["t3"]["codex"] = "t3".into();
                    e["check"]["words"] = words(&info);
                }
            }
            Some(e)
        }
        "response_item" if kind.ends_with("call") => {
            let name = p.get("name").and_then(Value::as_str).unwrap_or(kind);
            Some(tool_event(id, session, project, VIA, t, name))
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
    fn reads_prompts_tools_and_turn_ends() {
        crate::live::use_temp_home();
        let typed = rec("response_item", json!({
            "type": "message", "role": "user",
            "content": [{ "type": "input_text", "text": "the jump in player.rs feels floaty" }, { "type": "input_image" }],
            "internal_chat_message_metadata_passthrough": { "content_item_kinds": ["user.text", "user.image"] }
        }));
        let e = parse(&typed, "s", "game", 0, &Value::Null).unwrap();
        assert_eq!(e["kind"], "prompt");
        assert_eq!(e["images"], 1);
        assert_eq!(e["observation"], true);
        assert!(e.get("text").is_none());

        let injected = rec("response_item", json!({
            "type": "message", "role": "user",
            "content": [{ "type": "input_text", "text": "# AGENTS.md ..." }, { "type": "input_text", "text": "<environment_context>" }],
            "internal_chat_message_metadata_passthrough": { "content_item_kinds": ["agents_md.instructions", "environments.environment_context"] }
        }));
        assert!(parse(&injected, "s", "game", 0, &Value::Null).is_none());

        let call = rec("response_item", json!({ "type": "function_call", "name": "shell" }));
        assert_eq!(parse(&call, "s", "game", 0, &Value::Null).unwrap()["tool"], "shell");
        assert_eq!(parse(&rec("event_msg", json!({ "type": "task_complete" })), "s", "g", 0, &Value::Null).unwrap()["kind"], "stop");
        let aborted = rec("event_msg", json!({ "type": "turn_aborted", "reason": "interrupted" }));
        assert_eq!(parse(&aborted, "s", "g", 0, &Value::Null).unwrap()["kind"], "interrupt");
        assert!(parse(&rec("event_msg", json!({ "type": "token_count" })), "s", "g", 0, &Value::Null).is_none());
    }

    #[test]
    fn subagent_prompts_are_skipped_and_t3_sessions_get_checked() {
        crate::live::use_temp_home();
        let typed = rec("response_item", json!({
            "type": "message", "role": "user",
            "content": [{ "type": "input_text", "text": "review the diff in player.rs" }],
            "internal_chat_message_metadata_passthrough": { "content_item_kinds": ["user.text"] }
        }));
        // Written by the agent that started the subagent, even though it says user.text.
        assert!(parse(&typed, "s", "game", 0, &json!({ "subagent": true })).is_none());
        let call = rec("response_item", json!({ "type": "function_call", "name": "shell" }));
        assert!(parse(&call, "s", "game", 0, &json!({ "subagent": true })).is_some());
        // T3 sends what its agents write as user.text too, so the flush asks T3 first.
        let e = parse(&typed, "s", "game", 0, &json!({ "t3": true })).unwrap();
        assert_eq!(e["check"]["t3"]["codex"], "t3");
        assert_eq!(e["check"]["key"], crate::claude::prompt_key("review the diff in player.rs"));
    }

    #[test]
    fn meta_says_what_started_the_session() {
        let dir = std::env::temp_dir().join(format!("steer-codex-meta-{}", crate::live::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = |name: &str, payload: Value| {
            let path = dir.join(name);
            std::fs::write(&path, format!("{}\n", json!({ "type": "session_meta", "payload": payload }))).unwrap();
            read_meta(&path).unwrap().unwrap().2
        };
        let t3 = file("a.jsonl", json!({ "id": "a", "cwd": "/x", "originator": "T3 Code", "source": "vscode" }));
        assert_eq!(t3, json!({ "t3": true, "subagent": false }));
        let older = file("b.jsonl", json!({ "id": "b", "originator": "t3code_desktop", "source": { "subagent": { "thread_spawn": {} } } }));
        assert_eq!(older, json!({ "t3": true, "subagent": true }));
        let cli = file("c.jsonl", json!({ "id": "c", "originator": "codex-tui", "source": "cli" }));
        assert_eq!(cli, json!({ "t3": false, "subagent": false }));
        // The first line isn't all there yet: read it again next time.
        let half = dir.join("d.jsonl");
        std::fs::write(&half, r#"{"type":"session_meta","payload":{"id":"d","originator":"T3"#).unwrap();
        assert_eq!(read_meta(&half), None);
        std::fs::write(&half, "not json\n").unwrap();
        assert_eq!(read_meta(&half), Some(None));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
