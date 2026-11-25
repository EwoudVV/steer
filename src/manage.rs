//! Installing, updating, checking and removing steer: plain `steer`, `steer install`,
//! `steer update`, `steer doctor` and `steer uninstall`.

use crate::live::{self, dir, load_config};
use crate::watch;
use serde_json::json;
use std::fs;
use std::io::{IsTerminal, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const PRIVACY: &str = "https://github.com/EwoudVV/steer#privacy";
const DAY: u64 = 24 * 60 * 60;

fn has(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

/// Asks a yes/no question. Just pressing enter, or having no terminal to answer from,
/// picks `default`.
fn ask(question: &str, default: bool) -> bool {
    print!("{question} {} ", if default { "[Y/n]" } else { "[y/N]" });
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).unwrap_or(0) == 0 {
        println!();
        return default;
    }
    match line.trim().to_lowercase().as_str() {
        "" => default,
        answer => answer.starts_with('y'),
    }
}

/// The tools steer tracks, and whether each one looks installed on this computer.
fn tools() -> Vec<(&'static str, bool)> {
    let home = live::home();
    let env_or = |var: &str, fallback: PathBuf| std::env::var_os(var).map(PathBuf::from).unwrap_or(fallback);
    let data = env_or("XDG_DATA_HOME", home.join(".local").join("share"));
    vec![
        ("claude code", home.join(".claude").exists()),
        ("codex", env_or("CODEX_HOME", home.join(".codex")).exists()),
        ("opencode", data.join("opencode").exists()),
        ("copilot", env_or("COPILOT_HOME", home.join(".copilot")).exists()),
        ("cursor", live::cursor_dir().exists()),
        ("freebuff", crate::freebuff::root().join("projects").exists()),
    ]
}

/// A path with the home folder shown as ~, so it's short and doesn't show the person's name.
fn short(path: &std::path::Path) -> String {
    match path.strip_prefix(live::home()) {
        Ok(rest) if !live::home().as_os_str().is_empty() => format!("~{}{}", std::path::MAIN_SEPARATOR, rest.display()),
        _ => path.display().to_string(),
    }
}

/// What to type to run steer: just `steer` if it's on the PATH, else the full path.
fn steer_cmd() -> String {
    let bin = live::bin_path();
    let found = std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|d| {
            let candidate = d.join(bin.file_name().unwrap());
            candidate.exists() && fs::canonicalize(&candidate).ok() == fs::canonicalize(&bin).ok()
        })
    });
    if found {
        "steer".into()
    } else {
        bin.display().to_string()
    }
}

// ---------- plain `steer` and `steer install` ----------

/// `steer` with nothing after it: sets everything up the first time, after that it
/// shows the status.
pub fn bare() -> i32 {
    let set_up = load_config().is_some() && live::hooks_installed(&live::claude_settings());
    if set_up {
        println!("steer {VERSION}\n{}\n\nmore commands: {} help", live::status(), steer_cmd());
        return 0;
    }
    let code = finish(install(&[]));
    // Double clicking steer.exe opens a window that closes as soon as it's done.
    if cfg!(windows) && std::io::stdin().is_terminal() {
        print!("\npress enter to close");
        let _ = std::io::stdout().flush();
        let _ = std::io::stdin().read_line(&mut String::new());
    }
    code
}

/// Prints the result of a command and turns it into an exit code.
pub fn finish(result: Result<String, String>) -> i32 {
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

/// `steer install`: says what steer does and what it's about to change, asks, then
/// copies itself to ~/.steer/bin, signs in, hooks into the tools and starts the watcher.
pub fn install(args: &[String]) -> Result<String, String> {
    let yes = has(args, "--yes") || has(args, "-y");
    let watch = !has(args, "--no-watch");
    let found = tools();
    let have: Vec<&str> = found.iter().filter(|t| t.1).map(|t| t.0).collect();
    let missing: Vec<&str> = found.iter().filter(|t| !t.1).map(|t| t.0).collect();
    let signed_in = load_config().is_some();
    let cursor = live::cursor_dir().exists();
    let path = path_change();

    println!("steer {VERSION} tracks the time you spend working with ai agents. the agent running by itself doesn't count, only what you do around it.");
    println!("prompt text never leaves this computer, only counts like how many words it had. everything it sends is listed at {PRIVACY}");
    println!();
    if have.is_empty() {
        println!("didn't find any ai tools it knows on this computer yet");
    } else {
        println!("found: {}", have.join(", "));
    }
    if !missing.is_empty() {
        println!("not found: {}", missing.join(", "));
    }
    println!();
    println!("this will:");
    println!("  - put steer in {}", short(live::bin_path().parent().unwrap()));
    if !signed_in {
        println!("  - sign you in with your hack club account in the browser");
    }
    println!(
        "  - add steer hooks to {} (a backup of your settings is kept)",
        if cursor { "claude code and cursor" } else { "claude code" }
    );
    if watch {
        println!("  - run a small background watcher that starts at login. it reads codex, opencode, copilot and freebuff logs, and notices when you change code or commit in repos you use ai in (only counts get sent, never file names or code)");
        let editors: Vec<&str> = crate::editor::status().into_iter().map(|(name, _)| name).collect();
        if !editors.is_empty() {
            println!(
                "  - add a small steer extension to {}. it notes when you're typing, clicking or scrolling in a project's files or have the editor in front, and for projects you use ai in, steer sends the project and the times (never file names or code)",
                editors.join(" and ")
            );
        }
    }
    if let Some(change) = &path {
        println!("  - {}", describe(change));
    }
    if auto_update_on() {
        println!("  - check github for a new version once a day (to turn that off, make a file at {})", short(&dir().join("no-update")));
    }
    if !yes && !ask("go ahead?", true) {
        return Ok("ok, nothing was changed".into());
    }
    println!();

    let bin = live::install_bin()?;
    live::clean_old_bins();
    mark_update_check();
    println!("put steer in {}", short(&bin));
    if !signed_in {
        println!("signing in...");
        println!("{}", live::login(&["login".into()])?);
    }
    println!("{}", live::setup_all(false, watch)?);
    // Not being able to type just `steer` isn't worth failing the install over.
    let path_added = match path.as_ref().map(apply) {
        Some(Ok(msg)) => {
            println!("{msg}");
            true
        }
        Some(Err(e)) => {
            println!("{e}");
            false
        }
        None => false,
    };

    // Check-in answers are how steer's counting gets checked against what people were
    // really doing, so install asks. Only when someone's at the keyboard to answer.
    if !yes && watch && !crate::checkin::on() && crate::checkin::can_ask() {
        println!();
        println!(
            "one more thing: want to help check that steer's numbers are right? while you use an ai tool, it asks \"what are you doing right now?\" once every {} minutes, with 3 buttons. it closes by itself after 90 seconds if you're away, and answers never count as time. you can stop it anytime with: steer checkin off",
            crate::checkin::every_minutes()
        );
        if ask("turn on check-ins?", true) {
            match crate::checkin::command(&["checkin".into(), "on".into()]) {
                Ok(_) => println!("check-ins are on, thanks!"),
                Err(e) => println!("{e}"),
            }
        }
        // Asked here, so the watcher won't ask again.
        crate::checkin::mark_offered();
    }

    let config = load_config().ok_or("not signed in")?;
    let mut out = String::from("\ndone!");
    if let Some(name) = &config.name {
        let page = format!("{}/u/{name}", config.server.trim_end_matches('/'));
        out += &format!(" your page: {page}\nit updates while you work.");
        live::open_browser(&page);
    }
    if !cursor {
        out += "\nif you get cursor later, run steer setup again so it gets hooked up too.";
    }
    let cmd = if path_added { "steer".into() } else { steer_cmd() };
    out += &format!("\ncheck on it anytime with: {cmd} status{}", if path_added { " (in a new terminal)" } else { "" });
    Ok(out)
}

// ---------- so you can just type `steer` ----------

const MARK: &str = "# added by steer, steer uninstall takes it out";

/// How install makes `steer` work from any terminal.
enum PathChange {
    /// ~/.local/bin is already on the PATH, so a link there is enough.
    Link(PathBuf),
    /// A line in the shell's startup file (or a file of its own for fish).
    StartupFile(PathBuf),
    /// The user PATH on Windows.
    Windows,
}

fn on_path(dir: &std::path::Path) -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d == dir))
}

/// Startup files steer might have added a line to.
fn startup_files() -> Vec<PathBuf> {
    let home = live::home();
    let zdot = std::env::var_os("ZDOTDIR").map(PathBuf::from).unwrap_or_else(|| home.clone());
    vec![zdot.join(".zshrc"), home.join(".bashrc"), home.join(".bash_profile")]
}

fn fish_file() -> PathBuf {
    live::home().join(".config").join("fish").join("conf.d").join("steer.fish")
}

/// None if `steer` already works, or if there's no way this knows to make it work.
fn path_change() -> Option<PathChange> {
    if steer_cmd() == "steer" || (std::env::var_os("STEER_SANDBOX").is_some() && cfg!(windows)) {
        return None;
    }
    if cfg!(windows) {
        return Some(PathChange::Windows);
    }
    let home = live::home();
    let local = home.join(".local").join("bin");
    if on_path(&local) {
        return Some(PathChange::Link(local.join("steer")));
    }
    let shell = std::env::var("SHELL").unwrap_or_default();
    let file = match shell.rsplit('/').next().unwrap_or_default() {
        "zsh" => startup_files().swap_remove(0),
        "bash" if cfg!(target_os = "macos") => home.join(".bash_profile"),
        "bash" => home.join(".bashrc"),
        "fish" => fish_file(),
        _ => return None,
    };
    let already = fs::read_to_string(&file).is_ok_and(|s| s.contains(MARK));
    (!already).then_some(PathChange::StartupFile(file))
}

fn describe(change: &PathChange) -> String {
    match change {
        PathChange::Link(link) => format!("put a link to steer in {} so you can just type steer", short(link.parent().unwrap())),
        PathChange::StartupFile(file) => format!("add {} to your PATH in {} so you can just type steer", short(live::bin_path().parent().unwrap()), short(file)),
        PathChange::Windows => format!("add {} to your PATH so you can just type steer", short(live::bin_path().parent().unwrap())),
    }
}

fn apply(change: &PathChange) -> Result<String, String> {
    let bin_dir = live::bin_path().parent().unwrap().to_path_buf();
    match change {
        PathChange::Link(link) => {
            #[cfg(unix)]
            std::os::unix::fs::symlink(live::bin_path(), link).map_err(|e| format!("couldn't link {}: {e}", link.display()))?;
            Ok(format!("linked steer into {}", link.parent().unwrap().display()))
        }
        PathChange::StartupFile(file) => {
            let line = if file.extension().is_some_and(|e| e == "fish") {
                format!("{MARK}\nset -gx PATH \"{}\" $PATH\n", bin_dir.display())
            } else {
                format!("\n{MARK}\nexport PATH=\"{}:$PATH\"\n", bin_dir.display())
            };
            fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut f = fs::OpenOptions::new().create(true).append(true).open(file).map_err(|e| e.to_string())?;
            f.write_all(line.as_bytes()).map_err(|e| format!("couldn't add steer to {}: {e}", file.display()))?;
            Ok(format!("added steer to your PATH in {}, it works in new terminals", file.display()))
        }
        PathChange::Windows => {
            let b = bin_dir.display().to_string().replace('\'', "''");
            powershell(&format!(
                "$b='{b}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); \
                 if (-not (($p -split ';') -contains $b)) {{ [Environment]::SetEnvironmentVariable('Path', ((@($p, $b) | Where-Object {{ $_ }}) -join ';'), 'User') }}"
            ))?;
            Ok("added steer to your PATH, it works in new terminals".into())
        }
    }
}

fn powershell(script: &str) -> Result<String, String> {
    let out = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("couldn't run powershell: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Undoes whatever `apply` did, for uninstall.
fn undo_path() -> Vec<String> {
    let mut done = Vec::new();
    let bin_dir = live::bin_path().parent().unwrap().to_path_buf();
    if cfg!(windows) {
        if std::env::var_os("STEER_SANDBOX").is_none() {
            let b = bin_dir.display().to_string().replace('\'', "''");
            let script = format!(
                "$b='{b}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); \
                 if ($p) {{ $n=(($p -split ';') | Where-Object {{ $_ -and $_ -ne $b }}) -join ';'; \
                 if ($n -ne $p) {{ [Environment]::SetEnvironmentVariable('Path',$n,'User'); 'took steer out of your PATH' }} }}"
            );
            done.extend(powershell(&script).ok().filter(|m| !m.is_empty()));
        }
        return done;
    }
    let link = live::home().join(".local").join("bin").join("steer");
    if fs::read_link(&link).is_ok_and(|t| t == live::bin_path()) && fs::remove_file(&link).is_ok() {
        done.push(format!("removed the link in {}", link.parent().unwrap().display()));
    }
    if fish_file().exists() && fs::remove_file(fish_file()).is_ok() {
        done.push(format!("deleted {}", fish_file().display()));
    }
    for file in startup_files() {
        let Ok(text) = fs::read_to_string(&file) else { continue };
        if !text.contains(MARK) {
            continue;
        }
        // Take out the marker line, the PATH line after it, and the blank line before it.
        let lines: Vec<&str> = text.lines().collect();
        let mut kept: Vec<&str> = Vec::new();
        let mut i = 0;
        while i < lines.len() {
            if lines[i] == MARK {
                if kept.last() == Some(&"") {
                    kept.pop();
                }
                i += if lines.get(i + 1).is_some_and(|l| l.contains(&bin_dir.display().to_string())) { 2 } else { 1 };
                continue;
            }
            kept.push(lines[i]);
            i += 1;
        }
        let mut out = kept.join("\n");
        if text.ends_with('\n') && !out.is_empty() {
            out.push('\n');
        }
        if fs::write(&file, out).is_ok() {
            done.push(format!("took steer out of {}", file.display()));
        }
    }
    done
}

// ---------- updates ----------

fn releases() -> String {
    std::env::var("STEER_RELEASES").unwrap_or_else(|_| "https://github.com/EwoudVV/steer/releases".into())
}

/// The file name of this system's build on the GitHub release.
fn asset() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "steer-macos-arm64",
        ("macos", "x86_64") => "steer-macos-x64",
        ("linux", "x86_64") => "steer-linux-x64",
        ("linux", "aarch64") => "steer-linux-arm64",
        ("windows", "x86_64") => "steer-windows-x64.exe",
        _ => return None,
    })
}

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.trim().trim_start_matches('v').split('.').map(|p| p.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

fn newer_than_this(version: &str) -> bool {
    parse_version(version) > parse_version(VERSION)
}

/// Asks GitHub for the newest release. github.com/.../releases/latest redirects to the
/// newest tag, so only that redirect is read and nothing else gets downloaded.
fn latest_version() -> Result<String, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).redirects(0).build();
    let url = format!("{}/latest", releases());
    let resp = match agent.get(&url).call() {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("couldn't reach {url}: {e}")),
    };
    let location = resp.header("location").ok_or("github didn't say what the newest version is")?;
    let tag = location.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
    parse_version(tag)
        .map(|_| tag.trim_start_matches('v').to_owned())
        .ok_or_else(|| format!("couldn't read a version from {location}"))
}

/// Downloads `version` and swaps it into ~/.steer/bin. If the download looks wrong or
/// doesn't start, the current steer is left alone.
fn install_version(version: &str) -> Result<(), String> {
    let asset = asset().ok_or("there's no build of steer for this system")?;
    let url = format!("{}/download/v{version}/{asset}", releases());
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(120)).build();
    let resp = agent.get(&url).call().map_err(|e| format!("couldn't download {url}: {e}"))?;
    let mut bytes = Vec::new();
    resp.into_reader().take(64 << 20).read_to_end(&mut bytes).map_err(|e| format!("download broke off: {e}"))?;
    if bytes.len() < 200_000 {
        return Err(format!("the file at {url} is too small to be steer"));
    }

    let target = live::bin_path();
    let bin = target.parent().unwrap();
    fs::create_dir_all(bin).map_err(|e| e.to_string())?;
    let fresh = bin.join(format!("steer-new-{}{}", std::process::id(), std::env::consts::EXE_SUFFIX));
    fs::write(&fresh, &bytes).map_err(|e| format!("couldn't save the new version: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&fresh, fs::Permissions::from_mode(0o755));
    }
    let runs = Command::new(&fresh)
        .arg("version")
        .stdin(Stdio::null())
        .output()
        .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).starts_with("steer "));
    if !runs {
        let _ = fs::remove_file(&fresh);
        return Err("the new version didn't start, so it wasn't installed".into());
    }
    live::swap_in(&fresh, &target)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn mark_update_check() {
    let _ = fs::create_dir_all(dir());
    let _ = fs::write(dir().join("update-check"), now_secs().to_string());
}

pub(crate) fn auto_update_on() -> bool {
    std::env::var_os("STEER_NO_UPDATE").is_none() && !dir().join("no-update").exists()
}

/// True once a day, unless daily updates are turned off.
pub(crate) fn update_due() -> bool {
    auto_update_on()
        && fs::read_to_string(dir().join("update-check"))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .is_none_or(|last| now_secs().saturating_sub(last) >= DAY)
}

/// Installs the newest version if there's a newer one. Returns it if it did.
pub(crate) fn update() -> Result<Option<String>, String> {
    mark_update_check();
    live::clean_old_bins();
    let latest = latest_version()?;
    if !newer_than_this(&latest) {
        return Ok(None);
    }
    install_version(&latest)?;
    Ok(Some(latest))
}

pub fn update_command() -> Result<String, String> {
    match update()? {
        None => Ok(format!("steer {VERSION} is the newest version")),
        Some(v) => {
            watch::restart();
            Ok(format!("updated steer from {VERSION} to {v}"))
        }
    }
}

// ---------- steer doctor ----------

enum Check {
    Ok(String),
    Fix(String),
    Info(String),
}

/// Checks everything and says how to fix what's broken. Exits 1 if anything is.
pub fn doctor() -> i32 {
    let mut checks = vec![Check::Info(format!(
        "steer {VERSION} ({})",
        std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
    ))];
    let bin = live::bin_path();
    checks.push(if bin.exists() {
        Check::Ok(format!("installed in {}", bin.parent().unwrap().display()))
    } else {
        Check::Fix(format!("steer isn't in {}, run steer install", bin.parent().unwrap().display()))
    });

    match load_config() {
        None => checks.push(Check::Fix("not signed in, run steer login".into())),
        Some(c) => {
            let who = c.name.clone().unwrap_or_else(|| "(signed in with a key)".into());
            checks.push(match live::post(&c.server, "/api/events", Some(&c.key), &json!({ "events": [] })) {
                Ok(_) => Check::Ok(format!("signed in as {who} on {}", c.server)),
                Err(e) if e.contains(" 401") => Check::Fix(format!("{} doesn't know your key anymore, run steer login", c.server)),
                Err(e) => Check::Fix(format!("can't reach the server: {e}")),
            });
        }
    }

    let claude = live::home().join(".claude").exists();
    let claude_on = live::hooks_installed(&live::claude_settings());
    let claude_version = crate::claude::newest_version(&live::home().join(".claude").join("projects"))
        .map(|(a, b, c)| format!(" (claude code {a}.{b}.{c})"))
        .unwrap_or_default();
    checks.push(match (claude, claude_on) {
        (_, true) => Check::Ok(format!("claude code hooks are on{claude_version}")),
        (true, false) if live::some_hooks_installed(&live::claude_settings()) => {
            Check::Fix(format!("some claude code hooks are missing{claude_version}, run steer setup (the watcher adds them by itself after an update)"))
        }
        (true, false) => Check::Fix(format!("claude code hooks are off{claude_version}, run steer setup")),
        (false, false) => Check::Info("claude code isn't installed".into()),
    });
    checks.push(match (live::cursor_dir().exists(), live::cursor_hooks_installed()) {
        (_, true) => Check::Ok("cursor hooks are on".into()),
        (true, false) => Check::Fix("cursor hooks are off, run steer setup".into()),
        (false, false) => Check::Info("cursor isn't installed".into()),
    });
    checks.push(if watch::running() {
        Check::Ok("the watcher (codex, opencode, copilot, freebuff, saves and commits) is running".into())
    } else {
        Check::Fix("the watcher (codex, opencode, copilot, freebuff, saves and commits) isn't running, run steer setup".into())
    });
    for (editor, on) in crate::editor::status() {
        checks.push(if on {
            Check::Ok(format!("the {editor} extension is on"))
        } else {
            Check::Fix(format!("the {editor} extension isn't in {editor}, run steer setup"))
        });
    }
    checks.push(match crate::idle::seconds() {
        Some(_) => Check::Ok("can tell when you're away from the computer (idle time)".into()),
        None if cfg!(target_os = "linux") => {
            Check::Info("can't tell when you're away from the computer here. on x11, install xprintidle (gnome works without it). steer counts as before without it".into())
        }
        None => Check::Info("can't tell when you're away from the computer here. steer counts as before without it".into()),
    });
    if let Some(note) = live::clock_note() {
        checks.push(Check::Info(note));
    }

    let waiting = live::queued();
    let last = live::last_sent().map(|t| format!(" (last sent {})", live::ago(t))).unwrap_or_default();
    checks.push(if waiting == 0 {
        Check::Ok(format!("nothing waiting to send{last}"))
    } else if load_config().is_none() {
        Check::Fix(format!("{waiting} events are waiting to send, they go out once you sign in"))
    } else {
        match live::flush() {
            Ok(0) => Check::Info(format!("{waiting} events waiting, they're being sent right now{last}")),
            Ok(n) => Check::Ok(format!("sent {n} waiting events just now")),
            Err(e) => Check::Fix(format!("{waiting} events are waiting and sending them failed: {e}")),
        }
    });

    let auto = if auto_update_on() { "checks daily" } else { "daily checks are off" };
    checks.push(match latest_version() {
        Ok(v) if newer_than_this(&v) => Check::Fix(format!("steer {v} is out, run steer update ({auto})")),
        Ok(_) => Check::Ok(format!("up to date ({auto})")),
        Err(e) => Check::Fix(format!("couldn't check for updates: {e}")),
    });

    let mut problems = 0;
    for c in &checks {
        match c {
            Check::Ok(m) => println!("ok   {m}"),
            Check::Info(m) => println!("     {m}"),
            Check::Fix(m) => {
                problems += 1;
                println!("fix  {m}");
            }
        }
    }
    println!();
    if problems == 0 {
        println!("everything looks good");
        0
    } else {
        println!("{problems} thing{} to fix", if problems == 1 { "" } else { "s" });
        1
    }
}

// ---------- steer uninstall ----------

/// Takes steer out of every tool and stops the watcher, then (if you say so) deletes
/// ~/.steer with the key and the binary in it.
pub fn uninstall(args: &[String]) -> Result<String, String> {
    let yes = has(args, "--yes") || has(args, "-y");
    let mut out = live::setup_all(true, true)?;
    for msg in undo_path() {
        out += &format!("\n{msg}");
    }
    let data = dir();
    if data.exists() {
        let question = format!("also delete {}? it has your sign in key and anything that wasn't sent yet", data.display());
        if yes || ask(&question, false) {
            delete_dir(&data)?;
            out += &format!("\ndeleted {}", data.display());
        } else {
            out += &format!("\nkept {}", data.display());
        }
    }
    out += "\nyour account and page are still on the server";
    Ok(out)
}

/// Windows can't delete the steer.exe that's running this, so there a separate
/// process waits a few seconds and deletes the folder after this one exits.
fn delete_dir(path: &std::path::Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(_) => {
            use std::os::windows::process::CommandExt;
            // Passed as one raw line: the normal argument quoting escapes the quotes
            // around the path with backslashes, which cmd.exe doesn't understand.
            Command::new("cmd")
                .raw_arg(format!("/C ping -n 4 127.0.0.1 >NUL & rmdir /S /Q \"{}\"", path.display()))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("couldn't delete {}: {e}", path.display()))
        }
        #[cfg(not(windows))]
        Err(e) => Err(format!("couldn't delete {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers() {
        assert_eq!(parse_version("v0.10.2"), Some((0, 10, 2)));
        assert!(parse_version("0.10.0") > parse_version("0.9.9"));
        assert_eq!(parse_version("latest"), None);
        assert!(!newer_than_this("nonsense"));
        assert!(newer_than_this("999.0.0"));
        assert!(!newer_than_this(VERSION));
    }

    #[test]
    fn every_release_target_has_a_file() {
        assert!(asset().is_some());
    }
}
