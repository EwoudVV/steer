//! Reads OpenCode's database (~/.local/share/opencode/opencode.db, or under
//! $XDG_DATA_HOME) for messages written since the last look. It's opened read-only.

use crate::live::{event, home, project_name, prompt_event, tool_event};
use crate::prompt::PromptInfo;
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

pub const VIA: &str = "opencode";
const BATCH: i64 = 5000;

fn db_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local").join("share"));
    let path = base.join("opencode").join("opencode.db");
    path.exists().then_some(path)
}

fn open() -> Option<Connection> {
    let conn = Connection::open_with_flags(db_path()?, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(500));
    Some(conn)
}

/// Reads rows changed since `state.cursor` (ms). On the first run there's no cursor,
/// so it starts from the newest row and sends nothing old. `sent` stops the same tool
/// call being sent again each time its message gets updated.
pub fn poll(state: &mut Map<String, Value>, sent: &mut HashSet<String>) -> Vec<Value> {
    // If the database files haven't changed since last time there's nothing new, and
    // checking that is two file lookups instead of a query.
    let Some(path) = db_path() else { return Vec::new() };
    let stamp = changed_at(&path);
    if stamp.is_some() && state.get("stamp").and_then(Value::as_i64) == stamp {
        return Vec::new();
    }
    let Some(conn) = open() else { return Vec::new() };
    let Some(cursor) = state.get("cursor").and_then(Value::as_i64) else {
        let newest: i64 = conn
            .query_row("select coalesce(max(time_updated), 0) from session_message", [], |r| r.get(0))
            .unwrap_or(0);
        state.insert("cursor".into(), newest.into());
        if let Some(s) = stamp {
            state.insert("stamp".into(), s.into());
        }
        return Vec::new();
    };
    let (events, newest) = read_since(&conn, cursor);
    state.insert("cursor".into(), newest.max(cursor).into());
    if let Some(s) = stamp {
        state.insert("stamp".into(), s.into());
    }
    if sent.len() > 200_000 {
        sent.clear();
    }
    events.into_iter().filter(|e| sent.insert(e["id"].as_str().unwrap_or_default().to_owned())).collect()
}

/// Latest change time (ms) of the database and its write-ahead log.
fn changed_at(db: &std::path::Path) -> Option<i64> {
    let wal = db.with_extension("db-wal");
    [db.to_path_buf(), wal]
        .iter()
        .filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .max()
}

/// Rows can be updated a while after they're created (a long agent turn), so look at
/// messages created up to this long before the cursor. This lets SQLite use OpenCode's
/// index on time_created instead of reading the whole table.
const LOOKBACK_MS: i64 = 6 * 60 * 60 * 1000;

/// Every event in rows updated after `cursor`, plus the newest update time seen.
pub fn read_since(conn: &Connection, cursor: i64) -> (Vec<Value>, i64) {
    let sql = "select m.id, m.session_id, m.type, m.data, m.time_updated, s.directory, s.parent_id
               from session_message m left join session_v2 s on s.id = m.session_id
               where m.time_created > ?3 and m.time_updated > ?1 order by m.time_updated limit ?2";
    let Ok(mut stmt) = conn.prepare(sql) else { return (Vec::new(), cursor) };
    let rows = stmt.query_map(rusqlite::params![cursor, BATCH, cursor - LOOKBACK_MS], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
        ))
    });
    let Ok(rows) = rows else { return (Vec::new(), cursor) };

    let mut out = Vec::new();
    let mut newest = cursor;
    for (id, session_id, kind, data, updated, dir, parent) in rows.flatten() {
        newest = newest.max(updated);
        let Ok(d) = serde_json::from_str::<Value>(&data) else { continue };
        // A subagent's session belongs to the session that started it. Its "prompts"
        // were written by the agent, so they're skipped, but its tool calls count as
        // agent activity.
        let is_subagent = parent.is_some();
        let session = parent.unwrap_or(session_id);
        let project = project_name(dir.as_deref().unwrap_or_default());
        out.extend(parse(&id, &session, &project, &kind, &d, is_subagent));
    }
    (out, newest)
}

fn ms(v: Option<&Value>) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(v?.as_i64()?)
}

/// The events in one session_message row.
pub fn parse(id: &str, session: &str, project: &str, kind: &str, d: &Value, is_subagent: bool) -> Vec<Value> {
    let mut out = Vec::new();
    match kind {
        "user" if !is_subagent => {
            let Some(t) = ms(d.pointer("/time/created")) else { return out };
            let text = d.get("text").and_then(Value::as_str).unwrap_or_default();
            let images = d
                .get("files")
                .and_then(Value::as_array)
                .map(|f| f.iter().filter(|f| f.get("mime").and_then(Value::as_str).is_some_and(|m| m.starts_with("image/"))).count())
                .unwrap_or(0);
            if !text.trim().is_empty() || images > 0 {
                let model = d.get("model").and_then(Value::as_str);
                let tokens = d.get("tokens").and_then(Value::as_u64).or_else(|| d.pointer("/usage/output_tokens").and_then(Value::as_u64));
                out.push(prompt_event(format!("oc-{id}"), session, project, VIA, t, &PromptInfo::analyze_with(text.trim(), images, model, tokens)));
            }
        }
        "assistant" => {
            for item in d.get("content").and_then(Value::as_array).into_iter().flatten() {
                if item.get("type").and_then(Value::as_str) != Some("tool") {
                    continue;
                }
                let Some(t) = ms(item.pointer("/time/created")) else { continue };
                let tool_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
                let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                let model = item.get("model").and_then(Value::as_str);
                let tokens = item.get("tokens").and_then(Value::as_u64).or_else(|| item.pointer("/usage/output_tokens").and_then(Value::as_u64));
                out.push(tool_event(format!("oc-{id}-{tool_id}"), session, project, VIA, t, name, model, tokens));
            }
            if let Some(t) = ms(d.pointer("/time/completed")) {
                out.push(event(format!("oc-{id}-done"), session, project, VIA, t, "stop"));
            }
        }
        "idle" => {
            if let Some(t) = ms(d.pointer("/time/created")) {
                out.push(event(format!("oc-{id}"), session, project, VIA, t, "stop"));
            }
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_new_rows_only_and_skips_subagent_prompts() {
        crate::live::use_temp_home();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "create table session_message (id text, session_id text, type text, seq int, time_created int, time_updated int, data text);
             create table session_v2 (id text, directory text, parent_id text);
             insert into session_v2 values ('main', '/tmp/pong', null), ('sub', '/tmp/pong', 'main');",
        )
        .unwrap();
        let add = |id: &str, session: &str, kind: &str, t: i64, data: Value| {
            conn.execute(
                "insert into session_message values (?1, ?2, ?3, 0, ?4, ?4, ?5)",
                rusqlite::params![id, session, kind, t, data.to_string()],
            )
            .unwrap();
        };
        add("old", "main", "user", 1_000, json!({ "time": { "created": 1_000 }, "text": "old prompt", "files": [] }));
        add("u1", "main", "user", 2_000, json!({
            "time": { "created": 2_000 }, "text": "the paddle in game.py goes through the ball",
            "files": [{ "mime": "image/png" }]
        }));
        add("a1", "main", "assistant", 3_000, json!({
            "time": { "created": 2_100, "completed": 3_000 },
            "content": [{ "type": "text" }, { "type": "tool", "id": "t1", "name": "shell", "time": { "created": 2_500 } }]
        }));
        add("u2", "sub", "user", 3_100, json!({ "time": { "created": 3_100 }, "text": "subagent task" }));
        add("a2", "sub", "assistant", 3_200, json!({
            "time": { "created": 3_150 }, "content": [{ "type": "tool", "id": "t2", "name": "read", "time": { "created": 3_200 } }]
        }));
        add("i1", "main", "idle", 3_300, json!({ "time": { "created": 3_300 }, "outcome": "done" }));

        let (events, newest) = read_since(&conn, 1_500);
        assert_eq!(newest, 3_300);
        let kinds: Vec<&str> = events.iter().map(|e| e["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["prompt", "tool", "stop", "tool", "stop"]);
        assert_eq!(events[0]["images"], 1);
        assert_eq!(events[0]["project"], "pong");
        assert!(events.iter().all(|e| e["session"] == "main"));
        assert!(events.iter().all(|e| e.get("text").is_none()));
    }
}
