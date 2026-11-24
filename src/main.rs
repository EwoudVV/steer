mod analyze;
mod checkin;
mod codex;
mod copilot;
mod editor;
mod evidence;
mod freebuff;
mod idle;
mod claude;
mod git;
mod live;
mod native;
mod manage;
mod model;
mod opencode;
mod prompt;
mod report;
mod tail;
mod watch;

use chrono::{DateTime, Utc};
use std::collections::BTreeMap;
use std::path::PathBuf;

struct Args {
    days: Option<i64>,
    out: PathBuf,
    root: Option<PathBuf>,
    hide_titles: bool,
}

const HELP: &str = "report from your old claude code logs (runs on your computer, nothing gets uploaded):
  steer report [--days N | --all] [--out FILE] [--hide-titles] [--root DIR]

  --days N        only sessions active in the last N days (default 30)
  --all           every session
  --out FILE      where to write the HTML report (default steer-report.html)
  --hide-titles   don't show session titles in the report
  --root DIR      Claude Code projects folder (default ~/.claude/projects)
";

fn help() -> String {
    format!(
        "steer {}: tracks the time you spend working with ai agents\n\n{}\n\n{HELP}",
        manage::VERSION,
        live::HELP
    )
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut a = Args { days: Some(30), out: PathBuf::from("steer-report.html"), root: None, hide_titles: false };
    let mut it = args.iter().cloned();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--days" => {
                let v = it.next().ok_or("--days needs a number")?;
                a.days = Some(v.parse().map_err(|_| "--days needs a number")?);
            }
            "--all" => a.days = None,
            "--out" | "-o" => a.out = PathBuf::from(it.next().ok_or("--out needs a file path")?),
            "--root" => a.root = Some(PathBuf::from(it.next().ok_or("--root needs a folder")?)),
            "--hide-titles" => a.hide_titles = true,
            "-h" | "--help" => {
                println!("{}", help());
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(a)
}

/// Windows gives a new process every inheritable handle its parent has. steer's own
/// stdin/stdout/stderr are often pipes that Claude Code or a terminal reads from, so a
/// background `steer flush` or watcher would hold them open and whoever started steer
/// would wait until that background process exits. Marking them non-inheritable stops
/// that; child processes still get the stdio each Command asks for.
#[cfg(windows)]
fn stop_handle_inheritance() {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(which: u32) -> *mut std::ffi::c_void;
        fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
    }
    const HANDLE_FLAG_INHERIT: u32 = 1;
    // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE
    for which in [-10i32, -11, -12] {
        // SAFETY: plain Win32 calls on this process's own standard handles.
        unsafe {
            let handle = GetStdHandle(which as u32);
            if !handle.is_null() && handle as isize != -1 {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

fn main() {
    #[cfg(windows)]
    stop_handle_inheritance();
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    // Chrome starts steer with the extension's origin when the extension talks to it.
    if native::started_by_browser(&argv) {
        std::process::exit(native::run());
    }
    match argv.first().map(String::as_str) {
        None => std::process::exit(manage::bare()),
        Some("hook") => return live::hook(&argv[1..]),
        Some("install") => std::process::exit(manage::finish(manage::install(&argv))),
        Some("checkin") => std::process::exit(manage::finish(checkin::command(&argv))),
        Some("update") => std::process::exit(manage::finish(manage::update_command())),
        Some("doctor") => std::process::exit(manage::doctor()),
        Some("uninstall") => std::process::exit(manage::finish(manage::uninstall(&argv))),
        Some("version" | "--version" | "-V") => return println!("steer {}", manage::VERSION),
        Some("help" | "--help" | "-h") => return println!("{}", help()),
        Some("signup" | "login" | "setup" | "status" | "flush" | "submit") => std::process::exit(live::command(&argv)),
        Some("watch") => {
            if argv.iter().any(|a| a == "--dry-run") {
                let days = argv.iter().position(|a| a == "--days").and_then(|i| argv.get(i + 1)).and_then(|d| d.parse().ok()).unwrap_or(30);
                println!("{}", watch::dry_run(days));
                return;
            }
            std::process::exit(watch::run());
        }
        Some("report") => {
            argv.remove(0);
        }
        _ => {}
    }
    report(&argv);
}

fn report(argv: &[String]) {
    let args = parse_args(argv).unwrap_or_else(|e| {
        eprintln!("steer: {e}\n\n{}", help());
        std::process::exit(2);
    });
    let root = args.root.clone().or_else(claude::default_root).unwrap_or_else(|| {
        eprintln!("steer: couldn't find your home folder");
        std::process::exit(1);
    });
    let files = claude::find_session_files(&root);
    if files.is_empty() {
        eprintln!("steer: no Claude Code sessions found in {}", root.display());
        std::process::exit(1);
    }

    let cutoff = args.days.map(|d| Utc::now() - chrono::Duration::days(d));
    let mut commit_cache: BTreeMap<PathBuf, Vec<DateTime<Utc>>> = BTreeMap::new();
    let mut by_name: BTreeMap<String, report::Project> = BTreeMap::new();

    // Resumed or forked sessions copy old entries into a new file. Go through sessions
    // oldest first and keep each entry only the first time it shows up, so the same
    // time isn't counted twice.
    let mut sessions: Vec<model::Session> = files.iter().filter_map(|f| claude::parse_session(f)).collect();
    sessions.sort_by_key(|s| s.events.first().map(|e| e.t));
    let mut seen = std::collections::HashSet::new();

    for mut session in sessions {
        session.events.retain(|e| e.id.map_or(true, |id| seen.insert(id)));
        let Some(last) = session.events.last().map(|e| e.t) else { continue };
        if cutoff.is_some_and(|c| last < c) {
            continue;
        }
        let (name, repo) = git::project_for(session.cwd.as_deref());
        let commits = match &repo {
            Some(r) => commit_cache.entry(r.clone()).or_insert_with(|| git::my_commits(r)).as_slice(),
            None => &[],
        };
        let rep = analyze::analyze(&session, commits);
        if rep.turns.is_empty() {
            continue;
        }
        // One project per key, named the way it was most recently (sessions go oldest first).
        let project = by_name.entry(report::project_key(&name)).or_insert_with(|| report::Project::new(name.clone()));
        project.name = name;
        project.sessions.push(rep);
    }

    let mut projects: Vec<report::Project> = by_name.into_values().collect();
    analyze::count_overlap_once(projects.iter_mut().flat_map(|p| p.sessions.iter_mut()).flat_map(|s| s.turns.iter_mut()));
    for p in &mut projects {
        p.sessions.sort_by_key(|s| std::cmp::Reverse(s.start));
    }
    projects.sort_by_key(|p| std::cmp::Reverse(p.human_secs()));

    let window = match args.days {
        Some(1) => "last day".to_string(),
        Some(d) => format!("last {d} days"),
        None => "all time".to_string(),
    };
    let html = report::render(&projects, &report::Options { window: window.clone(), hide_titles: args.hide_titles });
    if let Err(e) = std::fs::write(&args.out, html) {
        eprintln!("steer: couldn't write {}: {e}", args.out.display());
        std::process::exit(1);
    }

    let human: i64 = projects.iter().map(report::Project::human_secs).sum();
    let agent: i64 = projects.iter().map(report::Project::agent_secs).sum();
    let flagged: i64 = projects.iter().map(report::Project::flagged_secs).sum();
    let overlap: i64 = projects.iter().map(report::Project::overlap_secs).sum();
    let sessions: usize = projects.iter().map(|p| p.sessions.len()).sum();
    println!("{sessions} sessions in {} projects, {window}", projects.len());
    println!("  your time            {}", report::fmt_dur(human));
    println!("  agent time           {}", report::fmt_dur(agent));
    println!("  1/3 rule             {}", report::fmt_dur(agent / 3));
    println!("  dark flow (ignored)  {}", report::fmt_dur(flagged));
    println!("  overlap (once)       {}", report::fmt_dur(overlap));
    let shown = std::fs::canonicalize(&args.out).unwrap_or(args.out);
    println!("report: {}", shown.display());
}
