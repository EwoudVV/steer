//! Evidence from your projects: saves that changed the code, and commits. The watcher
//! looks every 30 seconds, only in git repos an AI tool was used in during the last 2
//! hours, and only sends counts: how many files changed since it last looked, or a
//! commit's hash. File names and contents never leave the computer.
//!
//! A change only counts as yours once the agent has been quiet for a minute, so the
//! agent's own edits don't count. Going back to a state of the files seen in the last
//! hour (undoing a change, or flipping a file back and forth) doesn't count either, and
//! touching a file without changing it is nothing.
//!
//! The repos can be anyone's, so git runs here can't let a repo's own settings run
//! anything: no `git status` or `git log` (fsmonitor, filters and signature checks can
//! run programs), only `ls-files`, `rev-parse`, `cat-file` and `config`, with fsmonitor
//! off and a time limit. Files are compared here, not by git.

use crate::live::{dir, event, new_id};
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const EVERY: Duration = Duration::from_secs(30);
/// Repos an AI tool was used in this recently get looked at. web/steer.js only counts
/// evidence within 30 minutes of AI use, this is a bit longer so nothing is missed.
const REACH: i64 = 3600;
/// A change this soon after the agent's last step is the agent's.
const AGENT_QUIET: i64 = 60;
/// A new HEAD counts as a commit only if it was made this recently, so checking out an
/// old branch isn't one.
const COMMIT_FRESH: i64 = 600;
const MAX_REPOS: usize = 5;
/// Files looked at per repo. A repo with more (an untracked node_modules, say) only
/// gets its first this many looked at.
const MAX_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 1_000_000;
/// Bytes read per look across all repos. Files past it are told apart by size and time.
const READ_BUDGET: u64 = 32_000_000;
/// No git call may take longer than this, so a stuck one can't stop the watcher.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Files that change by themselves while something runs, not because someone edited them.
const NOISY: [&str; 12] = [".log", ".sqlite", ".sqlite3", ".db", ".db-journal", "-wal", "-shm", ".pid", ".tmp", ".swp", ".DS_Store", ".lock"];
/// How long a state of the files is remembered.
const REMEMBER: i64 = 3600;
/// Repos not used with an AI tool for this long are dropped from repos.json.
const FORGET: i64 = 7 * 86400;

fn repos_path() -> PathBuf {
    dir().join("repos.json")
}

fn read_repos() -> Map<String, Value> {
    fs::read_to_string(repos_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// The projects an AI tool was used in (by name, as events have it), and when it was
/// last used in each. For the editor extension's stretches (src/editor.rs).
pub(crate) fn used_projects() -> HashMap<String, i64> {
    let mut out = HashMap::new();
    for v in read_repos().values() {
        if let (Some(name), Some(used)) = (v["name"].as_str(), v["used"].as_i64()) {
            let last = out.entry(name.to_owned()).or_insert(used);
            *last = (*last).max(used);
        }
    }
    out
}

/// Called with every batch of events that gets queued: remembers which git repos the AI
/// tools were used in, and when the agent last did something there. Stored in
/// ~/.steer/repos.json, which never leaves the computer.
pub(crate) fn note(events: &[Value]) {
    let roots = crate::live::known_roots();
    if roots.is_empty() {
        return;
    }
    let mut saved = read_repos();
    if !note_into(&mut saved, &roots, events, Utc::now().timestamp()) {
        return;
    }
    let _ = fs::create_dir_all(dir());
    // Written next to it and moved over, so the watcher never reads half a file.
    let tmp = dir().join(format!("repos.json.{}", std::process::id()));
    if fs::write(&tmp, Value::Object(saved).to_string()).is_ok() {
        let _ = fs::rename(&tmp, repos_path());
    }
}

/// The part of `note` that doesn't touch files. Returns whether anything changed.
fn note_into(saved: &mut Map<String, Value>, roots: &[(String, PathBuf)], events: &[Value], now: i64) -> bool {
    let mut changed = false;
    for e in events {
        // steer's own events (evidence, check-ins) aren't AI use.
        if e["via"] == "steer" {
            continue;
        }
        let Some(project) = e["project"].as_str() else { continue };
        let Some((_, root)) = roots.iter().find(|(n, _)| n == project) else { continue };
        let t = e["t"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.timestamp()).unwrap_or(now);
        let entry = saved
            .entry(root.to_string_lossy().into_owned())
            .or_insert_with(|| json!({ "name": project, "used": 0, "agent": 0 }));
        if entry["used"].as_i64().unwrap_or(0) < t {
            entry["used"] = t.into();
            entry["name"] = project.into();
        }
        if matches!(e["kind"].as_str(), Some("tool" | "stop")) && entry["agent"].as_i64().unwrap_or(0) < t {
            entry["agent"] = t.into();
        }
        changed = true;
    }
    if changed {
        saved.retain(|_, v| now - v["used"].as_i64().unwrap_or(0) < FORGET);
    }
    changed
}

/// A repo being looked at: where it is, its project name, and when the agent last did
/// something in it.
pub(crate) struct Active {
    pub(crate) root: PathBuf,
    pub(crate) name: String,
    pub(crate) agent: i64,
}

struct Repo {
    head: String,
    files: HashMap<String, u64>,
    seen: VecDeque<(u64, i64)>,
    /// Size, modified time and hash of each file last time, so unchanged files aren't read again.
    stat: HashMap<String, (u64, i128, u64)>,
}

#[derive(Default)]
pub struct Watch {
    last: Option<Instant>,
    repos: HashMap<PathBuf, Repo>,
}

/// For the watcher loop: every 30 seconds, the evidence events to queue.
pub fn poll(w: &mut Watch) -> Vec<Value> {
    if w.last.is_some_and(|l| l.elapsed() < EVERY) {
        return Vec::new();
    }
    w.last = Some(Instant::now());
    let now = Utc::now().timestamp();
    let mut active: Vec<(i64, Active)> = read_repos()
        .into_iter()
        .filter_map(|(root, v)| {
            let used = v["used"].as_i64()?;
            (now - used <= REACH).then(|| {
                let name = v["name"].as_str().unwrap_or("unknown").to_owned();
                (used, Active { root: PathBuf::from(root), name, agent: v["agent"].as_i64().unwrap_or(0) })
            })
        })
        .collect();
    active.sort_by_key(|(used, _)| -used);
    active.truncate(MAX_REPOS);
    let active: Vec<Active> = active.into_iter().map(|(_, a)| a).collect();
    look(w, &active, now)
}

/// Compares each repo with how it was last time. The first look at a repo only notes how
/// it is, since what happened before that can't be told apart.
pub(crate) fn look(w: &mut Watch, active: &[Active], now: i64) -> Vec<Value> {
    w.repos.retain(|root, _| active.iter().any(|a| &a.root == root));
    let mut out = Vec::new();
    let mut budget = READ_BUDGET;
    for a in active {
        let mut stat = w.repos.get_mut(&a.root).map(|r| std::mem::take(&mut r.stat)).unwrap_or_default();
        let files = snapshot(&a.root, &mut stat, &mut budget);
        if let Some(r) = w.repos.get_mut(&a.root) {
            r.stat = stat.clone();
        }
        let Some(files) = files else { continue };
        let head = git(&a.root, &["rev-parse", "HEAD"]).map(|b| String::from_utf8_lossy(&b).trim().to_owned()).unwrap_or_default();
        let state = fingerprint(&files);
        let agent_busy = now - a.agent < AGENT_QUIET;
        let Some(r) = w.repos.get_mut(&a.root) else {
            w.repos.insert(a.root.clone(), Repo { head, files, seen: VecDeque::from([(state, now)]), stat });
            continue;
        };
        if head != r.head && !head.is_empty() {
            if !agent_busy && fresh_commit(&a.root, now) {
                let mut e = event(new_id(), "evidence", &a.name, "steer", Utc::now(), "commit");
                e["hash"] = head.clone().into();
                out.push(e);
            }
        } else if files != r.files && !agent_busy && !r.seen.iter().any(|(s, _)| *s == state) {
            let count = files.iter().filter(|(p, h)| r.files.get(*p) != Some(h)).count() + r.files.keys().filter(|p| !files.contains_key(*p)).count();
            let mut e = event(new_id(), "evidence", &a.name, "steer", Utc::now(), "save");
            e["count"] = count.clamp(1, 10_000).into();
            out.push(e);
        }
        r.head = head;
        r.files = files;
        r.seen.push_back((state, now));
        while r.seen.front().is_some_and(|(_, t)| now - t > REMEMBER) || r.seen.len() > 500 {
            r.seen.pop_front();
        }
    }
    out
}

/// Every file git knows about or would add (tracked, plus untracked ones that aren't
/// ignored) with a hash of what's in it now. Symlinks and files that change by
/// themselves are left out. None if git can't read the repo.
fn snapshot(root: &Path, stat: &mut HashMap<String, (u64, i128, u64)>, budget: &mut u64) -> Option<HashMap<String, u64>> {
    let listed = git(root, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"])?;
    let mut files = HashMap::new();
    let mut fresh = HashMap::new();
    for entry in listed.split(|b| *b == 0) {
        if entry.is_empty() {
            continue;
        }
        if files.len() >= MAX_FILES {
            break;
        }
        let path = String::from_utf8_lossy(entry).into_owned();
        if NOISY.iter().any(|end| path.ends_with(end)) || files.contains_key(&path) {
            continue;
        }
        let full = root.join(&path);
        let hash = match fs::symlink_metadata(&full) {
            Ok(m) if m.file_type().is_symlink() || !m.is_file() => continue,
            Ok(m) => {
                let modified = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as i128).unwrap_or(0);
                match stat.get(&path) {
                    Some(&(len, when, hash)) if len == m.len() && when == modified => hash,
                    _ => {
                        let hash = if m.len() <= MAX_FILE_BYTES && m.len() <= *budget {
                            *budget -= m.len();
                            fs::read(&full).map(|b| hash_of(&b)).unwrap_or(1)
                        } else {
                            // Too big, or read enough this time: size and time stand in.
                            hash_of(&m.len().to_le_bytes()) ^ (modified as u64)
                        };
                        fresh.insert(path.clone(), (m.len(), modified, hash));
                        hash
                    }
                }
            }
            Err(_) => 0, // tracked but deleted
        };
        if let Some(&(len, when, h)) = stat.get(&path) {
            fresh.entry(path.clone()).or_insert((len, when, h));
        }
        files.insert(path, hash);
    }
    *stat = fresh;
    Some(files)
}

fn fingerprint(files: &HashMap<String, u64>) -> u64 {
    let mut list: Vec<(&String, &u64)> = files.iter().collect();
    list.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    list.hash(&mut h);
    h.finish()
}

fn hash_of(bytes: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// Runs git in a repo with nothing the repo's settings could start (fsmonitor is the one
/// the commands used here would run), no input and a time limit. Its output, or None if
/// it failed or took too long.
fn git(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "--no-optional-locks"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    // Read while waiting, or a long listing fills the pipe and git never finishes.
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let until = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = reader.join().ok()?;
    status.filter(|s| s.success()).map(|_| out)
}

/// True if HEAD was committed in the last 10 minutes, by the person this repo is set up
/// for (when it says who that is). Reads the commit itself: `git log` can be made to run
/// a signature checker.
fn fresh_commit(root: &Path, now: i64) -> bool {
    let Some(commit) = git(root, &["cat-file", "commit", "HEAD"]) else { return false };
    let text = String::from_utf8_lossy(&commit);
    let line = |who: &str| text.lines().take_while(|l| !l.is_empty()).find_map(|l| l.strip_prefix(who).map(str::to_owned));
    let email = |l: &str| l.split_once('<').and_then(|(_, r)| r.split_once('>')).map(|(e, _)| e.to_owned()).unwrap_or_default();
    let when = line("committer ").and_then(|l| l.rsplit(' ').nth(1).and_then(|t| t.parse::<i64>().ok())).unwrap_or(0);
    let author = line("author ").map(|l| email(&l)).unwrap_or_default();
    let me = git(root, &["config", "user.email"]).map(|b| String::from_utf8_lossy(&b).trim().to_owned()).unwrap_or_default();
    now - when <= COMMIT_FRESH && (me.is_empty() || me.eq_ignore_ascii_case(&author))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(root: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(root).args(args).output().unwrap().status.success();
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn only_real_changes_by_you_count() {
        let root = std::env::temp_dir().join(format!("steer-evidence-{}", new_id()));
        fs::create_dir_all(&root).unwrap();
        run(&root, &["init", "-q"]);
        run(&root, &["config", "user.email", "me@example.com"]);
        run(&root, &["config", "user.name", "me"]);
        fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "-qm", "start"]);

        let mut w = Watch::default();
        let now = Utc::now().timestamp();
        let quiet = |agent: i64| [Active { root: root.clone(), name: "game".into(), agent }];
        let kinds = |events: Vec<Value>| events.iter().map(|e| e["kind"].as_str().unwrap().to_owned()).collect::<Vec<_>>();

        // The first look only notes how things are.
        assert!(look(&mut w, &quiet(0), now).is_empty());
        // You change a file: a save, of one file.
        fs::write(root.join("main.rs"), "fn main() { println!(\"hi\"); }\n").unwrap();
        let e = look(&mut w, &quiet(0), now + 30);
        assert_eq!(kinds(e.clone()), ["save"]);
        assert_eq!(e[0]["count"], 1);
        assert_eq!(e[0]["via"], "steer");
        // Nothing changed: nothing.
        assert!(look(&mut w, &quiet(0), now + 60).is_empty());
        // Saving it again unchanged (a new modified time, same contents): nothing.
        fs::write(root.join("main.rs"), "fn main() { println!(\"hi\"); }\n").unwrap();
        assert!(look(&mut w, &quiet(0), now + 90).is_empty());
        // Undoing it goes back to a state seen before: nothing.
        fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
        assert!(look(&mut w, &quiet(0), now + 120).is_empty());
        // The agent edits while it's running: not yours.
        fs::write(root.join("enemy.rs"), "struct Enemy;\n").unwrap();
        assert!(look(&mut w, &quiet(now + 140), now + 150).is_empty());
        // A new file you write after it stopped: a save.
        fs::write(root.join("boss.rs"), "struct Boss;\n").unwrap();
        assert_eq!(kinds(look(&mut w, &quiet(now + 140), now + 240)), ["save"]);
        // You commit: a commit with its hash.
        run(&root, &["add", "."]);
        run(&root, &["commit", "-qm", "boss"]);
        let e = look(&mut w, &quiet(now + 140), now + 270);
        assert_eq!(kinds(e.clone()), ["commit"]);
        let head = String::from_utf8(git(&root, &["rev-parse", "HEAD"]).unwrap()).unwrap();
        assert_eq!(e[0]["hash"], head.trim());
        // A repo that's no longer active is forgotten.
        assert!(look(&mut w, &[], now + 300).is_empty());
        assert!(w.repos.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_repos_own_settings_cant_run_anything() {
        let root = std::env::temp_dir().join(format!("steer-evil-{}", new_id()));
        fs::create_dir_all(&root).unwrap();
        run(&root, &["init", "-q"]);
        let marker = root.join("ran");
        let script = root.join("evil.sh");
        fs::write(&script, format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display())).unwrap();
        run(&root, &["config", "core.fsmonitor", &script.to_string_lossy()]);
        run(&root, &["config", "filter.x.clean", &script.to_string_lossy()]);
        run(&root, &["config", "log.showSignature", "true"]);
        run(&root, &["config", "gpg.program", &script.to_string_lossy()]);
        Command::new("chmod").arg("+x").arg(&script).status().unwrap();
        fs::write(root.join(".gitattributes"), "a.txt filter=x\n").unwrap();
        fs::write(root.join("a.txt"), "one\n").unwrap();
        run(&root, &["-c", "core.fsmonitor=false", "-c", "filter.x.clean=cat", "add", "a.txt", ".gitattributes"]);
        run(&root, &["-c", "core.fsmonitor=false", "-c", "filter.x.clean=cat", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "x"]);
        let _ = fs::remove_file(&marker);

        let mut w = Watch::default();
        let now = Utc::now().timestamp();
        let here = [Active { root: root.clone(), name: "evil".into(), agent: 0 }];
        look(&mut w, &here, now);
        fs::write(root.join("a.txt"), "two\n").unwrap();
        run(&root, &["-c", "core.fsmonitor=false", "-c", "filter.x.clean=cat", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qam", "y"]);
        fs::write(root.join("a.txt"), "three\n").unwrap();
        look(&mut w, &here, now + 30);
        look(&mut w, &here, now + 60);
        assert!(!marker.exists(), "something in the repo's settings ran");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn symlinks_and_noisy_files_dont_count() {
        let root = std::env::temp_dir().join(format!("steer-links-{}", new_id()));
        fs::create_dir_all(&root).unwrap();
        run(&root, &["init", "-q"]);
        let outside = std::env::temp_dir().join(format!("steer-outside-{}", new_id()));
        fs::write(&outside, "a").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        fs::write(root.join("server.log"), "a").unwrap();
        let mut w = Watch::default();
        let now = Utc::now().timestamp();
        let here = [Active { root: root.clone(), name: "links".into(), agent: 0 }];
        assert!(look(&mut w, &here, now).is_empty());
        fs::write(&outside, "changed").unwrap();
        fs::write(root.join("server.log"), "more lines").unwrap();
        assert!(look(&mut w, &here, now + 30).is_empty(), "a symlink's target or a log changing isn't a save");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn queued_events_say_which_repos_to_watch() {
        let root = std::env::temp_dir().join(format!("steer-repo-{}", new_id()));
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        let name = crate::live::project_name(&root.join("src").to_string_lossy());
        let roots: Vec<_> = crate::live::known_roots().into_iter().filter(|(n, _)| n == &name).collect();
        assert_eq!(roots, [(name.clone(), root.clone())], "project_name remembers the repo it found");
        let t = Utc::now();
        let mut saved = Map::new();
        // A repo nobody used an AI tool in for over a week is dropped.
        saved.insert("/old".into(), json!({ "name": "old", "used": t.timestamp() - 8 * 86400, "agent": 0 }));
        let events = [
            event(new_id(), "s", &name, "claude-code", t, "prompt"),
            event(new_id(), "s", &name, "claude-code", t + chrono::Duration::seconds(5), "tool"),
            // steer's own events don't count as using an AI tool.
            event(new_id(), "evidence", &name, "steer", t + chrono::Duration::seconds(50), "save"),
        ];
        assert!(note_into(&mut saved, &roots, &events, t.timestamp() + 60));
        assert!(!saved.contains_key("/old"));
        let entry = &saved[&root.to_string_lossy().into_owned()];
        assert_eq!(entry["name"], name.as_str());
        assert_eq!(entry["used"], t.timestamp() + 5);
        assert_eq!(entry["agent"], t.timestamp() + 5);
        let _ = fs::remove_dir_all(&root);
    }
}
