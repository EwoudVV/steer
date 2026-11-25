//! `steer watch`: runs in the background and reads tools that don't have hooks
//! (Codex, OpenCode) as they write their logs, and notices saves and commits in the
//! repos AI tools were used in (src/evidence.rs). New events are queued and sent every
//! few seconds, same as the Claude Code hook. `steer setup` makes it start at login.

use crate::live::{self, dir, enqueue, load_config};
use crate::{codex, copilot, freebuff, opencode};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

const EVERY: Duration = Duration::from_secs(5);
const LABEL: &str = "app.steer.watch";

fn state_path() -> PathBuf {
    dir().join("watch-state.json")
}
fn lock_path() -> PathBuf {
    dir().join("watch.lock")
}

/// True if a watcher has checked in within the last 30 seconds.
pub fn running() -> bool {
    fs::metadata(lock_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < Duration::from_secs(30))
}

/// True if the process in the lock file checked in recently and is still alive. Only
/// looking at the lock's age isn't enough: a watcher that was just stopped leaves a
/// fresh lock behind, and the new one would wrongly think it's still running.
fn another_watcher_alive() -> bool {
    if !running() {
        return false;
    }
    let Ok(pid) = fs::read_to_string(lock_path()) else { return false };
    let pid = pid.trim().to_owned();
    if pid.is_empty() || pid == std::process::id().to_string() {
        return false;
    }
    if cfg!(windows) {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&pid))
    } else {
        Command::new("kill").args(["-0", &pid]).status().is_ok_and(|s| s.success())
    }
}

pub fn run() -> i32 {
    if load_config().is_none() {
        eprintln!("steer: not signed in, run steer login first");
        return 1;
    }
    if another_watcher_alive() {
        return 0; // another one is already going
    }
    let _ = fs::create_dir_all(dir());
    let mut state: Map<String, Value> = fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Per tool: the first time a tool is watched, its existing files are skipped so old
    // history isn't sent. Files that show up after that are read from the start.
    let mut skip_codex = !state.contains_key("codex");
    let mut skip_copilot = !state.contains_key("copilot");
    let mut skip_freebuff = !state.contains_key("freebuff");
    let mut sent = HashSet::new();
    // Only the installed copy updates itself, never a build someone is working on.
    let installed = std::env::current_exe().ok().and_then(|e| fs::canonicalize(e).ok()) == fs::canonicalize(live::bin_path()).ok();
    let mut checkins = crate::checkin::Schedule::new();
    let mut evidence = crate::evidence::Watch::default();
    let mut presence = crate::idle::Presence::default();
    if installed {
        if let Some(msg) = live::refresh_hooks() {
            eprintln!("steer: {msg}");
        }
        if let Some(msg) = crate::editor::refresh() {
            eprintln!("steer: {msg}");
        }
    }

    loop {
        if installed && crate::manage::update_due() {
            match crate::manage::update() {
                Ok(Some(v)) => {
                    eprintln!("steer: updated to {v}, restarting the watcher");
                    let _ = fs::remove_file(lock_path());
                    if cfg!(windows) {
                        spawn_watcher();
                        return 0;
                    }
                    // launchd and systemd start it again after a failed exit, now
                    // running the new version.
                    return 1;
                }
                Ok(None) => {}
                Err(e) => eprintln!("steer: update check failed: {e}"),
            }
        }
        let _ = fs::write(lock_path(), std::process::id().to_string());
        let mut events = Vec::new();

        if let Some(s) = state.entry("codex").or_insert_with(|| json!({})).as_object_mut() {
            events.extend(codex::poll(s, skip_codex));
        }
        if let Some(s) = state.entry("copilot").or_insert_with(|| json!({})).as_object_mut() {
            events.extend(copilot::poll(s, skip_copilot));
        }
        if let Some(s) = state.entry("opencode").or_insert_with(|| json!({})).as_object_mut() {
            events.extend(opencode::poll(s, &mut sent));
        }
        if let Some(s) = state.entry("freebuff").or_insert_with(|| json!({})).as_object_mut() {
            events.extend(freebuff::poll(s, skip_freebuff));
        }
        skip_codex = false;
        skip_copilot = false;
        skip_freebuff = false;
        events.extend(crate::evidence::poll(&mut evidence));
        if let Some(s) = state.entry("editor").or_insert_with(|| json!({})).as_object_mut() {
            events.extend(crate::editor::poll(s));
        }
        events.extend(crate::idle::poll(&mut presence, now_secs()));

        let _ = enqueue(&events);
        let _ = fs::write(state_path(), Value::Object(state.clone()).to_string());
        crate::checkin::tick(&mut checkins);
        if !live::flushing() {
            let _ = live::flush();
        }
        std::thread::sleep(EVERY);
    }
}

/// `steer watch --dry-run [--days N]`: reads the last N days from every tool and
/// prints what it would send, as counts. Nothing is queued or sent.
pub fn dry_run(days: i64) -> String {
    // Repeat detection saves state in ~/.steer; keep the dry run out of the real one.
    std::env::set_var("STEER_HOME", std::env::temp_dir().join(format!("steer-dry-run-{}", std::process::id())));
    let mut out = String::new();

    let mut codex_state = Map::new();
    let codex_events = codex::poll(&mut codex_state, false);
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days);
    let recent = |e: &&Value| {
        e["t"].as_str().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).is_some_and(|t| t > cutoff)
    };
    out += &summary("codex", codex_events.iter().filter(recent).collect());
    let copilot_events = copilot::poll(&mut Map::new(), false);
    out += &summary("copilot", copilot_events.iter().filter(recent).collect());

    let mut oc_state = Map::new();
    oc_state.insert("cursor".into(), cutoff.timestamp_millis().into());
    let mut oc_events = Vec::new();
    loop {
        let before = oc_state["cursor"].as_i64();
        let batch = opencode::poll(&mut oc_state, &mut HashSet::new());
        oc_events.extend(batch);
        if oc_state["cursor"].as_i64() == before {
            break;
        }
    }
    out += &summary("opencode", oc_events.iter().collect());
    out + "nothing was queued or sent"
}

fn summary(tool: &str, events: Vec<&Value>) -> String {
    let count = |k: &str| events.iter().filter(|e| e["kind"] == k).count();
    let sessions: HashSet<&str> = events.iter().filter_map(|e| e["session"].as_str()).collect();
    let projects: HashSet<&str> = events.iter().filter_map(|e| e["project"].as_str()).collect();
    format!(
        "{tool}: {} sessions in {} projects, {} prompts ({} with images), {} tool calls, {} turn ends, {} interrupts\n",
        sessions.len(),
        projects.len(),
        count("prompt"),
        events.iter().filter(|e| e["kind"] == "prompt" && e["images"].as_u64().unwrap_or(0) > 0).count(),
        count("tool"),
        count("stop"),
        count("interrupt"),
    )
}

// ---------- starting at login ----------

fn bin() -> PathBuf {
    live::bin_path()
}

fn spawn_watcher() {
    let mut start = Command::new(bin());
    start.arg("watch").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A hidden console of its own. Fully detached would make the console programs
        // it runs (tasklist, reg) pop up windows.
        start.creation_flags(0x0800_0000);
    }
    let _ = start.spawn();
}

/// Stops the watcher that's running now, if there is one. Returns whether there was.
fn stop_running() -> bool {
    if !another_watcher_alive() {
        return false;
    }
    let Ok(pid) = fs::read_to_string(lock_path()) else { return false };
    let pid = pid.trim();
    if cfg!(windows) {
        let _ = Command::new("taskkill").args(["/PID", pid, "/F"]).output();
    } else {
        let _ = Command::new("kill").arg(pid).output();
    }
    let _ = fs::remove_file(lock_path());
    true
}

/// After `steer update`: restarts the watcher so it runs the new version.
pub fn restart() {
    if cfg!(target_os = "macos") {
        if live::home().join("Library").join("LaunchAgents").join(format!("{LABEL}.plist")).exists() {
            if let Ok(uid) = Command::new("id").arg("-u").output() {
                let job = format!("gui/{}/{LABEL}", String::from_utf8_lossy(&uid.stdout).trim());
                let _ = Command::new("launchctl").args(["kickstart", "-k", &job]).output();
            }
        }
    } else if cfg!(target_os = "linux") {
        let _ = Command::new("systemctl").args(["--user", "try-restart", "steer-watch.service"]).output();
    } else if stop_running() {
        spawn_watcher();
    }
}

/// Makes `steer watch` start at login and starts it now (or with `remove`, undoes that).
pub fn autostart(remove: bool) -> Result<String, String> {
    // launchd, systemd and the registry aren't per home folder, so tests that point HOME
    // somewhere else set this to keep their hands off the real login items.
    if std::env::var_os("STEER_SANDBOX").is_some() {
        return Ok("left login items alone (STEER_SANDBOX is set)".into());
    }
    if cfg!(target_os = "macos") {
        let plist = live::home().join("Library").join("LaunchAgents").join(format!("{LABEL}.plist"));
        let uid = Command::new("id").arg("-u").output().map_err(|e| e.to_string())?;
        let domain = format!("gui/{}", String::from_utf8_lossy(&uid.stdout).trim());
        let _ = Command::new("launchctl").args(["bootout", &format!("{domain}/{LABEL}")]).output();
        let _ = fs::remove_file(lock_path());
        if remove {
            let _ = fs::remove_file(&plist);
            return Ok("stopped the watcher and removed it from login items".into());
        }
        let log = dir().join("watch.log");
        let body = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{}</string><string>watch</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>{}</string>
</dict>
</plist>
"#,
            bin().display(),
            log.display()
        );
        fs::create_dir_all(plist.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&plist, body).map_err(|e| e.to_string())?;
        let out = Command::new("launchctl").args(["bootstrap", &domain]).arg(&plist).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("launchctl said: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(format!("the watcher now starts at login: {}", plist.display()))
    } else if cfg!(target_os = "linux") {
        let unit = live::home().join(".config/systemd/user/steer-watch.service");
        if remove {
            let _ = Command::new("systemctl").args(["--user", "disable", "--now", "steer-watch.service"]).output();
            let _ = fs::remove_file(&unit);
            return Ok("stopped the watcher and removed it from startup".into());
        }
        let body = format!(
            "[Unit]\nDescription=steer watcher\n\n[Service]\nExecStart={} watch\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n",
            bin().display()
        );
        fs::create_dir_all(unit.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&unit, body).map_err(|e| e.to_string())?;
        let _ = Command::new("systemctl").args(["--user", "daemon-reload"]).output();
        let out = Command::new("systemctl").args(["--user", "enable", "--now", "steer-watch.service"]).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("systemctl said: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(format!("the watcher now starts at login: {}", unit.display()))
    } else if cfg!(windows) {
        // Not tried on a real Windows machine yet.
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        // Stop the one that's running, so it's either gone or replaced by this version.
        stop_running();
        if remove {
            let _ = Command::new("reg").args(["delete", key, "/v", "steer-watch", "/f"]).output();
            return Ok("stopped the watcher and removed it from startup".into());
        }
        let cmd = format!("conhost.exe --headless \"{}\" watch", bin().display());
        let out = Command::new("reg").args(["add", key, "/v", "steer-watch", "/t", "REG_SZ", "/d", &cmd, "/f"]).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("reg said: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        spawn_watcher();
        Ok("the watcher now starts at login".into())
    } else {
        Ok("couldn't set the watcher to start at login on this system, run steer watch yourself".into())
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
