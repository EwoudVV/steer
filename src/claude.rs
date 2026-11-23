//! Reads Claude Code session logs (~/.claude/projects/<project>/<session>.jsonl).
//! Prompt text is analyzed in memory and dropped; nothing here is written or sent anywhere.

use crate::model::{Event, EventKind, Session};
use crate::prompt::PromptInfo;
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
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

/// `t3` is T3 Code's database, if it's on this computer. Only it can say which of T3's
/// prompts the person wrote (see `from_t3`).
pub fn parse_session(path: &Path, mut t3: Option<&mut crate::t3::Db>) -> Option<Session> {
    let reader = BufReader::new(File::open(path).ok()?);
    let mut events = Vec::new();
    let mut cwd = None;
    let mut custom_title = None;
    let mut ai_title = None;
    let mut session = None;
    // T3 only started marking its lines "t3-code" in November 2026, so one marked line
    // makes the whole session T3's, and so do T3's own tools (mcp__t3-code__...), which
    // every agent T3 runs gets and the log lists. Until the end, turns that came in
    // through the SDK are kept aside as (index in events, time, text).
    let mut ran_by_t3 = false;
    let mut sdk_turns = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let ty = v.get("type").and_then(Value::as_str).unwrap_or_default();
        if matches!(ty, "attachment" | "assistant") && line.contains("\"mcp__t3-code__") {
            ran_by_t3 = true;
        }
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
        if session.is_none() {
            session = str_field(&v, "sessionId");
        }
        ran_by_t3 |= from_t3(&v);
        let event = if ty == "assistant" {
            assistant_event(&v, t)
        } else {
            user_event(&v, t).or_else(|| typed_in_t3(&v, t, t3.as_deref_mut()))
        };
        if let Some(mut e) = event {
            if ty == "user" && !from_t3(&v) && sent_by_sdk(&v) {
                if let Some((_, text, _)) = prompt_line(&v) {
                    sdk_turns.push((events.len(), t, text));
                }
            }
            e.id = v.get("uuid").and_then(Value::as_str).map(hash_id);
            events.push(e);
        }
    }

    // In a session T3 ran (a line says so, or T3's database knows the session), the
    // unmarked SDK turns only count if T3's database says the person wrote them.
    let session = session.as_deref();
    let known = |db: &mut crate::t3::Db| session.is_some_and(|s| db.knows(s));
    if !sdk_turns.is_empty() && (ran_by_t3 || t3.as_deref_mut().is_some_and(known)) {
        let mut unverified = std::collections::HashSet::new();
        for (i, t, text) in &sdk_turns {
            let key = prompt_key(crate::t3::typed_part(text).0);
            let typed = match (t3.as_deref_mut(), session) {
                (Some(db), Some(s)) => db.typed(s, None, *t, &key) == crate::t3::Says::Typed(true),
                _ => false,
            };
            if typed {
                count_typed_part(&mut events[*i], text);
            } else {
                unverified.insert(*i);
            }
        }
        let mut i = 0;
        events.retain(|_| {
            i += 1;
            !unverified.contains(&(i - 1))
        });
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
    Some(Event { id: None, t, kind: EventKind::Agent { tools } })
}

fn user_event(v: &Value, t: DateTime<Utc>) -> Option<Event> {
    user_event_as(v, t, !from_t3(v))
}

/// Whether a line is from a Claude Code that T3 Code runs. T3 sends what agents write to
/// each other (tasks one agent hands another, messages between threads, scheduled tasks)
/// through the Agent SDK too, so in this log they look just like what the person typed.
/// Only T3's database can tell them apart (see t3.rs), so its "sdk" turns don't count
/// from the log alone.
pub(crate) fn from_t3(v: &Value) -> bool {
    v.get("entrypoint").and_then(Value::as_str) == Some("t3-code")
}

/// Whether a turn came in through the Claude Agent SDK.
pub(crate) fn sent_by_sdk(v: &Value) -> bool {
    v.pointer("/origin/kind").and_then(Value::as_str) == Some("sdk")
        || ["turnOrigin", "promptSource"].iter().any(|k| v.get(*k).and_then(Value::as_str) == Some("sdk"))
}

/// For the report: a T3 turn, if T3's database says the person wrote it.
fn typed_in_t3(v: &Value, t: DateTime<Utc>, db: Option<&mut crate::t3::Db>) -> Option<Event> {
    let db = db?;
    if !from_t3(v) || !sent_by_sdk(v) {
        return None;
    }
    let session = v.get("sessionId").and_then(Value::as_str)?;
    let (_, text, _) = prompt_line(v)?;
    if db.typed(session, None, t, &prompt_key(crate::t3::typed_part(&text).0)) != crate::t3::Says::Typed(true) {
        return None;
    }
    let mut e = user_event_as(v, t, true)?;
    count_typed_part(&mut e, &text);
    Some(e)
}

/// Only the part of a T3 prompt the person wrote counts (see `t3::typed_part`).
fn count_typed_part(e: &mut Event, text: &str) {
    if let EventKind::Prompt(p) = &mut e.kind {
        let (typed, images) = crate::t3::typed_part(text);
        *p = PromptInfo::analyze(typed, images.max(p.images));
    }
}

/// `sdk_typed`: whether a turn that came in through the Agent SDK is the person typing.
fn user_event_as(v: &Value, t: DateTime<Utc>, sdk_typed: bool) -> Option<Event> {
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
            return Some(Event { id: None, t, kind });
        }
    }

    // Newer logs mark who started a turn. Anything not from the human is skipped
    // (background task notices, messages from other agents, synthetic turns). "sdk" is
    // a person typing in an app built on the Claude Agent SDK, except in T3 Code (see
    // `from_t3`).
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
    if !sdk_typed && sent_by_sdk(v) {
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
    Some(Event { id: None, t, kind })
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
        // Apps on the Claude Agent SDK mark turns as "sdk".
        assert!(prompt_line(&line("human")).unwrap().2);
        assert!(prompt_line(&line("sdk")).unwrap().2);
        for not_typed in ["task-notification", "task_notification", "peer", "coordinator", "scheduled", "host_synthetic"] {
            assert!(!prompt_line(&line(not_typed)).unwrap().2, "{not_typed} isn't a person typing");
        }
    }

    #[test]
    fn t3_turns_count_only_when_t3_says_the_person_wrote_them() {
        use crate::t3::tests::{at, by, fake};
        let t3_line = |s: i64, text: &str| {
            let mut v = line("sdk");
            v["timestamp"] = at(s).to_rfc3339_opts(chrono::SecondsFormat::Millis, true).into();
            v["entrypoint"] = "t3-code".into();
            v["promptSource"] = "sdk".into();
            v["sessionId"] = "s1".into();
            v["message"]["content"] = text.into();
            v
        };
        // From the log alone it can't be told who wrote these.
        assert!(!prompt_line(&t3_line(0, "add a pause menu")).unwrap().2);

        let tmp = std::env::temp_dir().join(format!("steer-t3-report-{}", crate::live::new_id()));
        fs::create_dir_all(&tmp).unwrap();
        let db = tmp.join("statev2.sqlite");
        fake(
            &db,
            &[("th1", "s1")],
            &[
                ("m0", "th1", at(-101), by("user", "web", "start the router dashboard")),
                ("m1", "th1", at(-1), by("user", "web", "add a pause menu")),
                ("m2", "th1", at(19), by("agent", "mcp", "review the pause menu")),
            ],
        );
        // Before November 2026 T3's lines weren't marked "t3-code" yet.
        let mut older = t3_line(-100, "start the router dashboard");
        older["entrypoint"] = "sdk-ts".into();
        let log = tmp.join("s1.jsonl");
        let lines = [older.clone(), t3_line(0, "add a pause menu"), t3_line(20, "review the pause menu")];
        fs::write(&log, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
        // Another app on the Agent SDK, which T3 doesn't know.
        let other = tmp.join("s7.jsonl");
        older["sessionId"] = "s7".into();
        fs::write(&other, format!("{older}\n")).unwrap();

        let prompts = |log: &Path, t3: Option<&mut crate::t3::Db>| {
            parse_session(log, t3).map_or(0, |s| s.events.iter().filter(|e| matches!(e.kind, EventKind::Prompt(_))).count())
        };
        assert_eq!(prompts(log.as_path(), None), 0);
        assert_eq!(prompts(other.as_path(), None), 1);
        // An older T3 session with no marked line at all, but T3's tools in the log.
        let tools = tmp.join("s8.jsonl");
        older["sessionId"] = "s8".into();
        let listed = json!({ "type": "attachment", "attachment": { "type": "deferred_tools_delta", "addedNames": ["Read", "mcp__t3-code__delegate_task"] } });
        fs::write(&tools, format!("{older}\n{listed}\n")).unwrap();
        assert_eq!(prompts(tools.as_path(), None), 0);
        let mut t3 = crate::t3::Db::open(&db).unwrap();
        assert_eq!(prompts(log.as_path(), Some(&mut t3)), 2, "only the ones the person typed");
        assert_eq!(prompts(other.as_path(), Some(&mut t3)), 1);
        drop(t3);
        let _ = fs::remove_dir_all(&tmp);
    }
}
