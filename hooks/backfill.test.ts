import { expect, test } from 'claude-code/testing'

import type { JournalDay, JournalRollup } from '../types'
import { BACKFILL_SYSTEM, PANE_NOTE, USAGE, blocksOf, parseCommand, parseRange, pastDays } from './backfill'
import type { ScanSession } from './backfill'
import { CLOSE_SYSTEM, JOURNAL_ROOT } from './journal'
import type { ModelSeen } from './world'
import { world } from './world'

const MIN = 60 * 1000
// Thursday 12 November 2026, 09:00 UTC; the store says UTC (offset 0).
const NOW = Date.UTC(2026, 10, 12, 9, 0)
const at = (day: string, h: number, m = 0) => Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)

const turn = (day: string, h: number, m: number, prompt: string, reply: string) => ({ at: at(day, h, m), prompt, reply })

/** One day of fictional work: LedgerLoop twice (a 4 h gap splits it), QuoteForge once. */
const dayOf = (day: string): ScanSession[] => [
  {
    id: 'sess-ledger', title: 'LedgerLoop invoice export', project: 'ledgerloop',
    turns: [
      turn(day, 9, 0, 'Add a CSV export to the invoice list', 'Added the CSV export button to the invoice list.'),
      turn(day, 9, 30, 'Write a test for it', 'Wrote the export test.'),
      turn(day, 14, 0, 'Fix the rounding in totals', 'Fixed the rounding in the totals row.'),
    ],
  },
  { id: 'sess-quote', title: 'QuoteForge pricing page', project: 'quoteforge', turns: [turn(day, 11, 0, 'Draft the pricing table', 'Drafted the pricing table with three tiers.')] },
]

const ENTRIES = [
  { sessionId: 'b1', label: 'LedgerLoop export', done: 'Added the CSV export to the invoice list.', next: 'Ship the export.' },
  { sessionId: 'b2', label: 'QuoteForge pricing', done: 'Drafted the three-tier pricing table.', next: '' },
  { sessionId: 'b3', label: 'LedgerLoop totals', done: 'Fixed the rounding in the totals row.', next: '' },
]
const CLOSE = 'Added the CSV export to LedgerLoop.\nDrafted the QuoteForge pricing table.\nTomorrow: ship the export.'
const ROLL = 'Built the LedgerLoop export.\nDrafted QuoteForge pricing.\nCarry on: ship the export.'

/** The fake model: entries for the backfill prompt, lines for a close or a rollup. */
const model = (e: ModelSeen) => (e.system === BACKFILL_SYSTEM ? JSON.stringify(ENTRIES) : e.system === CLOSE_SYSTEM ? CLOSE : ROLL)

const setup = async ($: any, args: string) => (await $.command.run({ command: 'trips', args })).text as string

test('range words: 1d to 30d and fresh, anything else is the usage', async () => {
  expect(parseRange('1d')).toEqual({ kind: 'days', days: 1 })
  expect(parseRange('7D')).toEqual({ kind: 'days', days: 7 })
  expect(parseRange('30d')).toEqual({ kind: 'days', days: 30 })
  expect(parseRange('fresh')).toEqual({ kind: 'fresh' })
  for (const bad of ['0d', '31d', '7', 'week', '', '-1d', '1.5d']) expect(parseRange(bad)).toBeUndefined()
  expect(parseCommand('')).toEqual({ kind: 'pane' })
  expect(parseCommand('  setup   7d ')).toEqual({ kind: 'setup', range: { kind: 'days', days: 7 } })
  expect(parseCommand('setup')).toEqual({ kind: 'usage' })
  expect(parseCommand('setup 7d now')).toEqual({ kind: 'usage' })
  expect(parseCommand('help')).toEqual({ kind: 'usage' })
})

test('past days run oldest first and never include today', async () => {
  expect(pastDays('2026-11-12', 3)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11'])
  expect(pastDays('2026-03-01', 2)).toEqual(['2026-02-27', '2026-02-28'])
})

test('blocks split a session at a 2 h gap, keyed in time order, the busiest kept under the cap', async () => {
  const blocks = blocksOf(dayOf('2026-11-11'))
  expect(blocks.map(b => [b.key, b.sessionId, b.turns.length])).toEqual([['b1', 'sess-ledger', 2], ['b2', 'sess-quote', 1], ['b3', 'sess-ledger', 1]])
  const capped = blocksOf(dayOf('2026-11-11'), undefined, 2)
  expect(capped.map(b => [b.key, b.sessionId, b.turns.length])).toEqual([['b1', 'sess-ledger', 2], ['b2', 'sess-ledger', 1]])
})

test('/trips setup with no range prints the usage, and so does a wrong one: no store op, no model call', async ($, on) => {
  const w = await world($, on, { rows: [], surfaces: [], now: NOW, journal: { model } })
  expect(await setup($, 'setup')).toBe(USAGE)
  expect(await setup($, 'setup 90d')).toBe(USAGE)
  expect(USAGE).toContain(PANE_NOTE)
  expect(w.models).toHaveLength(0)
  expect(w.jops).toHaveLength(0)
})

test('setup 1d: one call for the day, one for its close, entries carry the real session ids', async ($, on) => {
  const w = await world($, on, { rows: [], surfaces: [], now: NOW, journal: { model, transcripts: { '2026-11-11': dayOf('2026-11-11') } } })
  const text = await setup($, 'setup 1d')
  expect(w.bscans).toEqual([['2026-11-11']])
  expect(w.models.map(m => m.system)).toEqual([BACKFILL_SYSTEM, CLOSE_SYSTEM])
  expect(w.models.every(m => m.model === 'haiku')).toBe(true)
  expect(w.models[0]!.prompt).toContain('Day: Wednesday 11 November 2026.')
  expect(w.models[0]!.prompt).toContain('block b1; title "LedgerLoop invoice export"; project ledgerloop; 09:00 to 09:30; 2 turns')
  expect(w.models[0]!.prompt).toContain('09:00 asked: Add a CSV export to the invoice list | answer: Added the CSV export button to the invoice list.')
  const d = w.jfs.get('days/2026-11-11') as JournalDay
  expect(d.closed).toBe(true)
  expect(d.close!.lines).toEqual(CLOSE.split('\n'))
  expect(d.entries!.map(e => [e.sessionId, e.at, e.label])).toEqual([
    ['sess-ledger', at('2026-11-11', 9, 30), 'LedgerLoop export'],
    ['sess-quote', at('2026-11-11', 11), 'QuoteForge pricing'],
    ['sess-ledger', at('2026-11-11', 14), 'LedgerLoop totals'],
  ])
  expect(d.versions).toHaveLength(1)
  expect(d.versions[0]!.backfill).toBe(true)
  expect(d.versions[0]!.reason).toBeUndefined()
  expect(text).toContain('Days written: 1. Quiet days: 0. Already in the journal: 0.')
  expect(text).toContain('Entries: 3. Model calls: 2. Fallbacks: 0.')
  expect(text).toContain(PANE_NOTE)
  expect((w.jfs.get('start') as { mode: string; from: string })).toMatchObject({ mode: '1d', from: '2026-11-11' })
  // The lease was taken for the run and let go after it.
  expect(w.lease()).toBeUndefined()
  expect(w.leaseHolders.every(h => h.endsWith(':setup'))).toBe(true)
})

test('idempotent: a rerun skips the stored day and writes nothing, with no model call', async ($, on) => {
  const w = await world($, on, { rows: [], surfaces: [], now: NOW, journal: { model, transcripts: { '2026-11-11': dayOf('2026-11-11') } } })
  await setup($, 'setup 1d')
  const writes = w.jwrites.length
  const calls = w.models.length
  const text = await setup($, 'setup 1d')
  expect(w.jwrites.length).toBe(writes)
  expect(w.models.length).toBe(calls)
  expect(w.bscans).toHaveLength(1)
  expect(text).toContain('Days written: 0. Quiet days: 0. Already in the journal: 1.')
  expect(text).toContain('Model calls: 0.')
})

test('a day with no turns is quiet: no call, no file', async ($, on) => {
  const w = await world($, on, { rows: [], surfaces: [], now: NOW, journal: { model, transcripts: { '2026-11-10': dayOf('2026-11-10') } } })
  const text = await setup($, 'setup 2d')
  expect(w.bscans).toEqual([['2026-11-10', '2026-11-11']])
  expect([...w.jfs.keys()].filter(k => k.startsWith('days/'))).toEqual(['days/2026-11-10'])
  expect(w.models).toHaveLength(2)
  expect(text).toContain('Days written: 1. Quiet days: 1.')
})

test('fresh: a start mark for today and nothing else; a rerun keeps it', async ($, on) => {
  const w = await world($, on, { rows: [], surfaces: [], now: NOW, journal: { model, transcripts: { '2026-11-11': dayOf('2026-11-11') } } })
  const text = await setup($, 'setup fresh')
  expect(text).toContain('Journal started fresh today (2026-11-12).')
  expect(text).toContain(PANE_NOTE)
  expect(w.jwrites).toEqual(['start'])
  expect(w.models).toHaveLength(0)
  expect(w.bscans).toHaveLength(0)
  expect(await setup($, 'setup fresh')).toContain('already has a start mark')
  expect(w.jwrites).toEqual(['start'])
})

test('fallback: no answer from the model still writes the day from the turns themselves', async ($, on) => {
  const w = await world($, on, { rows: [], surfaces: [], now: NOW, journal: { model: () => null, transcripts: { '2026-11-11': dayOf('2026-11-11') } } })
  const text = await setup($, 'setup 1d')
  const d = w.jfs.get('days/2026-11-11') as JournalDay
  expect(d.entries!.map(e => [e.sessionId, e.label, e.done])).toEqual([
    ['sess-ledger', 'LedgerLoop invoice export', 'Wrote the export test.'],
    ['sess-quote', 'QuoteForge pricing page', 'Drafted the pricing table with three tiers.'],
    ['sess-ledger', 'LedgerLoop invoice export', 'Fixed the rounding in the totals row.'],
  ])
  expect(d.versions[0]!.reason).toBe('api-error overloaded')
  expect(d.closed).toBe(true)
  expect(d.close!.reason).toBe('api-error overloaded')
  // 3 entries and the close fell back.
  expect(text).toContain('Entries: 3. Model calls: 2. Fallbacks: 4.')
})

test('fallback: an item with status talk or a long sentence falls back alone, the others stay', async ($, on) => {
  const bad = [
    ENTRIES[0],
    { sessionId: 'b2', label: 'QuoteForge', done: 'The pricing table is ready for review.', next: '' },
    { sessionId: 'b3', label: 'LedgerLoop', done: 'Fixed the rounding in the totals row of the invoice list so that every single total adds up again.', next: '' },
  ]
  const w = await world($, on, {
    rows: [], surfaces: [], now: NOW,
    journal: { model: e => (e.system === BACKFILL_SYSTEM ? JSON.stringify(bad) : CLOSE), transcripts: { '2026-11-11': dayOf('2026-11-11') } },
  })
  const text = await setup($, 'setup 1d')
  const d = w.jfs.get('days/2026-11-11') as JournalDay
  expect(d.entries!.map(e => e.done)).toEqual(['Added the CSV export to the invoice list.', 'Drafted the pricing table with three tiers.', 'Fixed the rounding in the totals row.'])
  expect(d.versions[0]!.reason).toBe('fallback: 2 of 3 entries')
  expect(text).toContain('Fallbacks: 2.')
})

test('another session holds the lease: nothing is scanned or written', async ($, on) => {
  const w = await world($, on, {
    rows: [], surfaces: [], now: NOW,
    journal: { model, lease: { holder: 'other', expiry: NOW + 5 * MIN }, transcripts: { '2026-11-11': dayOf('2026-11-11') } },
  })
  const text = await setup($, 'setup 1d')
  expect(text).toContain('Another session is writing the journal now.')
  expect(w.bscans).toHaveLength(0)
  expect(w.jwrites).toHaveLength(0)
  expect(w.models).toHaveLength(0)
})

test('a failed transcript scan stops the run, says so, and lets the lease go', async ($, on) => {
  const w = await world($, on, { rows: [], surfaces: [], now: NOW, journal: { model, scanFails: true } })
  const text = await setup($, 'setup 1d')
  expect(text).toContain('Setup stopped: Error: transcript scan failed: no transcripts')
  expect(w.jwrites).toHaveLength(0)
  expect(w.lease()).toBeUndefined()
})

test('setup 7d on a Monday writes the ended week from the new days: one rollup call', async ($, on) => {
  const monday = Date.UTC(2026, 10, 16, 9, 0)
  const w = await world($, on, {
    rows: [], surfaces: [], now: monday,
    journal: { model, transcripts: { '2026-11-10': dayOf('2026-11-10'), '2026-11-13': dayOf('2026-11-13') } },
  })
  const text = await setup($, 'setup 7d')
  expect(w.bscans).toEqual([['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']])
  expect(w.models).toHaveLength(5)
  const wk = w.jfs.get('weeks/2026-W46') as JournalRollup
  expect(wk.lines).toEqual(ROLL.split('\n'))
  expect(wk.children.map(c => c.key)).toEqual(['2026-11-10', '2026-11-13'])
  expect(text).toContain('Rollups written: 1 week.')
})

test('30d scans in chunks of 7 days, oldest first', async ($, on) => {
  const w = await world($, on, { rows: [], surfaces: [], now: NOW, journal: { model } })
  const text = await setup($, 'setup 30d')
  expect(w.bscans.map(c => c.length)).toEqual([7, 7, 7, 7, 2])
  expect(w.bscans[0]![0]).toBe('2026-10-13')
  expect(w.bscans[4]![1]).toBe('2026-11-11')
  expect(text).toContain('Days written: 0. Quiet days: 30.')
})

test('the journalDir option reaches every store op; left out, the default folder', async ($, on) => {
  const w = await world($, on, { rows: [], surfaces: [], now: NOW, journal: { model } })
  await setup($, 'setup fresh')
  expect(w.jroots.length).toBeGreaterThan(0)
  expect(w.jroots.every(r => r === JOURNAL_ROOT)).toBe(true)
})

test('journalDir set: the store is pointed at that folder', { options: { journalDir: '/scratch/trips-test-journal' } }, async ($, on) => {
  const w = await world($, on, { rows: [], surfaces: [], now: NOW, journal: { model } })
  await setup($, 'setup fresh')
  expect(w.jroots.length).toBeGreaterThan(0)
  expect(w.jroots.every(r => r === '/scratch/trips-test-journal')).toBe(true)
})

test('headless (no surface): the session starts no journal tick, so no model call before setup', async ($, on) => {
  const w = await world($, on, { rows: [], surfaces: [], now: NOW, journal: { model } })
  await w.at(NOW + 11 * MIN)
  expect(w.models).toHaveLength(0)
  expect(w.jops).toHaveLength(0)
})
