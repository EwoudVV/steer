//! Live tracking. Claude Code runs `steer hook` when you send a prompt, when a tool
//! runs and when the agent finishes. Each call saves one small event to a queue on
//! this computer and starts `steer flush` in the background to send it, so Claude
//! Code never waits on the network. Prompt text is turned into counts and flags here
//! and never leaves this computer.

use crate::prompt::PromptInfo;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DEFAULT_SERVER: &str = "https://steer.duck.hackclub.app";
const HOOK_EVENTS: [&str; 3] = ["UserPromptSubmit", "PostToolUse", "Stop"];
const BATCH: usize = 500;

pub(crate) fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// ~/.steer, or $STEER_HOME if set.
pub(crate) fn dir() -> PathBuf {
    std::env::var_os("STEER_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".steer"))
}

// ---------- config ----------

pub(crate) struct Config {
    pub(crate) server: String,
    pub(crate) key: String,
    pub(crate) name: Option<String>,
}

pub(crate) fn load_config() -> Option<Config> {
    let v: Value = serde_json::from_str(&fs::read_to_string(dir().join("config.json")).ok()?).ok()?;
    Some(Config {
        server: v.get("server")?.as_str()?.to_owned(),
        key: v.get("key")?.as_str()?.to_owned(),
        name: v.get("name").and_then(Value::as_str).map(str::to_owned),
    })
}

fn save_config(c: &Config) -> Result<(), String> {
    fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    let path = dir().join("config.json");
    let body = json!({ "server": c.server, "key": c.key, "name": c.name });
    fs::write(&path, serde_json::to_string_pretty(&body).unwrap()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ---------- talking to the server ----------

pub(crate) fn post(server: &str, path: &str, key: Option<&str>, body: &Value) -> Result<Value, String> {
    post_waiting(server, path, key, body, 15)
}

/// `post`, waiting up to `secs` for the answer.
pub(crate) fn post_waiting(server: &str, path: &str, key: Option<&str>, body: &Value, secs: u64) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(secs)).build();
    let mut req = agent
        .post(&format!("{}{}", server.trim_end_matches('/'), path))
        .set("Content-Type", "application/json");
    if let Some(k) = key {
        req = req.set("Authorization", &format!("Bearer {k}"));
    }
    match req.send_string(&body.to_string()) {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| e.to_string())?;
            serde_json::from_str(&text).map_err(|e| e.to_string())
        }
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or(text);
            Err(format!("server said {code}: {msg}"))
        }
        Err(e) => Err(format!("couldn't reach {server}: {e}")),
    }
}

// ---------- the hook ----------

/// Called by Claude Code (`steer hook`) or Cursor (`steer hook cursor EVENT`). Never
/// fails, and the tool waits for it, so it only queues and returns.
pub fn hook(args: &[String]) {
    if args.first().map(String::as_str) == Some("cursor") {
        let event = args.get(1).map(String::as_str).unwrap_or_default();
        let _ = record_cursor(event);
        // Cursor reads the answer as JSON. Always let the prompt through.
        println!("{}", if event == "prompt" { r#"{"continue":true}"# } else { "{}" });
    } else {
        // Claude Code: print nothing, anything printed on a prompt gets added to it.
        let _ = record();
    }
}

/// Cursor's hooks send conversation_id and workspace_roots, plus the prompt text on
/// beforeSubmitPrompt and tool_name on postToolUse. Not tried against real Cursor use
/// yet: written from Cursor's hooks docs.
fn record_cursor(which: &str) -> Option<()> {
    let mut input = String::new();
    std::io::stdin().take(20_000_000).read_to_string(&mut input).ok()?;
    let v: Value = serde_json::from_str(&input).ok()?;
    let session = v.get("conversation_id").and_then(Value::as_str)?;
    let root = v.pointer("/workspace_roots/0").and_then(Value::as_str).unwrap_or_default();
    let project = project_name(root);
    let e = match which {
        "prompt" => {
            let text = v.get("prompt").and_then(Value::as_str).unwrap_or_default().trim();
            let images = v
                .get("attachments")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter(|a| {
                            ["type", "mime_type", "mimeType"]
                                .iter()
                                .filter_map(|k| a.get(*k).and_then(Value::as_str))
                                .any(|s| s.contains("image"))
                        })
                        .count()
                })
                .unwrap_or(0);
            if text.is_empty() && images == 0 {
                return None;
            }
            prompt_event(new_id(), session, &project, "cursor", Utc::now(), &PromptInfo::analyze(text, images))
        }
        "tool" => {
            let tool = v.get("tool_name").and_then(Value::as_str).unwrap_or("tool");
            tool_event(new_id(), session, &project, "cursor", Utc::now(), tool, None, None)
        }
        "stop" => event(new_id(), session, &project, "cursor", Utc::now(), "stop"),
        _ => return None,
    };
    enqueue(&[e])?;
    if !flushing() {
        spawn_flush();
    }
    Some(())
}

fn record() -> Option<()> {
    let mut input = String::new();
    std::io::stdin().take(20_000_000).read_to_string(&mut input).ok()?;
    let v: Value = serde_json::from_str(&input).ok()?;
    let session = v.get("session_id")?.as_str()?;
    let cwd = v.get("cwd").and_then(Value::as_str).unwrap_or("");

    let project = project_name(cwd);
    let e = match v.get("hook_event_name")?.as_str()? {
        "UserPromptSubmit" => {
            let text = v.get("prompt")?.as_str()?.trim();
            // Background task notices, messages from other agents and scheduled prompts
            // come through this hook too, as if the person typed them. The obvious ones
            // are skipped here, and the rest get checked against Claude Code's log
            // before sending (see `verdict`).
            if crate::claude::injected(text) {
                return None;
            }
            let mut e = prompt_event(new_id(), session, &project, "claude-code", Utc::now(), &PromptInfo::analyze(text, 0));
            if let Some(log) = v.get("transcript_path").and_then(Value::as_str) {
                e["check"] = json!({ "log": log, "key": crate::claude::prompt_key(text) });
            }
            e
        }
        "PostToolUse" => {
            let tool = v.get("tool_name").and_then(Value::as_str).unwrap_or("");
            tool_event(new_id(), session, &project, "claude-code", Utc::now(), tool, None, None)
        }
        "Stop" => event(new_id(), session, &project, "claude-code", Utc::now(), "stop"),
        _ => return None,
    };
    enqueue(&[e])?;
    if !flushing() {
        spawn_flush();
    }
    Some(())
}

// ---------- events (shared by the hook and the watcher) ----------

/// One event as it goes to the server. `via` is the tool it came from.
pub(crate) fn event(id: String, session: &str, project: &str, via: &str, t: DateTime<Utc>, kind: &str) -> Value {
    json!({
        "id": id,
        "session": session,
        "project": project,
        "via": via,
        "kind": kind,
        "t": t.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

pub(crate) fn tool_event(
    id: String,
    session: &str,
    project: &str,
    via: &str,
    t: DateTime<Utc>,
    tool: &str,
    model: Option<&str>,
    tokens: Option<u64>,
) -> Value {
    let mut e = event(id, session, project, via, t, "tool");
    e["tool"] = tool.into();
    e["model"] = model.map(str::to_owned).into();
    e["tokens"] = tokens.into();
    e
}

/// A prompt as counts and flags only. The text itself never goes into the event.
pub(crate) fn prompt_event(
    id: String,
    session: &str,
    project: &str,
    via: &str,
    t: DateTime<Utc>,
    p: &PromptInfo,
) -> Value {
    let mut e = event(id, session, project, via, t, "prompt");
    e["words"] = p.words.into();
    e["chars"] = p.chars.into();
    e["images"] = p.images.into();
    e["specific"] = p.specific.into();
    e["observation"] = p.observation.into();
    e["generic"] = p.generic.into();
    e["repeat"] = is_repeat(session, p).into();
    e["model"] = p.model.clone().into();
    e["tokens"] = p.tokens.into();
    e
}

/// Adds events to the queue on this computer. They get sent by `flush`.
pub(crate) fn enqueue(events: &[Value]) -> Option<()> {
    if events.is_empty() {
        return Some(());
    }
    fs::create_dir_all(dir()).ok()?;
    // When an AI tool was last used, for check-ins (which don't count as use themselves).
    if events.iter().any(|e| e["kind"] != "checkin") {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = fs::write(dir().join("last-activity"), now.to_string());
    }
    crate::evidence::note(events);
    let mut queue = OpenOptions::new().create(true).append(true).open(dir().join("queue.jsonl")).ok()?;
    let lines: String = events.iter().map(|e| format!("{e}\n")).collect();
    queue.write_all(lines.as_bytes()).ok()
}

pub(crate) fn new_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}-{:x}", nanos, std::process::id())
}

/// Normalize a project name: lowercase, treat spaces and dashes as equivalent,
/// and collapse multiple spaces/dashes into single spaces.
/// "Vault Books", "vault-books", "VAULT_BOOKS" → "vault books"
fn normalize(name: &str) -> String {
    let mut t = name.to_lowercase();
    t = t.replace('-', " ");
    let parts: Vec<&str> = t.split_whitespace().collect();
    parts.join(" ")
}

/// Folder name of the git repo the session is in, or of the folder itself. The home
/// folder is called "home", since its name is usually the person's real name and the
/// profile is public.
pub(crate) fn project_name(cwd: &str) -> String {
    let start = Path::new(cwd);
    if cwd.is_empty() {
        return normalize("unknown");
    }
    if start == home() {
        return normalize("home");
    }
    let home = home();
    let mut d = Some(start);
    while let Some(p) = d {
        // A .git in the home folder (dotfiles) or above it isn't a project: its name
        // would be the person's username, and the watcher would look at everything.
        if p == home || home.starts_with(p) {
            break;
        }
        if p.join(".git").exists() {
            let name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let key = normalize(&name);
            let mut roots = ROOTS.lock().unwrap_or_else(|e| e.into_inner());
            roots.retain(|(n, _)| normalize(n) != key);
            roots.push((key.clone(), p.to_path_buf()));
            return key;
        }
        d = p.parent();
    }
    let raw = start
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".into());
    normalize(&raw)
}

/// Git repos `project_name` found in this run, by project name, so `evidence::note` can
/// tell which repos the AI tools were used in.
static ROOTS: std::sync::Mutex<Vec<(String, PathBuf)>> = std::sync::Mutex::new(Vec::new());

pub(crate) fn known_roots() -> Vec<(String, PathBuf)> {
    ROOTS.lock().map(|r| r.clone()).unwrap_or_default()
}

/// Compares the prompt to the previous one in the same session. Only word hashes of the
/// last prompt per session are kept, in ~/.steer/last-prompts.json.
fn is_repeat(session: &str, p: &PromptInfo) -> bool {
    is_repeat_in(&dir().join("last-prompts.json"), session, p)
}

const SAVED_SESSIONS: usize = 50;

fn is_repeat_in(path: &Path, session: &str, p: &PromptInfo) -> bool {
    let mut saved: Map<String, Value> = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let previous = saved.get(session).and_then(saved_hashes);
    let repeat = previous.is_some_and(|prev| p.words >= 3 && p.similarity_to(&prev) >= 0.6);

    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let hashes: Vec<Value> = p.word_hashes().iter().map(|h| (*h).into()).collect();
    saved.insert(session.to_owned(), json!({ "t": now, "h": hashes }));

    // Keep the sessions used most recently. serde_json's Map is sorted by key, not by
    // when things were added, so the oldest has to be found by its time. The current
    // session is never dropped.
    while saved.len() > SAVED_SESSIONS {
        let oldest = saved
            .iter()
            .filter(|(k, _)| k.as_str() != session)
            .min_by_key(|(_, v)| v.get("t").and_then(Value::as_u64).unwrap_or(0))
            .map(|(k, _)| k.clone());
        match oldest {
            Some(k) => {
                saved.remove(&k);
            }
            None => break,
        }
    }
    let _ = fs::write(path, Value::Object(saved).to_string());
    repeat
}

/// Reads a saved entry: {"t": secs, "h": [hashes]}, or just [hashes] from older versions.
fn saved_hashes(v: &Value) -> Option<HashSet<u64>> {
    let list = v.get("h").unwrap_or(v).as_array()?;
    Some(list.iter().filter_map(Value::as_u64).collect())
}

// ---------- sending ----------

fn lock_path() -> PathBuf {
    dir().join("flush.lock")
}

/// True if another `steer flush` is running. A lock older than a minute is from a
/// flush that died and gets ignored.
pub(crate) fn flushing() -> bool {
    fs::metadata(lock_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < Duration::from_secs(60))
}

pub(crate) fn spawn_flush() {
    let Ok(exe) = std::env::current_exe() else { return };
    let mut cmd = Command::new(exe);
    cmd.arg("flush").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = cmd.spawn();
}

/// Sends everything in the queue. Events that can't be sent stay queued for next time.
/// Returns how many were sent, or an error if sending stopped early.
pub fn flush() -> Result<usize, String> {
    let Some(config) = load_config() else { return Err("not signed in, run steer login".into()) };
    if flushing() {
        return Ok(0);
    }
    fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    fs::write(lock_path(), std::process::id().to_string()).map_err(|e| e.to_string())?;
    let result = send_all(&config);
    let _ = fs::remove_file(lock_path());
    result
}

fn send_all(config: &Config) -> Result<usize, String> {
    let mut waiting = Vec::new();
    let result = send_files(config, &mut waiting);
    // Prompts whose log line isn't written yet go back in the queue for the next flush.
    // Only after the loop, so this flush doesn't pick them up again right away.
    if !waiting.is_empty() {
        let _ = enqueue(&waiting);
    }
    result
}

enum Verdict {
    Send,
    Drop,
    Wait,
}

/// A prompt in Claude Code's log: when, the fingerprint of its text, and whether the
/// person typed it.
type LogPrompt = (DateTime<Utc>, String, bool);

/// The Claude Code hook can't tell who sent a prompt, but Claude Code's log for the
/// session says it: the person, a background task notice, another agent, a schedule. So
/// a hook prompt carries `check` (the log's path and a fingerprint of its text) and is
/// looked up there a few seconds later. Typed ones get sent, the rest are dropped. One
/// that never shows up within a minute is sent anyway, so a change in the log format
/// can't lose real prompts.
fn verdict(e: &Value, now: DateTime<Utc>, logs: &mut HashMap<String, Vec<LogPrompt>>) -> Verdict {
    let Some(check) = e.get("check") else { return Verdict::Send };
    let (Some(path), Some(key)) = (check["log"].as_str(), check["key"].as_str()) else { return Verdict::Send };
    let t = e["t"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map_or(now, |d| d.with_timezone(&Utc));
    let lines = logs.entry(path.to_owned()).or_insert_with(|| log_prompts(Path::new(path)));
    let near: Vec<&LogPrompt> =
        lines.iter().filter(|(lt, _, _)| (-10..=60).contains(&(*lt - t).num_seconds())).collect();
    if let Some((_, _, typed)) = near.iter().find(|(_, k, _)| k == key) {
        return if *typed { Verdict::Send } else { Verdict::Drop };
    }
    if (now - t).num_seconds() < 60 {
        return Verdict::Wait;
    }
    // Never found its own line. If everything around it in the log was not typed, it
    // wasn't either.
    if !near.is_empty() && near.iter().all(|(_, _, typed)| !typed) {
        Verdict::Drop
    } else {
        Verdict::Send
    }
}

/// The prompts near the end of a Claude Code log: when, the fingerprint of the text, and
/// whether the person typed it. Only the last few MB are read, logs get big.
fn log_prompts(path: &Path) -> Vec<LogPrompt> {
    const TAIL: u64 = 4 << 20;
    let Ok(mut f) = fs::File::open(path) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TAIL);
    let mut buf = Vec::new();
    use std::io::Seek;
    if f.seek(std::io::SeekFrom::Start(start)).is_err() || f.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();
    if start > 0 {
        lines.next(); // probably cut off in the middle
    }
    lines
        .filter(|l| l.contains("\"type\":\"user\""))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| crate::claude::prompt_line(&v))
        .map(|(t, text, typed)| (t, crate::claude::prompt_key(&text), typed))
        .collect()
}

fn send_files(config: &Config, waiting: &mut Vec<Value>) -> Result<usize, String> {
    let mut sent = 0;
    let mut logs = HashMap::new();
    loop {
        // Move the queue aside first, so hooks can keep adding to a fresh one meanwhile.
        let queue = dir().join("queue.jsonl");
        if queue.exists() {
            let _ = fs::rename(&queue, dir().join(format!("sending-{}.jsonl", new_id())));
        }
        let mut pending: Vec<PathBuf> = fs::read_dir(dir())
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("sending-")))
            .collect();
        if pending.is_empty() {
            return Ok(sent);
        }
        pending.sort();
        for file in pending {
            let events: Vec<Value> = fs::read_to_string(&file)
                .map_err(|e| e.to_string())?
                .lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect();
            let now = Utc::now();
            let mut ready = Vec::new();
            let mut held = Vec::new();
            for mut e in events {
                match verdict(&e, now, &mut logs) {
                    Verdict::Send => {
                        if let Some(o) = e.as_object_mut() {
                            o.remove("check"); // the log's path never leaves this computer
                        }
                        ready.push(e);
                    }
                    Verdict::Drop => {}
                    Verdict::Wait => held.push(e),
                }
            }
            for chunk in ready.chunks(BATCH) {
                // With this computer's time of sending, so the server can tell if its clock
                // is off and move the events' times to match (see clock_note).
                let sent_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
                let answer = post(&config.server, "/api/events", Some(&config.key), &json!({ "events": chunk, "sent_at": sent_at }))?;
                if let Some(skew) = answer.get("skew_secs").and_then(Value::as_i64) {
                    let _ = fs::write(dir().join("clock-skew"), skew.to_string());
                }
                sent += chunk.len();
                let _ = fs::write(dir().join("last-sent"), Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
            }
            waiting.extend(held);
            let _ = fs::remove_file(&file);
        }
        let _ = fs::write(lock_path(), std::process::id().to_string());
    }
}

pub(crate) fn queued() -> usize {
    fs::read_dir(dir())
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    n == "queue.jsonl" || n.starts_with("sending-")
                })
                .filter_map(|p| fs::read_to_string(p).ok())
                .map(|s| s.lines().count())
                .sum()
        })
        .unwrap_or(0)
}

// ---------- the installed copy ----------

/// Where steer lives once installed: ~/.steer/bin/steer. Hooks and the watcher run
/// this copy, so they keep working if the one you downloaded gets moved or deleted.
pub(crate) fn bin_path() -> PathBuf {
    dir().join("bin").join(if cfg!(windows) { "steer.exe" } else { "steer" })
}

/// Copies the running steer to ~/.steer/bin, unless it's already that copy.
pub(crate) fn install_bin() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let target = bin_path();
    let same = match (fs::canonicalize(&exe), fs::canonicalize(&target)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if !same {
        let bin = target.parent().unwrap();
        fs::create_dir_all(bin).map_err(|e| e.to_string())?;
        let fresh = bin.join(format!("steer-new-{}{}", std::process::id(), std::env::consts::EXE_SUFFIX));
        fs::copy(&exe, &fresh).map_err(|e| format!("couldn't copy steer to {}: {e}", bin.display()))?;
        swap_in(&fresh, &target)?;
    }
    Ok(target)
}

/// Puts `fresh` where `target` is. A rename is all or nothing, so a hook that runs at
/// the same moment never sees a half-written file. Windows won't replace an exe that's
/// running (like the watcher), but it does let it be renamed, so the old one is moved
/// out of the way first and deleted later by `clean_old_bins`.
pub(crate) fn swap_in(fresh: &Path, target: &Path) -> Result<(), String> {
    if fs::rename(fresh, target).is_ok() {
        return Ok(());
    }
    let old = target.with_file_name(format!("steer-old-{}.exe", new_id()));
    let _ = fs::rename(target, &old);
    fs::rename(fresh, target).map_err(|e| {
        let _ = fs::remove_file(fresh);
        format!("couldn't put steer in {}: {e}", target.display())
    })
}

/// Deletes copies left behind by `swap_in` and by updates that didn't finish.
pub(crate) fn clean_old_bins() {
    let Ok(entries) = fs::read_dir(dir().join("bin")) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let leftover = name.starts_with("steer-old-") || name.starts_with("steer-new-") || name.ends_with(".new");
        if leftover && !name.contains(&format!("-{}", std::process::id())) {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Hooks for Claude Code and Cursor, plus the watcher at login (or with `remove`, all
/// of that taken out again).
pub(crate) fn setup_all(remove: bool, watch: bool) -> Result<String, String> {
    let mut msg = setup(&claude_settings(), remove)?;
    if let Some(c) = setup_cursor(&cursor_dir().join("hooks.json"), remove)? {
        msg += &format!("\n{c}");
    }
    if watch {
        msg += &format!("\n{}", crate::watch::autostart(remove)?);
    }
    msg += &format!("\n{}", crate::native::install(remove));
    Ok(msg)
}

/// How far this computer's clock is from the server's, if it's off by a minute or more.
/// The server moves the times of events it gets from here to match, so nothing is lost,
/// but it's worth knowing.
pub(crate) fn clock_note() -> Option<String> {
    let skew: i64 = fs::read_to_string(dir().join("clock-skew")).ok()?.trim().parse().ok()?;
    if skew.abs() < 60 {
        return None;
    }
    let off = crate::report::fmt_dur(skew.abs());
    let which = if skew > 0 { "behind" } else { "ahead of" };
    Some(format!("this computer's clock is {off} {which} the server's. steer fixes the times it sends, but other apps might get confused, so it's worth setting the clock right"))
}

/// When events last went through to the server, written by `flush`.
pub(crate) fn last_sent() -> Option<DateTime<Utc>> {
    let text = fs::read_to_string(dir().join("last-sent")).ok()?;
    DateTime::parse_from_rfc3339(text.trim()).ok().map(|t| t.with_timezone(&Utc))
}

/// "4m ago", "2h ago", "3 days ago".
pub(crate) fn ago(t: DateTime<Utc>) -> String {
    let s = (Utc::now() - t).num_seconds().max(0);
    match s {
        0..=59 => "just now".into(),
        60..=3599 => format!("{}m ago", s / 60),
        3600..=86_399 => format!("{}h ago", s / 3600),
        _ => format!("{} days ago", s / 86_400),
    }
}

// ---------- Claude Code settings ----------

pub(crate) fn claude_settings() -> PathBuf {
    home().join(".claude").join("settings.json")
}

fn is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|h| {
                h.get("command").and_then(Value::as_str).is_some_and(|c| c.contains("steer") && c.ends_with(" hook"))
            })
        })
}

/// Adds (or with `remove`, takes out) the steer hooks in Claude Code's settings.json.
/// Everything else in the file is left alone, and the first time it's changed a backup
/// is saved next to it.
fn setup(settings: &Path, remove: bool) -> Result<String, String> {
    let original = if settings.exists() {
        Some(fs::read_to_string(settings).map_err(|e| format!("couldn't read {}: {e}", settings.display()))?)
    } else {
        None
    };
    if remove && original.is_none() {
        return Ok(format!("no steer hooks in {}", settings.display()));
    }
    let mut root: Value = match &original {
        Some(text) if !text.trim().is_empty() => serde_json::from_str(text)
            .map_err(|e| format!("{} isn't valid JSON ({e}), so it wasn't changed", settings.display()))?,
        _ => json!({}),
    };
    let obj = root.as_object_mut().ok_or("settings.json isn't a JSON object, so it wasn't changed")?;

    let command = if remove { String::new() } else { format!("\"{}\" hook", install_bin()?.display()) };

    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("\"hooks\" in settings.json isn't an object, so it wasn't changed")?;
    let mut changed = 0;
    for event in HOOK_EVENTS {
        let groups = hooks.entry(event).or_insert_with(|| json!([]));
        let Some(groups) = groups.as_array_mut() else { continue };
        let before = groups.len();
        groups.retain(|g| !is_ours(g));
        if remove {
            changed += before - groups.len();
        } else {
            let mut group = json!({ "hooks": [{ "type": "command", "command": command }] });
            if event == "PostToolUse" {
                group["matcher"] = "*".into();
            }
            groups.push(group);
            changed += 1;
        }
    }
    hooks.retain(|_, v| !v.as_array().is_some_and(|a| a.is_empty()));
    if hooks.is_empty() {
        obj.remove("hooks");
    }

    if let Some(text) = &original {
        let backup = settings.with_extension("json.steer-backup");
        if !backup.exists() {
            fs::write(&backup, text).map_err(|e| e.to_string())?;
        }
    }
    if let Some(parent) = settings.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(settings, serde_json::to_string_pretty(&root).unwrap() + "\n").map_err(|e| e.to_string())?;
    Ok(if remove {
        format!("took {changed} steer hooks out of {}", settings.display())
    } else {
        format!("added steer hooks for {} to {}", HOOK_EVENTS.join(", "), settings.display())
    })
}

pub(crate) fn hooks_installed(settings: &Path) -> bool {
    fs::read_to_string(settings)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("hooks").cloned())
        .and_then(|h| h.as_object().cloned())
        .is_some_and(|h| {
            HOOK_EVENTS
                .iter()
                .all(|e| h.get(*e).and_then(Value::as_array).is_some_and(|gs| gs.iter().any(is_ours)))
        })
}

// ---------- Cursor hooks ----------

const CURSOR_HOOKS: [(&str, &str); 3] = [("beforeSubmitPrompt", "prompt"), ("postToolUse", "tool"), ("stop", "stop")];

pub(crate) fn cursor_dir() -> PathBuf {
    home().join(".cursor")
}

fn is_ours_cursor(entry: &Value) -> bool {
    entry
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains("steer") && c.contains(" hook cursor "))
}

/// Adds (or with `remove`, takes out) steer's entries in ~/.cursor/hooks.json, keeping
/// everything else. Only done if Cursor is installed (~/.cursor exists).
fn setup_cursor(file: &Path, remove: bool) -> Result<Option<String>, String> {
    if !file.parent().is_some_and(Path::exists) {
        return Ok(None);
    }
    let original = fs::read_to_string(file).ok();
    let mut root: Value = match &original {
        Some(text) if !text.trim().is_empty() => serde_json::from_str(text)
            .map_err(|e| format!("{} isn't valid JSON ({e}), so it wasn't changed", file.display()))?,
        _ => json!({ "version": 1 }),
    };
    let obj = root.as_object_mut().ok_or("~/.cursor/hooks.json isn't a JSON object, so it wasn't changed")?;
    obj.entry("version").or_insert(1.into());
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("\"hooks\" in ~/.cursor/hooks.json isn't an object")?;
    let bin = bin_path();
    for (event, which) in CURSOR_HOOKS {
        let list = hooks.entry(event).or_insert_with(|| json!([]));
        let Some(list) = list.as_array_mut() else { continue };
        list.retain(|e| !is_ours_cursor(e));
        if !remove {
            list.push(json!({ "command": format!("\"{}\" hook cursor {which}", bin.display()) }));
        }
    }
    hooks.retain(|_, v| !v.as_array().is_some_and(|a| a.is_empty()));
    if let Some(text) = &original {
        let backup = file.with_extension("json.steer-backup");
        if !backup.exists() {
            fs::write(&backup, text).map_err(|e| e.to_string())?;
        }
    }
    fs::write(file, serde_json::to_string_pretty(&root).unwrap() + "\n").map_err(|e| e.to_string())?;
    Ok(Some(if remove {
        format!("took the steer hooks out of {}", file.display())
    } else {
        format!("added steer hooks to {}", file.display())
    }))
}

pub(crate) fn cursor_hooks_installed() -> bool {
    fs::read_to_string(cursor_dir().join("hooks.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .is_some_and(|v| {
            CURSOR_HOOKS.iter().all(|(event, _)| {
                v.pointer(&format!("/hooks/{event}")).and_then(Value::as_array).is_some_and(|l| l.iter().any(is_ours_cursor))
            })
        })
}

// ---------- commands ----------

pub const HELP: &str = "live tracking:
  steer                              set it all up, or if it already is, show status
  steer install [--yes]              sign in, hook into your tools, start the watcher
  steer status                       show what's set up and what's waiting to send
  steer doctor                       check everything and say how to fix what's broken
  steer update                       get the newest version now (it also checks daily)
  steer uninstall [--yes]            take steer out of your tools and delete ~/.steer
  steer version                      show which version this is
  steer checkin on|off               now and then, ask what you're doing, to help make
                                     steer's counting more accurate (off by default)

  steer login                        sign in with your hack club account
  steer login KEY [--server URL]     use a key you already have
  steer signup NAME --server URL     make an account on a server without hack club login
  steer setup [--no-watch]           hook into Claude Code and Cursor, and start the
                                     watcher for Codex, OpenCode and Copilot at login
  steer setup --remove               undo all of that
  steer watch --dry-run [--days N]   show what the watcher would send, as counts
  steer flush                        send waiting events now

  steer submit [PROJECT]             freeze a project's hours into a page for reviewers,
     [--from DAY] [--to DAY]         and get a line to paste into unified. run it in the
     [--repo URL]                    project's folder. days look like 2026-11-21

daily update checks are off if ~/.steer/no-update exists or STEER_NO_UPDATE is set";

/// `steer submit [PROJECT] [--from DAY] [--to DAY] [--repo URL]`: freezes a project's
/// hours into a review page and prints its link and a line to paste into Unified. The
/// project is the folder you're in unless you name one, and the repo is its GitHub
/// remote unless you give one.
fn submit(args: &[String]) -> Result<String, String> {
    let config = load_config().ok_or("not signed in, run steer login first")?;
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let mut named = None;
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--from" | "--to" | "--repo" => {
                it.next();
            }
            a if a.starts_with("--") => return Err(format!("unknown option {a}")),
            a => named = Some(normalize(a)),
        }
    }
    let here = project_name(&cwd);
    let project = named.clone().unwrap_or_else(|| here.clone());
    if project == "home" || project == "unknown" {
        return Err("run this in your project's folder, or say which project: steer submit NAME".into());
    }
    let repo = flag_value(args, "--repo").or_else(|| if project == here { github_remote(&cwd) } else { None });
    let mut body = json!({ "project": project });
    for (flag, key) in [("--from", "from"), ("--to", "to")] {
        if let Some(day) = flag_value(args, flag) {
            body[key] = day.into();
        }
    }
    if let Some(r) = &repo {
        body["repo"] = r.as_str().into();
    }
    // So the page has everything up to now.
    if !flushing() {
        let _ = flush();
    }
    // Making the page can take a while: it works out all your hours and looks your
    // commits up on GitHub.
    let v = post_waiting(&config.server, "/api/submit", Some(&config.key), &body, 90)?;
    let s = |k: &str| v[k].as_str().unwrap_or_default().to_owned();
    let mut out = format!("froze {} on {project} ({}h) into a review page:\n  {}\n\nfor unified, paste:\n  {}", s("your_time"), s("hours"), s("url"), s("line"));
    if repo.is_none() {
        out += "\n\nno github repo found, so commits on the page aren't linked. add one with --repo https://github.com/you/project";
    }
    Ok(out)
}

/// The GitHub page of the folder's `origin` remote, if it's on GitHub.
fn github_remote(cwd: &str) -> Option<String> {
    let out = Command::new("git").args(["-C", cwd, "remote", "get-url", "origin"]).output().ok().filter(|o| o.status.success())?;
    github_url(String::from_utf8_lossy(&out.stdout).trim())
}

fn github_url(remote: &str) -> Option<String> {
    let path = remote
        .strip_prefix("https://github.com/")
        .or_else(|| remote.strip_prefix("git@github.com:"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))?;
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = path.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    (parts.next().is_none() && ok(owner) && ok(name)).then(|| format!("https://github.com/{owner}/{name}"))
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn positional(args: &[String]) -> Option<&String> {
    let mut skip = false;
    for a in args.iter().skip(1) {
        if skip {
            skip = false;
        } else if a == "--server" || a == "--settings" {
            skip = true;
        } else if !a.starts_with("--") {
            return Some(a);
        }
    }
    None
}

/// Runs a live tracking command and returns the exit code.
pub fn command(args: &[String]) -> i32 {
    let result = match args[0].as_str() {
        "signup" => signup(args),
        "login" => login(args).map(|msg| {
            if hooks_installed(&claude_settings()) {
                msg
            } else {
                msg + "\nnext: steer setup"
            }
        }),
        "setup" => {
            let custom = flag_value(args, "--settings").map(PathBuf::from);
            let remove = args.iter().any(|a| a == "--remove");
            match custom {
                // A custom settings file means a test run, so only that file is touched.
                Some(settings) => setup(&settings, remove),
                None => setup_all(remove, !args.iter().any(|a| a == "--no-watch")),
            }
        }
        "status" => Ok(status()),
        "submit" => submit(args),
        "flush" => flush().map(|n| format!("sent {n} events")),
        _ => Err(format!("unknown command {}", args[0])),
    };
    match result {
        Ok(msg) => {
            println!("{msg}");
            0
        }
        Err(e) => {
            eprintln!("steer: {e}");
            1
        }
    }
}

fn signup(args: &[String]) -> Result<String, String> {
    let name = positional(args).ok_or("usage: steer signup NAME")?;
    let server = flag_value(args, "--server").unwrap_or_else(|| DEFAULT_SERVER.into());
    let resp = post(&server, "/api/signup", None, &json!({ "name": name }))?;
    let key = resp.get("key").and_then(Value::as_str).ok_or("server didn't send a key")?;
    let name = resp.get("name").and_then(Value::as_str).unwrap_or(name).to_owned();
    save_config(&Config { server: server.clone(), key: key.into(), name: Some(name.clone()) })?;
    Ok(format!(
        "signed up as {name}. your key is saved in {}\nyour page: {}/u/{name}\nnext: steer setup",
        dir().join("config.json").display(),
        server.trim_end_matches('/')
    ))
}

pub(crate) fn login(args: &[String]) -> Result<String, String> {
    let server = flag_value(args, "--server")
        .or_else(|| load_config().map(|c| c.server))
        .unwrap_or_else(|| DEFAULT_SERVER.into());
    if let Some(key) = positional(args) {
        post(&server, "/api/events", Some(key), &json!({ "events": [] }))?;
        save_config(&Config { server, key: key.clone(), name: None })?;
        return Ok("key works, saved".into());
    }

    // Sign in with Hack Club in the browser. If this computer already has a key, it's
    // sent along so the server links that account instead of making a new one.
    let existing = load_config().filter(|c| c.server == server).map(|c| c.key);
    let start = post(&server, "/api/cli-login", existing.as_deref(), &json!({}))?;
    let code = start.get("code").and_then(Value::as_str).ok_or("server didn't send a login code")?;
    let url = start.get("url").and_then(Value::as_str).ok_or("server didn't send a login link")?;
    let user_code = start.get("user_code").and_then(Value::as_str).unwrap_or_default();
    println!("your code: {user_code} (type it on the page that opens, only on a page you opened yourself)");
    println!("opening {url}");
    println!("(if no browser opens, open that link yourself)");
    open_browser(url);

    let deadline = std::time::Instant::now() + Duration::from_secs(10 * 60);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(2));
        let Ok(v) = get(&server, &format!("/api/cli-login/{code}")) else { continue };
        match v.get("status").and_then(Value::as_str) {
            Some("done") => {
                let key = v.get("key").and_then(Value::as_str).ok_or("server didn't send a key")?;
                let name = v.get("name").and_then(Value::as_str).map(str::to_owned);
                save_config(&Config { server: server.clone(), key: key.into(), name: name.clone() })?;
                let name = name.unwrap_or_default();
                return Ok(format!("signed in as {name}\nyour page: {}/u/{name}", server.trim_end_matches('/')));
            }
            Some("expired") => return Err("the login link expired, run steer login again".into()),
            _ => {}
        }
    }
    Err("timed out waiting for the browser, run steer login again".into())
}

pub(crate) fn get(server: &str, path: &str) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build();
    match agent.get(&format!("{}{}", server.trim_end_matches('/'), path)).call() {
        Ok(resp) => serde_json::from_str(&resp.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, resp)) => {
            // 404 on a login code means it expired, which the body says too.
            let text = resp.into_string().unwrap_or_default();
            serde_json::from_str(&text).map_err(|_| format!("server said {code}"))
        }
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn open_browser(url: &str) {
    if std::env::var_os("STEER_NO_BROWSER").is_some() {
        return;
    }
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(url);
        c
    } else if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    let _ = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

pub(crate) fn status() -> String {
    let settings = claude_settings();
    let mut out = String::new();
    match load_config() {
        Some(c) => {
            let who = c.name.as_deref().unwrap_or("(logged in with a key)");
            out += &format!("account: {who} on {}\n", c.server);
            if let Some(n) = &c.name {
                out += &format!("page: {}/u/{n}\n", c.server.trim_end_matches('/'));
            }
        }
        None => out += "account: none yet, run steer login\n",
    }
    out += &format!(
        "claude code hooks: {}\n",
        if hooks_installed(&settings) { "on" } else { "off, run steer setup" }
    );
    out += &format!(
        "cursor hooks: {}\n",
        if !cursor_dir().exists() {
            "cursor isn't installed"
        } else if cursor_hooks_installed() {
            "on"
        } else {
            "off, run steer setup"
        }
    );
    out += &format!(
        "watcher (codex, opencode, copilot, freebuff, saves and commits): {}\n",
        if crate::watch::running() { "running" } else { "not running, run steer setup" }
    );
    out += &format!("waiting to send: {} events", queued());
    if let Some(t) = last_sent() {
        out += &format!("\nlast sent: {}", ago(t));
    }
    if let Some(note) = clock_note() {
        out += &format!("\n{note}");
    }
    out
}

/// Points ~/.steer at a temp folder for tests, so they never touch the real one.
#[cfg(test)]
pub(crate) fn use_temp_home() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| std::env::set_var("STEER_HOME", std::env::temp_dir().join(format!("steer-tests-{}", std::process::id()))));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_remotes_become_links() {
        assert_eq!(github_url("git@github.com:EwoudVV/steer.git").as_deref(), Some("https://github.com/EwoudVV/steer"));
        assert_eq!(github_url("https://github.com/EwoudVV/steer").as_deref(), Some("https://github.com/EwoudVV/steer"));
        assert_eq!(github_url("ssh://git@github.com/a/b.git").as_deref(), Some("https://github.com/a/b"));
        assert_eq!(github_url("https://gitlab.com/a/b"), None);
        assert_eq!(github_url("https://github.com/a/b/c"), None);
    }

    #[test]
    fn repeat_detection_keeps_the_current_session() {
        let path = std::env::temp_dir().join(format!("steer-last-{}.json", new_id()));
        let filler = PromptInfo::analyze("add a settings page with a dark mode toggle", 0);
        for i in 0..SAVED_SESSIONS + 10 {
            is_repeat_in(&path, &format!("zzz-{i:03}"), &filler);
        }
        // "aaa" sorts before every other session, which used to get it thrown out.
        let first = PromptInfo::analyze("make the snake move faster when it eats food", 0);
        let again = PromptInfo::analyze("make the snake move faster when it eats food please", 0);
        assert!(!is_repeat_in(&path, "aaa", &first));
        assert!(is_repeat_in(&path, "aaa", &again));

        let saved: Map<String, Value> = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved.len(), SAVED_SESSIONS);
        assert!(saved.contains_key("aaa"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn cursor_setup_keeps_other_hooks_and_skips_when_not_installed() {
        let tmp = std::env::temp_dir().join(format!("steer-cursor-{}", new_id()));
        let file = tmp.join(".cursor").join("hooks.json");
        // No ~/.cursor: nothing is created.
        assert_eq!(setup_cursor(&file, false).unwrap(), None);
        assert!(!file.exists());

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let theirs = json!({ "version": 1, "hooks": { "stop": [{ "command": "say done" }] } });
        fs::write(&file, theirs.to_string()).unwrap();
        setup_cursor(&file, false).unwrap();
        setup_cursor(&file, false).unwrap(); // twice doesn't add twice
        let v: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["hooks"]["stop"].as_array().unwrap().len(), 2);
        assert!(v["hooks"]["beforeSubmitPrompt"][0]["command"].as_str().unwrap().ends_with(" hook cursor prompt"));

        setup_cursor(&file, true).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["hooks"]["stop"], json!([{ "command": "say done" }]));
        assert!(v["hooks"].get("beforeSubmitPrompt").is_none());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn hook_prompts_are_checked_against_the_log() {
        let tmp = std::env::temp_dir().join(format!("steer-log-{}", new_id()));
        fs::create_dir_all(&tmp).unwrap();
        let log = tmp.join("session.jsonl");
        let t0 = DateTime::parse_from_rfc3339("2026-11-20T15:00:00Z").unwrap().with_timezone(&Utc);
        let at = |s: i64| (t0 + chrono::Duration::seconds(s)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let lines = [
            json!({ "type": "user", "timestamp": at(0), "origin": { "kind": "human" }, "message": { "role": "user", "content": "make the snake   move faster" } }),
            json!({ "type": "user", "timestamp": at(5), "origin": { "kind": "peer" }, "message": { "role": "user", "content": "Another session says the build is done" } }),
            json!({ "type": "user", "timestamp": at(10), "isMeta": true, "promptSource": "system", "turnOrigin": "scheduled", "message": { "role": "user", "content": "Hourly check, look at the inbox" } }),
            json!({ "type": "assistant", "timestamp": at(12), "message": { "role": "assistant", "content": [] } }),
        ];
        fs::write(&log, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();

        let hooked = |text: &str, s: i64| {
            let mut e = event(new_id(), "s1", "game", "claude-code", t0 + chrono::Duration::seconds(s), "prompt");
            e["check"] = json!({ "log": log.to_string_lossy(), "key": crate::claude::prompt_key(text) });
            e
        };
        let later = t0 + chrono::Duration::seconds(90);
        let mut logs = HashMap::new();
        let send = |v: Verdict| matches!(v, Verdict::Send);
        // The hook's text and the log's can differ in spacing.
        assert!(send(verdict(&hooked("make the snake move faster", 0), later, &mut logs)));
        assert!(matches!(verdict(&hooked("Another session says the build is done", 5), later, &mut logs), Verdict::Drop));
        assert!(matches!(verdict(&hooked("Hourly check, look at the inbox", 10), later, &mut logs), Verdict::Drop));
        // Not in the log yet: wait. Still not there after a minute: send it anyway.
        let mut fresh = HashMap::new();
        assert!(matches!(verdict(&hooked("add a pause menu", 300), t0 + chrono::Duration::seconds(305), &mut fresh), Verdict::Wait));
        assert!(send(verdict(&hooked("add a pause menu", 300), t0 + chrono::Duration::seconds(400), &mut fresh)));
        // No check at all (older client, or Cursor): sent like before.
        assert!(send(verdict(&event(new_id(), "s1", "game", "claude-code", t0, "prompt"), later, &mut logs)));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn old_saved_format_still_reads() {
        assert_eq!(saved_hashes(&json!([1, 2, 3])).unwrap().len(), 3);
        assert_eq!(saved_hashes(&json!({ "t": 5, "h": [4, 5] })).unwrap().len(), 2);
    }

    #[test]
    fn setup_adds_and_removes_only_its_own_hooks() {
        let tmp = std::env::temp_dir().join(format!("steer-test-{}", new_id()));
        fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("STEER_HOME", tmp.join("steer"));
        let settings = tmp.join("settings.json");
        let theirs = json!({
            "model": "opus",
            "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] }
        });
        fs::write(&settings, theirs.to_string()).unwrap();

        setup(&settings, false).unwrap();
        setup(&settings, false).unwrap(); // running twice doesn't add twice
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["model"], "opus");
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], "*");
        assert!(hooks_installed(&settings));
        assert!(settings.with_extension("json.steer-backup").exists());

        setup(&settings, true).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
        assert!(v["hooks"].get("UserPromptSubmit").is_none());
        assert!(!hooks_installed(&settings));
        let _ = fs::remove_dir_all(&tmp);
    }
}
