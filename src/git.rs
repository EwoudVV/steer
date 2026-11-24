use chrono::{DateTime, TimeZone, Utc};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Normalize a project name: lowercase, treat spaces and dashes as equivalent,
/// and collapse multiple spaces/dashes into single spaces.
/// "Vault Books", "vault-books", "VAULT_BOOKS" → "vault books"
fn normalize(name: &str) -> String {
    let mut t = name.to_lowercase();
    t = t.replace('-', " ");
    t.split_whitespace().collect::<Vec<&str>>().join(" ")
}

/// Project name and git root for a session's working folder.
pub fn project_for(cwd: Option<&str>) -> (String, Option<PathBuf>) {
    let Some(cwd) = cwd else { return (normalize("unknown"), None) };
    let start = Path::new(cwd);
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join(".git").exists() {
            return (normalize(&base_name(d)), Some(d.to_path_buf()));
        }
        dir = d.parent();
    }
    (normalize(&base_name(start)), None)
}

fn base_name(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.display().to_string())
}

/// Commit times by the repo's configured user. Empty if git isn't available.
pub fn my_commits(repo: &Path) -> Vec<DateTime<Utc>> {
    let email = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["config", "user.email"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .filter(|s| !s.is_empty());

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args(["log", "--all", "--format=%at", "--max-count=20000"]);
    if let Some(e) = &email {
        cmd.arg("--fixed-strings").arg(format!("--author={e}"));
    }
    let Ok(out) = cmd.output() else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    let mut times: Vec<DateTime<Utc>> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<i64>().ok())
        .filter_map(|s| Utc.timestamp_opt(s, 0).single())
        .collect();
    times.sort();
    times
}
