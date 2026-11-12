import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register, UiPressArgument } from 'claude-code'

import type { JournalDay, JournalEntry, JournalRollup, JournalScale, SessionRow, SidebarGroup } from '../types'
import {
  LABEL_H, NEUTRAL_HUE, RAIL_FILL, RAIL_INK, RAIL_W, S12, S4, S8, TYPE, barSvg, chipSvg, contentPx, railHead, railRuns, railSvg, rowHeight,
} from './grid'
import type { RailMark, Step } from './grid'
import { ALL, SELECT_PLACEHOLDER, colourOf, elsewhere, elsewhereLine, groupColour, groupStats, inGroup, optionLabel, validFilter } from './groups'
import { ANNOUNCED_MAX, flips, paneTitle, toastText } from './nudge'
import {
  HANDOFF_LINE, NOT_RUNNING_LINE, PLATFORM_MAX, flipKey, fuelOf, isRunning, isWaiting, lampOf, line2, moreLine, normaliseRows, platform, prChips,
} from './platform'
import type { Signals } from './platform'
import { TOKENS, layout } from './rail'
import { TRAM_GLYPH, TRAM_SVG, bandView, countText, isNothing } from './band'
import { UNDO_MS, applyParks, isParked, parkedIds, parkedMap, staleMarks, undoList } from './park'
import { SCAN_PY } from './scan'
import {
  CARD_ENTRIES, FIRST_LINE, JOURNAL_TICK_MS, clockOf, dayLines, emptyLists, focusOf, hourLabel, journalTick, metaLine, newMemo, newestEntries, normaliseDay,
  periodLabel, setJournalRoot, store as journalStore, timeline,
} from './journal'
import { USAGE, parseCommand, runSetup } from './backfill'
import { SEARCH_PLACEHOLDER, noMatchLine, searchParked } from './search'
import { SHOWN_STEP, ageLabel, byFolder, isLive, tide, timeLabel } from './tide'

const PANE = 'trips'
const TICK_MS = 5000
const LAST_SCAN = 'lastScan'
const STORE_FILTER = 'groupFilter'
const STORE_ANNOUNCED = 'announced'
const STORE_DISMISSED = 'dismissed'
/** The host's session tools, as /mcp lists them in a desktop-hosted session. */
const HOST_SESSIONS = 'ccd_session_mgmt'
const HOST_SIDEBAR = 'ccd_sidebar'
/** Ticks to wait before asking the host again after it did not answer (one minute). */
const LIVE_BACKOFF = 12
/** list_sessions covers every non-archived row shown, with room, capped. */
const LIVE_LIMIT_MIN = 50
const LIVE_LIMIT_MAX = 1000
// The row hover fill (#f5f0eb at 6%) over the raised panel, solid, so the Open
// button hides the time beneath it.
const HOVER_FILL = '#191714'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** "2026-11-12" as "Thu 12 Nov"; anything else comes back as it was. */
export function dateLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}
const sessions = atom({ plugin: 'trips', key: 'sessions' } as const, [])
const groupsAtom = atom({ plugin: 'trips', key: 'groups' } as const, [])
const scannedAt = atom({ plugin: 'trips', key: 'scannedAt' } as const, 0)
const restingOpen = atom({ plugin: 'trips', key: 'restingOpen' } as const, false)
const restingShown = atom({ plugin: 'trips', key: 'restingShown' } as const, SHOWN_STEP)
const archiveOpen = atom({ plugin: 'trips', key: 'archiveOpen' } as const, false)
const runningAtom = atom({ plugin: 'trips', key: 'running' } as const, null)
const groupFilter = atom({ plugin: 'trips', key: 'groupFilter' } as const, ALL)
const platformOpen = atom({ plugin: 'trips', key: 'platformOpen' } as const, false)
const query = atom({ plugin: 'trips', key: 'query' } as const, '')
const replyOpen = atom({ plugin: 'trips', key: 'replyOpen' } as const, '')
const replyDraft = atom({ plugin: 'trips', key: 'replyDraft' } as const, '')
const dismissedAtom = atom({ plugin: 'trips', key: 'dismissed' } as const, [])
const undeliverable = atom({ plugin: 'trips', key: 'undeliverable' } as const, [])
const paneUp = atom({ plugin: 'trips', key: 'paneUp' } as const, false)
const undoParks = atom({ plugin: 'trips', key: 'undoParks' } as const, [])
const parkedAtom = atom({ plugin: 'trips', key: 'parked' } as const, {})
const journalDay = atom({ plugin: 'trips', key: 'journalDay' } as const, null)
const journalLists = atom({ plugin: 'trips', key: 'journalLists' } as const, emptyLists())
const journalTz = atom({ plugin: 'trips', key: 'journalTz' } as const, 0)
const journalOpen = atom({ plugin: 'trips', key: 'journalOpen' } as const, '')
const journalScale = atom({ plugin: 'trips', key: 'journalScale' } as const, 'day')
const journalKey = atom({ plugin: 'trips', key: 'journalKey' } as const, '')
const journalDocs = atom({ plugin: 'trips', key: 'journalDocs' } as const, {})
const journalBusy = atom({ plugin: 'trips', key: 'journalBusy' } as const, false)
const STORE_PARKED = 'parked'
const STORE_UNDO = 'undoParks'
export { UNDO_MS }
/** One-glyph icon labels, text presentation (U+FE0E) so the surface draws them monochrome. */
export const EYE = '\u{1F441}\u{FE0E}'
export const ARCHIVE = '\u{1F5C3}\u{FE0E}'
export const UNPARK = '\u{21A9}\u{FE0E}'

let currentId = ''
let isScanning = false
let liveWait = 0
let lastTitle = ''

type ScanOut = { sessions: SessionRow[]; groups: SidebarGroup[] }

// The 0.4 scanner printed a bare list; 0.5 prints { sessions, groups }. Either
// way each row is normalised, so a missing field reads as empty.
function parseScan(stdout: string): ScanOut {
  const data = JSON.parse(stdout) as unknown
  if (Array.isArray(data)) return { sessions: normaliseRows(data), groups: [] }
  const d = (data ?? {}) as { sessions?: unknown; groups?: unknown }
  const groups = Array.isArray(d.groups) ? (d.groups as SidebarGroup[]).filter(g => g && typeof g.id === 'string') : []
  return { sessions: normaliseRows(d.sessions), groups }
}

const textOf = (res: McpToolResult) =>
  res.content
    .map(b => {
      const t = b as { type?: unknown; text?: unknown }
      return t.type === 'text' && typeof t.text === 'string' ? t.text : ''
    })
    .join('\n')

/** list_sessions answers a JSON list of `{ sessionId: 'local_…', isRunning, ... }` as text. */
export function parseRunning(res: McpToolResult): Record<string, boolean> {
  const text = textOf(res)
  const start = text.indexOf('[')
  const list = JSON.parse(start >= 0 ? text.slice(start) : text) as unknown
  const rows = Array.isArray(list) ? list : ((list as { sessions?: unknown[] }).sessions ?? [])
  const out: Record<string, boolean> = {}
  for (const r of rows as Array<Record<string, unknown>>) {
    const id = r.sessionId ?? r.session_id ?? r.id
    if (typeof id === 'string') out[id] = r.isRunning === true
  }
  return out
}

async function signals($: EngineInterface): Promise<Signals> {
  return { dismissed: new Set(await read($, dismissedAtom)), running: await read($, runningAtom) }
}

// Opens a desktop session through the app's own deep link (claude://code/continue,
// which takes the desktop's local_ id). A terminal-only session has no desktop
// page, so its resume command goes to the clipboard instead.
async function openSession($: EngineInterface, row: SessionRow, surface: UiPressArgument['surface']) {
  if (row.localId) {
    const url = `claude://code/continue?session=${encodeURIComponent(row.localId)}`
    const run = await $.process.run(['/usr/bin/open', url], { timeoutMs: 10000 })
    if (run.exitCode !== 0) $.ui.toast(`Could not open ${row.title}`)
    return
  }
  await $.ui.copy({ text: `claude --resume ${row.id}`, surface })
  $.ui.toast('Terminal session: resume command copied')
}

// A PR chip is a pressable Text (a Button holds no Svg), so it opens the https URL itself.
async function openUrl($: EngineInterface, url: string) {
  if (!/^https:\/\//.test(url)) return
  const run = await $.process.run(['/usr/bin/open', url], { timeoutMs: 10000 })
  if (run.exitCode !== 0) $.ui.toast('Could not open the PR')
}

// The validator wants each update on a named atom, so each toggle has its own function.
async function flipResting($: EngineInterface) {
  const wasOpen = await read($, restingOpen)
  await update($, restingOpen, v => !v)
  if (wasOpen) await update($, restingShown, () => SHOWN_STEP)
}

async function showMoreResting($: EngineInterface) {
  await update($, restingShown, n => n + SHOWN_STEP)
}

async function flipArchive($: EngineInterface) {
  await update($, archiveOpen, v => !v)
}

async function flipPlatform($: EngineInterface) {
  await update($, platformOpen, v => !v)
}

// The group filter is kept in $.store, so the next session opens on the same group.
async function pickGroup($: EngineInterface, value: string) {
  const id = validFilter(value, await read($, groupsAtom))
  await update($, groupFilter, () => id)
  await $.store.set(STORE_FILTER, id)
}

async function setQuery($: EngineInterface, value: string) {
  await update($, query, () => value)
}

async function openReply($: EngineInterface, id: string) {
  await update($, replyDraft, () => '')
  await update($, replyOpen, () => id)
}

async function closeReply($: EngineInterface) {
  await update($, replyOpen, () => '')
  await update($, replyDraft, () => '')
}

async function setDraft($: EngineInterface, value: string) {
  await update($, replyDraft, () => value)
}

// Reply: the host's own send_message, which starts a turn in an idle session
// ("delivered") or queues it ("queued"). Where the host refuses or is absent,
// the engine's session.send. Only when both fail does the row say it cannot
// take a reply.
async function sendReply($: EngineInterface, row: SessionRow, text: string) {
  const message = text.trim()
  if (!message) return
  let word = ''
  let why = ''
  try {
    const res = await $.mcp.call(HOST_SESSIONS, 'send_message', { session_id: row.localId, message })
    const said = textOf(res)
    if (!res.isError) word = /queued/i.test(said) ? 'queued' : 'delivered'
    else why = said
  } catch (err) {
    why = String(err)
  }
  if (!word) {
    const sent = await $.session.send({ to: { sessionId: row.id }, text: message })
    if (sent.isDelivered) word = 'delivered'
    else why = sent.reason ?? why
  }
  if (word) {
    $.ui.toast(`Reply ${word}: ${row.title}`)
    await update($, undeliverable, list => list.filter(id => id !== row.id))
    await closeReply($)
  } else {
    $.ui.toast(`Could not send to ${row.title}: ${why.slice(0, 200)}`)
    await update($, undeliverable, list => (list.includes(row.id) ? list : [...list, row.id]))
    await closeReply($)
  }
}

// Done: the host clears the sidebar's needs-you mark, and Trips keeps a Done mark
// for this summary, so the row leaves the Platform until the session asks again.
async function markDone($: EngineInterface, row: SessionRow) {
  let failure = ''
  try {
    const res = await $.mcp.call(HOST_SIDEBAR, 'mark_completed', { session_id: row.localId })
    if (res.isError) failure = textOf(res) || 'the host refused'
  } catch (err) {
    failure = String(err)
  }
  const key = flipKey(row)
  await update($, dismissedAtom, list => (list.includes(key) ? list : [...list, key].slice(-ANNOUNCED_MAX)))
  await $.store.set(STORE_DISMISSED, await read($, dismissedAtom))
  if (failure) $.ui.toast(`${row.title} is off the Platform here, but the sidebar mark was not cleared: ${failure.slice(0, 160)}`)
  else $.ui.toast(`${row.title} marked done`)
  await retitle($)
}

async function saveParks($: EngineInterface) {
  await $.store.set(STORE_PARKED, await read($, parkedAtom))
  await $.store.set(STORE_UNDO, await read($, undoParks))
}

// The Undo window ends: the row moves into the Depot view, its mark kept.
async function endUndo($: EngineInterface, id: string) {
  if (!(await read($, undoParks)).some(u => u.id === id)) return
  await update($, undoParks, l => l.filter(u => u.id !== id))
  await saveParks($)
}

// Park: a Trips-only Depot mark, no host call. The app's session keeps running
// or idling as it was; Trips stops counting it as waiting.
async function parkRow($: EngineInterface, row: SessionRow) {
  if (row.id === currentId || !row.localId) return
  const at = await $.clock.now()
  await update($, parkedAtom, m => ({ ...m, [row.localId]: { at, summaryId: row.summaryId } }))
  await update($, undoParks, l => [...l.filter(u => u.id !== row.id), { id: row.id, localId: row.localId, title: row.title, until: at + UNDO_MS }])
  await saveParks($)
  $.clock.after(UNDO_MS, () => void endUndo($, row.id))
  await retitle($)
}

// Undo, or the unpark button later: the mark goes, the row is back as it was.
async function unpark($: EngineInterface, row: { id: string; localId: string }) {
  await update($, parkedAtom, m => {
    const next = { ...m }
    delete next[row.localId]
    return next
  })
  await update($, undoParks, l => l.filter(u => u.id !== row.id))
  await saveParks($)
  await retitle($)
}

async function hiddenIds($: EngineInterface): Promise<Set<string>> {
  return parkedIds(await read($, sessions), await read($, parkedAtom), await read($, undoParks))
}

async function waitingCount($: EngineInterface): Promise<number> {
  const s = await signals($)
  const hidden = await hiddenIds($)
  return (await read($, sessions)).filter(r => !hidden.has(r.id) && isWaiting(r, s)).length
}

// The pane title counts the waiting rows. Re-opening an open id only retitles,
// so this asks the engine first and never opens a pane the person closed.
async function retitle($: EngineInterface) {
  const title = paneTitle(await waitingCount($))
  if (title === lastTitle) return
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isUp) return
  await $.ui.open({ id: PANE, title })
  lastTitle = title
}

async function openPane($: EngineInterface) {
  lastTitle = paneTitle(await waitingCount($))
  const opened = await $.ui.open({ id: PANE, title: lastTitle })
  await syncPaneUp($)
  return opened
}

// Whether the Trips pane is drawn in this session: the band chip hides while it is.
async function setPaneUp($: EngineInterface, isUp: boolean) {
  if ((await read($, paneUp)) !== isUp) await update($, paneUp, () => isUp)
}

// The engine's own pane list is the truth; each scan reads it, so a close the
// hook did not see still shows the chip again within one tick. "Up" is placed
// and shown: an open pane that waits undrawn (isPlaced false) or sits as a tab
// behind another pane (isShown false) is not on screen, so the chip stays.
async function syncPaneUp($: EngineInterface) {
  await setPaneUp($, (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced && pane.isShown))
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [])

// The stored filter, set again once the groups are known (a first run has none).
async function restoreFilter($: EngineInterface, groups: SidebarGroup[]) {
  const filter = validFilter(await $.store.get(STORE_FILTER), groups)
  if ((await read($, groupFilter)) !== filter) await update($, groupFilter, () => filter)
}

// Fills an empty pane from the last scan any session stored, before the first
// scan of this session lands: switching sessions then shows the list at once.
// Rows an older version stored are normalised first. The filter and the Done
// marks come back from the store too.
async function seed($: EngineInterface) {
  const now = await $.clock.now()
  const marks = parkedMap(await $.store.get(STORE_PARKED))
  if (Object.keys(marks).length) await update($, parkedAtom, () => marks)
  const undo = undoList(await $.store.get(STORE_UNDO)).filter(u => u.until > now && marks[u.localId])
  if (undo.length) await update($, undoParks, () => undo)
  for (const u of undo) $.clock.after(Math.max(0, u.until - now), () => void endUndo($, u.id))
  const keys = strings(await $.store.get(STORE_DISMISSED))
  if (keys.length) await update($, dismissedAtom, () => keys)
  const last = (await $.store.get(LAST_SCAN)) as { rows?: unknown; groups?: SidebarGroup[]; nowMs?: number } | undefined
  const groups = Array.isArray(last?.groups) ? last.groups : []
  if (groups.length) await update($, groupsAtom, () => groups)
  await restoreFilter($, groups)
  if ((await read($, sessions)).length > 0) return
  const rows = normaliseRows(last?.rows)
  if (!rows.length) return
  await update($, sessions, () => rows)
  await update($, scannedAt, () => last?.nowMs ?? 0)
}

// isRunning from the host's list_sessions, sized to cover every non-archived
// row. A row the host did not list reads as unknown. Wrapped: the disk scan
// stands alone when the host is not there (a terminal session) or refuses; it
// asks again a minute later, and the rail keeps the 2-minute live rule meanwhile.
async function live($: EngineInterface, rows: SessionRow[]) {
  if (liveWait > 0) {
    liveWait--
    return
  }
  const shown = rows.filter(r => r.localId && !r.isArchived).length
  const limit = Math.min(LIVE_LIMIT_MAX, Math.max(LIVE_LIMIT_MIN, shown + 20))
  try {
    const res = await $.mcp.call(HOST_SESSIONS, 'list_sessions', { limit })
    if (res.isError) throw new Error(textOf(res).slice(0, 200))
    const map = parseRunning(res)
    await update($, runningAtom, () => map)
  } catch (err) {
    liveWait = LIVE_BACKOFF
    if ((await read($, runningAtom)) !== null) await update($, runningAtom, () => null)
    $.ui.log(`trips: host list_sessions unavailable: ${String(err).slice(0, 200)}`, { to: 'debug' })
  }
}

// One toast per flip to blocked, never for this session. The announced keys
// (session id plus summary id) are merged into what the store holds at write
// time, so two sessions announcing at once keep each other's keys.
async function nudge($: EngineInterface, prev: SessionRow[], next: SessionRow[]) {
  const announced = strings(await $.store.get(STORE_ANNOUNCED))
  const s = await signals($)
  const gone = await hiddenIds($)
  const found = flips(prev, next.filter(r => !gone.has(r.id) && isWaiting(r, s)), announced, currentId)
  if (!found.toast.length) return
  for (const row of found.toast) $.ui.toast(toastText(row), { timeoutMs: 8000 })
  const now = strings(await $.store.get(STORE_ANNOUNCED))
  const merged = [...new Set([...now, ...found.announced])].slice(-ANNOUNCED_MAX)
  await $.store.set(STORE_ANNOUNCED, merged)
}

// One scan: run the transcript scanner, store the rows newest first, ask the
// host who is running, toast new flips, retitle the pane.
async function scan($: EngineInterface) {
  if (isScanning) return
  isScanning = true
  try {
    const run = await $.process.run(['python3', '-I', '-c', SCAN_PY], { timeoutMs: 20000 })
    if (run.exitCode !== 0) {
      $.ui.log(`trips: scan failed: ${run.stderr.slice(0, 300)}`, { to: 'debug' })
      return
    }
    const { sessions: rows, groups } = parseScan(run.stdout)
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const prev = await read($, sessions)
    await update($, sessions, () => rows)
    await update($, groupsAtom, () => groups)
    await restoreFilter($, groups)
    const nowMs = await $.clock.now()
    await update($, scannedAt, () => nowMs)
    // Kept across sessions, so the pane in a session just opened draws at once.
    await $.store.set(LAST_SCAN, { rows, groups, nowMs })
    await live($, rows)
    // Auto-unpark: a session that asked again (new summary, or a message after
    // the mark) comes back as normal, Platform included.
    const stale = staleMarks(rows, await read($, parkedAtom))
    if (stale.length) {
      await update($, parkedAtom, m => {
        const next = { ...m }
        for (const k of stale) delete next[k]
        return next
      })
      await update($, undoParks, l => l.filter(u => !stale.includes(u.localId)))
      await saveParks($)
    }
    await nudge($, prev, rows)
    await retitle($)
    await syncPaneUp($)
  } catch (err) {
    $.ui.log(`trips: ${String(err)}`, { to: 'debug' })
  } finally {
    isScanning = false
  }
}

// ---- The daily summary (journal.ts) ----------------------------------------

const SCALE_DIR = { day: 'days', week: 'weeks', month: 'months', year: 'years' } as const
// This mod instance's lease holder: the session id plus a random part made once
// per instance at session start, so two instances never share a holder.
let journalHolder = ''
let journalMemo = newMemo()
const newHolder = (sessionId: string) => `${sessionId || 'session'}:${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`

// One journal tick in this session: never two at once here, and the store's
// lease keeps other sessions out. The card redraws from what the tick read.
async function runJournal($: EngineInterface, force = false) {
  if (await read($, journalBusy)) return
  // Nothing draws in a plain `claude -p` run: no card to fill, so no tick and
  // no model call there. /trips setup runs on its own.
  if (!force && (await $.session.surfaces()).length === 0) return
  await update($, journalBusy, () => true)
  try {
    if (!journalHolder) journalHolder = newHolder(currentId)
    const res = await journalTick($, { holder: journalHolder, rows: await read($, sessions), force, memo: journalMemo })
    if (res.error) $.ui.log(`trips: journal: ${res.error}`, { to: 'debug' })
    if (res.state) {
      const lists = res.state.lists
      const tz = res.state.tzOffsetMin
      await update($, journalLists, () => lists)
      await update($, journalTz, () => tz)
    }
    if (res.today !== undefined) {
      const today = res.today
      await update($, journalDay, () => today)
    }
  } finally {
    await update($, journalBusy, () => false)
  }
}

// The browser's keys for a scale: the stored files, today's day included.
async function scaleKeys($: EngineInterface, scale: JournalScale): Promise<string[]> {
  const lists = await read($, journalLists)
  const keys = [...lists[SCALE_DIR[scale]]]
  const today = await read($, journalDay)
  if (scale === 'day' && today && !keys.includes(today.date)) keys.push(today.date)
  return keys.sort()
}

async function shownKey($: EngineInterface): Promise<string> {
  const keys = await scaleKeys($, await read($, journalScale))
  const key = await read($, journalKey)
  return key && keys.includes(key) ? key : keys[keys.length - 1] ?? ''
}

// Loads the file the browser shows, once: closed days and rollups do not change.
async function loadShown($: EngineInterface) {
  const scale = await read($, journalScale)
  const key = await shownKey($)
  const today = await read($, journalDay)
  if (!key || (scale === 'day' && key === today?.date)) return
  const path = `${SCALE_DIR[scale]}/${key}`
  if ((await read($, journalDocs))[path] !== undefined) return
  try {
    const got = await journalStore<{ files: Record<string, unknown> }>($, 'read', { paths: [path] })
    const raw = got.files[path]
    const doc = !raw ? null : scale === 'day' ? normaliseDay(raw, key) : (raw as JournalRollup)
    await update($, journalDocs, m => ({ ...m, [path]: doc }))
  } catch (err) {
    $.ui.log(`trips: journal read: ${String(err).slice(0, 200)}`, { to: 'debug' })
  }
}

async function flipTimeline($: EngineInterface) {
  await update($, journalOpen, v => (v === 'timeline' ? '' : 'timeline'))
}

async function flipJournal($: EngineInterface) {
  await update($, journalOpen, v => (v === 'journal' ? '' : 'journal'))
  await loadShown($)
}

async function pickScale($: EngineInterface, scale: JournalScale) {
  await update($, journalScale, () => scale)
  await update($, journalKey, () => '')
  await loadShown($)
}

async function stepPeriod($: EngineInterface, by: number) {
  const keys = await scaleKeys($, await read($, journalScale))
  const at = keys.indexOf(await shownKey($))
  const next = keys[at + by]
  if (!next) return
  await update($, journalKey, () => next)
  await loadShown($)
}

// /trips setup <range>: the backfill, under the journal's lease. The card's
// own tick waits while it runs in this session.
async function setup($: EngineInterface, range: Parameters<typeof runSetup>[1]) {
  if (await read($, journalBusy)) return { text: 'The journal is updating in this session now. Try again in a minute.' }
  await update($, journalBusy, () => true)
  try {
    if (!journalHolder) journalHolder = newHolder(currentId)
    const res = await runSetup($, range, `${journalHolder}:setup`)
    return { text: res.text }
  } finally {
    await update($, journalBusy, () => false)
  }
}

export const register: Register = (on, options) => {
  // Reply and Done on other sessions only when the person turns this on.
  const canAct = options.actOnOtherSessions === true
  // The journal's folder: the journalDir option, ~/.claude/trips-journal by default.
  setJournalRoot(options.journalDir)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    currentId = await $.session.id()
    journalHolder = newHolder(currentId)
    journalMemo = newMemo()
    await seed($)
    await $.command.register({
      name: 'trips',
      description: 'Show the Trips pane. /trips setup <1d|7d|30d|fresh> fills the journal for past days or starts it fresh',
      argumentHint: '[setup <1d|7d|30d|fresh>]',
    })
    void openPane($)
    void scan($).then(() => runJournal($))
    $.clock.every(TICK_MS, () => void scan($))
    // The daily summary: every 5 minutes, acting when this hour has no version.
    $.clock.every(JOURNAL_TICK_MS, () => void runJournal($))

    return started
  })

  on('command.run', { command: 'trips' }, async ($, e) => {
    const asked = parseCommand(e.args)
    if (asked.kind === 'usage') return { text: USAGE }
    if (asked.kind === 'setup') return setup($, asked.range)
    await openPane($)
    void scan($)

    return { text: 'Trips pane opened.' }
  })

  // The person's close mark, or Escape: the band chip comes back at once.
  on('ui.close', async ($, e, next) => {
    const done = await next(e)
    if (e.id === PANE) await setPaneUp($, false)

    return done
  })

  // The Trips pill in the band above the prompt, the one way in besides
  // /trips. Always there, 0 waiting included, unless a survey holds the band or
  // the pane is open. It reads the same rows and waiting rule as the Platform
  // (every group, not the filter), redraws when a scan writes them, and adds no
  // scan of its own. It draws its own pill, then places what the plugins beneath
  // draw (the Thread pill) beside it in one row, so either chain order shows both.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await signals($)
    const hidden = await hiddenIds($)
    const all = await read($, sessions)
    const waiting = platform(all.filter(r => !hidden.has(r.id)), s).waiting
    const view = bandView(waiting, all)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const open = () => void openPane($)
    const isDesktop = e.surface !== 'terminal' && 'Svg' in els
    // Compact, glyphs only: the tram, `⏳ N`, the eye. The word Trips and the
    // trip title live in the pane. Nothing here shrinks, so the Thread pill's
    // label is the one part of the band that truncates when narrow.
    const tone = view.count > 0 ? TOKENS.warning : TOKENS.muted
    const eye = (
      <Box key="trips-eye" flexShrink={0}>
        <Button key="trips-open" plain label={EYE} onPress={open} />
      </Box>
    )
    let own
    if (!isDesktop) {
      own = (
        <Box key="trips-band" flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
          <Text>{TRAM_GLYPH}</Text>
          <Box key="trips-count" flexShrink={0}>
            {view.count > 0 ? <Text color={TOKENS.warning}>{countText(view.count)}</Text> : <Text dimColor>{countText(0)}</Text>}
          </Box>
          {eye}
        </Box>
      )
    } else {
      const { Svg } = els
      own = (
        <Box key="trips-band" flexDirection="row" alignItems="center" gap={S8} flexShrink={1} minWidth={0} backgroundColor={TOKENS.overlay} borderStyle="round" borderColor={TOKENS.hair} paddingX={S8} paddingY={S4}>
          <Svg source={TRAM_SVG} alt="Trips" width={16} height={16} />
          <Box key="trips-count" flexShrink={0}>
            <Text size={TYPE.line2} weight="medium" tabular color={tone}>{countText(view.count)}</Text>
          </Box>
          {eye}
        </Box>
      )
    }
    const beneath = await next(e)
    if (isNothing(beneath)) return own
    return (
      <Box key="trips-row" flexDirection="row" flexWrap="nowrap" alignItems="center" gap={isDesktop ? S8 : 1}>
        {own}
        {beneath}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // This session's own activity re-sorts at once, without waiting for the tick.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void scan($)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const undoRows = await read($, undoParks)
    const marks = await read($, parkedAtom)
    const scanned = await read($, sessions)
    const parkedNow = new Set(scanned.filter(r => isParked(r, marks)).map(r => r.id))
    const rows = applyParks(scanned, marks, undoRows)
    const pendingById = new Map(undoRows.map(p => [p.id, p]))
    const groups = await read($, groupsAtom)
    const at = await read($, scannedAt)
    const isRestingOpen = await read($, restingOpen)
    const restingCount = await read($, restingShown)
    const isArchiveOpen = await read($, archiveOpen)
    const isPlatformOpen = await read($, platformOpen)
    const filter = validFilter(await read($, groupFilter), groups)
    const q = await read($, query)
    const openReplyId = await read($, replyOpen)
    const draft = await read($, replyDraft)
    const failed = new Set(await read($, undeliverable))
    const s = await signals($)
    // The scan time keys the "now" labels, so a redraw after each scan ages them.
    const nowMs = at || (await $.clock.now())
    const isAll = filter === ALL
    const open = (row: SessionRow) => (press: UiPressArgument) => void openSession($, row, press.surface)

    // Waiting rows leave the tides for the Platform, so nothing shows twice.
    // An archived session never waits: pending archives (their Undo row up) and
    // archived ones are out of every count; a pending one that waited keeps its
    // place on the Platform as its Undo row.
    const live = rows.filter(r => !pendingById.has(r.id))
    const waitingAll = platform(live, s).waiting
    const waitingIds = new Set(waitingAll.map(r => r.id))
    const undoWaiting = rows.filter(r => pendingById.has(r.id) && isWaiting(r, s))
    const undoIds = new Set(undoWaiting.map(r => r.id))
    const undoOnPlatform = undoWaiting.filter(r => inGroup(r, filter))
    const tides = tide(rows.filter(r => !waitingIds.has(r.id) && !undoIds.has(r.id)), nowMs)
    const view = platform(live.filter(r => inGroup(r, filter)), s, isPlatformOpen)
    const awake = tides.awake.filter(r => inGroup(r, filter))
    const resting = tides.resting.filter(r => inGroup(r, filter))
    const archive = tides.archive.filter(r => inGroup(r, filter))
    const other = elsewhere(waitingAll, filter, groups)
    const groupName = groups.find(g => g.id === filter)?.name ?? ''

    // The daily summary's state, for the card at the top.
    const jDay = await read($, journalDay)
    const jEntries = newestEntries(jDay)
    // A day written before entries shows its old lines until its first entry.
    const jLines = jEntries.length ? [] : jDay?.lines ?? []
    const isJournalEmpty = jEntries.length === 0 && jLines.length === 0
    const jTz = await read($, journalTz)
    const jOpen = await read($, journalOpen)
    const jBusy = await read($, journalBusy)
    const updateNow = () => void runJournal($, true)

    // The terminal draws no Svg: a plain list there.
    if (e.surface === 'terminal' || !('Svg' in els)) {
      return (
        <Box flexDirection="column">
          {jEntries.slice(0, CARD_ENTRIES).map((en, n) => <Text key={`journal-entry:${n}`}>{`${clockOf(en.at, jTz)} ${en.label}: ${en.done}`}</Text>)}
          {jLines.map((l, n) => <Text key={`journal-line:${n}`}>{l}</Text>)}
          {isJournalEmpty && <Text key="journal-first" dimColor>{FIRST_LINE}</Text>}
          {isJournalEmpty && <Button key="journal-now" plain label="Update now" onPress={updateNow} />}
          {view.shown.map(r => (
            <Button key={`open:${r.id}`} plain onPress={open(r)}>
              {`waiting ${r.title}`}
              <Text dimColor> {r.nextAction}</Text>
            </Button>
          ))}
          {awake.length === 0 && <Text dimColor>No sessions in the last 24 h.</Text>}
          {awake.map(r => (
            <Button key={`open:${r.id}`} plain onPress={open(r)}>
              {timeLabel(r, nowMs)} {r.title}
              <Text dimColor> {r.groupName || r.project}</Text>
            </Button>
          ))}
          <Text dimColor>{`Sidings ${resting.length} · Depot ${archive.length}`}</Text>
        </Box>
      )
    }

    const { Svg } = els
    // Fields only where the surface draws them: desktop and the editor, never mobile.
    const fields = (e.surface === 'desktop' || e.surface === 'vscode') && 'Input' in els && 'Select' in els ? els : undefined
    const items = layout(awake, nowMs)
    const lastRow = [...items].reverse().find(i => i.kind === 'row')
    const usage = rows.some(r => r.id === currentId) ? await $.session.usage().catch(() => undefined) : undefined
    const fuel = fuelOf(usage?.context.percent)

    // One line of the pane on the grid: a 24 px rail column and a content
    // column that every text, chip and bar of the line starts in. The rail
    // cell stretches to the line's real height (the lane pads only its content
    // column), so its head drawing and the 2 px fill below it meet the cells
    // above and below with no break, however far the text wraps.
    const lane = (
      key: string,
      mark: RailMark,
      content: unknown,
      pad: { top: Step | 0; bottom: Step | 0 },
      look: { fill?: string; hoverFill?: string } = {},
      railH = LABEL_H,
    ) => {
      const head = railHead(mark, railH)
      return (
        <Box
          key={`lane:${key}`}
          flexDirection="row"
          alignItems="stretch"
          gap={S8}
          backgroundColor={look.fill}
          hover={look.hoverFill ? { backgroundColor: look.hoverFill } : undefined}
        >
          <Box key={`rail:${key}`} flexShrink={0} flexDirection="column" alignItems="center">
            <Svg source={railSvg(mark, head)} alt={railAlt(mark)} width={RAIL_W} height={head} />
            {railRuns(mark) && (
              <Box key={`railfill:${key}`} flexGrow={1} flexShrink={0} backgroundColor={RAIL_INK}>
                <Svg source={RAIL_FILL} alt="rail" width={2} height={1} />
              </Box>
            )}
          </Box>
          <Box key={`content:${key}`} flexDirection="column" gap={S4} flexGrow={1} flexShrink={1} minWidth={0} paddingTop={pad.top} paddingBottom={pad.bottom}>
            {content as never}
          </Box>
        </Box>
      )
    }
    const blank: RailMark = { kind: 'blank', line: false }
    // Every Svg carries words: a surface without the element, or one that drops an empty alt, still says it.
    const railAlt = (mark: RailMark) =>
      mark.kind === 'row' ? (mark.lamp === 'blocked' ? 'waiting on you' : mark.lamp === 'running' ? 'running' : mark.lamp === 'review' ? 'ready for review' : mark.lamp === 'done' ? 'completed' : 'rail')
        : mark.kind === 'blank' ? 'spacer' : mark.kind
    const column = contentPx(e.props.bodyColumns)

    const chip = (key: string, label: string, hue: string, mono = false) => {
      const c = chipSvg(label, hue, mono)
      return (
        <Box key={`chip:${key}`} flexShrink={0}>
          <Svg source={c.source} alt={label} width={c.width} height={c.height} />
        </Box>
      )
    }

    // The act row of a waiting row, with actOnOtherSessions on.
    const acts = (row: SessionRow) => {
      if (failed.has(row.id))
        return (
          <Box key={`acts:${row.id}`} flexDirection="row" alignItems="center" gap={S8}>
            <Box flexShrink={1} minWidth={0}>
              <Text size={TYPE.line2} color={TOKENS.muted} wrap="truncate-end">{NOT_RUNNING_LINE}</Text>
            </Box>
            <Button key={`act-open:${row.id}`} variant="secondary" onPress={open(row)}>Open</Button>
          </Box>
        )
      if (fields && openReplyId === row.id) {
        const { Input } = fields
        return (
          <Box key={`acts:${row.id}`} flexDirection="row" alignItems="center" gap={S8}>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Input
                key={`reply:${row.id}`}
                placeholder="Reply"
                value={draft}
                submitLabel="send"
                autoFocus
                onInput={value => void setDraft($, value)}
                onSubmit={value => void sendReply($, row, value)}
              />
            </Box>
            <Button key={`send:${row.id}`} variant="primary" onPress={() => void sendReply($, row, draft)}>Send</Button>
            <Button key={`cancel:${row.id}`} variant="secondary" onPress={() => void closeReply($)}>Cancel</Button>
          </Box>
        )
      }
      return (
        <Box key={`acts:${row.id}`} flexDirection="row" gap={S8}>
          {fields && <Button key={`reply-open:${row.id}`} variant="secondary" onPress={() => void openReply($, row.id)}>Reply</Button>}
          <Button key={`done:${row.id}`} variant="secondary" onPress={() => void markDone($, row)}>Done</Button>
          <Button key={`act-open:${row.id}`} variant="secondary" onPress={open(row)}>Open</Button>
        </Box>
      )
    }

    // One session row: title and time, line 2, chips, fuel, acts, all in the content column.
    const sessionRow = (row: SessionRow, time: string, opts: { hasRail: boolean; isLast: boolean; isMuted: boolean; inFolder?: boolean; isPlatform?: boolean }) => {
      const pend = pendingById.get(row.id)
      if (pend)
        return lane(`row:${row.id}`, { kind: 'row', lamp: 'done', colour: colourOf(row, groups), line: opts.hasRail && opts.isLast ? 'end' : 'full' }, (
          <Box key={`undo:${row.id}`} flexDirection="row" alignItems="center" gap={S8} minWidth={0}>
            <Box flexShrink={1} minWidth={0}>
              <Text size={TYPE.line2} color={TOKENS.muted} wrap="truncate-end">{`Parked ${pend.title} in the Depot ·`}</Text>
            </Box>
            <Button key={`undo:${row.id}`} plain label="Undo" onPress={() => void unpark($, pend)} />
          </Box>
        ), { top: S4, bottom: S4 }, {}, rowHeight({ line2: false, chips: false, fuel: false, acts: false }))
      const isCurrent = row.id === currentId
      const isRowLive = isLive(row, nowMs)
      const lamp = lampOf(row, s, opts.hasRail && isRowLive)
      const isRowWaiting = lamp === 'blocked'
      const colour = colourOf(row, groups)
      const isHot = isCurrent && fuel?.isHot === true
      const l2 = isHot ? { tone: 'ask' as const, text: HANDOFF_LINE } : line2(row, s)
      const titleColour = isCurrent ? TOKENS.primary : opts.isMuted ? TOKENS.secondary : TOKENS.primary
      const timeText = lamp === 'running' ? 'running' : time
      // The group chip draws while every group is mixed; the folder stands in without a group.
      const showGroup = isAll && !opts.inFolder
      const prs = prChips(row)
      const groupChip = showGroup && row.groupName ? chip(`${row.id}:grp`, row.groupName, colour) : undefined
      const folderChip = showGroup && !row.groupName && row.project ? chip(`${row.id}:dir`, row.project, NEUTRAL_HUE) : undefined
      const isRowParked = parkedNow.has(row.id)
      // A Platform row keeps its PR chips only: project and time go on one meta line.
      const onPlatform = opts.isPlatform === true
      const hasChips = onPlatform ? prs.length > 0 : !!groupChip || !!folderChip || prs.length > 0 || !!row.branch || isRowParked
      const metaName = row.groupName || row.project
      const content = [
        <Box key={`title:${row.id}`} flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={S8} minWidth={0}>
          <Box flexShrink={1} minWidth={0}>
            <Text size={TYPE.title} weight="semibold" color={titleColour} wrap="truncate-end">{row.title}</Text>
          </Box>
          <Box flexShrink={0} position="relative">
            {!onPlatform && <Text size={TYPE.meta} tabular color={lamp === 'running' || lamp === 'live' ? TOKENS.signal : TOKENS.muted}>{timeText}</Text>}
            {/* On hover the eye (open) and the archive box cover the time. */}
            {!isCurrent && (
              <Box
                position="absolute"
                top={0}
                right={0}
                display="none"
                flexDirection="row"
                gap={S8}
                backgroundColor={HOVER_FILL}
                hover={{ display: 'flex' }}
              >
                <Button key={`go:${row.id}`} plain label={EYE} onPress={open(row)} />
                {row.localId && !row.isArchived && <Button key={`archive:${row.id}`} plain label={ARCHIVE} onPress={() => void parkRow($, row)} />}
                {parkedNow.has(row.id) && <Button key={`unpark:${row.id}`} plain label={UNPARK} onPress={() => void unpark($, row)} />}
              </Box>
            )}
          </Box>
        </Box>,
        l2.text !== '' && (
          <Box key={`l2:${row.id}`} flexDirection="row" width="100%" minWidth={0} overflow="hidden">
            {l2.tone === 'ask' && !isHot && !onPlatform && (
              <Box flexShrink={0}>
                <Text size={TYPE.line2} color={TOKENS.muted}>{'Needs you: '}</Text>
              </Box>
            )}
            <Box flexShrink={1} minWidth={0}>
              <Text
                size={TYPE.line2}
                color={l2.tone === 'ask' ? (onPlatform ? TOKENS.secondary : TOKENS.warning) : l2.tone === 'recap' ? TOKENS.secondary : TOKENS.muted}
                wrap="truncate-end"
              >
                {l2.text}
              </Text>
            </Box>
          </Box>
        ),
        onPlatform && metaName && (
          <Box key={`meta:${row.id}`} flexDirection="row" alignItems="center" gap={S4} minWidth={0}>
            <Box flexShrink={1} minWidth={0}>
              <Text size={TYPE.meta} color={colour} wrap="truncate-end">{metaName}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text size={TYPE.meta} tabular color={TOKENS.muted}>{`· ${time}`}</Text>
            </Box>
          </Box>
        ),
        hasChips && (
          <Box key={`chips:${row.id}`} flexDirection="row" flexWrap="wrap" alignItems="center" gap={S4}>
            {isRowParked && !onPlatform ? chip(`${row.id}:parked`, 'parked', NEUTRAL_HUE) : undefined}
            {onPlatform ? undefined : groupChip}
            {onPlatform ? undefined : folderChip}
            {prs.flatMap(p => [
              chip(p.key, p.label, p.isOpen ? TOKENS.patina : NEUTRAL_HUE),
              <Button key={p.key} plain label="↗" onPress={() => void openUrl($, p.url)} />,
            ])}
            {row.branch && !onPlatform ? chip(`${row.id}:br`, row.branch, NEUTRAL_HUE, true) : undefined}
          </Box>
        ),
        isCurrent && fuel && (
          <Box key={`fuel:${row.id}`} flexDirection="row" alignItems="center" gap={S8}>
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Svg source={barSvg(column - 84, 4, fuel.isHot ? TOKENS.warning : TOKENS.patina, fuel.percent, TOKENS.overlay)} alt={`context ${fuel.percent}%`} width={Math.max(1, column - 84)} height={4} />
            </Box>
            <Box flexShrink={0}>
              <Text size={TYPE.meta} color={fuel.isHot ? TOKENS.warning : TOKENS.muted}>{`context ${fuel.percent}%`}</Text>
            </Box>
          </Box>
        ),
        canAct && isRowWaiting && !isCurrent && acts(row),
      ]
      const mark: RailMark = { kind: 'row', lamp, colour, line: opts.hasRail && opts.isLast ? 'end' : 'full' }
      const railH = rowHeight({ line2: l2.text !== '' || (onPlatform && !!metaName), chips: hasChips, fuel: isCurrent && !!fuel, acts: canAct && isRowWaiting && !isCurrent })
      return lane(`row:${row.id}`, mark, content, { top: S4, bottom: S4 }, {
        fill: isCurrent ? TOKENS.overlay : undefined,
        hoverFill: isCurrent ? TOKENS.overlay : TOKENS.hover,
      }, railH)
    }

    // A section label: 12 px above, 4 px below, 11 px text.
    const label = (key: string, mark: RailMark, left: unknown, right?: unknown) =>
      lane(key, mark, (
        <Box key={`label:${key}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={S8}>
          {left as never}
          {right as never}
        </Box>
      ), { top: S12, bottom: S4 })

    // A section caption: mono, uppercase, muted.
    const caption = (key: string, text: string, colour: string = TOKENS.muted) => (
      <Text key={key} size={TYPE.meta} mono weight="medium" color={colour}>{text.toUpperCase()}</Text>
    )

    const hairline = (key: string) => (
      <Box key={key} width="100%" overflow="hidden">
        <Svg source={barSvg(column, 1, TOKENS.hair)} alt="divider" width={column} height={1} />
      </Box>
    )

    // A fold row (Sidings, Depot, "+N more"): 8 px above and below, 32 px tall in all.
    // The label is a coloured Text on the content column; the action is a real Button.
    const fold = (key: string, text: string, colour: string, onPress: () => void, action: string, right = '', isSection = false) =>
      lane(key, blank, (
        <Box key={`fold:${key}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={S8}>
          <Box key={`foldtext:${key}`} flexShrink={1} minWidth={0}>
            {isSection ? caption('t', text, colour) : <Text size={TYPE.line2} weight="medium" color={colour} wrap="truncate-end">{text}</Text>}
          </Box>
          <Box key={`foldact:${key}`} flexDirection="row" alignItems="center" gap={S8} flexShrink={0}>
            {right ? <Text size={TYPE.meta} tabular color={TOKENS.muted}>{right}</Text> : undefined}
            <Button key={`flip:${key}`} variant="secondary" label={action} onPress={onPress} />
          </Box>
        </Box>
      ), { top: S4, bottom: S4 }, {}, 40)

    // A folder's sessions under one header: the folder name and its count.
    const folderBlock = (key: string, list: SessionRow[], limit: number, time: (r: SessionRow) => string, suffix = '') =>
      byFolder(list, limit).flatMap(group => [
        label(`${key}:${group.project}`, blank,
          <Text key="name" size={TYPE.meta} weight="medium" color={TOKENS.secondary}>{suffix ? `${group.project} · ${suffix}` : group.project}</Text>,
          <Text key="n" size={TYPE.meta} tabular color={TOKENS.muted}>{String(group.rows.length)}</Text>),
        ...group.rows.map(r => sessionRow(r, time(r), { hasRail: false, isLast: false, isMuted: true, inFolder: true })),
      ])

    // The group bar: All on the left (trip count muted, waiting count an amber
    // badge), the sidebar group Select on the right.
    const stats = groupStats(groups, tides.awake, waitingAll)
    const groupBar = (
      <Box key="gbar" flexDirection="row" justifyContent="space-between" alignItems="center" gap={S8} paddingBottom={S4}>
        <Box key="gall" flexDirection="row" alignItems="center" gap={S8} flexShrink={0} paddingX={isAll ? S4 : undefined} backgroundColor={isAll ? TOKENS.patinaTint : undefined}>
          <Button key="filter:all" variant={isAll ? 'primary' : 'secondary'} label="All" onPress={() => void pickGroup($, ALL)} />
          <Text size={TYPE.meta} mono tabular color={isAll ? TOKENS.patina : TOKENS.muted}>{String(tides.awake.length)}</Text>
          {waitingAll.length > 0 ? chip('all-badge', `${waitingAll.length} waiting`, TOKENS.warning) : undefined}
        </Box>
        {fields && (
          <Box key="gsel" flexDirection="row" alignItems="center" gap={S8} flexShrink={1} minWidth={0}>
            {!isAll && (
              <Svg
                source={`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" fill="none" stroke="${groupColour(filter, groups)}" stroke-width="2"/></svg>`}
                alt="group colour"
                width={12}
                height={12}
              />
            )}
            <fields.Select
              key="group"
              value={filter}
              options={[{ value: ALL, label: SELECT_PLACEHOLDER }, ...stats.map(g => ({ value: g.id, label: optionLabel(g) }))]}
              onSelect={value => void pickGroup($, value)}
            />
          </Box>
        )}
      </Box>
    )

    // The daily summary card: today's 3 to 5 lines, the meta line, Timeline and
    // Journal. Muted, on the overlay fill, grid steps only, no side accent.
    const jMeta = metaLine(jDay)
    const jFocus = focusOf(jDay, await $.clock.now())
    const jScale = await read($, journalScale)
    const jKeys = await scaleKeys($, jScale)
    const jKey = await shownKey($)
    const jAt = jKeys.indexOf(jKey)
    const jDocs = await read($, journalDocs)
    const jShown: JournalDay | JournalRollup | null | undefined =
      jScale === 'day' && jKey === jDay?.date ? jDay : jKey ? jDocs[`${SCALE_DIR[jScale]}/${jKey}`] : undefined
    const jText = (key: string, text: string, colour: string, size: (typeof TYPE)[keyof typeof TYPE] = TYPE.line2) => (
      <Box key={key} minWidth={0}>
        <Text size={size} color={colour}>{text}</Text>
      </Box>
    )
    const block = (key: string, head: string, lines: string[], isDim: boolean) => (
      <Box key={key} flexDirection="column" gap={S4} paddingTop={S4}>
        {jText(`${key}:head`, head, TOKENS.muted, TYPE.meta)}
        {lines.length
          ? lines.map((l, n) => jText(`${key}:${n}`, l, isDim ? TOKENS.muted : TOKENS.secondary))
          : jText(`${key}:none`, 'No lines.', TOKENS.muted)}
      </Box>
    )
    // One entry: the time in a muted mono column, the label, what was done, and "→ next" dimmer below.
    const entryRow = (key: string, en: JournalEntry) => (
      <Box key={key} flexDirection="row" gap={S8} alignItems="flex-start" paddingTop={S4} minWidth={0}>
        <Box key={`${key}:time`} flexShrink={0} width={6}>
          <Text size={TYPE.meta} mono tabular color={TOKENS.muted}>{clockOf(en.at, jTz)}</Text>
        </Box>
        <Box key={`${key}:body`} flexDirection="column" gap={S4} flexGrow={1} flexShrink={1} minWidth={0}>
          <Box key={`${key}:head`} flexDirection="row" flexWrap="wrap" gap={S4} minWidth={0}>
            <Box key={`${key}:label`} flexShrink={0}>
              <Text size={TYPE.line2} weight="semibold" color={TOKENS.primary}>{en.label}</Text>
            </Box>
            <Box key={`${key}:done`} flexShrink={1} minWidth={0}>
              <Text size={TYPE.line2} color={TOKENS.secondary}>{en.done}</Text>
            </Box>
          </Box>
          {en.next ? jText(`${key}:next`, `→ ${en.next}`, TOKENS.muted, TYPE.meta) : undefined}
        </Box>
      </Box>
    )
    const childScale = { day: 'day', week: 'day', month: 'week', year: 'month' } as const
    const browser = () => {
      const isDay = jScale === 'day'
      const day = isDay ? (jShown as JournalDay | null | undefined) : undefined
      const roll = isDay ? undefined : (jShown as JournalRollup | null | undefined)
      const lines = isDay ? dayLines(day) : roll?.lines ?? []
      const dayEntries = isDay ? newestEntries(day) : []
      const children = isDay && dayEntries.length
        ? dayEntries.map((en, n) => entryRow(`journal-child:${n}`, en))
        : isDay
        ? timeline(day).map((v, n) => block(`journal-child:${n}`, `${hourLabel(v.hour)}${v.quiet ? ' · quiet' : ''}`, v.lines, v.quiet === true))
        : [...(roll?.children ?? [])].reverse().map((c, n) => block(`journal-child:${n}`, periodLabel(childScale[jScale], c.key), c.lines, false))
      return (
        <Box key="journal-browser" flexDirection="column" gap={S8} paddingTop={S8}>
          <Box key="journal-scales" flexDirection="row" gap={S4}>
            {(['day', 'week', 'month', 'year'] as const).map(sc => (
              <Button key={`scale:${sc}`} variant={sc === jScale ? 'primary' : 'secondary'} label={sc[0]!.toUpperCase() + sc.slice(1)} onPress={() => void pickScale($, sc)} />
            ))}
          </Box>
          {jKey ? (
            <Box key="journal-nav" flexDirection="row" justifyContent="space-between" alignItems="center" gap={S8}>
              {jAt > 0 ? <Button key="journal-prev" variant="secondary" label="Previous" onPress={() => void stepPeriod($, -1)} /> : <Box key="journal-prev-none" />}
              <Box key="journal-period" flexShrink={1} minWidth={0}>
                <Text size={TYPE.meta} weight="medium" color={TOKENS.secondary} wrap="truncate-end">{periodLabel(jScale, jKey)}</Text>
              </Box>
              {jAt < jKeys.length - 1 ? <Button key="journal-next" variant="secondary" label="Next" onPress={() => void stepPeriod($, 1)} /> : <Box key="journal-next-none" />}
            </Box>
          ) : jText('journal-empty', `No ${jScale} summaries yet. The first comes when this ${jScale} ends.`, TOKENS.muted)}
          {jKey && (
            <Box key="journal-period-lines" flexDirection="column" gap={S4}>
              {lines.length
                ? lines.map((l, n) => jText(`journal-period-line:${n}`, l, TOKENS.primary))
                : jText('journal-period-none', isDay && day && !day.closed ? 'Open day. It closes at midnight.' : 'No summary lines.', TOKENS.muted)}
            </Box>
          )}
          {children}
        </Box>
      )
    }
    const jDate = jDay ? dateLabel(jDay.date) : ''
    const journalCard = (
      <Box key="journal-wrap" flexDirection="column" paddingBottom={S8}>
        <Box key="journal" flexDirection="column" gap={S4} paddingX={S8} paddingY={S8} backgroundColor={TOKENS.overlay} borderStyle="round" borderColor={TOKENS.hair}>
          <Box key="journal-head" flexDirection="row" justifyContent="space-between" alignItems="center" gap={S8}>
            <Text key="journal-title" size={TYPE.line2} weight="semibold" color={TOKENS.primary}>Today</Text>
            {jDate && <Text key="journal-date" size={TYPE.meta} mono color={TOKENS.muted}>{jDate}</Text>}
          </Box>
          {jFocus && jText('journal-focus', `Focus: ${jFocus}`, TOKENS.signal, TYPE.meta)}
          {jEntries.slice(0, CARD_ENTRIES).flatMap((en, n) => [n > 0 ? hairline(`journal-rule:${n}`) : undefined, entryRow(`journal-entry:${n}`, en)])}
          {jLines.map((l, n) => jText(`journal-line:${n}`, l, TOKENS.primary))}
          {isJournalEmpty && jText('journal-first', FIRST_LINE, TOKENS.muted)}
          {hairline('journal-foot-rule')}
          <Box key="journal-acts" flexDirection="row" justifyContent="space-between" alignItems="center" gap={S8} paddingTop={S4}>
            <Box key="journal-foot-meta" flexShrink={1} minWidth={0}>
              {jMeta ? jText('journal-meta', jMeta, TOKENS.muted, TYPE.meta) : <Box key="journal-meta-none" />}
            </Box>
            <Box key="journal-foot-btns" flexDirection="row" gap={S4} flexShrink={0}>
              {isJournalEmpty && <Button key="journal-now" variant="secondary" label={jBusy ? 'Updating' : 'Update now'} onPress={updateNow} />}
              {(jDay?.versions.length ?? 0) > 0 && <Button key="journal-timeline" variant={jOpen === 'timeline' ? 'primary' : 'secondary'} label="Timeline" onPress={() => void flipTimeline($)} />}
              <Button key="journal-browse" variant={jOpen === 'journal' ? 'primary' : 'secondary'} label="Journal" onPress={() => void flipJournal($)} />
            </Box>
          </Box>
          {jOpen === 'timeline' && (
            <Box key="journal-timeline-list" flexDirection="column" gap={S4}>
              {jEntries.length
                ? jEntries.map((en, n) => entryRow(`timeline:${jEntries.length - 1 - n}`, en))
                : timeline(jDay).map((v, n) =>
                  block(`timeline:${(jDay?.versions.length ?? 0) - 1 - n}`, `${hourLabel(v.hour)}${v.quiet ? ' · quiet' : v.reason ? ' · kept' : ''}`, v.lines, v.quiet === true))}
            </Box>
          )}
          {jOpen === 'journal' && browser()}
        </Box>
      </Box>
    )

    const parked = searchParked(resting, archive, q)
    const platformRows = [...undoOnPlatform, ...view.shown]
    const muted = (key: string, text: string) =>
      lane(key, blank, <Text key="t" size={TYPE.line2} color={TOKENS.muted}>{text}</Text>, { top: S8, bottom: S8 }, {}, 32)

    return (
      <Box flexDirection="column" backgroundColor={TOKENS.raised} borderStyle="round" borderColor={TOKENS.hair} paddingX={S8} paddingY={S8}>
        {journalCard}
        {groupBar}

        {(view.waiting.length > 0 || other.count > 0 || undoOnPlatform.length > 0) && [
          label('platform', blank,
            caption('name', 'PLATFORM', TOKENS.warning),
            <Text key="n" size={TYPE.meta} mono tabular color={TOKENS.muted}>{view.waiting.length ? `${view.waiting.length} of ${view.waiting.length + awake.length} blocked` : 'none here'}</Text>),
          platformRows.length > 0 && (
            <Box key="platform-panel" flexDirection="column" backgroundColor={TOKENS.overlay} borderStyle="round" borderColor={TOKENS.hair}>
              {platformRows.flatMap((r, n) => [
                n > 0 ? hairline(`platform-rule:${n}`) : undefined,
                sessionRow(r, timeLabel(r, nowMs), { hasRail: false, isLast: false, isMuted: false, isPlatform: true }),
              ])}
            </Box>
          ),
          (view.more > 0 || (isPlatformOpen && view.waiting.length > PLATFORM_MAX)) &&
            fold('platform-more', isPlatformOpen ? `Showing all ${view.waiting.length} waiting` : moreLine(view), TOKENS.warning, () => void flipPlatform($), isPlatformOpen ? 'fewer' : 'show'),
          other.count > 0 &&
            lane('elsewhere', blank, (
              <Box key="elsewhere-row" flexDirection="row" justifyContent="space-between" alignItems="center" gap={S8} paddingX={S8} paddingY={S4} backgroundColor={TOKENS.warningTint}>
                <Box flexShrink={1} minWidth={0}>
                  <Text size={TYPE.line2} color={TOKENS.warning} wrap="truncate-end">{elsewhereLine(other)}</Text>
                </Box>
                <Button key="elsewhere" variant="secondary" label="Show all" onPress={() => void pickGroup($, ALL)} />
              </Box>
            ), { top: S4, bottom: S4 }, {}, 36),
        ]}

        {awake.length > 0 && label('last24', blank, caption('name', 'LAST 24 HOURS'), <Text key="n" size={TYPE.meta} mono tabular color={TOKENS.muted}>{String(awake.length)}</Text>)}
        {awake.length > 0 &&
          lane('now', { kind: 'now' }, (
            <Box key="now-row" flexDirection="row" alignItems="center" gap={S8}>
              <Text size={TYPE.meta} weight="medium" color={TOKENS.signal}>now</Text>
              <Box key="hairline" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                <Svg source={barSvg(column - 32, 1, TOKENS.subtle)} alt="divider" width={Math.max(1, column - 32)} height={1} />
              </Box>
            </Box>
          ), { top: S12, bottom: S4 }, {}, LABEL_H)}
        {items.map((item, n) => {
          if (item.kind === 'hour')
            return label(`h${n}`, { kind: 'hour' }, <Text key="t" size={TYPE.meta} mono tabular color={TOKENS.muted}>{item.label}</Text>)
          if (item.kind === 'gap')
            return label(`g${n}`, { kind: 'gap' }, <Text key="t" size={TYPE.meta} mono tabular color={TOKENS.muted}>{`// ${item.label} quiet`}</Text>)
          return sessionRow(item.row, timeLabel(item.row, nowMs), { hasRail: true, isLast: item === lastRow, isMuted: false })
        })}
        {awake.length === 0 && muted('empty', isAll ? 'No sessions in the last 24 h.' : `No trips in ${groupName} in the last 24 h.`)}

        {fields &&
          lane('search', blank, (
            <fields.Input
              key="search"
              placeholder={SEARCH_PLACEHOLDER}
              value={q}
              onInput={value => void setQuery($, value)}
              onSubmit={value => void setQuery($, value)}
            />
          ), { top: S12, bottom: S4 }, {}, 44)}

        {parked.isSearching && parked.total === 0 && muted('no-match', noMatchLine(q))}
        {parked.isSearching && parked.total > 0 && [
          ...folderBlock('sidings', parked.resting, parked.resting.length, r => timeLabel(r, nowMs), 'Sidings'),
          ...folderBlock('depot', parked.archive, parked.archive.length, ageLabel, 'Depot'),
        ]}
        {!parked.isSearching && [
          fold('resting', 'Sidings', TOKENS.muted, () => void flipResting($), isRestingOpen ? 'hide' : 'show', `1 to 7 days · ${resting.length}`, true),
          ...(isRestingOpen ? folderBlock('sidings', resting, restingCount, r => timeLabel(r, nowMs)) : []),
          isRestingOpen && resting.length > restingCount &&
            fold('resting-more', `+${resting.length - restingCount} more`, TOKENS.muted, () => void showMoreResting($), 'show'),
          fold('archive', 'Depot', TOKENS.muted, () => void flipArchive($), isArchiveOpen ? 'hide' : 'show', `over 7 days · ${archive.length}`, true),
          ...(isArchiveOpen ? folderBlock('depot', archive, SHOWN_STEP, ageLabel) : []),
        ]}
      </Box>
    )
  })
}
