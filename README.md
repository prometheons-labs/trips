# Trips

A Claude Code mod for people who run many sessions at once.

Every chat is a trip. Trips gives you a docked pane that shows which trips wait on you, what each one asks, and where every other trip stands. It also keeps a small journal for you. The journal writes one line each time you switch tasks: what you got done, and what comes next. At the end of each day it writes a short close, and it sums up each week, month and year.

## What you get

- **The Trips pane.** It docks beside the transcript in the desktop app. Sessions that wait on you sit on the Platform at the top, with their ask. Below them runs the rail of the last 24 hours, newest first, with signal lamps, sidebar group colours, branch and PR chips. Older trips sit in the Sidings (1 to 7 days) and the Depot (over 7 days or archived), with search. Click a trip to open it.
- **The pill above the prompt.** A tram mark, the count of trips that wait on you, and an eye that opens the pane.
- **The journal card.** At the top of the pane: today's newest entries, each with the time, a short label, what was done and the next step. Timeline lists all of today. Journal opens a Day, Week, Month and Year browser.

## Requirements

- A Claude Code build with mods support (function hooks). It was built and tested on Claude Code 2.1.321.
- The pane and the pill draw in the Claude Code desktop app. A terminal session draws a plain text list.
- macOS for the pane's data. The pane reads the desktop app's session records under `~/Library/Application Support/Claude/`, which is a macOS path. The journal backfill reads the transcripts under `~/.claude/projects/`, which every platform has.
- `python3` on your `PATH`. The scanner and the journal store are small Python scripts that the mod runs.

## Install

From a shell:

```bash
claude plugin install trips --marketplace vanRaco/trips
```

At the prompt of a terminal session:

```
/plugin install trips --marketplace vanRaco/trips
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `vanRaco/trips`, then **Add plugin**. A mod installed from a terminal at the user scope loads in desktop sessions too.

## Set up the journal

The journal fills itself from now on, one entry per session each hour you work. To fill it for the days before you installed Trips, run setup once. Install and set up in one line:

```bash
claude plugin install trips --marketplace vanRaco/trips && claude -p "/trips setup 7d"
```

Pick the range that suits you:

| Range | What it does | Model calls, about |
|---|---|---|
| `1d` | Yesterday only | 2 |
| `7d` | The last 7 days | up to 14, plus 1 or 2 week summaries |
| `30d` | The last 30 days | up to 60, plus the week and month summaries that came due |
| `fresh` | Start from now, write no past entries | none |

Any `Nd` from `1d` to `30d` works. Setup never writes today: the hourly journal does that. It skips every day the journal already holds, so a rerun writes nothing new and makes no model calls. It prints a short summary: days written, quiet days, entries, model calls and fallbacks.

You can also type `/trips setup 7d` at the prompt of any session where Trips is loaded.

The Trips pane needs no setup. It reads the session records directly, back 30 days.

## Set it up with Claude

Paste this into a Claude Code terminal session:

```
Install the Claude Code mod "trips" from the GitHub marketplace vanRaco/trips
with `claude plugin install trips --marketplace vanRaco/trips` (user scope).
Then ask me which journal range I want: 1d, 7d, 30d or fresh. Tell me that
7d makes up to about 16 model calls on my own Claude login and fresh makes
none. Run `claude -p "/trips setup <my choice>"` and show me its summary.
```

## Privacy

Everything runs on your machine.

- **What it reads, read only.** The desktop app's session records and sidebar groups under `~/Library/Application Support/Claude/` (`claude-code-sessions/` and `claude_desktop_config.json`), and the transcripts under `~/.claude/projects/*/*.jsonl`. Trips never writes to any file of the app or to a transcript.
- **What it writes.** The journal folder (`~/.claude/trips-journal/` by default, see `journalDir` below), a scan cache in your temporary folder (`trips-scan-cache-v1.json`), and the mod's own store inside Claude Code (the pane's filter, park and Done marks).
- **Model calls.** The journal asks Haiku through `$.model.complete`, which uses your own Claude login, the same as your sessions. A call carries short excerpts: session titles, folder names, your prompts and the agent's replies, cut to a few hundred characters each. The hourly journal makes at most one call an hour, plus one close a day and one summary per ended week, month and year. Setup makes the calls in the table above.
- **Nothing else leaves the machine.** No telemetry, no other network calls.
- **Acting on other sessions is off by default.** With `actOnOtherSessions` off, Trips only reads and opens sessions.

## Settings

Set these in `/config` (the `trips` rows), or in `~/.claude/settings.json` under `pluginConfigs`:

```json
{ "pluginConfigs": { "trips": { "options": { "journalDir": "~/notes/trips-journal", "actOnOtherSessions": false } } } }
```

- `journalDir`: where the journal keeps its files. Default `~/.claude/trips-journal`. A leading `~` is your home folder.
- `actOnOtherSessions`: show Reply and Done on trips that wait on you. Default off.

## Uninstall

```bash
claude plugin uninstall trips
```

The journal stays where it is. Delete it yourself if you want it gone: `rm -rf ~/.claude/trips-journal` (or your `journalDir`).

## How it works

### What goes where

| Place | What | Shown as |
|---|---|---|
| Platform | Blocked sessions (the app's own summary says they wait on you), not archived, not marked Done, not mid-turn | Above "now", newest first, at most 5, then "+N more waiting, oldest X". A blocked row sits here only, never twice. |
| Trips rail | 0 to 24 h | The live lane, newest first, with "now", hour labels and gap breaks. |
| Sidings | 24 h to 7 days | Closed by default. Grouped by folder, 30 rows at a time with "+N more". |
| Depot | Over 7 days, or archived in the app | Closed by default. Grouped by folder, newest 30 only. |

In the Sidings and the Depot, folders run by their newest session, and sessions run newest first inside each folder. New activity moves a session back to the rail. The pane refreshes every 5 seconds and after each turn of the current session. The last scan is kept in the mod's store, so the pane in a session you switch to draws at once. `/trips` or the eye on the pill reopens the pane.

### Each row

- Signal lamp: amber for blocked, a teal ring for review ready, a grey ring for completed, a pulsing dot while a turn runs. Without an answer from the host, a dot for activity in the last 2 minutes.
- Line colour: the sidebar group's place in the sidebar picks one of 5 hues. A session with no group takes its folder's hue.
- Line 2: on a blocked row the ask after "Needs you:", else the last turn's recap, else your last prompt.
- Chips: group (or folder), branch, and PR chips that open the PR.
- Fuel gauge on the current session's row: the context fill from `$.session.usage()`. At 80 percent it turns amber and says to hand off before compaction.

### The pill

The band above the prompt shows the tram mark, `⏳ N` (amber above 0) and the eye. It draws beside the pill of any other mod in the band, in one row that never wraps. It hides only while a survey holds the band.

### Park in the Depot

Hover a row's title for the eye (open) and the archive box (park). Parking is Trips-only: no host call, the session keeps running as before. A parked trip moves to the Depot with a "parked" chip and never counts as waiting. An Undo row stands in its place for 8 seconds. The trip comes back by itself when the session asks again.

### Group filter, nudges and search

- All, or one sidebar group, filters every section. The choice is kept for the next session.
- When a session flips to blocked, one toast names it and its ask. Each flip is announced once across all your sessions.
- "Find a parked session" filters the Sidings and the Depot as you type. Every word must appear in the title, the group, the branch or the folder.

### Reply and Done

Off by default. With `actOnOtherSessions` on, every blocked row that is not the current session shows Reply, Done and Open. Reply goes through the host's `send_message`, else `$.session.send`. Done calls the host's `mark_completed` and keeps a Done mark in Trips until the session asks again.

### Data sources

- Desktop session records, read only: `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_<id>.json` (title, folder, times, archive flag, the app's turn summary, PRs, branch).
- Sidebar groups, read only: `claude_desktop_config.json` in the same folder.
- Transcripts: `~/.claude/projects/*/*.jsonl`, for title fallbacks, the last prompt and the activity time. Activity is the time of the last user or agent message, never the file time.
- Running state: `$.mcp.call('ccd_session_mgmt', 'list_sessions')` when the host offers it.
- The scanner reaches back 30 days and skips sessions with no desktop record (headless runs).

### The journal

- **Entry**: `{ at, sessionId, label, done, next }`. `label` is the session or project in at most 4 words. `done` is one past-tense sentence that names the concrete thing finished. `next` is one short imperative sentence, or empty.
- **Hourly**: a tick every 5 minutes acts when the current hour has no entry yet. One Haiku call turns every session touched since the last run into one entry, as a JSON array. The prompt carries each session's wrap-up, turn report, status detail, recap, last prompt and ask, read from the desktop record, plus today's last 6 entries. No tick runs where nothing draws, such as a plain `claude -p` run.
- **Line checks**: an item that is missing, over 16 words a sentence, or holds status talk ("ready for review", "in progress"), advice, a count of sessions, a "Now:" prefix, a semicolon or an em dash falls back to an entry built from the session's own text, with no model. A reply that is not JSON falls back for every session.
- **Day close**: the first tick after midnight closes every past day still open. One call writes 3 to 5 lines of concrete work, the last starting "Tomorrow:". A closed day never takes another entry.
- **Rollups**: when an ISO week ends, one call over its days writes the week. When a month and its last ISO week end, one call over its weeks writes the month (a week belongs to the month of its Thursday). When December and its last week end, one call writes the year. A failed call keeps the first line of each child.
- **Storage**: local JSON in the journal folder: `days/YYYY-MM-DD.json`, `weeks/YYYY-Www.json`, `months/YYYY-MM.json`, `years/YYYY.json`, and `start.json` (setup's start mark). Each write goes to a temporary file, then a rename. A day file that does not parse is moved aside, never overwritten.
- **One writer**: every open session loads the mod, so a tick takes `lease.json` (made with `O_EXCL`, 10 minutes, renewed before each model call) under `lease.lock` before it writes. A second session finds the lease and skips. After an error the ticks back off 5, 10, 20, 40, then 60 minutes.

### Setup (the backfill)

- `/trips setup <range>` takes the same lease as the hourly tick, so the two never race. A busy lease means it writes nothing and says to try again.
- The transcript reader (`hooks/backfill-scan.ts`, run as `python3 -I -c`) counts a session when the desktop app has a record of it or when it started in an interactive terminal. Headless and SDK runs stay out. It bisects each large transcript to the first line of the range and stops past it, so a 7-day scan takes a few seconds. It scans 7 days per run to keep its output small.
- Per day, each session's turns split into work blocks at a 2 hour gap. The 24 busiest blocks go to one Haiku call, with the first and last turns of each block (your prompt and the agent's answer, cut short). The reply passes the same line checks and fallbacks as the hourly path. Then one call closes the day.
- Days with no turns are quiet: no call and no file. After the days, the rollups that came due are written as the tick writes them. Weeks or months the journal already summed up are kept as they are.

### Code

- `hooks/register.tsx`: the pane, the pill, the 5 second scan, the commands.
- `hooks/journal.ts`: prompts, line checks, dates, the hourly tick and the rollups. `hooks/journal-store.ts`: the Python store.
- `hooks/backfill.ts`: `/trips setup`. `hooks/backfill-scan.ts`: the transcript reader.
- `hooks/scan.ts`: the pane's scanner. `hooks/platform.ts`, `groups.ts`, `nudge.ts`, `search.ts`, `tide.ts`, `park.ts`, `band.ts`: the pane's rules. `hooks/rail.ts` and `hooks/grid.ts`: the dark tokens, hues, the 4 px grid and the small SVGs.
- Tests: `hooks/*.test.ts(x)`, over the in-memory engine, store and model in `hooks/world.ts` and `hooks/fixture.ts`. No test reaches a real session, a real file or a real model.

### Checks

```bash
claude plugin validate .
claude plugin test .
bash checks/store-check.sh
```

`checks/store-check.sh` runs the real Python store against a temporary home folder (the test kit cannot spawn processes): 8 sessions racing for an expired lease over 30 rounds, renew and release by holder, a corrupt day moved aside, the path guard, the `journalDir` folder and the start mark. It needs `bun` to pull the Python out of the TypeScript file.

For type checks, `tsc -p .` works where Claude Code has laid its types into `.claude-plugin/types/` (a folder it hot-reloads). Elsewhere, use the `tsconfig.json` from the header of Claude Code's `claude-code.d.ts`, kept outside the mod folder.

### Limits

- Mods cannot draw inside the desktop app's own left session list, so the pane docks beside the transcript.
- The host tools (`ccd_session_mgmt`, `ccd_sidebar`) exist only in sessions the desktop app hosts. Without them the 2 minute live rule applies, and Reply falls back to `$.session.send`.
- The terminal draws a plain list, with no SVG.
- Setup reads what the transcripts still hold. Claude Code removes old transcripts after its cleanup period (30 days by default), so older days stay empty.

## License

MIT. See [LICENSE](LICENSE).
