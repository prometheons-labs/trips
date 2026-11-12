import { expect, test } from 'claude-code/testing'

import type { JournalDay } from '../types'
import { row } from './fixture'
import { JOURNAL_SYSTEM, cleanLines, fallbackEntry, focusOf, mergeEntries, parseEntries, validLines } from './journal'
import { world } from './world'

const MIN = 60000
// Wednesday 11 November 2026, 14:02 UTC; the store says UTC (offset 0).
const T = Date.UTC(2026, 10, 11, 14, 2)
const A_AT = T - 10 * MIN
const B_AT = T - 30 * MIN
const rows = () => [
  row('a', 0, { title: 'Fix the invoice footer', project: 'ledgerloop', wrapUp: 'Added the footer links to the invoice page.', mtimeMs: A_AT }),
  row('b', 0, { title: 'QuoteForge ticket 412', project: 'quoteforge', nextAction: 'Pick layout A or B', status: 'blocked', detail: 'Drafted two layouts for the ticket list.', mtimeMs: B_AT }),
  row('old', 0, { title: 'Old research', mtimeMs: T - 3 * 60 * MIN }),
]
/** Sample entries as the model writes them. */
const SAMPLE = [
  { sessionId: 'a', label: 'LedgerLoop invoices', done: 'Added footer links to the invoice page.', next: 'Ship the invoice footer.' },
  { sessionId: 'b', label: 'QuoteForge ticket 412', done: 'Drafted two layouts for the ticket list.', next: 'Pick layout A or B.' },
]
const reply = (items: unknown[]) => JSON.stringify(items)
const day = (w: { jfs: Map<string, unknown> }, key = '2026-11-11') => w.jfs.get(`days/${key}`) as JournalDay

test('closes and rollups keep 3 to 5 lines: bullets stripped, status talk dropped, capped at 5, fewer than 3 rejected', () => {
  const text = '- One thing\n2. Two things\n\n• Three — four\n* Five\n6) Six\n7. Seven'
  expect(cleanLines(text)).toEqual(['One thing', 'Two things', 'Three, four', 'Five', 'Six'])
  expect(validLines(text)).toHaveLength(5)
  expect(validLines('1. Only one\n\n- and two')).toBeUndefined()
  expect(validLines('Shipped the Trips card.\nThree sessions await review.\nPast hour: QuoteForge.\nFixed the invoice.')).toBeUndefined()
  expect(validLines('Shipped the Trips card.\nFixed the invoice.\nTomorrow: ship the footer.')).toHaveLength(3)
})

test('hourly: one haiku call turns each session touched in the last hour into one entry, the same hour adds nothing, the next hour appends', async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', now: T, journal: { model: () => reply(SAMPLE) } })
  expect(w.models).toHaveLength(1)
  expect(w.models[0]!.model).toBe('haiku')
  expect(w.models[0]!.system).toBe(JOURNAL_SYSTEM)
  expect(w.models[0]!.prompt).toContain('sessionId a; title "Fix the invoice footer"')
  expect(w.models[0]!.prompt).toContain('wrap-up: Added the footer links to the invoice page.')
  expect(w.models[0]!.prompt).toContain('asks them: Pick layout A or B')
  expect(w.models[0]!.prompt).not.toContain('Old research')
  let d = day(w)
  expect(d.versions).toHaveLength(1)
  expect(d.versions[0]).toMatchObject({ hour: 14, at: new Date(T).toISOString(), sources: ['a', 'b'], entries: 2 })
  expect(d.versions[0]!.reason).toBeUndefined()
  // Oldest first, stamped with each session's turn-end time.
  expect(d.entries).toEqual([{ at: B_AT, ...SAMPLE[1] }, { at: A_AT, ...SAMPLE[0] }])

  // Later ticks in the same hour make no call and no entry.
  await w.at(T + 50 * MIN)
  expect(w.models).toHaveLength(1)
  expect(day(w).entries).toHaveLength(2)

  // The next hour: a's new turn is one new entry; the earlier notes go in the prompt.
  w.setRows([row('a', 0, { title: 'Fix the invoice footer', mtimeMs: T + 52 * MIN })])
  w.setModel(() => reply([{ sessionId: 'a', label: 'LedgerLoop invoices', done: 'Shipped the invoice footer.', next: '' }]))
  await w.at(T + 61 * MIN)
  expect(w.models).toHaveLength(2)
  expect(w.models[1]!.prompt).toContain('13:52 LedgerLoop invoices: Added footer links to the invoice page.')
  d = day(w)
  expect(d.versions.map(v => v.hour)).toEqual([14, 15])
  expect(d.entries!.map(e => [e.sessionId, e.done])).toEqual([
    ['b', 'Drafted two layouts for the ticket list.'],
    ['a', 'Added footer links to the invoice page.'],
    ['a', 'Shipped the invoice footer.'],
  ])
})

test('quiet hour: no session touched since the last run makes no model call, adds no entry and records a quiet version', async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', now: T, journal: { model: () => reply(SAMPLE) } })
  expect(w.models).toHaveLength(1)
  await w.at(T + 61 * MIN)
  expect(w.models).toHaveLength(1)
  const d = day(w)
  expect(d.versions).toHaveLength(2)
  expect(d.versions[1]).toMatchObject({ hour: 15, quiet: true, sources: [], entries: 0 })
  expect(d.entries).toHaveLength(2)
})

test('a reply with status talk such as "awaits review" is rejected and falls back to the session\'s own text', async ($, on) => {
  const bad = [
    { sessionId: 'a', label: 'Trips', done: 'The invoice session awaits review.', next: '' },
    { sessionId: 'b', label: 'QuoteForge ticket 412', done: 'Drafted two layouts for the ticket list.', next: 'Pick layout A or B.' },
  ]
  const w = await world($, on, { rows: rows(), sessionId: 'me', now: T, journal: { model: () => reply(bad) } })
  const d = day(w)
  expect(d.versions[0]!.reason).toBe('fallback: 1 of 2 entries')
  const a = d.entries!.find(e => e.sessionId === 'a')!
  expect(a).toEqual({ at: A_AT, sessionId: 'a', label: 'Fix the invoice footer', done: 'Added the footer links to the invoice page.', next: '' })
  expect(d.entries!.find(e => e.sessionId === 'b')!.label).toBe('QuoteForge ticket 412')

  // The other banned shapes, and a reply that is no JSON at all.
  const r = rows().slice(0, 1)
  for (const done of ['Ready for review.', 'Now: fixing the footer.', 'Touched 3 sessions today.', 'Fixed it; shipped it.', 'Check each session before continuing.',
    'This sentence runs on far too long for a pocket notebook note because it has more than sixteen words in it.']) {
    expect(parseEntries(reply([{ sessionId: 'a', label: 'x', done, next: '' }]), r)).toEqual({ entries: [fallbackEntry(r[0]!)], fallbacks: 1 })
  }
  expect(parseEntries('Sorry, here are the notes.', r).fallbacks).toBe(1)
})

test('a call not answered still writes fallback entries and records the reason', async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', now: T, journal: { model: () => null } })
  const d = day(w)
  expect(d.versions[0]!.reason).toBe('api-error overloaded')
  expect(d.entries!.map(e => e.done)).toEqual(['Drafted two layouts for the ticket list.', 'Added the footer links to the invoice page.'])
  expect(d.entries!.find(e => e.sessionId === 'b')!.next).toBe('Pick layout A or B.')
})

test('entries dedupe by session and turn time, sort by time, and a focus shows only when one session leads', () => {
  const e = (sessionId: string, at: number, label = sessionId) => ({ at, sessionId, label, done: 'Did it.', next: '' })
  const merged = mergeEntries([e('a', 3), e('b', 1)], [e('a', 3), e('c', 2)])
  expect(merged.map(x => `${x.sessionId}@${x.at}`)).toEqual(['b@1', 'c@2', 'a@3'])
  const d = (entries: ReturnType<typeof e>[]): JournalDay => ({ date: '2026-11-11', lines: [], versions: [], entries, closed: false })
  expect(focusOf(d([e('a', T - 90 * MIN, 'Trips journal'), e('a', T - 20 * MIN, 'Trips journal'), e('b', T - 30 * MIN)]), T)).toBe('Trips journal')
  expect(focusOf(d([e('a', T - 90 * MIN), e('a', T - 20 * MIN), e('b', T - 30 * MIN), e('b', T - 10 * MIN)]), T)).toBe('')
  expect(focusOf(d([e('a', T - 20 * MIN), e('b', T - 30 * MIN)]), T)).toBe('')
  expect(focusOf(d([e('a', T - 200 * MIN), e('a', T - 190 * MIN)]), T)).toBe('')
})

test('one writer: a live lease held by another session blocks the write, the hour slot it wrote is honoured, and the lease is let go after a write', async ($, on) => {
  const w = await world($, on, {
    rows: rows(), sessionId: 'me', now: T,
    journal: { model: () => reply(SAMPLE), lease: { holder: 'other', expiry: T + 7 * MIN } },
  })
  expect(w.jops).toContain('lease')
  expect(w.models).toHaveLength(0)
  expect(w.jwrites).toEqual([])

  // Its lease lapses unreleased: the next tick takes over, writes once, releases.
  await w.at(T + 11 * MIN)
  expect(w.models).toHaveLength(1)
  expect(w.jwrites).toEqual(['days/2026-11-11'])
  expect(w.lease()).toBeUndefined()

  // The next hour's slot is already written by another session: this one skips, without a lease.
  const other = day(w)
  w.jfs.set('days/2026-11-11', { ...other, versions: [...other.versions, { at: new Date(T + 60 * MIN).toISOString(), hour: 15, lines: [], sources: ['b'], entries: 0 }] })
  w.setRows([row('a', 0, { mtimeMs: T + 58 * MIN })])
  const leasesBefore = w.jops.filter(o => o === 'lease').length
  await w.at(T + 70 * MIN)
  expect(w.models).toHaveLength(1)
  expect(w.jwrites).toEqual(['days/2026-11-11'])
  expect(w.jops.filter(o => o === 'lease').length).toBe(leasesBefore)
})

test('one writer per instance: the holder is unique per mod instance, so a live lease of another instance in the same session still blocks', async ($, on) => {
  const w = await world($, on, {
    rows: rows(), sessionId: 'me', now: T,
    journal: { model: () => reply(SAMPLE), lease: { holder: 'me', expiry: T + 7 * MIN } },
  })
  expect(w.models).toHaveLength(0)
  expect(w.jwrites).toEqual([])
  const holder = w.leaseHolders[0]!
  expect(holder).toMatch(/^me:[a-z0-9]{6,}$/)
  expect(holder).not.toBe('trips')
  await w.at(T + 11 * MIN)
  expect(w.models).toHaveLength(1)
  expect(new Set(w.leaseHolders)).toEqual(new Set([holder]))
  expect(w.leaseHolders.length).toBeGreaterThanOrEqual(3)
  expect(w.lease()).toBeUndefined()
})

test('one writer under store failure: a failed write keeps the made entries, retries only the write with backoff, and never calls haiku twice for the hour', async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', now: T, journal: { model: () => reply(SAMPLE), writeFails: true } })
  expect(w.models).toHaveLength(1)
  expect(w.jfs.has('days/2026-11-11')).toBe(false)
  await w.at(T + 5 * MIN)
  expect(w.models).toHaveLength(1)
  expect(w.lease()).toBeUndefined()
  // Two failures: a 10 minute wait, so the tick at 10 minutes reads nothing.
  const states = w.jops.filter(o => o === 'state').length
  await w.at(T + 11 * MIN)
  expect(w.jops.filter(o => o === 'state').length).toBe(states)
  w.setWriteFails(false)
  await w.at(T + 16 * MIN)
  expect(w.models).toHaveLength(1)
  const d = day(w)
  expect(d.versions).toHaveLength(1)
  expect(d.entries!.map(e => e.done)).toEqual([SAMPLE[1]!.done, SAMPLE[0]!.done])
  expect(d.versions[0]!.at).toBe(new Date(T).toISOString())
})
