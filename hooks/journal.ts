// The daily summary: an hourly action journal written by Haiku through
// `$.model.complete` (the session's own credentials), stored as JSON in the
// journal folder (~/.claude/trips-journal/ by default) by the Python store in
// journal-store.ts.
//
// One tick every 5 minutes. A tick reads the store; when there is work (a past
// day still open, a week, month or year that ended, or no version in this
// hour yet), it takes the lease, reads again, closes past days first, writes
// the rollups that came due, then this hour's version, and lets the lease go.
import type { EngineInterface } from 'claude-code'

import type { JournalDay, JournalEntry, JournalLists, JournalRollup, JournalVersion, SessionRow } from '../types'
import { JOURNAL_PY } from './journal-store'

/** The store's default folder; the Python store resolves the home folder at run time. */
export const JOURNAL_ROOT = '~/.claude/trips-journal'
let journalRoot = JOURNAL_ROOT
/** Points the store at the `journalDir` option: blank means the default folder. */
export function setJournalRoot(dir: unknown) {
  journalRoot = typeof dir === 'string' && dir.trim() ? dir.trim() : JOURNAL_ROOT
}
export const journalRootNow = () => journalRoot
export const JOURNAL_MODEL = 'haiku'
export const JOURNAL_TICK_MS = 5 * 60 * 1000
export const LEASE_MS = 10 * 60 * 1000
export const MIN_LINES = 3
export const MAX_LINES = 5
const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS
const MAX_ROWS = 20

export const JOURNAL_INTRO = 'You keep the interstitial journal of a person who works with Claude Code: the short notes they would jot in a pocket notebook between tasks.'

/** The rules every entry follows, the hourly run's and the backfill's. */
export const ENTRY_RULES = [
  'label: the session or project in at most 4 words, such as "Trips journal" or "LedgerLoop invoices".',
  'done: one sentence in the past tense that names the concrete thing finished or changed: a file, feature, ticket, decision or page. Example: "Added the hourly entry trail to the Trips card."',
  'next: one short imperative sentence with the next step, such as "Ship the invoice footer." Use "" when there is none.',
  'Never describe a status: no "ready for review", "awaits review", "waiting" or "in progress". Never give advice such as "check each session". Never count sessions or projects.',
  'Never start done with "Now:", "Past hour:" or "Next:".',
  'At most 16 words per sentence. Plain words, British spelling, no semicolons, no em dashes, no contractions.',
]

/** The hourly run's system prompt: one interstitial entry per session touched. */
export const JOURNAL_SYSTEM = [
  JOURNAL_INTRO,
  'You get the sessions they touched since the last note. Write exactly one entry per session.',
  'Reply with a JSON array only, one object per session: {"sessionId": "...", "label": "...", "done": "...", "next": "..."}.',
  ...ENTRY_RULES,
].join('\n')

/** The day close's system prompt. */
export const CLOSE_SYSTEM = [
  'You close the day of a person who works with Claude Code, from the journal entries they jotted between tasks.',
  'Write 3 to 5 lines. Never more than 5, never fewer than 3. Each line is one past-tense sentence of at most 16 words.',
  'Each line names concrete work done: a feature, file, ticket, decision or page. Example: "Shipped the invoice export page."',
  'The last line starts "Tomorrow:" with the next concrete step.',
  'Never describe a status such as "ready for review" or "awaits review", never give advice, never count sessions or projects.',
  'Plain words, British spelling, no semicolons, no em dashes, no contractions, no bullets, no numbering, no headings, no preamble.',
  'Reply with the lines only, one per line.',
].join('\n')

const ROLLUP_WORDS = { week: ['week', 'daily'], month: ['month', 'weekly'], year: ['year', 'monthly'] } as const

/** The week, month or year rollup's system prompt. */
export const rollupSystem = (kind: 'week' | 'month' | 'year') => {
  const [period, child] = ROLLUP_WORDS[kind]
  return [
    `You write the summary of one ${period} of a person's work, from their ${child} summaries.`,
    'Write 3 to 5 lines. Never more than 5, never fewer than 3. Each line is one past-tense sentence of at most 16 words.',
    'Each line names concrete work done: a feature, file, ticket, decision or page. Example: "Shipped the invoice export page."',
    'The last line starts "Carry on:" with what is still open.',
    'Never describe a status such as "ready for review" or "awaits review", never give advice, never count sessions or projects.',
    'Plain words, British spelling, no semicolons, no em dashes, no contractions, no bullets, no numbering, no headings, no preamble.',
    'Reply with the lines only, one per line.',
  ].join('\n')
}

// ---- Lines ------------------------------------------------------------------

const BULLET = /^(?:[-*+•·◦‣▪●○>]+|\(?\d{1,2}[.):]|[a-e][.)]|#+)\s*/u

/** The model's reply as journal lines: bullets and numbering stripped, empties dropped, 5 at most. */
export function cleanLines(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    for (let n = 0; n < 3 && BULLET.test(line); n++) line = line.replace(BULLET, '').trim()
    line = line.replace(/\*\*|__/g, '').replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim()
    if (!line) continue
    out.push(line)
    if (out.length === MAX_LINES) break
  }
  return out
}

/** Status talk, advice, counts and the old formula: never in an entry or a close line. */
const BANNED = [
  /\b(?:ready for (?:your )?review|awaits? (?:your )?review|awaiting (?:your )?review|waiting (?:on|for) (?:you|review)|in progress|check each session|before continuing)\b/i,
  /^(?:now|past hour|next)\s*:/i,
  /\b\d+\s+(?:sessions|projects)\b/i,
  /\b(?:sessions|projects) touched\b/i,
  /[;—]/,
]
export const isBanned = (text: string) => BANNED.some(re => re.test(text))

/** Every sentence holds at most `max` words. */
export const shortSentences = (text: string, max = 16) =>
  text.split(/(?<=[.!?])\s+/).every(sentence => sentence.split(/\s+/).filter(Boolean).length <= max)

/** The lines when the reply holds 3 to 5 of them, banned lines dropped, else undefined. */
export function validLines(text: string): string[] | undefined {
  const lines = cleanLines(text).filter(l => !isBanned(l))
  return lines.length >= MIN_LINES ? lines : undefined
}

// ---- Entries ----------------------------------------------------------------

const words = (s: string, n: number) => s.split(/\s+/).filter(Boolean).slice(0, n).join(' ')
const firstSentence = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  const m = /^.*?[.!?](?=\s|$)/.exec(t)
  return (m ? m[0] : t).trim()
}
const asSentence = (s: string) => (s && !/[.!?]$/.test(s) ? `${s}.` : s)

/** A session's short name: its title, else its folder, 4 words at most. */
export const shortLabel = (row: SessionRow) => words((row.title || row.project || row.id.slice(0, 8)).replace(/[:|]/g, ' '), 4)

/** An entry from the session's own text, no model: the wrap-up, recap, report or detail, and its ask. */
export function fallbackEntry(row: SessionRow): JournalEntry {
  const sources = [row.wrapUp, row.recap, row.report, row.detail].map(t => firstSentence(t ?? '')).filter(Boolean)
  const done = sources.find(t => !isBanned(t)) ?? `Worked on ${row.title || row.project || 'a session'}.`
  const next = firstSentence(row.nextAction)
  return { at: row.mtimeMs, sessionId: row.id, label: shortLabel(row), done: asSentence(words(done, 24)), next: next && !isBanned(next) ? asSentence(words(next, 16)) : '' }
}

/**
 * The model's JSON array as entries, one per touched session. An item that is
 * missing, malformed, over 16 words a sentence or holds status talk falls back
 * to the session's own text. `fallbacks` counts those.
 */
export function parseEntries(text: string, rows: SessionRow[]): { entries: JournalEntry[]; fallbacks: number } {
  let items: unknown[] = []
  try {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    const data = start >= 0 && end > start ? (JSON.parse(text.slice(start, end + 1)) as unknown) : undefined
    if (Array.isArray(data)) items = data
  } catch {
    items = []
  }
  const byId = new Map<string, JournalEntry>()
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const it = raw as Record<string, unknown>
    const row = rows.find(r => r.id === it.sessionId)
    if (!row || byId.has(row.id)) continue
    const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
    const done = clean(it.done)
    const next = clean(it.next)
    if (!done || isBanned(done) || (next && isBanned(next)) || !shortSentences(done) || !shortSentences(next)) continue
    byId.set(row.id, { at: row.mtimeMs, sessionId: row.id, label: words(clean(it.label), 4) || shortLabel(row), done: asSentence(done), next: asSentence(next) })
  }
  const entries = rows.map(r => byId.get(r.id) ?? fallbackEntry(r))
  return { entries, fallbacks: rows.length - byId.size }
}

/** Today's entries with new ones added: one per session and turn time, oldest first. */
export function mergeEntries(old: JournalEntry[], add: JournalEntry[]): JournalEntry[] {
  const seen = new Set(old.map(e => `${e.sessionId}@${e.at}`))
  const out = [...old]
  for (const e of add) {
    const k = `${e.sessionId}@${e.at}`
    if (!seen.has(k)) {
      seen.add(k)
      out.push(e)
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** The newest entries first, `n` at most. */
export const newestEntries = (day: JournalDay | null | undefined, n = Infinity) => [...(day?.entries ?? [])].reverse().slice(0, n)

/** The session that clearly led the last 2 hours: at least 2 entries and more than half of them. */
export function focusOf(day: JournalDay | null | undefined, now: number): string {
  const recent = (day?.entries ?? []).filter(e => e.at > now - 2 * HOUR_MS && e.at <= now)
  const counts = new Map<string, number>()
  for (const e of recent) counts.set(e.sessionId, (counts.get(e.sessionId) ?? 0) + 1)
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (!top || top[1] < 2 || top[1] * 2 <= recent.length) return ''
  return [...recent].reverse().find(e => e.sessionId === top[0])?.label ?? ''
}

// ---- Dates (local time, from the store's offset in minutes east of UTC) -------

const pad = (n: number) => String(n).padStart(2, '0')
const shifted = (ms: number, tz: number) => new Date(ms + tz * 60000)

export const dayKey = (ms: number, tz: number) => {
  const d = shifted(ms, tz)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
export const hourOf = (ms: number, tz: number) => shifted(ms, tz).getUTCHours()
export const clockOf = (ms: number, tz: number) => {
  const d = shifted(ms, tz)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}
export const hourLabel = (hour: number) => `${pad(hour)}:00`

const utcOfDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
}
const keyOfUtc = (t: number) => dayKey(t, 0)

/** The ISO week of a day key: `2026-W46`. The week's year is its Thursday's. */
export function weekKey(day: string): string {
  const t = utcOfDay(day)
  const dow = (new Date(t).getUTCDay() + 6) % 7
  const thu = t + (3 - dow) * DAY_MS
  const year = new Date(thu).getUTCFullYear()
  const week = 1 + Math.floor((thu - Date.UTC(year, 0, 1)) / (7 * DAY_MS))
  return `${year}-W${pad(week)}`
}

/** The Thursday of an ISO week, as a day key. */
export function thursdayOf(week: string): string {
  const [ys, ws] = week.split('-W')
  const year = Number(ys)
  const jan4 = Date.UTC(year, 0, 4)
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS
  return keyOfUtc(monday + (Number(ws) - 1) * 7 * DAY_MS + 3 * DAY_MS)
}

/** The month a week belongs to: its Thursday's, as ISO years do. */
export const monthOfWeek = (week: string) => thursdayOf(week).slice(0, 7)

/** The last ISO week that belongs to a month. */
export function lastWeekOf(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const last = Date.UTC(y!, m!, 0)
  const dow = (new Date(last).getUTCDay() + 6) % 7
  const thu = last - ((dow - 3 + 7) % 7) * DAY_MS
  return weekKey(keyOfUtc(thu))
}

/** A month has ended once its days and its last week are past. */
export const monthEnded = (month: string, today: string) => today.slice(0, 7) > month && weekKey(today) > lastWeekOf(month)

/** The rollups that came due on `today`, given what is stored: weeks, then months, then years. */
export function dueRollups(lists: JournalLists, today: string): { weeks: string[]; months: string[]; years: string[] } {
  const week = weekKey(today)
  const uniq = (xs: string[]) => [...new Set(xs)].sort()
  const weeks = uniq(lists.days.filter(d => d < today).map(weekKey)).filter(w => w < week && !lists.weeks.includes(w))
  const allWeeks = uniq([...lists.weeks, ...weeks])
  const months = uniq(allWeeks.map(monthOfWeek)).filter(m => monthEnded(m, today) && !lists.months.includes(m))
  const allMonths = uniq([...lists.months, ...months])
  const years = uniq(allMonths.map(m => m.slice(0, 4))).filter(y => monthEnded(`${y}-12`, today) && !lists.years.includes(y))
  return { weeks, months, years }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** A period's name for the browser: `Wednesday 11 November 2026`, `Week 46, 2026`, `November 2026`, `2026`. */
export function periodLabel(scale: 'day' | 'week' | 'month' | 'year', key: string): string {
  if (scale === 'day') {
    const d = new Date(utcOfDay(key))
    return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  }
  if (scale === 'week') return `Week ${Number(key.split('-W')[1])}, ${key.slice(0, 4)}`
  if (scale === 'month') return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`
  return key
}

// ---- The store --------------------------------------------------------------

export type StoreState = {
  root: string
  tzOffsetMin: number
  lists: JournalLists
  recent: Record<string, JournalDay | null>
}

/** One op of the Python store. Rejects when the store fails, so the tick stops. */
export async function store<T>($: EngineInterface, op: 'state' | 'read' | 'write' | 'lease' | 'release' | 'mark', arg: unknown): Promise<T> {
  const run = await $.process.run(['python3', '-I', '-c', JOURNAL_PY, op, JSON.stringify(arg), journalRoot], { timeoutMs: 15000 })
  if (run.exitCode !== 0) throw new Error(`journal store ${op} failed: ${run.stderr.slice(0, 200)}`)
  return JSON.parse(run.stdout) as T
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function normaliseDay(v: unknown, date: string): JournalDay {
  const d = (v && typeof v === 'object' ? v : {}) as Partial<JournalDay>
  const versions = Array.isArray(d.versions)
    ? d.versions.filter((x): x is JournalVersion => !!x && typeof x === 'object' && typeof x.hour === 'number').map(x => ({ ...x, lines: asList(x.lines), sources: asList(x.sources) }))
    : []
  const entries = Array.isArray(d.entries)
    ? d.entries.filter((e): e is JournalEntry => !!e && typeof e === 'object' && typeof e.at === 'number' && typeof e.sessionId === 'string' && typeof e.done === 'string')
      .map(e => ({ at: e.at, sessionId: e.sessionId, label: String(e.label ?? ''), done: e.done, next: typeof e.next === 'string' ? e.next : '' }))
    : []
  return {
    date: typeof d.date === 'string' ? d.date : date,
    lines: asList(d.lines),
    versions,
    entries,
    closed: d.closed === true,
    ...(d.close && typeof d.close === 'object' ? { close: { ...d.close, lines: asList(d.close.lines) } } : {}),
  }
}

export function normaliseState(v: unknown): StoreState {
  const s = (v && typeof v === 'object' ? v : {}) as Partial<StoreState>
  if (typeof s.tzOffsetMin !== 'number' || !s.lists) throw new Error('journal store: no state')
  const l = s.lists as Partial<JournalLists>
  const recent: Record<string, JournalDay | null> = {}
  for (const [k, d] of Object.entries(s.recent ?? {})) recent[k] = d ? normaliseDay(d, k) : null
  return {
    root: String(s.root ?? ''),
    tzOffsetMin: s.tzOffsetMin,
    lists: { days: asList(l.days), weeks: asList(l.weeks), months: asList(l.months), years: asList(l.years) },
    recent,
  }
}

export const emptyLists = (): JournalLists => ({ days: [], weeks: [], months: [], years: [] })

/** The lines a day shows: its close when closed, else its current lines. */
export const dayLines = (d: JournalDay | null | undefined) => (d?.close?.lines.length ? d.close.lines : d?.lines ?? [])

// ---- Model ------------------------------------------------------------------

export type Asked = { lines?: string[]; text?: string; reason?: string }

/** Every model call this module made, so /trips setup can count its own. */
export const modelCalls = { n: 0 }

export async function ask($: EngineInterface, system: string, prompt: string, maxTokens = 400): Promise<Asked> {
  modelCalls.n += 1
  try {
    const r = await $.model.complete({ model: JOURNAL_MODEL, system, prompt, maxTokens, timeoutMs: 60000 })
    if (!r.isAnswered) return { reason: r.reason === 'api-error' ? `api-error ${r.error}` : r.reason }
    const lines = validLines(r.text)
    return lines ? { lines, text: r.text } : { text: r.text, reason: `short reply: ${cleanLines(r.text).filter(l => !isBanned(l)).length} lines` }
  } catch (err) {
    return { reason: `refused: ${String(err).slice(0, 120)}` }
  }
}

const one = (s: string, max = 200) => s.replace(/\s+/g, ' ').trim().slice(0, max)

/** The hourly prompt: the time, today's last entries, and each session touched with its own words. */
export function hourPrompt(now: number, tz: number, earlier: JournalEntry[], rows: SessionRow[]): string {
  const d = shifted(now, tz)
  const head = `Now: ${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${clockOf(now, tz)}.`
  const prev = earlier.length ? earlier.slice(-6).map(e => `${clockOf(e.at, tz)} ${e.label}: ${e.done}`).join('\n') : '(none yet today)'
  const list = rows.slice(0, MAX_ROWS).map(r => {
    const parts = [`sessionId ${r.id}`, `title "${one(r.title, 100)}"`, `project ${r.project || 'unknown'}`]
    if (r.groupName) parts.push(`group ${r.groupName}`)
    if (r.wrapUp) parts.push(`wrap-up: ${one(r.wrapUp, 400)}`)
    else if (r.recap) parts.push(`recap: ${one(r.recap)}`)
    if (r.report && r.report !== r.wrapUp) parts.push(`turn report: ${one(r.report, 400)}`)
    if (r.detail) parts.push(`detail: ${one(r.detail, 400)}`)
    if (r.lastPrompt) parts.push(`their last prompt: ${one(r.lastPrompt, 160)}`)
    if (r.nextAction) parts.push(`asks them: ${one(r.nextAction)}`)
    parts.push(`turn ended ${clockOf(r.mtimeMs, tz)}`)
    return parts.join('; ')
  })
  return `${head}\n\nEarlier notes today:\n${prev}\n\nSessions touched since the last note, newest first:\n${list.join('\n')}`
}

export function closePrompt(day: JournalDay, tz = 0): string {
  if (day.entries?.length) {
    const notes = day.entries.map(e => `${clockOf(e.at, tz)} ${e.label}: ${e.done}${e.next ? ` Next: ${e.next}` : ''}`)
    return `Day: ${periodLabel('day', day.date)}.\n\nJournal entries, oldest first:\n${notes.join('\n')}`
  }
  const entries = day.versions.filter(v => !v.quiet && v.lines.length).map(v => `${hourLabel(v.hour)}\n${v.lines.join('\n')}`)
  return `Day: ${periodLabel('day', day.date)}.\n\nHourly entries:\n\n${entries.join('\n\n')}`
}

/** A close without the model: the newest done of each session, 5 at most, else the old lines. */
export function fallbackClose(day: JournalDay): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of newestEntries(day)) {
    if (seen.has(e.sessionId)) continue
    seen.add(e.sessionId)
    out.push(`${e.label}: ${e.done}`)
    if (out.length === MAX_LINES) break
  }
  return out.length ? out : day.lines
}

export function rollupPrompt(kind: 'week' | 'month' | 'year', key: string, children: JournalRollup['children']): string {
  const scale = kind === 'week' ? 'day' : kind === 'month' ? 'week' : 'month'
  const parts = children.filter(c => c.lines.length).map(c => `${periodLabel(scale, c.key)}\n${c.lines.join('\n')}`)
  return `${kind[0]!.toUpperCase()}${kind.slice(1)}: ${periodLabel(kind, key)}.\n\nSummaries:\n\n${parts.join('\n\n')}`
}

// ---- The tick ---------------------------------------------------------------

export type TickResult = {
  state?: StoreState
  today?: JournalDay | null
  /** What the tick did: 'idle' (nothing due), 'lease' (another session writes), 'wrote', 'error', 'backoff'. */
  outcome: 'idle' | 'lease' | 'wrote' | 'error' | 'backoff'
  error?: string
}

/**
 * One mod instance's memory across ticks. `made` keeps what the model wrote for
 * each slot (a close, a rollup, an hour's version), so a failed store write is
 * retried without a second model call. `written` holds the slots that landed.
 * After an error the ticks back off: 5, 10, 20, 40, then 60 minutes.
 */
export type JournalMemo = { made: Map<string, unknown>; written: Set<string>; fails: number; waitUntil: number }
export const newMemo = (): JournalMemo => ({ made: new Map(), written: new Set(), fails: 0, waitUntil: 0 })
const MEMO_MAX = 64

async function once<T>(memo: JournalMemo, slot: string, make: () => Promise<T>): Promise<T> {
  if (memo.made.has(slot)) return memo.made.get(slot) as T
  const made = await make()
  memo.made.set(slot, made)
  while (memo.made.size > MEMO_MAX) memo.made.delete(memo.made.keys().next().value as string)
  return made
}

const lastVersionAt = (recent: Record<string, JournalDay | null>) => {
  let at = 0
  for (const d of Object.values(recent)) for (const v of d?.versions ?? []) at = Math.max(at, Date.parse(v.at) || 0)
  return at
}

/** Whether a tick has anything to write: a past day open, a rollup due, or this hour's slot empty. */
export function hasWork(st: StoreState, now: number, force: boolean): boolean {
  const today = dayKey(now, st.tzOffsetMin)
  const hour = hourOf(now, st.tzOffsetMin)
  if (Object.entries(st.recent).some(([k, d]) => k < today && d && !d.closed)) return true
  const due = dueRollups(st.lists, today)
  if (due.weeks.length || due.months.length || due.years.length) return true
  const doc = st.recent[today]
  if (doc?.closed) return false
  return force || !doc?.versions.some(v => v.hour === hour)
}

export async function closeDay($: EngineInterface, day: JournalDay, at: string, tz: number): Promise<JournalDay> {
  const said = (day.entries?.length ?? 0) > 0 || day.versions.some(v => !v.quiet && v.lines.length)
  if (!said) return { ...day, closed: true, close: { at, lines: day.lines, reason: 'no activity' } }
  const r = await ask($, CLOSE_SYSTEM, closePrompt(day, tz))
  return { ...day, closed: true, close: r.lines ? { at, lines: r.lines } : { at, lines: fallbackClose(day), reason: r.reason } }
}

async function rollup($: EngineInterface, kind: 'week' | 'month' | 'year', key: string, children: JournalRollup['children'], at: string): Promise<JournalRollup> {
  if (!children.some(c => c.lines.length)) return { kind, key, at, lines: [], reason: 'no activity', children }
  const r = await ask($, rollupSystem(kind), rollupPrompt(kind, key, children))
  if (r.lines) return { kind, key, at, lines: r.lines, children }
  // The call failed: the first line of each child stands in, so the period still reads.
  return { kind, key, at, lines: children.map(c => c.lines[0]).filter((l): l is string => !!l).slice(0, MAX_LINES), reason: r.reason, children }
}

/**
 * The rollups that came due on `today`, written under the caller's lease:
 * weeks from dailies, months from weeklies, years from monthlies. `st.lists`
 * is updated as each lands. Shared by the hourly tick and /trips setup.
 */
export async function writeRollups(
  $: EngineInterface,
  st: StoreState,
  today: string,
  at: string,
  memo: JournalMemo,
  put: (path: string, data: unknown, slot: string) => Promise<void>,
  renew: () => Promise<void>,
): Promise<{ weeks: number; months: number; years: number }> {
  const due = dueRollups(st.lists, today)
  if (due.weeks.length) {
    const need = st.lists.days.filter(d => due.weeks.includes(weekKey(d)) && !(d in st.recent)).map(d => `days/${d}`)
    const files = need.length ? (await store<{ files: Record<string, unknown> }>($, 'read', { paths: need })).files : {}
    for (const w of due.weeks) {
      const children = st.lists.days.filter(d => weekKey(d) === w).map(d => ({
        key: d, lines: dayLines(d in st.recent ? st.recent[d] : normaliseDay(files[`days/${d}`], d)),
      }))
      const slot = `week:${w}`
      if (!memo.made.has(slot)) await renew()
      await put(`weeks/${w}`, await once(memo, slot, () => rollup($, 'week', w, children, at)), slot)
      st.lists.weeks = [...st.lists.weeks, w].sort()
    }
  }
  for (const [kind, keys, childDir, belongs] of [
    ['month', due.months, 'weeks', (child: string, key: string) => monthOfWeek(child) === key],
    ['year', due.years, 'months', (child: string, key: string) => child.slice(0, 4) === key],
  ] as const) {
    if (!keys.length) continue
    const childKeys = (childDir === 'weeks' ? st.lists.weeks : st.lists.months).filter(c => keys.some(k => belongs(c, k)))
    const files = (await store<{ files: Record<string, unknown> }>($, 'read', { paths: childKeys.map(c => `${childDir}/${c}`) })).files
    for (const key of keys) {
      const children = childKeys.filter(c => belongs(c, key)).map(c => {
        const f = files[`${childDir}/${c}`] as Partial<JournalRollup> | null | undefined
        return { key: c, lines: asList(f?.lines) }
      })
      const slot = `${kind}:${key}`
      if (!memo.made.has(slot)) await renew()
      await put(`${kind === 'month' ? 'months' : 'years'}/${key}`, await once(memo, slot, () => rollup($, kind, key, children, at)), slot)
      if (kind === 'month') st.lists.months = [...st.lists.months, key].sort()
      else st.lists.years = [...st.lists.years, key].sort()
    }
  }
  return { weeks: due.weeks.length, months: due.months.length, years: due.years.length }
}

/**
 * One journal tick. `rows` are the scanner's rows; `force` is Update now (write
 * this hour even when its slot holds a version). Never throws.
 */
export async function journalTick($: EngineInterface, opts: { holder: string; rows: SessionRow[]; force?: boolean; memo?: JournalMemo }): Promise<TickResult> {
  const force = opts.force === true
  const memo = opts.memo ?? newMemo()
  let state: StoreState | undefined
  let now = 0
  try {
    now = await $.clock.now()
    if (!force && now < memo.waitUntil) return { outcome: 'backoff' }
    state = normaliseState(await store($, 'state', { now, recent: 3 }))
    const today0 = dayKey(now, state.tzOffsetMin)
    if (!hasWork(state, now, force)) return { state, today: state.recent[today0] ?? null, outcome: 'idle' }

    const lease = await store<{ held: boolean }>($, 'lease', { holder: opts.holder, now, ttlMs: LEASE_MS })
    if (!lease.held) return { state, today: state.recent[today0] ?? null, outcome: 'lease' }
    try {
      // Read again under the lease: another session may have written meanwhile.
      const st = normaliseState(await store($, 'state', { now, recent: 3 }))
      state = st
      const tz = st.tzOffsetMin
      const today = dayKey(now, tz)
      const hour = hourOf(now, tz)
      const at = new Date(now).toISOString()
      const put = async (path: string, data: unknown, slot: string) => {
        await store($, 'write', { writes: [{ path, data }] })
        memo.written.add(slot)
      }
      // Renew the lease before each step that may call the model: a long catch-up outlasts one lease.
      const renew = async () => {
        const got = await store<{ held: boolean }>($, 'lease', { holder: opts.holder, now: await $.clock.now(), ttlMs: LEASE_MS })
        if (!got.held) throw new Error('journal lease lost')
      }

      // 1. Close every past day still open, before any version of today.
      for (const [key, doc] of Object.entries(st.recent).sort(([a], [b]) => a.localeCompare(b))) {
        if (key >= today || !doc || doc.closed) continue
        const slot = `close:${key}`
        if (!memo.made.has(slot)) await renew()
        const close = await once(memo, slot, async () => (await closeDay($, doc, at, tz)).close)
        const closed: JournalDay = { ...doc, closed: true, close }
        await put(`days/${key}`, closed, slot)
        st.recent[key] = closed
      }

      // 2. Rollups that came due: weeks from dailies, months from weeklies, years from monthlies.
      await writeRollups($, st, today, at, memo, put, renew)

      // 3. This hour's version, never into a closed day, once per hour unless forced.
      const doc = st.recent[today] ?? normaliseDay(null, today)
      if (!doc.closed && (force || !doc.versions.some(v => v.hour === hour))) {
        const since = force ? now - HOUR_MS : Math.max(lastVersionAt(st.recent), now - HOUR_MS)
        const touched = opts.rows.filter(r => r.mtimeMs > since).sort((a, b) => b.mtimeMs - a.mtimeMs)
        // One model call per hour slot in this instance: a failed write is retried
        // with the lines already made. Update now after a landed write is a new slot.
        const base = `version:${today}:${hour}`
        const slot = force && memo.written.has(base) ? `${base}:force:${now}` : base
        if (!memo.made.has(slot) && touched.length) await renew()
        const made = await once(memo, slot, async (): Promise<{ version: JournalVersion; entries: JournalEntry[] }> => {
          if (!touched.length) return { version: { at, hour, lines: doc.lines, quiet: true, sources: [], entries: 0 }, entries: [] }
          const some = touched.slice(0, MAX_ROWS)
          const r = await ask($, JOURNAL_SYSTEM, hourPrompt(now, tz, doc.entries ?? [], some), 1500)
          const got = parseEntries(r.text ?? '', some)
          const reason = r.text === undefined ? r.reason : got.fallbacks ? `fallback: ${got.fallbacks} of ${some.length} entries` : undefined
          const version: JournalVersion = { at, hour, lines: got.entries.map(e => `${e.label}: ${e.done}`), sources: some.map(t => t.id), entries: got.entries.length }
          return { version: reason ? { ...version, reason } : version, entries: got.entries }
        })
        const version = made.version.quiet ? { ...made.version, lines: doc.lines } : made.version
        const next: JournalDay = { ...doc, versions: [...doc.versions, version], entries: mergeEntries(doc.entries ?? [], made.entries) }
        await put(`days/${today}`, next, slot)
        st.recent[today] = next
        if (!st.lists.days.includes(today)) st.lists.days = [...st.lists.days, today].sort()
      }
      memo.fails = 0
      memo.waitUntil = 0
      return { state: st, today: st.recent[today] ?? null, outcome: 'wrote' }
    } finally {
      await store($, 'release', { holder: opts.holder }).catch(() => undefined)
    }
  } catch (err) {
    memo.fails += 1
    memo.waitUntil = now + Math.min(HOUR_MS, JOURNAL_TICK_MS * 2 ** (memo.fails - 1))
    return { state, outcome: 'error', error: String(err).slice(0, 300) }
  }
}

/** The card's meta line: `Updated 14:00 · 7 versions`. */
export function metaLine(day: JournalDay | null | undefined): string {
  const n = day?.versions.length ?? 0
  const last = day?.versions[n - 1]
  if (!last) return ''
  const e = day?.entries?.length ?? 0
  if (e) return `Updated ${hourLabel(last.hour)} · ${e} ${e === 1 ? 'entry' : 'entries'} today`
  return `Updated ${hourLabel(last.hour)} · ${n} ${n === 1 ? 'version' : 'versions'}`
}

/** How many entries the card shows: the newest 5. */
export const CARD_ENTRIES = 5

/** Today's versions for the timeline, newest first. */
export const timeline = (day: JournalDay | null | undefined): JournalVersion[] => [...(day?.versions ?? [])].reverse()

export const FIRST_LINE = 'First summary at the next hour.'
