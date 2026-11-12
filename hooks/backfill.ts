// /trips setup: fills the journal for past days from the transcripts, or marks
// a fresh start. One Haiku call per past day writes that day's entries, one
// more closes it, then the rollups that came due are written as the hourly
// tick writes them. It takes the same lease as the tick, so the two never race,
// and it skips every day the store already holds, so a rerun writes nothing.
import type { EngineInterface } from 'claude-code'

import type { JournalDay, JournalEntry, JournalVersion, SessionRow } from '../types'
import { BACKFILL_PY } from './backfill-scan'
import {
  ENTRY_RULES, JOURNAL_INTRO, LEASE_MS, ask, clockOf, closeDay, dayKey, hourOf, mergeEntries, modelCalls, newMemo, normaliseState,
  parseEntries, periodLabel, store, writeRollups,
} from './journal'
import { normaliseRows } from './platform'

export const SETUP_MAX_DAYS = 30
/** A work block ends after this long with no message in its session. */
export const BLOCK_GAP_MS = 2 * 3600 * 1000
/** Blocks per day the model reads: the busiest, then back in time order. */
export const MAX_BLOCKS = 24
/** Turns per block in the prompt: the first and the last few. */
const PROMPT_TURNS = 4
/** Days per scanner run, so one run's output stays well under the 4 MiB cap. */
const SCAN_CHUNK = 7
const DAY_MS = 24 * 3600 * 1000

export const PANE_NOTE = 'The Trips pane needs no backfill: it reads the session records directly, back 30 days.'

export const USAGE = [
  'Usage: /trips setup <1d|7d|30d|fresh>',
  '  1d, 7d, 30d  fill the journal for that many past days from your transcripts (one model call per active day, plus its close)',
  '  fresh        start the journal from now, with no past entries',
  'Any Nd from 1d to 30d works. Days the journal already holds are skipped.',
  PANE_NOTE,
].join('\n')

export type SetupRange = { kind: 'fresh' } | { kind: 'days'; days: number }

/** The range word of `/trips setup <range>`, or undefined when it is not one. */
export function parseRange(word: string | undefined): SetupRange | undefined {
  const w = (word ?? '').trim().toLowerCase()
  if (w === 'fresh') return { kind: 'fresh' }
  const m = /^(\d{1,2})d$/.exec(w)
  if (!m) return undefined
  const days = Number(m[1])
  return days >= 1 && days <= SETUP_MAX_DAYS ? { kind: 'days', days } : undefined
}

/** What `/trips <args>` asks for: the pane, setup with a range, or the usage text. */
export function parseCommand(args: string): { kind: 'pane' } | { kind: 'setup'; range: SetupRange } | { kind: 'usage' } {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return { kind: 'pane' }
  if (parts[0]!.toLowerCase() !== 'setup' || parts.length !== 2) return { kind: 'usage' }
  const range = parseRange(parts[1])
  return range ? { kind: 'setup', range } : { kind: 'usage' }
}

const utcOfDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
}

/** The `n` local days before `today`, oldest first. */
export function pastDays(today: string, n: number): string[] {
  const t = utcOfDay(today)
  const out: string[] = []
  for (let k = n; k >= 1; k--) out.push(dayKey(t - k * DAY_MS, 0))
  return out
}

// ---- Blocks: a stretch of turns in one session -------------------------------

export type ScanTurn = { at: number; prompt: string; reply: string }
export type ScanSession = { id: string; title: string; project: string; turns: ScanTurn[] }
export type Block = { key: string; sessionId: string; title: string; project: string; from: number; at: number; turns: ScanTurn[] }

/** One day's sessions as work blocks, split at a 2 h gap, the busiest MAX_BLOCKS kept, oldest first, keyed b1, b2, ... */
export function blocksOf(sessions: ScanSession[], gapMs = BLOCK_GAP_MS, max = MAX_BLOCKS): Block[] {
  const all: Omit<Block, 'key'>[] = []
  for (const s of sessions) {
    const turns = [...(s.turns ?? [])].filter(t => typeof t?.at === 'number').sort((a, b) => a.at - b.at)
    let cur: ScanTurn[] = []
    const flush = () => {
      if (cur.length) all.push({ sessionId: s.id, title: s.title, project: s.project, from: cur[0]!.at, at: cur[cur.length - 1]!.at, turns: cur })
      cur = []
    }
    for (const t of turns) {
      if (cur.length && t.at - cur[cur.length - 1]!.at > gapMs) flush()
      cur.push(t)
    }
    flush()
  }
  const kept = all.length > max ? [...all].sort((a, b) => b.turns.length - a.turns.length || b.at - a.at).slice(0, max) : all
  return [...kept].sort((a, b) => a.at - b.at).map((b, n) => ({ ...b, key: `b${n + 1}` }))
}

const fold = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n)

/** A block as the row parseEntries and fallbackEntry read: its own words, no model. */
export function blockRow(b: Block): SessionRow {
  const replies = b.turns.map(t => t.reply).filter(Boolean)
  const prompts = b.turns.map(t => t.prompt).filter(Boolean)
  const [row] = normaliseRows([{
    id: b.key, localId: '', title: b.title || b.project || 'a session', project: b.project, mtimeMs: b.at,
    lastPrompt: fold(prompts[prompts.length - 1] ?? '', 160), report: fold(replies[replies.length - 1] ?? '', 400),
  }])
  return row!
}

/** The backfill's system prompt: one entry per block of one past day. */
export const BACKFILL_SYSTEM = [
  JOURNAL_INTRO,
  'You get one past day of their work as blocks: each block is a stretch of turns in one session, with what they asked and what the agent answered. Write exactly one entry per block.',
  'Reply with a JSON array only, one object per block: {"sessionId": "<the block id, such as b1>", "label": "...", "done": "...", "next": "..."}.',
  ...ENTRY_RULES,
].join('\n')

export function backfillPrompt(day: string, tz: number, blocks: Block[]): string {
  const list = blocks.map(b => {
    const turns = b.turns.length > PROMPT_TURNS ? [b.turns[0]!, ...b.turns.slice(-(PROMPT_TURNS - 1))] : b.turns
    const lines = turns.map(t => `  ${clockOf(t.at, tz)} asked: ${fold(t.prompt, 160) || '(none)'} | answer: ${fold(t.reply, 240) || '(tools only)'}`)
    const skipped = b.turns.length - turns.length
    return [
      `block ${b.key}; title "${fold(b.title, 100)}"; project ${b.project || 'unknown'}; ${clockOf(b.from, tz)} to ${clockOf(b.at, tz)}; ${b.turns.length} turns${skipped ? ` (${skipped} not shown)` : ''}`,
      ...lines,
    ].join('\n')
  })
  return `Day: ${periodLabel('day', day)}.\n\nWork blocks, oldest first:\n${list.join('\n')}`
}

// ---- The run ------------------------------------------------------------------

export type SetupResult = {
  text: string
  daysWritten: number
  quietDays: number
  skippedDays: number
  entries: number
  modelCalls: number
  fallbacks: number
  rollups: { weeks: number; months: number; years: number }
  /** Another session holds the lease: nothing was written. */
  isBusy?: boolean
}

type ScanOut = { days: Record<string, ScanSession[]>; files?: number }

async function scanDays($: EngineInterface, days: string[]): Promise<Record<string, ScanSession[]>> {
  const out: Record<string, ScanSession[]> = {}
  for (let i = 0; i < days.length; i += SCAN_CHUNK) {
    const chunk = days.slice(i, i + SCAN_CHUNK)
    const run = await $.process.run(['python3', '-I', '-c', BACKFILL_PY, JSON.stringify({ days: chunk })], { timeoutMs: 300000 })
    if (run.exitCode !== 0) throw new Error(`transcript scan failed: ${run.stderr.slice(0, 200)}`)
    if (run.isStdoutTruncated) throw new Error('transcript scan output was cut at 4 MiB')
    const got = JSON.parse(run.stdout) as ScanOut
    for (const d of chunk) out[d] = Array.isArray(got.days?.[d]) ? got.days[d]! : []
  }
  return out
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Runs `/trips setup`. `holder` names this instance on the lease. Never throws:
 * a failure comes back as the text.
 */
export async function runSetup($: EngineInterface, range: SetupRange, holder: string): Promise<SetupResult> {
  const result: SetupResult = { text: '', daysWritten: 0, quietDays: 0, skippedDays: 0, entries: 0, modelCalls: 0, fallbacks: 0, rollups: { weeks: 0, months: 0, years: 0 } }
  const calls0 = modelCalls.n
  let held = false
  try {
    const now = await $.clock.now()
    const at = new Date(now).toISOString()
    const first = normaliseState(await store($, 'state', { now, recent: 1 }))
    const today = dayKey(now, first.tzOffsetMin)

    if (range.kind === 'fresh') {
      const m = await store<{ written: boolean }>($, 'mark', { at, mode: 'fresh', from: today })
      result.text = [
        m.written ? `Journal started fresh today (${today}). No past entries were written.` : 'The journal already has a start mark. Nothing was changed.',
        'The first entries come at the next hour while a Trips session is open.',
        PANE_NOTE,
      ].join('\n')
      return result
    }

    const lease = await store<{ held: boolean }>($, 'lease', { holder, now, ttlMs: LEASE_MS })
    if (!lease.held) {
      result.isBusy = true
      result.text = `Another session is writing the journal now. Nothing was written. Try again in a few minutes.\n${PANE_NOTE}`
      return result
    }
    held = true
    const renew = async () => {
      const got = await store<{ held: boolean }>($, 'lease', { holder, now: await $.clock.now(), ttlMs: LEASE_MS })
      if (!got.held) throw new Error('journal lease lost')
    }
    // Read again under the lease: the hourly tick may have written meanwhile.
    const st = normaliseState(await store($, 'state', { now, recent: 3 }))
    const tz = st.tzOffsetMin
    const wanted = pastDays(today, range.days)
    const todo = wanted.filter(d => !st.lists.days.includes(d))
    result.skippedDays = wanted.length - todo.length
    const scanned = todo.length ? await scanDays($, todo) : {}

    for (const day of todo) {
      const blocks = blocksOf(scanned[day] ?? [])
      if (!blocks.length) {
        result.quietDays++
        continue
      }
      const rows = blocks.map(blockRow)
      await renew()
      const r = await ask($, BACKFILL_SYSTEM, backfillPrompt(day, tz, blocks), 4000)
      const got = parseEntries(r.text ?? '', rows)
      const real = new Map(blocks.map(b => [b.key, b.sessionId]))
      const entries: JournalEntry[] = got.entries.map(e => ({ ...e, sessionId: real.get(e.sessionId) ?? e.sessionId }))
      const reason = r.text === undefined ? r.reason : got.fallbacks ? `fallback: ${got.fallbacks} of ${rows.length} entries` : undefined
      result.fallbacks += got.fallbacks
      const version: JournalVersion = {
        at, hour: hourOf(blocks[blocks.length - 1]!.at, tz), lines: entries.map(e => `${e.label}: ${e.done}`),
        sources: [...new Set(entries.map(e => e.sessionId))], entries: entries.length, backfill: true,
        ...(reason ? { reason } : {}),
      }
      const open: JournalDay = { date: day, lines: [], versions: [version], entries: mergeEntries([], entries), closed: false }
      await renew()
      const closed = await closeDay($, open, at, tz)
      if (closed.close?.reason) result.fallbacks++
      await store($, 'write', { writes: [{ path: `days/${day}`, data: closed }] })
      st.recent[day] = closed
      st.lists.days = [...st.lists.days, day].sort()
      result.daysWritten++
      result.entries += entries.length
    }

    if (result.daysWritten) {
      const put = async (path: string, data: unknown) => {
        await store($, 'write', { writes: [{ path, data }] })
      }
      result.rollups = await writeRollups($, st, today, at, newMemo(), put, renew)
    }
    await store($, 'mark', { at, mode: `${range.days}d`, from: wanted[0] })

    result.modelCalls = modelCalls.n - calls0
    const r = result.rollups
    const rolled = [r.weeks && plural(r.weeks, 'week'), r.months && plural(r.months, 'month'), r.years && plural(r.years, 'year')].filter(Boolean)
    result.text = [
      `Backfilled ${plural(range.days, 'past day')} (${wanted[0]} to ${wanted[wanted.length - 1]}).`,
      `Days written: ${result.daysWritten}. Quiet days: ${result.quietDays}. Already in the journal: ${result.skippedDays}.`,
      `Entries: ${result.entries}. Model calls: ${result.modelCalls}. Fallbacks: ${result.fallbacks}.`,
      `Rollups written: ${rolled.length ? rolled.join(', ') : 'none'}.`,
      PANE_NOTE,
    ].join('\n')
    return result
  } catch (err) {
    result.modelCalls = modelCalls.n - calls0
    result.text = `Setup stopped: ${String(err).slice(0, 300)}\nDays written before it stopped: ${result.daysWritten}. Rerun the same command to carry on.`
    return result
  } finally {
    if (held) await store($, 'release', { holder }).catch(() => undefined)
  }
}
