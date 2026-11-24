//! Reads Claude Code session logs (~/.claude/projects/<project>/<session>.jsonl).
//! Prompt text is analyzed in memory and dropped; nothing here is written or sent anywhere.

use crate::model::{Event, EventKind, Session};
use crate::prompt::PromptInfo;
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub fn default_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

/// Top-level session files only. Subagent logs live in nested folders and are skipped,
/// since they're the agent talking to itself.
pub fn find_session_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(dirs) = fs::read_dir(root) else { return out };
    for dir in dirs.flatten() {
        let Ok(entries) = fs::read_dir(dir.path()) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// The Claude Code version that wrote the newest session log, like (2, 1, 330). Every
/// entry in a log says which version wrote it.
pub fn newest_version(root: &Path) -> Option<(u32, u32, u32)> {
    let newest = find_session_files(root)
        .into_iter()
        .filter_map(|p| Some((fs::metadata(&p).ok()?.modified().ok()?, p)))
        .max_by_key(|(t, _)| *t)?
        .1;
    let mut file = File::open(newest).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(256 * 1024))).ok()?;
    let mut buf = Vec::new();
    file.take(256 * 1024).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let at = text.rfind("\"version\":\"")? + "\"version\":\"".len();
    parse_version(text[at..].split('"').next()?)
}

/// "2.1.330" as (2, 1, 330).
pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.trim().split('.').map(|p| p.parse::<u32>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

pub fn parse_session(path: &Path) -> Option<Session> {
    let reader = BufReader::new(File::open(path).ok()?);
    let mut events = Vec::new();
    let mut cwd = None;
    let mut custom_title = None;
    let mut ai_title = None;

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let ty = v.get("type").and_then(Value::as_str).unwrap_or_default();
        match ty {
            "custom-title" => {
                custom_title = str_field(&v, "customTitle");
                continue;
            }
            "ai-title" => {
                ai_title = str_field(&v, "aiTitle");
                continue;
            }
            "user" | "assistant" => {}
            _ => continue,
        }
        if flag(&v, "isSidechain") {
            continue;
        }
        let Some(t) = timestamp(&v) else { continue };
        if cwd.is_none() {
            cwd = str_field(&v, "cwd");
        }
        let event = if ty == "assistant" { assistant_event(&v, t) } else { user_event(&v, t) };
        if let Some(mut e) = event {
            e.id = v.get("uuid").and_then(Value::as_str).map(hash_id);
            events.push(e);
        }
    }

    if events.is_empty() {
        return None;
    }
    events.sort_by_key(|e| e.t);
    Some(Session { cwd, title: custom_title.or(ai_title), events })
}

fn assistant_event(v: &Value, t: DateTime<Utc>) -> Option<Event> {
    if flag(v, "isApiErrorMessage") {
        return None;
    }
    let tools = v
        .pointer("/message/content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                .filter_map(|b| str_field(b, "name"))
                .collect()
        })
        .unwrap_or_default();
    let model = str_field(v, "model");
    let tokens = usage_tokens(v);
    Some(Event { id: None, t, kind: EventKind::Agent { tools }, model, tokens })
}

fn user_event(v: &Value, t: DateTime<Utc>) -> Option<Event> {
    // Entries the harness injects rather than the human typing them.
    if ["isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "isVirtual"]
        .iter()
        .any(|f| flag(v, f))
    {
        return None;
    }
    let content = v.pointer("/message/content")?;

    // Tool results come back to the agent as "user" entries. They're agent activity,
    // unless the human rejected the call, which is a steering decision.
    if let Some(blocks) = content.as_array() {
        if blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
            let kind = if v.get("toolDenialKind").and_then(Value::as_str) == Some("user-rejected") {
                EventKind::Rejected
            } else {
                EventKind::Agent { tools: Vec::new() }
            };
            return Some(Event { id: None, t, kind, model: None, tokens: None });
        }
    }

    // Newer logs mark who started a turn. Anything not from the human is skipped
    // (background task notices, messages from other agents, synthetic turns). "sdk" is
    // a person typing in an app built on the Claude Agent SDK, like T3 Code.
    let from_person = |s: &str| s == "human" || s == "sdk";
    if let Some(kind) = v.pointer("/origin/kind").and_then(Value::as_str) {
        if !from_person(kind) {
            return None;
        }
    }
    if let Some(origin) = v.get("turnOrigin").and_then(Value::as_str) {
        if !from_person(origin) {
            return None;
        }
    }
    if v.get("promptSource").and_then(Value::as_str) == Some("system") {
        return None;
    }

    let (raw, images) = extract_text(content);
    let stripped = strip_tag(&raw, "system-reminder");
    let text = stripped.trim();
    if injected(text) {
        return None;
    }
    let kind = if text.starts_with("[Request interrupted by user") {
        EventKind::Interrupt
    } else if text.starts_with("<bash-input>") {
        EventKind::Shell
    } else if text.starts_with("<command-name>") {
        EventKind::Command
    } else if text.is_empty() && images == 0 {
        return None;
    } else {
        EventKind::Prompt(PromptInfo::analyze(text, images))
    };
    Some(Event { id: None, t, kind, model: None, tokens: None })
}

/// Text Claude Code puts in a user message itself, never typed by the person.
const INJECTED: [&str; 7] = [
    "<task-notification>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<bash-stdout>",
    "<bash-stderr>",
    "Caveat:",
    // The summary Claude Code puts in after squeezing a long conversation down.
    "This session is being continued from a previous conversation",
];

pub(crate) fn injected(text: &str) -> bool {
    INJECTED.iter().any(|p| text.starts_with(p))
}

/// A short fingerprint of a prompt's text for finding it in the log: the start of the
/// text with spaces evened out, hashed (FNV-1a, so it's the same in every version).
pub(crate) fn prompt_key(text: &str) -> String {
    let start: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(300).collect();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in start.bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// For a "user" line in a Claude Code log: its text, and whether the person typed it.
/// Task notices, messages from other agents, scheduled prompts and summaries say false.
/// The live hook can't tell these apart, so it checks its prompts against this.
pub(crate) fn prompt_line(v: &Value) -> Option<(DateTime<Utc>, String, bool)> {
    if v.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let t = timestamp(v)?;
    let content = v.pointer("/message/content")?;
    if content.as_array().is_some_and(|b| b.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))) {
        return None;
    }
    let (raw, _) = extract_text(content);
    let text = strip_tag(&raw, "system-reminder").trim().to_owned();
    let typed = matches!(user_event(v, t), Some(Event { kind: EventKind::Prompt(_), .. }));
    Some((t, text, typed))
}

fn extract_text(content: &Value) -> (String, usize) {
    match content {
        Value::String(s) => (s.clone(), 0),
        Value::Array(blocks) => {
            let mut text = String::new();
            let mut images = 0;
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(s) = b.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(s);
                        }
                    }
                    Some("image") => images += 1,
                    _ => {}
                }
            }
            (text, images)
        }
        _ => (String::new(), 0),
    }
}

fn strip_tag(s: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        rest = match rest[start..].find(&close) {
            Some(end) => &rest[start + end + close.len()..],
            None => "",
        };
    }
    out.push_str(rest);
    out
}

fn hash_id(id: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut h);
    h.finish()
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn timestamp(v: &Value) -> Option<DateTime<Utc>> {
    let s = v.get("timestamp").and_then(Value::as_str)?;
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

/// Total tokens (input + output) from a message's usage block.
fn usage_tokens(v: &Value) -> Option<u64> {
    let usage = v.pointer("/message/usage").or_else(|| v.pointer("/usage"))?;
    let out = usage.get("output_tokens").and_then(Value::as_u64);
    let input = usage.get("input_tokens").and_then(Value::as_u64);
    match (input, out) {
        (Some(i), Some(o)) => Some(i + o),
        (_, Some(o)) => Some(o),
        (Some(i), None) => Some(i),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(origin: &str) -> Value {
        json!({
            "type": "user",
            "timestamp": "2026-11-22T20:00:00.000Z",
            "turnOrigin": origin,
            "origin": { "kind": origin },
            "message": { "role": "user", "content": "add a pause menu to main.rs" }
        })
    }

    #[test]
    fn prompts_typed_in_sdk_apps_count() {
        // T3 Code and other apps on the Claude Agent SDK mark turns as "sdk".
        assert!(prompt_line(&line("human")).unwrap().2);
        assert!(prompt_line(&line("sdk")).unwrap().2);
        for not_typed in ["task-notification", "task_notification", "peer", "coordinator", "scheduled", "host_synthetic"] {
            assert!(!prompt_line(&line(not_typed)).unwrap().2, "{not_typed} isn't a person typing");
        }
    }
}
