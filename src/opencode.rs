//! Reads OpenCode's database (~/.local/share/opencode/opencode.db, or under
//! $XDG_DATA_HOME) for messages written since the last look. It's opened read-only.
//!
//! Since OpenCode 2.4 each part of an assistant message (its text, reasoning and tool
//! calls) is saved as its own session_part row, and the message row keeps `content: []`.
//! Messages saved before that keep their parts inside, so both are read. Written from
//! OpenCode's source (anomalyco/opencode, packages/core/src/session/projector.ts), not
//! tried against a real 2.4 database yet.

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
/// call being sent again each time its message (or its own row) gets updated.
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
        // A part gets saved without touching its message, so it can be the newest row.
        let newest = |table: &str| {
            conn.query_row(&format!("select coalesce(max(time_updated), 0) from {table}"), [], |r| r.get::<_, i64>(0))
                .unwrap_or(0)
        };
        state.insert("cursor".into(), newest("session_message").max(newest("session_part")).into());
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

const MESSAGES: &str = "select m.id, m.session_id, m.type, m.data, m.time_updated as updated, s.directory, s.parent_id
    from session_message m left join session_v2 s on s.id = m.session_id
    where m.time_created > ?3 and m.time_updated > ?1";

/// Tool calls saved as their own rows. They're found through their message, which is
/// made before them, so the lookback works for them too. The cross join makes SQLite go
/// that way round: session_part has no index on time, so the other way reads all of it.
const PARTS: &str = "select p.message_id, p.session_id, 'part', p.data, p.time_updated, s.directory, s.parent_id
    from session_message m cross join session_part p on p.message_id = m.id
    left join session_v2 s on s.id = p.session_id
    where m.time_created > ?3 and p.type = 'tool' and p.time_updated > ?1";

/// Every event in rows updated after `cursor`, plus the newest update time seen.
pub fn read_since(conn: &Connection, cursor: i64) -> (Vec<Value>, i64) {
    // OpenCode before 2.2.2 has no session_part table.
    let stmt = conn
        .prepare(&format!("{MESSAGES} union all {PARTS} order by updated limit ?2"))
        .or_else(|_| conn.prepare(&format!("{MESSAGES} order by updated limit ?2")));
    let Ok(mut stmt) = stmt else { return (Vec::new(), cursor) };
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

/// The events in one session_message row, or in a tool call's own session_part row
/// (kind "part", where `id` is its message's).
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
                out.push(prompt_event(format!("oc-{id}"), session, project, VIA, t, &PromptInfo::analyze(text.trim(), images)));
            }
        }
        "assistant" => {
            for item in d.get("content").and_then(Value::as_array).into_iter().flatten() {
                if item.get("type").and_then(Value::as_str) == Some("tool") {
                    out.extend(tool(id, session, project, item));
                }
            }
            if let Some(t) = ms(d.pointer("/time/completed")) {
                out.push(event(format!("oc-{id}-done"), session, project, VIA, t, "stop"));
            }
        }
        "part" => out.extend(tool(id, session, project, d)),
        "idle" => {
            if let Some(t) = ms(d.pointer("/time/created")) {
                out.push(event(format!("oc-{id}"), session, project, VIA, t, "stop"));
            }
        }
        _ => {}
    }
    out
}

/// A tool call, from its message's content or from its own row. Its id is the same
/// either way, so when OpenCode moves an older message's parts into rows, the calls read
/// again are dropped as repeats (by `sent`, and by the server).
fn tool(message: &str, session: &str, project: &str, item: &Value) -> Option<Value> {
    let t = ms(item.pointer("/time/created"))?;
    let tool_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
    let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
    Some(tool_event(format!("oc-{message}-{tool_id}"), session, project, VIA, t, name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_new_rows_only_and_skips_subagent_prompts() {
        crate::live::use_temp_home();
        // Laid out like OpenCode before 2.2.2, which has no session_part table.
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

    /// A database laid out like OpenCode 2.4's, with the indexes the queries rely on.
    fn with_parts() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "create table session_message (id text primary key, session_id text, type text, seq int, time_created int, time_updated int, data text);
             create index session_message_time_created_idx on session_message (time_created);
             create table session_part (message_id text, session_id text, ordinal int, type text, call_id text,
                                        time_created int, time_updated int, data text, primary key (message_id, ordinal));
             create table session_v2 (id text primary key, directory text, parent_id text);
             insert into session_v2 values ('main', '/tmp/pong', null), ('sub', '/tmp/pong', 'main');",
        )
        .unwrap();
        conn
    }

    fn message(conn: &Connection, id: &str, session: &str, kind: &str, created: i64, updated: i64, data: Value) {
        conn.execute(
            "insert or replace into session_message values (?1, ?2, ?3, 0, ?4, ?5, ?6)",
            rusqlite::params![id, session, kind, created, updated, data.to_string()],
        )
        .unwrap();
    }

    /// A part as OpenCode 2.4 saves it: its type and call id as columns, and the whole
    /// part, the same as it would be inside its message's content, as data.
    fn part(conn: &Connection, message: &str, session: &str, ordinal: i64, updated: i64, data: Value) {
        let call = data.get("id").and_then(Value::as_str).map(str::to_owned);
        conn.execute(
            "insert into session_part values (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
            rusqlite::params![message, session, ordinal, data["type"].as_str(), call, updated, data.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn reads_tool_calls_saved_as_their_own_rows() {
        crate::live::use_temp_home();
        let conn = with_parts();
        message(&conn, "u1", "main", "user", 2_000, 2_000, json!({ "time": { "created": 2_000 }, "text": "the ball goes through the paddle" }));
        // The message row keeps the step's times, and its content is empty.
        message(&conn, "a1", "main", "assistant", 2_100, 3_000, json!({ "time": { "created": 2_100, "completed": 3_000 }, "content": [] }));
        part(&conn, "a1", "main", 0, 2_200, json!({ "type": "text", "text": "looking at game.py" }));
        part(&conn, "a1", "main", 1, 2_600, json!({ "type": "tool", "id": "t1", "name": "read", "time": { "created": 2_300, "completed": 2_600 } }));
        // Saved after its message row was last changed.
        part(&conn, "a1", "main", 2, 3_500, json!({ "type": "tool", "id": "t2", "name": "shell", "time": { "created": 2_900 } }));
        // A subagent's tool calls count for the session that started it.
        message(&conn, "a2", "sub", "assistant", 2_150, 2_150, json!({ "time": { "created": 2_150 }, "content": [] }));
        part(&conn, "a2", "sub", 0, 2_400, json!({ "type": "tool", "id": "t3", "name": "grep", "time": { "created": 2_400 } }));
        // Already read last time.
        message(&conn, "a0", "main", "assistant", 1_000, 1_200, json!({ "time": { "created": 1_000, "completed": 1_200 }, "content": [] }));
        part(&conn, "a0", "main", 0, 1_100, json!({ "type": "tool", "id": "t0", "name": "read", "time": { "created": 1_100 } }));

        let (events, newest) = read_since(&conn, 1_500);
        assert_eq!(newest, 3_500);
        let ids: Vec<&str> = events.iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["oc-u1", "oc-a2-t3", "oc-a1-t1", "oc-a1-done", "oc-a1-t2"]);
        assert_eq!(events[2]["tool"], "read");
        assert_eq!(events[2]["t"], "1970-01-01T00:00:02.300Z", "when the call started, not when its row changed");
        assert!(events.iter().all(|e| e["session"] == "main" && e["project"] == "pong"));
        assert!(events.iter().all(|e| e.get("text").is_none()));
    }

    #[test]
    fn a_tool_call_keeps_its_id_when_its_message_moves_into_rows() {
        crate::live::use_temp_home();
        let conn = with_parts();
        let t1 = json!({ "type": "tool", "id": "t1", "name": "read", "time": { "created": 2_100 } });
        // Saved by OpenCode 2.3, with the parts inside the message.
        message(&conn, "a1", "main", "assistant", 2_000, 2_500, json!({ "time": { "created": 2_000 }, "content": [t1] }));
        // Saved by 2.4, in the same database.
        message(&conn, "a2", "main", "assistant", 2_600, 2_600, json!({ "time": { "created": 2_600 }, "content": [] }));
        part(&conn, "a2", "main", 0, 2_700, json!({ "type": "tool", "id": "t2", "name": "edit", "time": { "created": 2_700 } }));
        let (first, cursor) = read_since(&conn, 1_500);

        // 2.4 moves a1's parts into rows right before it adds another one.
        message(&conn, "a1", "main", "assistant", 2_000, 3_000, json!({ "time": { "created": 2_000 }, "content": [] }));
        part(&conn, "a1", "main", 0, 3_000, t1);
        part(&conn, "a1", "main", 1, 3_100, json!({ "type": "tool", "id": "t3", "name": "shell", "time": { "created": 3_100 } }));
        let (second, _) = read_since(&conn, cursor);

        assert_eq!(first[0], second[0], "t1 reads the same from either layout");
        // What poll sends, with `sent` dropping repeats.
        let mut sent = HashSet::new();
        let ids: Vec<&str> = first.iter().chain(&second).map(|e| e["id"].as_str().unwrap()).filter(|id| sent.insert(*id)).collect();
        assert_eq!(ids, ["oc-a1-t1", "oc-a2-t2", "oc-a1-t3"]);
    }

    #[test]
    fn parts_are_found_through_recent_messages() {
        // OpenCode keeps every part ever saved, so reading all of them every few seconds
        // would get slow.
        let conn = with_parts();
        let mut stmt = conn.prepare(&format!("explain query plan {PARTS}")).unwrap();
        let plan: Vec<String> = stmt.query_map([0, 0, 0], |r| r.get(3)).unwrap().flatten().collect();
        assert!(plan.iter().any(|step| step.contains("SEARCH p USING INDEX")), "{plan:?}");
        assert!(!plan.iter().any(|step| step.contains("SCAN p")), "{plan:?}");
    }
}
