# steer

[![steered with ai](https://steer.duck.hackclub.app/badge/duck/ai_tracker.svg)](https://steer.duck.hackclub.app/u/duck/ai_tracker)

steer tracks the time you spend working with ai coding agents. the time the agent runs by itself doesnt count, only what you do around it, like writing prompts, reading what it did, testing and fixing stuff. made for hack club's ai time tracking bounty.

works with claude code, codex, opencode, copilot (vs code and cli), cursor and freebuff, and with the browser extension, chatgpt and claude on the web.

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
- codex, opencode, copilot and freebuff dont have hooks like that, so a small background watcher (`steer watch`) reads their session logs every 5 seconds. it uses about 0.2% cpu
- the watcher also looks at the git repos you used an ai tool in during the last hour, every 30 seconds, to see when you change code or commit yourself. that counts the time you spend coding and testing by hand between prompts, within 30 minutes of using an ai tool. a change only counts if the agent wasn't editing right then, and saving a file without changing it or undoing back to how it was doesnt count. it only lists files with git and compares them itself, so nothing in a repo's own git settings can run
- for chatgpt and claude on the web there's a browser extension. it sees when you send a message and when the answer is done, works out the prompt's counts right there in the browser, and gives only the counts to steer on your computer
- in vs code and cursor, `steer setup` adds a small extension that notes when you type, click or scroll in a project's files while the editor is in front. an agent editing files doesnt count, since that happens without any typing or clicking. since 0.5.9 it also notes how long the editor is in front with a project open, so reading the agents answer in its chat or the terminal can count, but only while no agent is working and youre at the computer. it writes the folder and the times to `~/.steer`, and the watcher sends just the project and the times, for projects you used an ai tool in around then. steer updates the extension by itself when theres a new one
- events go into a queue in `~/.steer` and get sent to the server in the background, so your tools never wait on the network
- the server stamps each event when it arrives. anything more than 5 minutes off doesnt count, so you cant make up old sessions later

## chatgpt and claude in the browser

the extension isnt on the chrome web store yet, so for now:

1. run `steer update` and then `steer setup`, which lets chrome start steer
2. download this repo, go to `chrome://extensions`, turn on developer mode, click "load unpacked" and pick the `extension` folder
3. click the steer icon to pick which project your chats count toward. if you dont pick one, they go to the repo you last used an ai tool in

it works in chrome, edge, brave, arc, vivaldi and chromium. while the answer is being written nothing counts, same as an agent running. reading it and writing your next message does.

## privacy

prompt text never leaves your computer. steer reads it to work out a few counts and then drops it. this is everything a prompt event sends:

`id, session, project, via (which tool), time, words, chars, images, specific, observation, generic, repeat`

when you change code or commit in a repo you used ai in, the watcher sends one of these. file names and code never leave your computer:

`save: id, project, time, count (how many files changed)`
`commit: id, project, time, hash`

chats in the browser send the same counts as a prompt, with via `chatgpt` or `claude-ai`. the extension only runs on chatgpt.com and claude.ai, and the only thing it asks chrome for is talking to steer on your computer.

steer also collects a few signs of what you're doing, so it can count your time from what you actually do instead of guessing from gaps. they don't count toward anything yet:

`wait: id, session, project, time, reason`: claude code showed you a permission prompt (only that it did, nothing about the tool or the command)
`focus: id, session, project, time, on`: a chatgpt or claude tab came to the front, or stopped being there
`copy / typing: id, session, project, time`: you copied something out of a chatgpt or claude tab, or started typing your next message there (never the text)
`away / back / here: id, time, away_secs`: from your computer's idle timer, only within an hour of using an ai tool. away when nobody touched the keyboard or mouse for 2 minutes, back when someone does again (with how long they were gone), and here every 5 minutes while someone's there. the idle timer is one number of seconds, with no app names and nothing about what you typed
`editor: id, project, time, secs, app`: from the vs code and cursor extension, how long you were typing, clicking or scrolling in a project's files, and which editor. only for projects you used an ai tool in within 2 hours of it, never file names, code or what you typed

prompts also say which permission mode claude code or codex was in (like default or never), and tool events say how long the tool ran.

each batch of events also says what time your computer thinks it is, so if your clock is off the server can fix the times instead of dropping them.

project is the name of the git repo or folder you were in (your home folder shows up as "home"). names that only differ in capitals, spaces, dashes or underscores are one project, so "Vault Books" on one computer and a clone called "vault-books" on another add up together. your page is public.

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

when you ship a project, sign in at [steer.duck.hackclub.app/me](https://steer.duck.hackclub.app/me) with your hack club account and hit submit next to it. or run this in its folder:

```bash
steer submit
```

either way it freezes the project's hours into a review page with its own link, and gives you a line to paste into the hours field when you submit. the page has the hours, a written justification, checks, every day and every session, and your commits linked on github, so a reviewer can check the hours without asking you anything. it never changes after that, even if you keep working. you can limit it to some days, on the website or with `--from 2026-11-01 --to 2026-11-21`.

the same page lists the review pages you made and what reviewers decided, and you can delete your account there.

## readme badge

each project's page on steer has a badge for your README that shows how long you've steered it, and updates by itself:

```markdown
[![steered with ai](https://steer.duck.hackclub.app/badge/NAME/PROJECT.svg)](https://steer.duck.hackclub.app/u/NAME/PROJECT)
```

## check-ins (optional, off by default)

```bash
steer checkin on
```

while you use an ai tool, steer asks "what are you doing right now?" once at a random moment every 20 minutes, with three buttons: something else, waiting on the ai, working on my project. if you're away it closes by itself after 90 seconds. each answer sends only which button you picked and when, and never counts as time. the answers from everyone who turns this on are used to set how steer counts the time between prompts, instead of guessing, and to check it: https://steer.duck.hackclub.app/accuracy compares steer, a flat 1/3, and hackatime's and wakatime's timeouts with what people answered. `steer checkin off` stops it.

`steer install` asks whether to turn this on. if you installed before it asked, steer asks once in a popup the next time you use an ai tool (at most 3 times a day apart if you don't click anything, and never again once you click either button).

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
