import { expect, test } from 'claude-code/testing'

import { blocked, row } from './fixture'
import { BAND, world } from './world'

// The engine's own band beneath the plugin: what next(e) reaches when the chip stands aside.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const engineBand = (on: any) =>
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })

const two = () => [
  row('me', 1),
  blocked('old', 3 * 24 * 60, 'pick A or B', { title: 'Choose the LedgerLoop colour tokens', groupId: 'cg-lantern' }),
  blocked('new', 60, 'approve the plan', { title: 'Dispatch Desk route planner', groupId: 'cg-quote' }),
]

test('shown at 0 waiting, with the eye button', async ($, on) => {
  engineBand(on)
  const w = await world($, on, { rows: [row('me', 1), row('v', 5, { status: 'review_ready' })], sessionId: 'me', firstOpenUnplaced: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await w.mountBand(surface)
    expect(await ui.find({ key: 'trips-band' })).toBeDefined()
    expect((await ui.find({ key: 'trips-count' }))?.text).toBe('\u23F3 0')
    expect(await ui.find({ key: 'trips-open' })).toBeDefined()
    await ui.unmount()
  }
})

test('compact at 0 waiting: no word Trips and no trip title, glyphs only', async ($, on) => {
  engineBand(on)
  const rows = [row('old', 90, { title: 'Older trip' }), row('fresh', 2, { title: 'Freshest trip' })]
  const w = await world($, on, { rows, sessionId: 'me', firstOpenUnplaced: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await w.mountBand(surface)
    expect((await ui.find({ key: 'trips-count' }))?.text).toBe('\u23F3 0')
    expect(await ui.find({ type: 'Text', text: 'Freshest trip' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Trips|waiting/ })).toBeUndefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
    await ui.unmount()
  }
  const term = await w.mountBand('terminal')
  expect(await term.find({ type: 'Text', text: '\u{1F68B}' })).toBeDefined()
  await term.unmount()
})

test('with no sessions at all the pill shows the zero count and the eye', async ($, on) => {
  const w = await world($, on, { rows: [], sessionId: 'me', firstOpenUnplaced: true })
  const ui = await w.mountBand('desktop')
  expect((await ui.find({ key: 'trips-count' }))?.text).toBe('\u23F3 0')
  expect(await ui.find({ key: 'trips-open' })).toBeDefined()
  await ui.unmount()
})

test('no header toolbar icon: the session starts no socket listener', async ($, on) => {
  const w = await world($, on, { rows: [row('me', 1)], sessionId: 'me', firstOpenUnplaced: true })
  await w.tick()
  expect(w.spawns).toEqual([])
  expect(w.runs.some(argv => argv.join(' ').includes('run/trips'))).toBe(false)
})

test('the pill draws beside what the band beneath draws, in one row', async ($, on) => {
  // A stand-in for the Thread pill of the threads mod beneath this plugin.
  engineBand(on)
  const w = await world($, on, { rows: two(), sessionId: 'me', firstOpenUnplaced: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await w.mountBand(surface)
    const r = await ui.find({ key: 'trips-row' })
    expect(r?.props.flexDirection).toBe('row')
    expect(r?.props.flexWrap).toBe('nowrap')
    expect(r?.props.alignItems).toBe('center')
    expect((await ui.find({ key: 'trips-band' }))?.props).toMatchObject({ flexShrink: 1, minWidth: 0 })
    expect((await ui.find({ key: 'trips-eye' }))?.props.flexShrink).toBe(0)
    expect(await ui.find({ key: 'trips-open' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})

test('with nothing beneath, the pill draws alone, no row around it', async ($, on) => {
  const w = await world($, on, { rows: [row('me', 1)], sessionId: 'me', firstOpenUnplaced: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await w.mountBand(surface)
    expect(await ui.find({ key: 'trips-open' })).toBeDefined()
    expect(await ui.find({ key: 'trips-row' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the pane open: the Trips pill stays beside the band beneath', async ($, on) => {
  engineBand(on)
  const w = await world($, on, { rows: two(), sessionId: 'me' })
  const ui = await w.mountBand('desktop')
  expect(await ui.find({ key: 'trips-open' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

test('a survey holds the band: the Trips pill stands aside, the band beneath still draws', async ($, on) => {
  engineBand(on)
  await world($, on, { rows: two(), sessionId: 'me', firstOpenUnplaced: true })
  const survey = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true, isCollapsed: false } })
  expect(await survey.find({ key: 'trips-open' })).toBeUndefined()
  expect(await survey.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await survey.unmount()
})

test('shown at N > 0 with the count only, in every group, no title', async ($, on) => {
  engineBand(on)
  // The pane filter is one group; the chip still counts every group.
  const w = await world($, on, { rows: two(), sessionId: 'me', firstOpenUnplaced: true, store: { groupFilter: 'cg-lantern' } })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await w.mountBand(surface)
    expect((await ui.find({ key: 'trips-count' }))?.text).toBe('\u23F3 2')
    // The titles stay in the pane, off the pill.
    expect(await ui.find({ type: 'Text', text: 'Dispatch Desk route planner' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Session me' })).toBeUndefined()
    expect(await ui.find({ key: 'trips-open' })).toBeDefined()
    await ui.unmount()
  }
})

test('Open opens the Trips pane by its id, and the chip stays while the pane is placed', async ($, on) => {
  engineBand(on)
  const w = await world($, on, { rows: two(), sessionId: 'me', firstOpenUnplaced: true })
  const ui = await w.mountBand('desktop')
  const before = w.opens.length
  w.allowPlace()
  await ui.press({ key: 'trips-open' })
  expect(w.opens.slice(before)).toEqual(['trips'])
  expect(await ui.find({ key: 'trips-open' })).toBeDefined()
  await ui.unmount()
})

test('the chip stays while the pane is placed from the start', async ($, on) => {
  engineBand(on)
  const w = await world($, on, { rows: two(), sessionId: 'me' })
  const ui = await w.mountBand('desktop')
  expect(await ui.find({ key: 'trips-open' })).toBeDefined()
  await ui.unmount()
})

test('the pane is open but not placed: after a scan the chip stays', async ($, on) => {
  engineBand(on)
  const w = await world($, on, { rows: two(), sessionId: 'me', firstOpenUnplaced: true })
  const ui = await w.mountBand('desktop')
  expect(await ui.find({ key: 'trips-open' })).toBeDefined()
  await w.tick()
  await w.tick()
  expect(await ui.find({ key: 'trips-open' })).toBeDefined()
  await ui.unmount()
})

test('the pane is placed but a tab behind another pane: the chip stays', async ($, on) => {
  engineBand(on)
  const w = await world($, on, { rows: two(), sessionId: 'me', paneBehind: true })
  const ui = await w.mountBand('desktop')
  await w.tick()
  expect(await ui.find({ key: 'trips-open' })).toBeDefined()
  await ui.unmount()
})
