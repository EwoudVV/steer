//! Shared by the readers of JSONL session logs (Codex, Copilot, Junie): reads only the
//! lines added to each file since last time, and remembers where it got to.

use serde_json::{json, Map, Value};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Most to read from one file in one go, so a huge file can't stall the watcher.
const MAX_READ: u64 = 32 * 1024 * 1024;

/// The session and project the lines of one file belong to. A reader can change the
/// project partway through, e.g. when the session moves to another folder.
pub struct Ctx {
    pub session: String,
    pub project: String,
    /// The tool's permission setting for this session, if its log says (Codex's
    /// approval_policy). Kept with the file's state like the project.
    pub mode: Option<String>,
}

/// Every .jsonl file under `dir`, at any depth.
pub fn jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            jsonl_files(&path, out);
        } else if path.extension().is_some_and(|x| x == "jsonl") {
            out.push(path);
        }
    }
}

/// Reads what's new in each file and turns it into events with `parse`. `state` keeps,
/// per file, how far it's been read plus its session and project (from `meta` the first
/// time a file is seen). With `skip_existing`, files seen for the first time are skipped
/// to their end, so old history isn't sent.
pub fn poll(
    files: Vec<PathBuf>,
    state: &mut Map<String, Value>,
    skip_existing: bool,
    meta: impl Fn(&Path) -> (String, String),
    mut parse: impl FnMut(&Value, &mut Ctx, u64) -> Option<Value>,
) -> Vec<Value> {
    poll_lines(files, state, skip_existing, meta, |line, ctx, offset| {
        let v = serde_json::from_slice::<Value>(line).ok()?;
        parse(&v, ctx, offset)
    })
}

/// Same as `poll`, but `parse` gets each line as it is in the file, so a reader can skip
/// lines it doesn't need without parsing them.
pub fn poll_lines(
    files: Vec<PathBuf>,
    state: &mut Map<String, Value>,
    skip_existing: bool,
    meta: impl Fn(&Path) -> (String, String),
    parse: impl FnMut(&[u8], &mut Ctx, u64) -> Option<Value>,
) -> Vec<Value> {
    read_new(files, state, skip_existing, meta, parse, MAX_READ)
}

fn read_new(
    files: Vec<PathBuf>,
    state: &mut Map<String, Value>,
    skip_existing: bool,
    meta: impl Fn(&Path) -> (String, String),
    mut parse: impl FnMut(&[u8], &mut Ctx, u64) -> Option<Value>,
    max_read: u64,
) -> Vec<Value> {
    let mut out = Vec::new();
    for path in files {
        let key = path.to_string_lossy().into_owned();
        let Ok(len) = fs::metadata(&path).map(|m| m.len()) else { continue };
        let entry = state
            .entry(key)
            .or_insert_with(|| json!({ "offset": if skip_existing { len } else { 0 } }));
        let mut offset = entry["offset"].as_u64().unwrap_or(0);
        if len < offset {
            offset = 0; // the file was replaced
            remove(entry, "skip");
        }
        if len == offset {
            continue;
        }
        if entry.get("session").is_none() {
            let (session, project) = meta(&path);
            entry["session"] = session.into();
            entry["project"] = project.into();
        }
        let mut ctx = Ctx {
            session: entry["session"].as_str().unwrap_or_default().to_owned(),
            project: entry["project"].as_str().unwrap_or("unknown").to_owned(),
            mode: entry["mode"].as_str().map(str::to_owned),
        };

        let Ok(mut file) = File::open(&path) else { continue };
        if file.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        let mut buf = Vec::new();
        if file.take(max_read).read_to_end(&mut buf).is_err() {
            continue;
        }
        let full = buf.len() as u64 == max_read;
        // The rest of a line that was too long to read (see below) is dropped.
        let mut start = 0;
        if entry.get("skip").is_some() {
            let Some(i) = buf.iter().position(|&b| b == b'\n') else {
                entry["offset"] = (offset + buf.len() as u64).into();
                continue;
            };
            start = i + 1;
            remove(entry, "skip");
        }
        // Only whole lines. A line still being written gets picked up next time. One
        // longer than what's read in one go never would be, so it's skipped instead of
        // read again and again.
        let Some(end) = buf[start..].iter().rposition(|&b| b == b'\n').map(|i| start + i) else {
            if full && start == 0 {
                entry["skip"] = true.into();
                entry["offset"] = (offset + max_read).into();
            } else {
                entry["offset"] = (offset + start as u64).into();
            }
            continue;
        };
        let mut pos = offset + start as u64;
        for line in buf[start..end].split(|&b| b == b'\n') {
            let line_offset = pos;
            pos += line.len() as u64 + 1;
            if let Some(e) = parse(line, &mut ctx, line_offset) {
                out.push(e);
            }
        }
        entry["offset"] = (offset + end as u64 + 1).into();
        entry["project"] = ctx.project.into();
        if let Some(mode) = ctx.mode {
            entry["mode"] = mode.into();
        }
    }
    state.retain(|k, _| Path::new(k).exists());
    out
}

fn remove(entry: &mut Value, key: &str) {
    if let Some(o) = entry.as_object_mut() {
        o.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn a_line_too_long_to_read_is_skipped() {
        let dir = std::env::temp_dir().join(format!("steer-tail-{}", crate::live::new_id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("log.jsonl");
        let append = |s: &str| fs::OpenOptions::new().create(true).append(true).open(&file).unwrap().write_all(s.as_bytes()).unwrap();
        let mut state = Map::new();
        let meta = |_: &Path| ("s".to_owned(), "p".to_owned());
        let read = |state: &mut Map<String, Value>| -> Vec<String> {
            read_new(vec![file.clone()], state, false, meta, |line, _, _| Some(String::from_utf8_lossy(line).into_owned().into()), 64)
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect()
        };
        append("one\n");
        assert_eq!(read(&mut state), ["one"]);
        // Longer than the 64 bytes read at a time, and still being written.
        append(&"x".repeat(100));
        assert!(read(&mut state).is_empty());
        append(&format!("{}\ntwo\n", "x".repeat(100)));
        let got: Vec<String> = (0..5).flat_map(|_| read(&mut state)).collect();
        assert_eq!(got, ["two"], "the long line is skipped a piece at a time, never read as lines");
        // A line that's only partly there isn't read until it's whole.
        append("thr");
        assert!(read(&mut state).is_empty());
        append("ee\n");
        assert_eq!(read(&mut state), ["three"]);
        let _ = fs::remove_dir_all(&dir);
    }
}
