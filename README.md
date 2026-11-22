# steer

[![steered with ai](https://steer.duck.hackclub.app/badge/duck/ai_tracker.svg)](https://steer.duck.hackclub.app/u/duck/ai_tracker)

steer tracks the time you spend working with ai coding agents. the time the agent runs by itself doesnt count, only what you do around it, like writing prompts, reading what it did, testing and fixing stuff. made for hack club's ai time tracking bounty.

works with claude code, codex, opencode, copilot (vs code and cli), cursor and freebuff, also when t3 code runs claude code or codex for you.

## install

mac and linux:

```bash
curl -fsSL https://steer.duck.hackclub.app/install.sh | sh
```

windows (powershell):

```powershell
irm https://steer.duck.hackclub.app/install.ps1 | iex
```

it tells you what it found and what it's going to change, and asks first. then you sign in with your hack club account and it hooks into your tools. your page is at `https://steer.duck.hackclub.app/u/NAME` and updates while you work.

you can also download steer from the [releases page](https://github.com/EwoudVV/steer/releases) and run it. the first time, it does the same setup.

to undo everything:

```bash
steer uninstall
```

## how it works

- claude code and cursor run `steer hook` on every prompt, tool call and when the agent finishes
- t3 code runs claude code and codex for you, and it also sends them what your agents write to each other: a task one agent hands another, a message from another thread, a scheduled task. their logs show all of that as you typing. so for prompts from t3 code, steer looks in t3's own database on your computer (`~/.t3/userdata/statev2.sqlite`, opened read-only) and only counts the ones you wrote
- codex, opencode, copilot and freebuff dont have hooks like that, so a small background watcher (`steer watch`) reads their session logs every 5 seconds. it uses about 0.2% cpu
- the watcher also looks at the git repos you used an ai tool in during the last hour, every 30 seconds, to see when you change code or commit yourself. that counts the time you spend coding and testing by hand between prompts, within 30 minutes of using an ai tool. a change only counts if the agent wasn't editing right then, and saving a file without changing it or undoing back to how it was doesnt count. it only lists files with git and compares them itself, so nothing in a repo's own git settings can run
- events go into a queue in `~/.steer` and get sent to the server in the background, so your tools never wait on the network
- the server stamps each event when it arrives. anything more than 5 minutes off doesnt count, so you cant make up old sessions later

## privacy

prompt text never leaves your computer. steer reads it to work out a few counts and then drops it. this is everything a prompt event sends:

`id, session, project, via (which tool), time, words, chars, images, specific, observation, generic, repeat`

when you change code or commit in a repo you used ai in, the watcher sends one of these. file names and code never leave your computer:

`save: id, project, time, count (how many files changed)`
`commit: id, project, time, hash`

each batch of events also says what time your computer thinks it is, so if your clock is off the server can fix the times instead of dropping them.

for prompts from t3 code, steer reads two things from t3's database: which thread the session belongs to, and that thread's last 20 messages, to find the prompt and see who wrote it. none of it is kept or sent.

project is the name of the git repo or folder you were in (your home folder shows up as "home"). your page is public.

## how time is counted

the bottom of every report explains it, and the code is in `src/analyze.rs` (and `web/steer.js` for the website and server, which gives the same numbers). short version: the gap between the agent finishing and your next prompt counts, with caps, and loops of "continue" / "fix it" without testing dont count.

## other commands

```bash
steer                              # sets it all up the first time, after that shows the status
steer doctor                       # checks everything and says how to fix what's broken
steer update                       # gets the newest version now
steer uninstall                    # takes steer out of your tools and deletes ~/.steer
steer checkin on                   # help make the counting more accurate, see below
steer submit                       # freeze this project's hours into a page for reviewers
steer watch --dry-run --days 30    # what the watcher would send, as counts only
steer report --days 30             # html report from your old claude code logs
```

## submitting a project

when you ship a project, run this in its folder:

```bash
steer submit
```

it freezes the project's hours into a review page with its own link, and prints a line to paste into the hours field when you submit. the page has the hours, a written justification, checks, every day and every session, and your commits linked on github, so a reviewer can check the hours without asking you anything. it never changes after that, even if you keep working. `--from 2026-11-01 --to 2026-11-21` limits it to those days.

## readme badge

each project's page on steer has a badge for your README that shows how long you've steered it, and updates by itself:

```markdown
[![steered with ai](https://steer.duck.hackclub.app/badge/NAME/PROJECT.svg)](https://steer.duck.hackclub.app/u/NAME/PROJECT)
```

## check-ins (optional, off by default)

```bash
steer checkin on
```

while you use an ai tool, steer asks "what are you doing right now?" once at a random moment every 20 minutes, with three buttons: something else, my project on my own, my project with the ai. if you're away it closes by itself after 90 seconds. each answer sends only which button you picked and when, and never counts as time. the answers from everyone who turns this on are used to set how steer counts the time between prompts, instead of guessing. `steer checkin off` stops it.

## updates

the watcher checks github for a new version once a day and swaps it in by itself. that check only asks github which version is newest, nothing about you gets sent. to turn it off, make a file at `~/.steer/no-update` (or set `STEER_NO_UPDATE`) and run `steer update` when you want to.

the website also has a drop-a-folder version of the report that runs in your browser.

## hosting cost

zrl's limit is $500 a month at hackatime's size: 15,488 people a month logging 109,759 hours. `tools/load/loadtest.mjs` runs the real server and sends it events the way the client does, so this can be checked again anytime.

counting every one of those hours as ai time, with 3 times as much agent time around it, at 300 events an hour (real steer users send 150 to 500), that's about 100 million events a month. the busiest hour would be about 150 events a second, or around 1,900 people at once.

| | people at once | events a second | cpu | memory |
|---|---|---|---|---|
| tested | 800 | 65 | 6% of one core | 81 MB |
| tested | 8,000 | 650 | 20% of one core | 122 MB |
| tested, each with a month of history | 50 | 4 | | 115 MB |

that was on a laptop, a cheap server core is maybe 2 to 3 times slower. each event takes about 190 bytes on disk, so about 19 GB a month, and it gzips about 12 times smaller.

so one server with 4 cores, 8 GB of memory and a 250 GB disk is plenty. after hetzner's 2026 price increase that's somewhere around €20 to €75 a month depending on where it is, so with backups it stays under $100 a month, at least 5 times under the limit.

## running your own server

```bash
PORT=8790 STEER_DATA=./data node server/server.mjs
```

then `steer signup NAME --server https://your.server`.

behind a proxy that isn't on the same machine, set `TRUSTED_PROXIES` to its address so the per ip limits see the real visitor and not the proxy.

## license

AGPL-3.0-or-later, see LICENSE
