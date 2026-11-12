import { expect, test } from 'claude-code/testing'

import type { JournalDay, JournalEntry, JournalRollup } from '../types'
import { blocked, row } from './fixture'
import { FIRST_LINE } from './journal'
import { TOKENS } from './rail'
import { world } from './world'

type El = { type: string; key?: string; text?: string; props?: Record<string, unknown>; children?: unknown[] }
const keyOf = (el: El) => (el.key ?? el.props?.key) as string | undefined
const kids = (el: El): El[] => (el.children ?? []).filter((c): c is El => !!c && typeof c === 'object' && 'type' in (c as object))
function walk(el: El, out: El[] = []): El[] {
  out.push(el)
  for (const c of kids(el)) walk(c, out)
  return out
}
type Ui = {
  drawn: () => Promise<unknown>
  find: (q: object) => Promise<El | undefined>
  findAll: (q: object) => Promise<El[]>
  press: (q: object) => Promise<unknown>
  unmount: () => Promise<unknown>
}
const textOf = async (ui: Ui, key: string) => (await ui.find({ key }))?.text
const colourOf = async (ui: Ui, key: string) => kids((await ui.find({ key }))!)[0]?.props?.color
const keysIn = async (ui: Ui) => walk((await ui.drawn()) as El).map(keyOf).filter((k): k is string => !!k)
/** One entry row as the reader sees it: time, label, done, next. */
const entryAt = async (ui: Ui, key: string) => [await textOf(ui, `${key}:time`), await textOf(ui, `${key}:label`), await textOf(ui, `${key}:done`), await textOf(ui, `${key}:next`)]

const MIN = 60000
const T = Date.UTC(2026, 10, 11, 14, 2)
const at = (h: number, m: number) => Date.UTC(2026, 10, 11, h, m)
const SAMPLE = [{ sessionId: 'a', label: 'LedgerLoop invoices', done: 'Added footer links to the invoice page.', next: 'Ship the invoice footer.' }]
const reply = () => JSON.stringify(SAMPLE)
const v = (hour: number, lines: string[], extra: Record<string, unknown> = {}) => ({ at: new Date(at(hour, 2)).toISOString(), hour, lines, sources: ['a'], ...extra })
const en = (sessionId: string, h: number, m: number, label: string, done: string, next = ''): JournalEntry => ({ at: at(h, m), sessionId, label, done, next })
/** A day of six entries: Trips journal leads the last two hours. */
const busyDay = (): JournalDay => ({
  date: '2026-11-11', lines: [], closed: false,
  versions: [v(10, []), v(11, []), v(12, []), v(13, [])],
  entries: [
    en('t', 9, 40, 'QuoteForge ticket 412', 'Drafted two layouts for the ticket list.', 'Pick layout A or B.'),
    en('s', 10, 15, 'LedgerLoop invoices', 'Added the invoice index page.'),
    en('j', 12, 20, 'Trips journal', 'Wrote the entry trail type.'),
    en('j', 12, 50, 'Trips journal', 'Built the hourly entry run.'),
    en('t', 13, 10, 'QuoteForge ticket 412', 'Picked layout B for the list.'),
    en('j', 13, 40, 'Trips journal', 'Drew the entry rows on the card.', 'Ship 0.6.0.'),
  ],
})

test('no summary yet: one dim line and Update now, which writes this hour at once under the lease', async ($, on) => {
  const w = await world($, on, { rows: [row('a', 0, { mtimeMs: T - 2 * 60 * MIN })], sessionId: 'me', now: T, journal: { model: reply } })
  const ui = (await w.mount('desktop')) as unknown as Ui
  expect(w.models).toHaveLength(0)
  expect(await textOf(ui, 'journal-first')).toBe(FIRST_LINE)
  expect(await colourOf(ui, 'journal-first')).toBe(TOKENS.muted)
  expect((await ui.find({ key: 'journal-now' }))?.props?.label).toBe('Update now')

  w.setRows([row('a', 0, { title: 'Fix the invoice footer', mtimeMs: T - 10 * MIN })])
  await w.tick()
  await ui.press({ key: 'journal-now' })
  expect(w.models).toHaveLength(1)
  // The first tick's lease, then Update now's lease and its renewal before the model call.
  expect(w.jops.filter(o => o === 'lease').length).toBe(3)
  expect(w.lease()).toBeUndefined()
  expect((w.jfs.get('days/2026-11-11') as JournalDay).versions.map(x => x.hour)).toEqual([14, 14])
  expect(await entryAt(ui, 'journal-entry:0')).toEqual(['13:52', 'LedgerLoop invoices', 'Added footer links to the invoice page.', '→ Ship the invoice footer.'])
  expect(await ui.find({ key: 'journal-now' })).toBeUndefined()
  expect(await ui.find({ key: 'journal-first' })).toBeUndefined()
  await ui.unmount()
})

test('Update now honours another session\'s lease: no call and no write', async ($, on) => {
  const w = await world($, on, {
    rows: [row('a', 0, { mtimeMs: T - 5 * MIN })], sessionId: 'me', now: T,
    journal: { model: reply, lease: { holder: 'other', expiry: T + 4 * MIN } },
  })
  const ui = (await w.mount('desktop')) as unknown as Ui
  await ui.press({ key: 'journal-now' })
  expect(w.models).toHaveLength(0)
  expect(w.jwrites).toEqual([])
  expect(await textOf(ui, 'journal-first')).toBe(FIRST_LINE)
  await ui.unmount()
})

test('the card sits at the top, above the Platform: a Focus line, the 3 to 5 lines of newest entries, and "Updated 14:00 · N entries today"', async ($, on) => {
  const w = await world($, on, {
    rows: [row('me', 0, { mtimeMs: T - 30 * MIN }), blocked('b', 0, 'pick A or B', { mtimeMs: T - 3 * 60 * MIN })],
    sessionId: 'me', running: {}, now: T,
    journal: { model: () => JSON.stringify([{ sessionId: 'me', label: 'Trips journal', done: 'Wrote the card tests.', next: '' }]), files: { 'days/2026-11-11': busyDay() } },
  })
  const ui = (await w.mount('desktop')) as unknown as Ui
  const keys = await keysIn(ui)
  const tree = (await ui.drawn()) as El
  expect(keyOf(kids(tree)[0]!)).toBe('journal-wrap')
  expect(keys.indexOf('journal')).toBeLessThan(keys.indexOf('lane:platform'))
  expect(keys.indexOf('journal')).toBeLessThan(keys.indexOf('gbar'))
  // Newest first, 5 at most: the new 13:32 entry sits between 13:10 and 13:40.
  expect(await entryAt(ui, 'journal-entry:0')).toEqual(['13:40', 'Trips journal', 'Drew the entry rows on the card.', '→ Ship 0.6.0.'])
  expect(await entryAt(ui, 'journal-entry:1')).toEqual(['13:32', 'Trips journal', 'Wrote the card tests.', undefined])
  expect(await textOf(ui, 'journal-entry:4:time')).toBe('12:20')
  expect(await ui.find({ key: 'journal-entry:5' })).toBeUndefined()
  expect((await ui.find({ key: 'journal-entry:0:time' }))!.children?.[0]).toMatchObject({ props: { mono: true, color: TOKENS.muted } })
  expect(await colourOf(ui, 'journal-entry:0:next')).toBe(TOKENS.muted)
  expect(await textOf(ui, 'journal-focus')).toBe('Focus: Trips journal')
  expect(await textOf(ui, 'journal-meta')).toBe('Updated 14:00 · 7 entries today')
  // Grid steps only, the overlay fill, a round hairline, no side accent.
  const card = await ui.find({ key: 'journal' })
  expect(card?.props).toMatchObject({ paddingX: 'sm', paddingY: 'sm', gap: 'xs', backgroundColor: TOKENS.overlay, borderStyle: 'round' })
  for (const p of ['borderLeft', 'borderLeftColor', 'borderLeftWidth']) expect(card?.props?.[p]).toBeUndefined()
  expect((await ui.find({ key: 'journal-timeline' }))?.props?.label).toBe('Timeline')
  expect((await ui.find({ key: 'journal-browse' }))?.props?.label).toBe('Journal')
  await ui.unmount()
})

test('no Focus line when no session clearly leads the last two hours', async ($, on) => {
  // In the last 2 hours: Trips journal once, QuoteForge once. Nobody leads.
  const e = busyDay()
  e.entries = e.entries!.filter(x => x.sessionId !== 'j' || x.at === at(13, 40))
  const w = await world($, on, { rows: [], sessionId: 'me', now: T, journal: { model: reply, files: { 'days/2026-11-11': e } } })
  const ui = (await w.mount('desktop')) as unknown as Ui
  expect(await textOf(ui, 'journal-entry:0:label')).toBe('Trips journal')
  expect(await ui.find({ key: 'journal-focus' })).toBeUndefined()
  await ui.unmount()
})

test('timeline: Timeline shows every entry of today newest first in the same row format', async ($, on) => {
  const w = await world($, on, { rows: [], sessionId: 'me', now: T, journal: { model: reply, files: { 'days/2026-11-11': busyDay() } } })
  const ui = (await w.mount('desktop')) as unknown as Ui
  expect(await ui.find({ key: 'journal-timeline-list' })).toBeUndefined()
  await ui.press({ key: 'journal-timeline' })
  const order = (await keysIn(ui)).filter(k => /^timeline:\d+$/.test(k))
  expect(order).toEqual(['timeline:5', 'timeline:4', 'timeline:3', 'timeline:2', 'timeline:1', 'timeline:0'])
  expect(await Promise.all(order.map(k => textOf(ui, `${k}:time`)))).toEqual(['13:40', '13:10', '12:50', '12:20', '10:15', '09:40'])
  expect(await entryAt(ui, 'timeline:0')).toEqual(['09:40', 'QuoteForge ticket 412', 'Drafted two layouts for the ticket list.', '→ Pick layout A or B.'])
  await ui.press({ key: 'journal-timeline' })
  expect(await ui.find({ key: 'journal-timeline-list' })).toBeUndefined()
  await ui.unmount()
})

test('timeline of a day written before entries: its old lines show, and its versions list newest first, quiet ones dimmed', async ($, on) => {
  const old = { date: '2026-11-11', lines: ['x', 'y', 'z'], closed: false, versions: [v(12, ['x', 'y', 'z']), v(13, ['x', 'y', 'z'], { quiet: true })] }
  const w = await world($, on, { rows: [], sessionId: 'me', now: T, journal: { model: reply, files: { 'days/2026-11-11': old } } })
  const ui = (await w.mount('desktop')) as unknown as Ui
  expect(await textOf(ui, 'journal-line:0')).toBe('x')
  expect(await ui.find({ key: 'journal-first' })).toBeUndefined()
  expect(await textOf(ui, 'journal-meta')).toBe('Updated 14:00 · 3 versions')
  await ui.press({ key: 'journal-timeline' })
  const order = (await keysIn(ui)).filter(k => /^timeline:\d+$/.test(k))
  expect(order).toEqual(['timeline:2', 'timeline:1', 'timeline:0'])
  expect(await Promise.all(order.map(k => textOf(ui, `${k}:head`)))).toEqual(['14:00 · quiet', '13:00 · quiet', '12:00'])
  expect(await colourOf(ui, 'timeline:1:0')).toBe(TOKENS.muted)
  expect(await colourOf(ui, 'timeline:0:0')).toBe(TOKENS.secondary)
  await ui.unmount()
})

test('journal browser: Day, Week, Month and Year each show their lines and child summaries, with previous and next', async ($, on) => {
  const week: JournalRollup = { kind: 'week', key: '2026-W45', at: '', lines: ['Built the Trips rail.', 'Two', 'Three'], children: [{ key: '2026-11-05', lines: ['Shipped Trips archive.'] }] }
  const month: JournalRollup = { kind: 'month', key: '2026-10', at: '', lines: ['Shipped the quote PDF.', 'Two', 'Three'], children: [{ key: '2026-W44', lines: ['Built the rail.'] }] }
  const year: JournalRollup = { kind: 'year', key: '2025', at: '', lines: ['Started the booking agent.', 'Two', 'Three'], children: [] }
  const yesterday = { date: '2026-11-10', lines: ['a', 'b', 'c'], closed: true, close: { at: '', lines: ['Closed six QuoteForge tickets.', 'Two', 'Three'] }, versions: [v(10, ['a', 'b', 'c'])] }
  const w = await world($, on, {
    rows: [], sessionId: 'me', now: T,
    journal: { model: reply, files: { 'days/2026-11-10': yesterday, 'days/2026-11-11': busyDay(), 'weeks/2026-W45': week, 'months/2026-10': month, 'years/2025': year } },
  })
  const ui = (await w.mount('desktop')) as unknown as Ui
  await ui.press({ key: 'journal-browse' })
  expect((await ui.find({ key: 'scale:day' }))?.props?.variant).toBe('primary')
  expect(await textOf(ui, 'journal-period')).toBe('Wednesday 11 November 2026')
  expect(await ui.find({ key: 'journal-next' })).toBeUndefined()
  expect(await textOf(ui, 'journal-period-none')).toBe('Open day. It closes at midnight.')
  expect(await entryAt(ui, 'journal-child:0')).toEqual(['13:40', 'Trips journal', 'Drew the entry rows on the card.', '→ Ship 0.6.0.'])

  await ui.press({ key: 'journal-prev' })
  expect(await textOf(ui, 'journal-period')).toBe('Tuesday 10 November 2026')
  expect(await textOf(ui, 'journal-period-line:0')).toBe('Closed six QuoteForge tickets.')
  expect(await textOf(ui, 'journal-child:0:0')).toBe('a')
  expect(await ui.find({ key: 'journal-prev' })).toBeUndefined()
  await ui.press({ key: 'journal-next' })
  expect(await textOf(ui, 'journal-period')).toBe('Wednesday 11 November 2026')

  await ui.press({ key: 'scale:week' })
  expect(await textOf(ui, 'journal-period')).toBe('Week 45, 2026')
  expect(await textOf(ui, 'journal-period-line:0')).toBe('Built the Trips rail.')
  expect(await textOf(ui, 'journal-child:0:0')).toBe('Shipped Trips archive.')
  expect(await textOf(ui, 'journal-child:0:head')).toBe('Thursday 5 November 2026')

  await ui.press({ key: 'scale:month' })
  expect(await textOf(ui, 'journal-period')).toBe('October 2026')
  expect(await textOf(ui, 'journal-child:0:0')).toBe('Built the rail.')

  await ui.press({ key: 'scale:year' })
  expect(await textOf(ui, 'journal-period')).toBe('2025')
  expect(await textOf(ui, 'journal-period-line:0')).toBe('Started the booking agent.')
  await ui.unmount()
})
