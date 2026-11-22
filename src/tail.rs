//! Shared by the readers of JSONL session logs (Codex, Copilot): reads only the lines
//! added to each file since last time, and remembers where it got to.

use serde_json::{json, Map, Value};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Most to read from one file in one go, so a huge file can't stall the watcher.
const MAX_READ: u64 = 32 * 1024 * 1024;

/// The session and project the lines of one file belong to. A reader can change the
/// project partway through, e.g. when the session moves to another folder. `tags` is
/// whatever else the reader noted about the file when it first saw it.
pub struct Ctx {
    pub session: String,
    pub project: String,
    pub tags: Value,
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
    meta: impl Fn(&Path) -> (String, String, Value),
    mut parse: impl FnMut(&Value, &mut Ctx, u64) -> Option<Value>,
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
        }
        if len == offset {
            continue;
        }
        // Files first seen by an older version have no tags yet.
        if entry.get("session").is_none() || entry.get("tags").is_none() {
            let (session, project, tags) = meta(&path);
            if entry.get("session").is_none() {
                entry["session"] = session.into();
                entry["project"] = project.into();
            }
            entry["tags"] = tags;
        }
        let mut ctx = Ctx {
            session: entry["session"].as_str().unwrap_or_default().to_owned(),
            project: entry["project"].as_str().unwrap_or("unknown").to_owned(),
            tags: entry["tags"].clone(),
        };

        let Ok(mut file) = File::open(&path) else { continue };
        if file.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        let mut buf = Vec::new();
        if file.take(MAX_READ).read_to_end(&mut buf).is_err() {
            continue;
        }
        // Only whole lines. A line still being written gets picked up next time.
        let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { continue };
        let mut pos = offset;
        for line in buf[..end].split(|&b| b == b'\n') {
            let line_offset = pos;
            pos += line.len() as u64 + 1;
            let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
            if let Some(e) = parse(&v, &mut ctx, line_offset) {
                out.push(e);
            }
        }
        entry["offset"] = (offset + end as u64 + 1).into();
        entry["project"] = ctx.project.into();
    }
    state.retain(|k, _| Path::new(k).exists());
    out
}
