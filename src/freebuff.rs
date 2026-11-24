//! Reads Freebuff chats (and Codebuff's, they share the code):
//! ~/.config/manicode/projects/<folder>/chats/<chat>/chat-messages.json, or under
//! $FREEBUFF_CONFIG_DIR. Each file is the whole chat as one JSON array, rewritten every
//! few seconds while the agent works. Its times only say the hour and minute, so events
//! are stamped when the watcher sees them change (it looks every 5 seconds).
//!
//! Written from Freebuff's source (CodebuffAI/freebuff, cli/src/types/chat.ts and
//! cli/src/utils/run-state-storage.ts). Not tried against real Freebuff use yet.

use crate::live::{event, home, new_id, prompt_event, tool_event};
use crate::prompt::PromptInfo;
use chrono::{Local, Timelike, Utc};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const VIA: &str = "freebuff";
/// Chats not written in this long aren't read.
const RECENT: Duration = Duration::from_secs(2 * 3600);
/// A chat file bigger than this isn't parsed every few seconds.
const MAX_BYTES: u64 = 30_000_000;

pub(crate) fn root() -> PathBuf {
    std::env::var_os("FREEBUFF_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".config").join("manicode"))
}

/// New events from every chat written recently. On the watcher's first look
/// (`skip_existing`) it only notes what's there. A chat it hasn't seen before only gets
/// events for messages from the last few minutes, so reopening an old chat doesn't send
/// its history again.
pub fn poll(state: &mut Map<String, Value>, skip_existing: bool) -> Vec<Value> {
    poll_in(&root(), state, skip_existing)
}

pub(crate) fn poll_in(root: &Path, state: &mut Map<String, Value>, skip_existing: bool) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(projects) = fs::read_dir(root.join("projects")) else { return out };
    let now = SystemTime::now();
    let mut live = Vec::new();
    for project in projects.flatten() {
        let Ok(chats) = fs::read_dir(project.path().join("chats")) else { continue };
        let name = project_label(&project.file_name().to_string_lossy());
        for chat in chats.flatten() {
            let file = chat.path().join("chat-messages.json");
            let Ok(meta) = fs::metadata(&file) else { continue };
            let Ok(modified) = meta.modified() else { continue };
            if now.duration_since(modified).unwrap_or_default() > RECENT || meta.len() > MAX_BYTES {
                continue;
            }
            let key = file.to_string_lossy().into_owned();
            live.push(key.clone());
            let stamp = modified.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let known = state.get(&key).cloned();
            if known.as_ref().and_then(|k| k["stamp"].as_u64()) == Some(stamp) {
                continue;
            }
            let Some(messages) = fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Vec<Value>>(&b).ok()) else { continue };
            let session = format!("{VIA}:{name}/{}", chat.file_name().to_string_lossy());
            let mut seen = known.as_ref().and_then(|k| k["seen"].as_object().cloned()).unwrap_or_default();
            out.extend(changes(&messages, &mut seen, &session, &name, skip_existing, known.is_none()));
            state.insert(key, json!({ "stamp": stamp, "seen": seen }));
        }
    }
    // Forget chats that went quiet.
    state.retain(|k, _| live.contains(k));
    out
}

/// The folder name, or "home" for the home folder, whose name is usually the person's
/// real name.
fn project_label(folder: &str) -> String {
    let home_name = home().file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    if folder.is_empty() || folder == home_name {
        "home".into()
    } else {
        folder.into()
    }
}

/// Compares the chat with what was seen before (`seen`: message id -> [tool calls
/// sent, finished]) and returns events for what's new, stamped now. With `skip` it
/// only records. In a chat not seen before, only messages from the last few minutes
/// count.
fn changes(messages: &[Value], seen: &mut Map<String, Value>, session: &str, project: &str, skip: bool, new_chat: bool) -> Vec<Value> {
    let mut out = Vec::new();
    let now = Utc::now();
    for m in messages {
        let Some(id) = m["id"].as_str() else { continue };
        let quiet = skip || (new_chat && !just_now(m["timestamp"].as_str().unwrap_or_default()));
        let variant = m["variant"].as_str().unwrap_or_default();
        let before = seen.get(id).cloned();
        match variant {
            "user" => {
                if before.is_none() && !quiet {
                    let text = m["content"].as_str().unwrap_or_default();
                    let images = m["attachments"].as_array().map_or(0, Vec::len);
                    let model = m.get("model").and_then(Value::as_str);
                    let tokens = m.get("usage").and_then(|u| u.get("output_tokens")).and_then(Value::as_u64);
                    out.push(prompt_event(new_id(), session, project, VIA, now, &PromptInfo::analyze_with(text, images, model, tokens)));
                }
                seen.insert(id.into(), json!([0, true]));
            }
            "ai" | "agent" => {
                let mut tools = Vec::new();
                if let Some(blocks) = m["blocks"].as_array() {
                    tool_names(blocks, &mut tools);
                }
                // Mode dividers and notices are "ai" messages too, but the agent didn't
                // do anything in them.
                let did_work = !tools.is_empty() || !m["content"].as_str().unwrap_or_default().is_empty() || has_text(&m["blocks"]);
                if !did_work {
                    continue;
                }
                let sent = before.as_ref().and_then(|b| b[0].as_u64()).unwrap_or(0) as usize;
                let was_done = before.as_ref().and_then(|b| b[1].as_bool()).unwrap_or(false);
                let done = m["isComplete"].as_bool().unwrap_or(false);
                if !quiet {
                    if before.is_none() && tools.is_empty() && !done {
                        // Started answering, no tool calls yet.
                        out.push(event(new_id(), session, project, VIA, now, "tool"));
                    }
                    for name in tools.iter().skip(sent) {
                        out.push(tool_event(new_id(), session, project, VIA, now, name));
                    }
                    if done && !was_done && variant == "ai" {
                        out.push(event(new_id(), session, project, VIA, now, "stop"));
                    }
                }
                seen.insert(id.into(), json!([tools.len().max(sent), done]));
            }
            _ => {}
        }
    }
    out
}

/// Tool names in order, including ones inside spawned agents.
fn tool_names(blocks: &[Value], out: &mut Vec<String>) {
    for b in blocks {
        match b["type"].as_str() {
            Some("tool") => out.push(b["toolName"].as_str().unwrap_or("tool").chars().take(80).collect()),
            Some("agent") => {
                if let Some(inner) = b["blocks"].as_array() {
                    tool_names(inner, out);
                }
            }
            _ => {}
        }
    }
}

/// True if a "08:05 PM" or "20:05" style time is within the last 3 minutes, here.
fn just_now(time: &str) -> bool {
    let digits: Vec<u32> = time.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect();
    let [hour, minute, ..] = digits[..] else { return false };
    let lower = time.to_ascii_lowercase();
    let pm = lower.contains('p');
    let am = lower.contains('a') && !pm;
    let hour = match (hour, am, pm) {
        (12, true, _) => 0,
        (h, _, true) if h < 12 => h + 12,
        (h, _, _) => h,
    };
    let now = Local::now();
    let then = (hour * 60 + minute) as i64;
    let mins = (now.hour() * 60 + now.minute()) as i64;
    (mins - then).rem_euclid(1440) <= 3
}

fn has_text(blocks: &Value) -> bool {
    blocks.as_array().is_some_and(|bs| bs.iter().any(|b| b["type"] == "text" && b["content"].as_str().is_some_and(|c| !c.is_empty())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, messages: &Value) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("chat-messages.json"), messages.to_string()).unwrap();
        // A later modified time each write, even within the same millisecond.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let file = fs::File::options().write(true).open(dir.join("chat-messages.json")).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_millis(n * 50)).unwrap();
    }
    fn kinds(events: &[Value]) -> Vec<&str> {
        events.iter().map(|e| e["kind"].as_str().unwrap()).collect()
    }

    #[test]
    fn reads_a_chat_as_it_grows() {
        let root = std::env::temp_dir().join(format!("steer-freebuff-{}", new_id()));
        let chat = root.join("projects").join("game").join("chats").join("2026-11-22T20-00-00.000Z");
        let user = json!({ "id": "u1", "variant": "user", "content": "add a pause menu to main.rs", "timestamp": "08:00 PM" });
        write(&chat, &json!([user]));
        let mut state = Map::new();
        // Already there when the watcher starts: nothing sent.
        assert!(poll_in(&root, &mut state, true).is_empty());

        // The agent starts working and calls two tools.
        let ai = |tools: &[&str], done: bool| {
            let blocks: Vec<Value> = tools.iter().map(|t| json!({ "type": "tool", "toolCallId": t, "toolName": t, "input": {} })).collect();
            json!({ "id": "a1", "variant": "ai", "content": "", "blocks": blocks, "timestamp": "08:00 PM", "isComplete": done })
        };
        write(&chat, &json!([user, ai(&["read_files", "str_replace"], false)]));
        let e = poll_in(&root, &mut state, false);
        assert_eq!(kinds(&e), ["tool", "tool"]);
        assert_eq!(e[0]["tool"], "read_files");
        assert_eq!(e[0]["via"], "freebuff");
        assert_eq!(e[0]["project"], "game");
        // Nothing changed: nothing new.
        assert!(poll_in(&root, &mut state, false).is_empty());
        // One more tool, then it finishes.
        write(&chat, &json!([user, ai(&["read_files", "str_replace", "run_terminal_command"], true)]));
        assert_eq!(kinds(&poll_in(&root, &mut state, false)), ["tool", "stop"]);
        // The next prompt.
        let next = json!({ "id": "u2", "variant": "user", "content": "now make escape open it", "timestamp": "08:03 PM" });
        write(&chat, &json!([user, ai(&["read_files", "str_replace", "run_terminal_command"], true), next]));
        let e = poll_in(&root, &mut state, false);
        assert_eq!(kinds(&e), ["prompt"]);
        assert_eq!(e[0]["words"], 5);
        assert_eq!(e[0]["session"], "freebuff:game/2026-11-22T20-00-00.000Z");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_new_chat_counts_from_its_first_prompt_but_an_old_one_doesnt_replay() {
        let root = std::env::temp_dir().join(format!("steer-freebuff-{}", new_id()));
        fs::create_dir_all(root.join("projects")).unwrap();
        let mut state = Map::new();
        assert!(poll_in(&root, &mut state, true).is_empty());
        let now = Local::now().format("%I:%M %p").to_string();
        let earlier = (Local::now() - chrono::Duration::minutes(40)).format("%H:%M").to_string();
        // A chat started after the watcher: its first prompt counts.
        let chat = root.join("projects").join("game").join("chats").join("new");
        write(&chat, &json!([{ "id": "u1", "variant": "user", "content": "fix the jump in player.rs", "timestamp": now }]));
        assert_eq!(kinds(&poll_in(&root, &mut state, false)), ["prompt"]);
        // An older chat written to again: only what's new counts, not its history.
        let old = root.join("projects").join("game").join("chats").join("old");
        write(&old, &json!([
            { "id": "o1", "variant": "user", "content": "make a snake game", "timestamp": earlier },
            { "id": "o2", "variant": "ai", "content": "done", "blocks": [{ "type": "tool", "toolName": "write_file" }], "timestamp": earlier, "isComplete": true },
            { "id": "o3", "variant": "user", "content": "add a score counter", "timestamp": now },
        ]));
        assert_eq!(kinds(&poll_in(&root, &mut state, false)), ["prompt"]);
        assert!(just_now(&Local::now().format("%H:%M").to_string()));
        assert!(!just_now(&earlier));
        assert!(!just_now("whenever"));
        let _ = fs::remove_dir_all(&root);
    }
}
