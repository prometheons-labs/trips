import { expect, test } from 'claude-code/testing'

import type { JournalDay, JournalRollup } from '../types'
import { row } from './fixture'
import { CLOSE_SYSTEM, JOURNAL_SYSTEM, dueRollups, emptyLists, lastWeekOf, monthOfWeek, rollupSystem, weekKey } from './journal'
import type { ModelSeen } from './world'
import { world } from './world'

const MIN = 60000
const ENTRY = { sessionId: 'a', label: 'Trips journal', done: 'Built the hourly entry trail.', next: 'Ship the card.' }
const THREE = JSON.stringify([ENTRY])
const CLOSE = 'Today you shipped the Trips journal.\nYou jumped between QuoteForge and the invoice.\nTomorrow: finish the invoice footer.'
const ROLL = (kind: string) => `This ${kind} you built the journal.\nQuoteForge kept coming back.\nCarry on: the invoice.`
const byPrompt = (e: ModelSeen) =>
  e.system === CLOSE_SYSTEM ? CLOSE
    : e.system === rollupSystem('week') ? ROLL('week')
      : e.system === rollupSystem('month') ? ROLL('month')
        : e.system === rollupSystem('year') ? ROLL('year')
          : THREE
const openDay = (date: string, hour: number, lines: string[]): JournalDay => ({
  date, lines, closed: false,
  versions: [{ at: `${date}T${String(hour).padStart(2, '0')}:02:00.000Z`, hour, lines, sources: ['a'] }],
})
const closedDay = (date: string, lines: string[]): JournalDay => ({ ...openDay(date, 10, lines), closed: true, close: { at: `${date}T23:59:00.000Z`, lines } })
const rollupDoc = (kind: JournalRollup['kind'], key: string, lines: string[]): JournalRollup => ({ kind, key, at: '2026-01-01T00:00:00.000Z', lines, children: [] })

test('week, month and year keys follow ISO weeks: a week belongs to its Thursday', () => {
  expect(weekKey('2026-11-11')).toBe('2026-W46')
  expect(weekKey('2026-12-31')).toBe('2026-W53')
  expect(weekKey('2027-01-01')).toBe('2026-W53')
  expect(weekKey('2027-01-04')).toBe('2027-W01')
  expect(weekKey('2025-12-29')).toBe('2026-W01')
  expect(monthOfWeek('2026-W44')).toBe('2026-10')
  expect(monthOfWeek('2026-W45')).toBe('2026-11')
  expect(lastWeekOf('2026-10')).toBe('2026-W44')
  expect(lastWeekOf('2026-12')).toBe('2026-W53')
  // A month waits for its last week; a year waits for December's last week.
  const lists = { ...emptyLists(), weeks: ['2026-W43', '2026-W44'], months: ['2026-12'] }
  expect(dueRollups(lists, '2026-11-01').months).toEqual([])
  expect(dueRollups(lists, '2026-11-02').months).toEqual(['2026-10'])
  expect(dueRollups(lists, '2027-01-03').years).toEqual([])
  expect(dueRollups(lists, '2027-01-04').years).toEqual(['2026'])
})

test('closes the day at midnight: the first tick writes a close entry with one haiku call and closed:true before the new day', async ($, on) => {
  const at = Date.UTC(2026, 10, 11, 23, 2)
  const w = await world($, on, { rows: [row('a', 0, { title: 'Trips journal', mtimeMs: at - 5 * MIN })], sessionId: 'me', now: at, journal: { model: byPrompt } })
  expect(w.models.map(m => m.system)).toEqual([JOURNAL_SYSTEM])
  await w.at(Date.UTC(2026, 10, 12, 0, 3))
  const closed = w.jfs.get('days/2026-11-11') as JournalDay
  expect(closed.closed).toBe(true)
  expect(closed.close?.lines).toEqual(CLOSE.split('\n'))
  expect(closed.versions).toHaveLength(1)
  expect(w.models.map(m => m.system)).toEqual([JOURNAL_SYSTEM, CLOSE_SYSTEM])
  // The close reads the day's entries, each with its time.
  expect(w.models[1]!.prompt).toContain('22:57 Trips journal: Built the hourly entry trail. Next: Ship the card.')
  // The close lands before the new day's first version.
  expect(w.jwrites).toEqual(['days/2026-11-11', 'days/2026-11-11', 'days/2026-11-12'])
  expect((w.jfs.get('days/2026-11-12') as JournalDay).versions[0]).toMatchObject({ hour: 0, quiet: true })
})

test('closes the day without status talk: a close reply that talks status falls back to each session\'s newest entry', async ($, on) => {
  const at = Date.UTC(2026, 10, 11, 23, 2)
  const w = await world($, on, {
    rows: [row('a', 0, { title: 'Trips journal', mtimeMs: at - 5 * MIN })], sessionId: 'me', now: at,
    journal: { model: e => (e.system === CLOSE_SYSTEM ? 'Today you had 4 sessions.\nTwo await review.\nTomorrow: check each session before continuing.' : THREE) },
  })
  await w.at(Date.UTC(2026, 10, 12, 0, 3))
  expect((w.jfs.get('days/2026-11-11') as JournalDay).close).toMatchObject({ lines: ['Trips journal: Built the hourly entry trail.'], reason: 'short reply: 0 lines' })
})

test('never writes a version into a closed day', async ($, on) => {
  const at = Date.UTC(2026, 10, 11, 14, 2)
  const w = await world($, on, {
    rows: [row('a', 0, { mtimeMs: at - 5 * MIN })], sessionId: 'me', now: at,
    journal: { model: byPrompt, files: { 'days/2026-11-11': closedDay('2026-11-11', ['done']) } },
  })
  await w.at(at + 61 * MIN)
  expect(w.models).toHaveLength(0)
  expect(w.jwrites).toEqual([])
  expect((w.jfs.get('days/2026-11-11') as JournalDay).versions).toHaveLength(1)
})

test('next tick after midnight: with no Trips session at 00:00, the first tick of the next morning closes yesterday first', async ($, on) => {
  const at = Date.UTC(2026, 10, 11, 9, 1)
  const w = await world($, on, {
    rows: [row('a', 0, { mtimeMs: at - 5 * MIN })], sessionId: 'me', now: at,
    journal: { model: byPrompt, files: { 'days/2026-11-10': openDay('2026-11-10', 21, ['Late work on QuoteForge.', 'Past hour: QuoteForge.', 'Next: sleep.']) } },
  })
  expect(w.models.map(m => m.system)).toEqual([CLOSE_SYSTEM, JOURNAL_SYSTEM])
  expect(w.models[0]!.prompt).toContain('Late work on QuoteForge.')
  expect(w.jwrites).toEqual(['days/2026-11-10', 'days/2026-11-11'])
  const y = w.jfs.get('days/2026-11-10') as JournalDay
  expect(y).toMatchObject({ closed: true, close: { lines: CLOSE.split('\n') } })
  expect((w.jfs.get('days/2026-11-11') as JournalDay).entries).toEqual([{ at: at - 5 * MIN, ...ENTRY }])
})

test('week rollup: when the ISO week ends, one haiku call over its closed dailies writes weeks/YYYY-Www', async ($, on) => {
  const at = Date.UTC(2026, 10, 9, 8, 2) // Monday of week 46
  const w = await world($, on, {
    rows: [], sessionId: 'me', now: at,
    journal: {
      model: byPrompt,
      files: {
        'days/2026-11-05': closedDay('2026-11-05', ['Thursday: Trips archive.']),
        'days/2026-11-06': closedDay('2026-11-06', ['Friday: the invoice.']),
      },
    },
  })
  expect(w.models.map(m => m.system)).toEqual([rollupSystem('week')])
  expect(w.models[0]!.prompt).toContain('Thursday: Trips archive.')
  expect(w.models[0]!.prompt).toContain('Friday: the invoice.')
  const wk = w.jfs.get('weeks/2026-W45') as JournalRollup
  expect(wk).toMatchObject({ kind: 'week', key: '2026-W45', lines: ROLL('week').split('\n') })
  expect(wk.children).toEqual([{ key: '2026-11-05', lines: ['Thursday: Trips archive.'] }, { key: '2026-11-06', lines: ['Friday: the invoice.'] }])
  expect(w.jfs.has('weeks/2026-W46')).toBe(false)
  // Rollups are written before today's first version.
  expect(w.jwrites).toEqual(['weeks/2026-W45', 'days/2026-11-09'])
})

test('month rollup: when a month and its last week end, one haiku call over its weeklies writes months/YYYY-MM', async ($, on) => {
  const at = Date.UTC(2026, 10, 2, 9, 2) // Monday 2 November: week 44, the last of October, has ended
  const w = await world($, on, {
    rows: [], sessionId: 'me', now: at,
    journal: {
      model: byPrompt,
      files: {
        'weeks/2026-W43': rollupDoc('week', '2026-W43', ['Week 43: QuoteForge tickets.']),
        'weeks/2026-W44': rollupDoc('week', '2026-W44', ['Week 44: the Trips rail.']),
      },
    },
  })
  expect(w.models.map(m => m.system)).toEqual([rollupSystem('month')])
  const mo = w.jfs.get('months/2026-10') as JournalRollup
  expect(mo).toMatchObject({ kind: 'month', key: '2026-10', lines: ROLL('month').split('\n') })
  expect(mo.children.map(c => c.key)).toEqual(['2026-W43', '2026-W44'])
  expect(w.models[0]!.prompt).toContain('Week 44: the Trips rail.')
})

test('year rollup: when December and its last week end, one haiku call over the monthlies writes years/YYYY', async ($, on) => {
  const at = Date.UTC(2027, 0, 4, 9, 2)
  const w = await world($, on, {
    rows: [], sessionId: 'me', now: at,
    journal: {
      model: byPrompt,
      files: {
        'months/2026-11': rollupDoc('month', '2026-11', ['November: the journal.']),
        'months/2026-12': rollupDoc('month', '2026-12', ['December: the invoice.']),
      },
    },
  })
  expect(w.models.map(m => m.system)).toEqual([rollupSystem('year')])
  const yr = w.jfs.get('years/2026') as JournalRollup
  expect(yr).toMatchObject({ kind: 'year', key: '2026', lines: ROLL('year').split('\n') })
  expect(yr.children).toEqual([{ key: '2026-11', lines: ['November: the journal.'] }, { key: '2026-12', lines: ['December: the invoice.'] }])
})

test('a failed rollup call still writes the period from its children, with the reason', async ($, on) => {
  const at = Date.UTC(2026, 10, 9, 8, 2)
  const w = await world($, on, {
    rows: [], sessionId: 'me', now: at,
    journal: { model: () => null, files: { 'days/2026-11-05': closedDay('2026-11-05', ['Thursday: Trips archive.', 'More.']) } },
  })
  expect(w.jfs.get('weeks/2026-W45')).toMatchObject({ lines: ['Thursday: Trips archive.'], reason: 'api-error overloaded' })
})
