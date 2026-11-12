import { expect, test } from 'claude-code/testing'

import type { JournalDay, JournalEntry } from '../types'
import { blocked, row } from './fixture'
import { TOKENS } from './rail'
import { lampOf } from './platform'
import { dateLabel } from './register'
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
  unmount: () => Promise<unknown>
}

/** The text runs inside an element, in drawn order (a Text keeps no key, its string is its child). */
const runs = (el: El) => walk(el).filter(e => e.type === 'Text').map(e => e.children?.[0] as string)

const MIN = 60000
const T = Date.UTC(2026, 10, 11, 14, 2)
const at = (h: number, m: number) => Date.UTC(2026, 10, 11, h, m)
const en = (h: number, m: number, label: string, done: string, next = ''): JournalEntry => ({ at: at(h, m), sessionId: 'j', label, done, next })
const day = (): JournalDay => ({
  date: '2026-11-11', lines: [], closed: false,
  versions: [{ at: new Date(at(13, 2)).toISOString(), hour: 13, lines: [], sources: ['a'] }],
  entries: [en(12, 20, 'Trips journal', 'Wrote the entry trail type.'), en(13, 40, 'Trips journal', 'Drew the entry rows.', 'Ship 0.6.2.')],
})

const mixed = () => [
  row('me', 1, { title: 'Current work' }),
  blocked('b', 30, 'pick A or B', { title: 'Waiting trip' }),
  row('r', 70, { title: 'Review trip', status: 'review_ready', hour: '12:00' }),
  row('d', 200, { title: 'Done trip', status: 'completed', hour: '10:00' }),
]

test('the journal card: Today and the date, entry rows with time, label and done, a footer with meta and both buttons', async ($, on) => {
  const w = await world($, on, { rows: [row('me', 0, { mtimeMs: T - 30 * MIN })], sessionId: 'me', running: {}, now: T, journal: { model: () => '[]', files: { 'days/2026-11-11': day() } } })
  const ui = (await w.mount('desktop')) as unknown as Ui
  const head = (await ui.find({ key: 'journal-head' }))!
  expect(head.props?.justifyContent).toBe('space-between')
  expect(runs(head)).toEqual(['Today', dateLabel('2026-11-11')])
  expect(dateLabel('2026-11-12')).toBe('Thu 12 Nov')

  // One entry row: a fixed-width mono time column, a semi-bold label, the done sentence, then a dimmer next line.
  const entry = (await ui.find({ key: 'journal-entry:0' }))!
  const time = (await ui.find({ key: 'journal-entry:0:time' }))!
  expect(keyOf(kids(entry)[0]!)).toBe('journal-entry:0:time')
  expect(time.props?.width).toBe(6)
  expect(time.text).toBe('13:40')
  expect(kids(time)[0]?.props).toMatchObject({ mono: true, color: TOKENS.muted })
  const label = (await ui.find({ key: 'journal-entry:0:label' }))!
  expect(label.text).toBe('Trips journal')
  expect(kids(label)[0]?.props?.weight).toBe('semibold')
  expect((await ui.find({ key: 'journal-entry:0:done' }))?.text).toBe('Drew the entry rows.')
  expect((await ui.find({ key: 'journal-entry:0:next' }))?.text).toBe('→ Ship 0.6.2.')
  expect(await ui.find({ key: 'journal-rule:1' })).toBeDefined()

  // The footer: meta on the left, Timeline and Journal on the right.
  const foot = (await ui.find({ key: 'journal-acts' }))!
  expect(foot.props?.justifyContent).toBe('space-between')
  const [left, right] = kids(foot)
  expect(runs(left!)[0]).toMatch(/^Updated \d\d:00 · \d+ entries today$/)
  expect((await ui.find({ key: 'journal-foot-meta' }))?.text).toBe((await ui.find({ key: 'journal-meta' }))?.text)
  const labels = walk(right!).filter(e => e.type === 'Button').map(e => e.props?.label)
  expect(labels).toEqual(['Timeline', 'Journal'])
  await ui.unmount()
})

test('Platform: a caption, "x of y blocked", and one bordered panel of rows with project and time on a meta line', async ($, on) => {
  const w = await world($, on, { rows: mixed(), sessionId: 'me', running: {} })
  const ui = (await w.mount('desktop')) as unknown as Ui
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('PLATFORM')
  expect(texts).toContain('1 of 4 blocked')
  const panel = (await ui.find({ key: 'platform-panel' }))!
  expect(panel.props).toMatchObject({ borderStyle: 'round', borderColor: TOKENS.hair })
  for (const p of ['borderLeft', 'borderLeftColor', 'borderLeftWidth']) expect(panel.props?.[p]).toBeUndefined()
  expect(walk(panel).some(e => keyOf(e) === 'lane:row:b')).toBe(true)
  const meta = (await ui.find({ key: 'meta:b' }))!
  expect(runs(meta)).toEqual(['tools', '· 10:15'])
  await ui.unmount()
})

test('lamps map from status: blocked amber, running pulse, review patina ring, done grey ring', async ($, on) => {
  const quiet = { dismissed: new Set<string>(), running: { local_me: true } }
  expect(lampOf(blocked('b', 5, 'x'), quiet, false)).toBe('blocked')
  expect(lampOf(row('me', 1), quiet, true)).toBe('running')
  expect(lampOf(row('r', 5, { status: 'review_ready' }), quiet, false)).toBe('review')
  expect(lampOf(row('d', 5, { status: 'completed' }), quiet, false)).toBe('done')

  const w = await world($, on, { rows: mixed(), sessionId: 'me', running: { local_me: true } })
  const ui = (await w.mount('desktop')) as unknown as Ui
  const all = walk((await ui.drawn()) as El)
  const lampSrc = (id: string) => String(kids(all.find(e => keyOf(e) === `rail:row:${id}`)!)[0]!.props?.source)
  const sig = (src: string) => (src.includes('class="p"') ? 'running' : src.includes(`fill="${TOKENS.warning}"`) ? 'blocked' : src.includes(`stroke="${TOKENS.patina}"`) ? 'review' : src.includes(`stroke="${TOKENS.muted}"`) ? 'done' : 'other')
  const kinds = new Set(['me', 'r', 'd'].map(id => sig(lampSrc(id))))
  expect(kinds.size).toBeGreaterThanOrEqual(3)
  expect(sig(lampSrc('me'))).toBe('running')
  expect(sig(lampSrc('r'))).toBe('review')
  expect(sig(lampSrc('d'))).toBe('done')
  expect(sig(String(kids(all.find(e => keyOf(e) === 'rail:row:b') ?? ({} as El))[0]?.props?.source ?? ''))).toBe('blocked')
  await ui.unmount()
})

test('section labels are uppercase mono captions with a count on the right', async ($, on) => {
  const w = await world($, on, { rows: mixed(), sessionId: 'me', running: {} })
  const ui = (await w.mount('desktop')) as unknown as Ui
  const lane = (await ui.find({ key: 'label:last24' }))!
  const [name, count] = kids(lane)
  const title = name!.children?.[0] as string
  expect(title).toBe('LAST 24 HOURS')
  expect(title).toBe(title.toUpperCase())
  expect(name!.props).toMatchObject({ mono: true, color: TOKENS.muted })
  expect(count!.children?.[0]).toMatch(/^\d+$/)
  const sidings = (await ui.find({ key: 'foldtext:resting' }))!
  expect(runs(sidings)).toEqual(['SIDINGS'])
  expect((await ui.find({ key: 'flip:resting' }))?.props?.label).toBe('show')
  await ui.unmount()
})
