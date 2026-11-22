//! T3 Code runs Claude Code and Codex for you, and it sends them more than what you
//! type: tasks one agent hands another, messages between threads, scheduled tasks,
//! notices that a pull request's checks finished. Their logs show all of it as typed
//! ("sdk" in Claude Code's log, a user message in Codex's), but T3's own database says
//! who wrote each message: $T3CODE_HOME/userdata/statev2.sqlite, where T3CODE_HOME is
//! ~/.t3 unless set. So prompts from T3 are looked up there. It's opened read-only, and
//! all that's read is which thread a session belongs to and that thread's last few
//! messages, to find the prompt and see who wrote it. Nothing from it is kept or sent.
//!
//! Written from T3 Code's source (nightly 0.1.10, apps/server/src/orchestration-v2) and
//! checked against 3 days of real use. These tables aren't a format T3 promises to
//! keep, so when they can't be read steer goes by the log alone, like before.

use crate::live::home;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How many of a thread's latest messages a prompt is matched against. A queued message
/// can wait hours before T3 sends it, so this is a count and not a time window.
const RECENT: i64 = 20;
/// A prompt whose text matches none of them (T3 added the paths of attached files, say)
/// is the thread's newest message, if that one is at most this old (seconds).
const NEWEST_WITHIN: i64 = 15 * 60;

const THREADS: &str = "select thread_id, json_extract(payload_json, '$.nativeThreadRef.nativeId')
    from orchestration_v2_projection_provider_threads
    where thread_id is not null and json_extract(payload_json, '$.nativeThreadRef.nativeId') is not null";
/// Uses T3's index on (thread_id, created_at), so it never reads the whole table.
const MESSAGES: &str = "select message_id, created_at, payload_json from orchestration_v2_projection_messages
    where thread_id = ?1 and role = 'user' and created_at <= ?2 order by created_at desc limit ?3";

/// T3's database, if it's on this computer.
pub(crate) fn db_path() -> Option<PathBuf> {
    let base = std::env::var_os("T3CODE_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".t3"));
    // "dev" is where T3 keeps it when it runs from its source.
    ["userdata", "dev"].iter().map(|d| base.join(d).join("statev2.sqlite")).find(|p| p.exists())
}

/// What the Claude Code hook adds to a prompt's check when T3 started this Claude Code.
/// T3 puts its thread's id in the environment of every Claude Code it runs. It's read
/// here because the flush that looks the prompt up can run in a process T3 didn't start.
pub(crate) fn hook_check(input: &Value) -> Option<Value> {
    let thread = std::env::var("T3CODE_THREAD_ID").ok().filter(|t| !t.is_empty())?;
    let db = db_path()?;
    // Subagents and agent team members run inside the same Claude Code, so they get the
    // same thread. What they're sent comes from the agent that started them.
    let agent = input.get("agent_id").is_some_and(|a| !a.is_null());
    Some(json!({ "db": db.to_string_lossy().into_owned(), "thread": thread, "agent": agent }))
}

/// For `steer doctor`: None if T3 isn't on this computer, otherwise where its database
/// is and whether steer can read what it needs from it.
pub(crate) fn check() -> Option<(PathBuf, Result<(), String>)> {
    let path = db_path()?;
    let readable = Db::open(&path).ok_or_else(|| "it doesn't open".to_string()).and_then(|db| {
        for sql in [THREADS, MESSAGES] {
            db.conn.prepare(sql).map_err(|e| e.to_string())?;
        }
        Ok(())
    });
    Some((path, readable))
}

/// T3's database, opened read-only for one flush or one report.
pub(crate) struct Db {
    conn: Connection,
    /// Claude Code and Codex session ids, to the T3 thread each one belongs to.
    threads: Option<HashMap<String, String>>,
}

struct Message {
    id: String,
    at: DateTime<Utc>,
    payload: Value,
}

impl Db {
    pub(crate) fn open(path: &Path) -> Option<Db> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
        let _ = conn.busy_timeout(Duration::from_millis(500));
        Some(Db { conn, threads: None })
    }

    /// The T3 thread a Claude Code or Codex session belongs to, if T3 started it.
    fn thread_of(&mut self, session: &str) -> Option<String> {
        if self.threads.is_none() {
            let mut map = HashMap::new();
            if let Ok(mut stmt) = self.conn.prepare(THREADS) {
                if let Ok(rows) = stmt.query_map(rusqlite::params![], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                    for (thread, session) in rows.flatten() {
                        map.insert(session, thread);
                    }
                }
            }
            self.threads = Some(map);
        }
        self.threads.as_ref()?.get(session).cloned()
    }

    /// Whether T3 started this Claude Code or Codex session (and still knows it).
    pub(crate) fn knows(&mut self, session: &str) -> bool {
        self.thread_of(session).is_some()
    }

    /// Whether the person wrote the prompt T3 sent to `session` at `t`, found by its
    /// fingerprint (`claude::prompt_key`). `thread` is the thread the hook was told, if
    /// any. None when T3's database can't say: the session isn't one T3 started (a
    /// Claude Code that an agent runs inside a T3 thread gets T3's environment too), it
    /// belongs to another thread, or the database can't be read.
    pub(crate) fn typed(&mut self, session: &str, thread: Option<&str>, t: DateTime<Utc>, key: &str) -> Option<bool> {
        let owner = self.thread_of(session)?;
        if thread.is_some_and(|th| th != owner) {
            return None;
        }
        // T3 saves a message before it sends it, so the prompt's message is never newer.
        let until = (t + chrono::Duration::seconds(2)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut stmt = self.conn.prepare(MESSAGES).ok()?;
        let rows = stmt
            .query_map(rusqlite::params![owner, until, RECENT], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })
            .ok()?;
        let messages: Vec<Message> = rows
            .flatten()
            .filter_map(|(id, at, payload)| {
                let at = DateTime::parse_from_rfc3339(&at).ok()?.with_timezone(&Utc);
                Some(Message { id, at, payload: serde_json::from_str(&payload).ok()? })
            })
            .collect();
        Some(decide(&messages, t, key))
    }
}

fn text(m: &Message) -> &str {
    m.payload.get("text").and_then(Value::as_str).unwrap_or_default()
}

/// Finds the message a prompt came from in `messages` (newest first) and says whether
/// the person wrote it.
fn decide(messages: &[Message], t: DateTime<Utc>, key: &str) -> bool {
    // The same text can be in a thread more than once ("continue"). The newest one is
    // the one that was just sent.
    if let Some(m) = messages.iter().find(|m| crate::claude::prompt_key(text(m)) == key) {
        return by_person(m);
    }
    // Sometimes T3 changes the text on the way (attached files, skills, "Ultrathink:").
    // It sends a message right after saving it, so then it's the newest one.
    messages.first().is_some_and(|m| (t - m.at).num_seconds() <= NEWEST_WITHIN && by_person(m))
}

/// T3's own test for a message the person sent from the app (`sentByUserFromClient` in
/// its Orchestrator.ts): written by the user, from the web or desktop app or the phone,
/// and not by a scheduled task. Also not the /compact T3 sends by itself when you come
/// back to an idle thread, or a guest's message. What agents write is "agent", and
/// answers T3 passes on (which an agent can give too) come from the "server".
fn by_person(m: &Message) -> bool {
    let unset = |p: &str| m.payload.pointer(p).map_or(true, Value::is_null);
    m.payload.get("createdBy").and_then(Value::as_str) == Some("user")
        && matches!(m.payload.get("creationSource").and_then(Value::as_str), Some("web" | "mobile"))
        && unset("/scheduledTaskId")
        && unset("/idleCompaction")
        && unset("/context/guest")
        && !m.id.starts_with("scheduled-task-message:")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A T3 database with only what steer reads. `sessions` are (thread, session) and
    /// `messages` are (id, thread, when, payload).
    pub(crate) fn fake(path: &Path, sessions: &[(&str, &str)], messages: &[(&str, &str, DateTime<Utc>, Value)]) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "create table orchestration_v2_projection_provider_threads (provider_thread_id text primary key, thread_id text, provider text not null, payload_json text not null);
             create table orchestration_v2_projection_messages (message_id text primary key, thread_id text not null, role text not null, created_at text not null, payload_json text not null);
             create index messages_by_thread on orchestration_v2_projection_messages (thread_id, created_at, message_id);",
        )
        .unwrap();
        for (i, (thread, session)) in sessions.iter().enumerate() {
            let payload = json!({ "nativeThreadRef": { "driver": "claudeAgent", "nativeId": session } });
            conn.execute(
                "insert into orchestration_v2_projection_provider_threads values (?1, ?2, 'claudeAgent', ?3)",
                rusqlite::params![format!("pt{i}"), thread, payload.to_string()],
            )
            .unwrap();
        }
        for (id, thread, at, payload) in messages {
            conn.execute(
                "insert into orchestration_v2_projection_messages values (?1, ?2, 'user', ?3, ?4)",
                rusqlite::params![id, thread, at.to_rfc3339_opts(SecondsFormat::Millis, true), payload.to_string()],
            )
            .unwrap();
        }
    }

    pub(crate) fn at(s: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-22T20:00:00Z").unwrap().with_timezone(&Utc) + chrono::Duration::seconds(s)
    }

    pub(crate) fn by(who: &str, from: &str, text: &str) -> Value {
        json!({ "createdBy": who, "creationSource": from, "text": text })
    }

    #[test]
    fn only_messages_the_person_wrote_count() {
        let path = std::env::temp_dir().join(format!("steer-t3-{}.sqlite", crate::live::new_id()));
        let mut scheduled = by("user", "web", "check the inbox");
        scheduled["scheduledTaskId"] = "task-1".into();
        let mut compact = by("user", "web", "/compact");
        compact["idleCompaction"] = "onReturn".into();
        fake(
            &path,
            &[("th1", "s1")],
            &[
                ("m1", "th1", at(0), by("user", "web", "make the snake   move faster")),
                ("m2", "th1", at(20), by("agent", "mcp", "Act as the reviewer sub-agent for this task.\n\nreview the diff")),
                ("scheduled-task-message:task-1:1:cron", "th1", at(40), scheduled),
                ("m4", "th1", at(60), by("user", "mobile", "look at this screenshot")),
                ("async-answer:r1", "th1", at(80), by("user", "server", "Which database?\nsqlite")),
                ("m6", "th1", at(100), by("user", "web", "continue")),
                ("m7", "th1", at(120), by("agent", "server", "continue")),
                ("m8", "th1", at(130), compact),
            ],
        );
        let mut db = Db::open(&path).unwrap();
        let mut typed = |s: i64, text: &str| db.typed("s1", Some("th1"), at(s), &crate::claude::prompt_key(text));

        assert_eq!(typed(1, "make the snake move faster"), Some(true));
        assert_eq!(typed(21, "Act as the reviewer sub-agent for this task.\n\nreview the diff"), Some(false));
        assert_eq!(typed(41, "check the inbox"), Some(false), "a scheduled task");
        // T3 added where the screenshot is saved, so the text doesn't match. It's the
        // newest message, and the person sent it from their phone.
        assert_eq!(typed(61, "look at this screenshot\n\n[Attached image \"shot.png\" is saved at: /tmp/shot.png]"), Some(true));
        assert_eq!(typed(81, "Which database?\nsqlite"), Some(false), "an answer T3 passed on");
        // The same text twice: the newest one is the one just sent.
        assert_eq!(typed(101, "continue"), Some(true));
        assert_eq!(typed(121, "continue"), Some(false));
        assert_eq!(typed(131, "/compact"), Some(false), "T3's own /compact");
        // Nothing recent in the thread matches.
        assert_eq!(typed(3600, "add a pause menu"), Some(false));
        // A message saved after the prompt isn't where it came from.
        assert_eq!(typed(-30, "make the snake move faster"), Some(false));

        // Sessions T3 doesn't know (a Claude Code an agent started), or another thread's.
        assert_eq!(db.typed("s9", Some("th1"), at(1), &crate::claude::prompt_key("make the snake move faster")), None);
        assert_eq!(db.typed("s1", Some("th2"), at(1), &crate::claude::prompt_key("make the snake move faster")), None);
        // Codex prompts don't come with a thread, only the session.
        assert_eq!(db.typed("s1", None, at(1), &crate::claude::prompt_key("make the snake move faster")), Some(true));
        drop(db);

        assert!(Db::open(&std::env::temp_dir().join(format!("steer-t3-none-{}.sqlite", crate::live::new_id()))).is_none());
        let _ = std::fs::remove_file(&path);
    }
}
