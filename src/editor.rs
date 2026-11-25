//! VS Code and Cursor. steer's extension for them (editor/) writes the stretches of time
//! someone worked in a project's files to ~/.steer/editor/<window>.jsonl, and since 0.5.9
//! the stretches the window was in front with a project open to ~/.steer/editor-front:
//! the folder, when it started and ended, and which editor. The watcher turns each one
//! into an "editor" or "front" event with just the project's name and the times, and only
//! for projects an AI tool was used in around then, since coding without AI is
//! Hackatime's job. Folder paths, file names and code never leave the computer.
//!
//! `steer setup` puts the extension in with the editors' own command line tools
//! (`code --install-extension`), from a .vsix made here out of editor/. After an update
//! with a newer extension, the watcher puts the new one in where the old one is.

use crate::live::{dir, event, home, new_id, project_name};
use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const PACKAGE: &str = include_str!("../editor/package.json");
const SCRIPT: &str = include_str!("../editor/extension.js");
const ID: &str = "steer.steer-editor";
/// A stretch counts if an AI tool was used in its project this close to it.
const REACH: i64 = 2 * 3600;
/// The extension writes long stretches in 15 minute pieces. Anything much longer is broken.
const LONGEST: i64 = 3600;
/// Fully read files from editor windows closed this long ago get deleted.
const OLD: Duration = Duration::from_secs(86_400);
/// The editors' command line tools can be slow to start, but not this slow.
const CLI_TIMEOUT: Duration = Duration::from_secs(120);

// ---------- reading what the extension wrote ----------

/// Called by the watcher every few seconds. `state` keeps how far each file was read.
pub(crate) fn poll(state: &mut Map<String, Value>) -> Vec<Value> {
    let (used, now) = (crate::evidence::used_projects(), Utc::now());
    let mut out = poll_dir(&dir().join("editor"), "", "editor", state, &used, &project_name, now);
    out.extend(poll_dir(&dir().join("editor-front"), "front/", "front", state, &used, &project_name, now));
    out
}

/// Reads one folder of the extension's files. `kind` is what its stretches become, and
/// `prefix` keeps their place in `state` apart from the other folder's.
#[allow(clippy::too_many_arguments)]
fn poll_dir(
    folder: &Path,
    prefix: &str,
    kind: &str,
    state: &mut Map<String, Value>,
    used: &HashMap<String, i64>,
    name_of: &dyn Fn(&str) -> String,
    now: DateTime<Utc>,
) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(folder) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).filter(|n| n.ends_with(".jsonl")).map(|n| format!("{prefix}{n}")) else {
            continue;
        };
        let Ok(mut file) = fs::File::open(&path) else { continue };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let mut offset = state.get(&name).and_then(Value::as_u64).unwrap_or(0);
        if offset > len {
            offset = 0; // the file was replaced
        }
        // Only what's new, and at most a megabyte at a time (the rest comes next time).
        let mut new = Vec::new();
        if offset < len && file.seek(SeekFrom::Start(offset)).is_ok() {
            let _ = file.take(1_000_000).read_to_end(&mut new);
        }
        let (events, read) = events_from(&new, kind, used, name_of, now);
        out.extend(events);
        offset += read as u64;
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > OLD);
        if offset == len && old && fs::remove_file(&path).is_ok() {
            state.remove(&name);
        } else {
            state.insert(name, offset.into());
        }
    }
    out
}

/// Events from the complete lines in `bytes`, and how many bytes those were. A last line
/// without its newline is still being written, so it's left for next time.
fn events_from(bytes: &[u8], kind: &str, used: &HashMap<String, i64>, name_of: &dyn Fn(&str) -> String, now: DateTime<Utc>) -> (Vec<Value>, usize) {
    let complete = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let events = bytes[..complete]
        .split(|&b| b == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter_map(|v| {
            let folder = v["folder"].as_str()?;
            let time = |k: &str| v[k].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc));
            let (start, end) = (time("start")?, time("end")?);
            let secs = (end - start).num_seconds();
            if !(0..=LONGEST).contains(&secs) || end > now + chrono::Duration::minutes(1) {
                return None;
            }
            let app = match v["app"].as_str()? {
                "vscode" => "vscode",
                "cursor" => "cursor",
                _ => return None,
            };
            let project = name_of(folder);
            let last_ai = *used.get(&project)?;
            if (start.timestamp() - last_ai).abs() > REACH {
                return None;
            }
            let mut e = event(new_id(), "editor", &project, "steer", start, kind);
            e["secs"] = secs.into();
            e["app"] = app.into();
            Some(e)
        })
        .collect();
    (events, complete)
}

// ---------- putting the extension in ----------

/// The editors on this computer that have a command line tool to install it with.
fn editors() -> Vec<(&'static str, PathBuf)> {
    let home = home();
    let env_dir = |k: &str| std::env::var_os(k).map(PathBuf::from).unwrap_or_default();
    let (local, programs) = (env_dir("LOCALAPPDATA"), env_dir("ProgramFiles"));
    let candidates = [
        (
            "vs code",
            "code",
            vec![
                PathBuf::from("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
                home.join("Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
                local.join("Programs/Microsoft VS Code/bin/code.cmd"),
                programs.join("Microsoft VS Code/bin/code.cmd"),
                PathBuf::from("/usr/share/code/bin/code"),
                PathBuf::from("/snap/bin/code"),
            ],
        ),
        (
            "cursor",
            "cursor",
            vec![
                PathBuf::from("/Applications/Cursor.app/Contents/Resources/app/bin/cursor"),
                home.join("Applications/Cursor.app/Contents/Resources/app/bin/cursor"),
                local.join("Programs/cursor/resources/app/bin/cursor.cmd"),
                PathBuf::from("/usr/share/cursor/bin/cursor"),
                PathBuf::from("/opt/Cursor/resources/app/bin/cursor"),
            ],
        ),
    ];
    candidates
        .into_iter()
        .filter_map(|(name, cmd, paths)| paths.into_iter().find(|p| p.is_file()).or_else(|| on_path(cmd)).map(|p| (name, p)))
        .collect()
}

fn on_path(cmd: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) { vec![format!("{cmd}.cmd"), format!("{cmd}.exe")] } else { vec![cmd.to_owned()] };
    std::env::split_paths(&std::env::var_os("PATH")?).flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

/// Where an editor keeps its extensions.
fn extensions_dir(editor: &str) -> PathBuf {
    home().join(if editor == "cursor" { ".cursor" } else { ".vscode" }).join("extensions")
}

fn has_extension(editor: &str) -> bool {
    fs::read_dir(extensions_dir(editor))
        .map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().starts_with(&format!("{ID}-"))))
        .unwrap_or(false)
}

/// The extension's version in this build of steer.
fn version() -> String {
    serde_json::from_str::<Value>(PACKAGE).ok().and_then(|v| v["version"].as_str().map(str::to_owned)).unwrap_or_default()
}

/// "0.10.0" is newer than "0.9.1".
fn older(a: &str, b: &str) -> bool {
    let parts = |v: &str| v.split('.').map(|p| p.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>();
    parts(a) < parts(b)
}

/// The newest version of the extension an editor has, if it has it.
fn installed_version(editor: &str) -> Option<String> {
    let prefix = format!("{ID}-");
    fs::read_dir(extensions_dir(editor))
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_prefix(&prefix).map(str::to_owned))
        .max_by(|a, b| if older(a, b) { std::cmp::Ordering::Less } else if older(b, a) { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal })
}

/// After an update with a newer extension, puts it in the editors that have an older one,
/// so nobody has to run setup again. Editors without it (never added, or taken out) are
/// left alone.
pub(crate) fn refresh() -> Option<String> {
    if std::env::var_os("STEER_SANDBOX").is_some() {
        return None;
    }
    let new = version();
    let stale: Vec<_> = editors().into_iter().filter(|(name, _)| installed_version(name).is_some_and(|v| older(&v, &new))).collect();
    if stale.is_empty() {
        return None;
    }
    let vsix = dir().join("steer-editor.vsix");
    fs::create_dir_all(dir()).and_then(|()| fs::write(&vsix, build_vsix())).ok()?;
    let updated: Vec<&str> = stale
        .iter()
        .filter(|(_, cli)| run(cli, &["--install-extension".as_ref(), vsix.as_os_str(), "--force".as_ref()]))
        .map(|(name, _)| *name)
        .collect();
    (!updated.is_empty()).then(|| format!("updated the steer extension in {} to {new}", updated.join(" and ")))
}

/// For `steer doctor`: each editor found, and whether the extension is in it.
pub(crate) fn status() -> Vec<(&'static str, bool)> {
    // Setup leaves the editors alone in the sandbox, so doctor doesn't ask for it either.
    if std::env::var_os("STEER_SANDBOX").is_some() {
        return Vec::new();
    }
    editors().into_iter().map(|(name, _)| (name, has_extension(name))).collect()
}

/// Puts the extension in every editor found (or takes it out with `remove`). Never fails
/// setup: an editor that won't take it is just mentioned.
pub(crate) fn install(remove: bool) -> String {
    if std::env::var_os("STEER_SANDBOX").is_some() {
        return "left vs code and cursor alone (STEER_SANDBOX is set)".into();
    }
    let found = editors();
    if found.is_empty() {
        return if remove { "no vs code or cursor to take the extension out of".into() } else { "didn't find vs code or cursor, so no editor extension".into() };
    }
    let vsix = dir().join("steer-editor.vsix");
    if !remove && fs::create_dir_all(dir()).and_then(|()| fs::write(&vsix, build_vsix())).is_err() {
        return format!("couldn't write {}, so no editor extension", vsix.display());
    }
    let mut done = Vec::new();
    let mut failed = Vec::new();
    for (name, cli) in &found {
        let args: Vec<&std::ffi::OsStr> = if remove {
            vec!["--uninstall-extension".as_ref(), ID.as_ref()]
        } else {
            vec!["--install-extension".as_ref(), vsix.as_os_str(), "--force".as_ref()]
        };
        // Taking out one that was never put in "fails", which is fine.
        if run(cli, &args) || (remove && !has_extension(name)) {
            done.push(*name);
        } else {
            failed.push(*name);
        }
    }
    let mut lines = Vec::new();
    if !done.is_empty() {
        lines.push(if remove {
            format!("took the steer extension out of {}", done.join(" and "))
        } else {
            format!("added the steer extension to {}. it notes when you're working in a project's files or have the editor in front, and only the project and the times get sent", done.join(" and "))
        });
    }
    if !failed.is_empty() {
        lines.push(if remove {
            format!("couldn't take the steer extension out of {}, you can remove it in the editor's extensions", failed.join(" and "))
        } else {
            format!("couldn't add the steer extension to {}. you can do it in the editor: extensions, the ... menu, install from vsix, and pick {}", failed.join(" and "), vsix.display())
        });
    }
    lines.join("\n")
}

/// Runs an editor's command line tool, true if it worked.
fn run(cli: &Path, args: &[&std::ffi::OsStr]) -> bool {
    let Ok(mut child) = Command::new(cli).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() < CLI_TIMEOUT => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                return false;
            }
        }
    }
}

// ---------- the .vsix ----------

/// The extension as a .vsix: a zip with the extension's files under extension/ and two
/// small files that say what's in it.
pub(crate) fn build_vsix() -> Vec<u8> {
    let version = version();
    let manifest = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="steer-editor" Version="{version}" Publisher="steer" />
    <DisplayName>steer</DisplayName>
    <Description xml:space="preserve">tells steer when you're working in a project's files</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.75.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"#
    );
    let types = r#"<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>
"#;
    zip(&[
        ("[Content_Types].xml", types.as_bytes()),
        ("extension.vsixmanifest", manifest.as_bytes()),
        ("extension/package.json", PACKAGE.as_bytes()),
        ("extension/extension.js", SCRIPT.as_bytes()),
    ])
}

/// A zip with the files stored as they are, no compression, which is all a .vsix needs.
fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let offset = out.len() as u32;
        let (crc, len, name_len) = (crc32(data), data.len() as u32, name.len() as u16);
        // Version 2.0, no flags, stored, 1980-01-01 00:00.
        let common = |b: &mut Vec<u8>| {
            for v in [20u16, 0, 0, 0, 0x21] {
                b.extend(v.to_le_bytes());
            }
            b.extend(crc.to_le_bytes());
            b.extend(len.to_le_bytes());
            b.extend(len.to_le_bytes());
            b.extend(name_len.to_le_bytes());
            b.extend(0u16.to_le_bytes());
        };
        out.extend(0x0403_4b50u32.to_le_bytes());
        common(&mut out);
        out.extend(name.as_bytes());
        out.extend(*data);
        central.extend(0x0201_4b50u32.to_le_bytes());
        central.extend(20u16.to_le_bytes()); // made by
        common(&mut central);
        for v in [0u16, 0, 0] {
            central.extend(v.to_le_bytes()); // comment, disk, internal attributes
        }
        central.extend(0u32.to_le_bytes()); // external attributes
        central.extend(offset.to_le_bytes());
        central.extend(name.as_bytes());
    }
    let (start, size, count) = (out.len() as u32, central.len() as u32, files.len() as u16);
    out.extend(central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    for v in [0u16, 0, count, count] {
        out.extend(v.to_le_bytes());
    }
    out.extend(size.to_le_bytes());
    out.extend(start.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    /// For trying the package in a real editor: STEER_VSIX=/tmp/steer.vsix cargo test -- --ignored write_vsix
    #[test]
    #[ignore = "writes a file, run by hand"]
    fn write_vsix() {
        if let Some(path) = std::env::var_os("STEER_VSIX") {
            fs::write(path, build_vsix()).unwrap();
        }
    }

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn the_vsix_has_the_extension_in_it() {
        let v = build_vsix();
        // Walk the zip's own headers back out.
        let mut names = Vec::new();
        let mut at = 0;
        while v[at..].starts_with(&0x0403_4b50u32.to_le_bytes()) {
            let u16_at = |i: usize| u16::from_le_bytes([v[at + i], v[at + i + 1]]) as usize;
            let u32_at = |i: usize| u32::from_le_bytes([v[at + i], v[at + i + 1], v[at + i + 2], v[at + i + 3]]);
            let (size, name_len) = (u32_at(18) as usize, u16_at(26));
            let name = String::from_utf8(v[at + 30..at + 30 + name_len].to_vec()).unwrap();
            let data = &v[at + 30 + name_len..at + 30 + name_len + size];
            assert_eq!(u32_at(14), crc32(data), "{name}'s checksum");
            names.push(name);
            at += 30 + name_len + size;
        }
        assert_eq!(names, ["[Content_Types].xml", "extension.vsixmanifest", "extension/package.json", "extension/extension.js"]);
        assert!(v.ends_with(&[0, 0]) && v.windows(4).any(|w| w == 0x0605_4b50u32.to_le_bytes()));
        let manifest: Value = serde_json::from_str(PACKAGE).unwrap();
        assert_eq!(format!("{}.{}", manifest["publisher"].as_str().unwrap(), manifest["name"].as_str().unwrap()), ID);
    }

    #[test]
    fn stretches_become_events_only_near_ai_use() {
        let now = DateTime::parse_from_rfc3339("2026-11-24T18:00:00Z").unwrap().with_timezone(&Utc);
        let used = HashMap::from([("game".to_owned(), now.timestamp() - 600)]);
        let name_of = |f: &str| f.rsplit('/').next().unwrap_or_default().to_owned();
        let lines = concat!(
            r#"{"folder":"/home/x/game","start":"2026-11-24T17:50:00.000Z","end":"2026-11-24T17:55:30.000Z","app":"vscode"}"#,
            "\n",
            // a project nobody used an AI tool in: Hackatime's
            r#"{"folder":"/home/x/essay","start":"2026-11-24T17:50:00.000Z","end":"2026-11-24T17:52:00.000Z","app":"cursor"}"#,
            "\n",
            // too long ago to be near the AI use
            r#"{"folder":"/home/x/game","start":"2026-11-24T12:00:00.000Z","end":"2026-11-24T12:05:00.000Z","app":"vscode"}"#,
            "\n",
            r#"{"folder":"/home/x/game","start":"2026-11-24T17:56:00.000Z","end":"2026-11-24T17:50:00.000Z","app":"vscode"}"#,
            "\n",
            r#"{"folder":"/home/x/game","start":"2026-11-24T17:57:00.000Z","end":"2026-11-24T17:58:00.000Z","app":"notepad"}"#,
            "\nnot json\n",
            // still being written
            r#"{"folder":"/home/x/game","start":"2026-11-24T17:59:00.000Z""#,
        );
        let (events, read) = events_from(lines.as_bytes(), "editor", &used, &name_of, now);
        assert_eq!(read, lines.rfind('\n').unwrap() + 1, "the unfinished last line is left for next time");
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!((e["kind"].as_str(), e["via"].as_str(), e["project"].as_str()), (Some("editor"), Some("steer"), Some("game")));
        assert_eq!((e["secs"].as_i64(), e["app"].as_str()), (Some(330), Some("vscode")));
        assert_eq!(e["t"], "2026-11-24T17:50:00.000Z");
        assert!(e.get("folder").is_none(), "the folder's path stays here");
    }

    #[test]
    fn files_are_read_once_and_half_written_lines_wait() {
        let folder = std::env::temp_dir().join(format!("steer-editor-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        let now = Utc::now();
        let used = HashMap::from([("game".to_owned(), now.timestamp())]);
        let name_of = |f: &str| f.rsplit('/').next().unwrap_or_default().to_owned();
        let line = |secs: i64| {
            let start = now - chrono::Duration::seconds(600);
            let end = start + chrono::Duration::seconds(secs);
            let iso = |t: DateTime<Utc>| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            format!(r#"{{"folder":"/x/game","start":"{}","end":"{}","app":"vscode"}}"#, iso(start), iso(end))
        };
        let file = folder.join("123.jsonl");
        let second = line(20);
        fs::write(&file, format!("{}\n{}", line(10), &second[..30])).unwrap();
        let mut state = Map::new();
        let first = poll_dir(&folder, "", "editor", &mut state, &used, &name_of, now);
        assert_eq!(first.iter().map(|e| e["secs"].as_i64()).collect::<Vec<_>>(), [Some(10)]);
        // The window finishes writing the second line.
        fs::write(&file, format!("{}\n{second}\n", line(10))).unwrap();
        let next = poll_dir(&folder, "", "editor", &mut state, &used, &name_of, now);
        assert_eq!(next.iter().map(|e| e["secs"].as_i64()).collect::<Vec<_>>(), [Some(20)]);
        assert!(poll_dir(&folder, "", "editor", &mut state, &used, &name_of, now).is_empty(), "nothing twice");
        // The same file name in the folder for the window being in front is read on its own.
        let front = folder.join("front");
        fs::create_dir_all(&front).unwrap();
        fs::write(front.join("123.jsonl"), format!("{}\n", line(30))).unwrap();
        let fronts = poll_dir(&front, "front/", "front", &mut state, &used, &name_of, now);
        assert_eq!(fronts.iter().map(|e| (e["kind"].as_str(), e["secs"].as_i64())).collect::<Vec<_>>(), [(Some("front"), Some(30))]);
        assert!(state.contains_key("123.jsonl") && state.contains_key("front/123.jsonl"));
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn the_window_in_front_becomes_its_own_kind() {
        let now = DateTime::parse_from_rfc3339("2026-11-24T18:00:00Z").unwrap().with_timezone(&Utc);
        let used = HashMap::from([("game".to_owned(), now.timestamp() - 600)]);
        let name_of = |f: &str| f.rsplit('/').next().unwrap_or_default().to_owned();
        let line = concat!(r#"{"folder":"/home/x/game","start":"2026-11-24T17:50:00.000Z","end":"2026-11-24T17:54:00.000Z","app":"cursor"}"#, "\n");
        let (events, _) = events_from(line.as_bytes(), "front", &used, &name_of, now);
        assert_eq!(events.len(), 1);
        assert_eq!((events[0]["kind"].as_str(), events[0]["secs"].as_i64(), events[0]["app"].as_str()), (Some("front"), Some(240), Some("cursor")));
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(older("0.1.0", "0.2.0"));
        assert!(older("0.9.1", "0.10.0"));
        assert!(!older("0.2.0", "0.2.0"));
        assert!(!older("1.0.0", "0.9.9"));
        assert!(!version().is_empty());
    }
}
