import { expect, test } from 'claude-code/testing'

import { GROUPS, blocked, row } from './fixture'
import {
  FUEL_HOT, HANDOFF_LINE, flipKey, fuelOf, isWaiting, lampOf, line2, moreLine, platform, prChips,
} from './platform'
import type { Signals } from './platform'
import { railSvg } from './grid'
import { TOKENS } from './rail'
import { world } from './world'

const quiet: Signals = { dismissed: new Set(), running: null }

test('state A: nothing waits, so the Platform is empty', async () => {
  const view = platform([row('a', 1, { status: 'review_ready' }), row('b', 30, { status: 'completed' })], quiet)
  expect([view.waiting.length, view.shown.length, view.more]).toEqual([0, 0, 0])
})

test('state B: one blocked row rises to the Platform with its ask', async () => {
  const view = platform([row('a', 1, { status: 'review_ready' }), blocked('b', 2 * 24 * 60, 'pick option A or B')], quiet)
  expect(view.shown.map(r => r.id)).toEqual(['b'])
  expect(line2(view.shown[0]!, quiet)).toEqual({ tone: 'ask', text: 'pick option A or B' })
})

test('state C: more than five blocked shows the newest five and counts the rest', async () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map(n => blocked(`b${n}`, n * 24 * 60, `ask ${n}`))
  const view = platform(rows, quiet)
  expect(view.shown.map(r => r.id)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5'])
  expect(view.more).toBe(3)
  expect(moreLine(view)).toBe('+3 more waiting, oldest 8 d')
  expect(platform(rows, quiet, true).shown.length).toBe(8)
})

test('state D: a running turn pulses; a blocked row stays waiting whatever isRunning says', async () => {
  const s: Signals = { dismissed: new Set(), running: { local_r: true, local_b: true, local_i: false, local_v: false, local_d: false, local_n: false } }
  expect(lampOf(row('r', 12, { status: 'review_ready' }), s, true)).toBe('running')
  expect(isWaiting(blocked('b', 30, 'x'), s)).toBe(true)
  expect(lampOf(blocked('b', 30, 'x'), s, false)).toBe('blocked')
  expect(lampOf(blocked('i', 30, 'x'), s, false)).toBe('blocked')
  expect(lampOf(row('v', 1, { status: 'review_ready' }), s, true)).toBe('review')
  expect(lampOf(row('d', 1, { status: 'completed' }), s, false)).toBe('done')
  expect(lampOf(row('n', 90), s, false)).toBe('none')
  // No host answer, or a row the host did not list: the 2-minute live rule stands.
  expect(lampOf(row('l', 1), quiet, true)).toBe('live')
  expect(lampOf(row('x', 1), s, true)).toBe('live')
})

test('archived and Done rows leave the Platform, Done turns its lamp grey', async () => {
  const b = blocked('b', 60, 'approve the plan')
  const done: Signals = { dismissed: new Set([flipKey(b)]), running: null }
  expect(platform([blocked('x', 60, 'a', { isArchived: true }), b], done).waiting.length).toBe(0)
  expect(lampOf(b, done, false)).toBe('done')
  // A new summary is a new ask: the Done mark no longer holds.
  expect(isWaiting({ ...b, summaryId: 'next' }, done)).toBe(true)
})

test('line 2 reads the ask, else the recap, else the last prompt', async () => {
  expect(line2(row('r', 7, { status: 'review_ready', recap: 'The report is live.' }), quiet)).toEqual({ tone: 'recap', text: 'The report is live.' })
  expect(line2(row('p', 9000, { lastPrompt: 'build the blueprint' }), quiet)).toEqual({ tone: 'prompt', text: 'You: build the blueprint' })
  expect(line2(row('n', 1), quiet).tone).toBe('none')
})

test('PR chips: open first and teal, merged quiet, none without PRs', async () => {
  const r = row('p', 60, { prs: [{ prNumber: 44, url: 'https://github.com/x/y/pull/44', state: 'merged' }, { prNumber: 1, url: 'https://github.com/x/y/pull/1', state: 'open' }] })
  expect(prChips(r).map(c => [c.label, c.isOpen])).toEqual([['#1 open', true], ['#44 merged', false]])
  expect(prChips(row('n', 1))).toEqual([])
})

test('the fuel gauge turns amber at 80 percent', async () => {
  expect(fuelOf(46)).toEqual({ percent: 46, isHot: false })
  expect(fuelOf(FUEL_HOT)?.isHot).toBe(true)
  expect(fuelOf(undefined)).toBeUndefined()
})

test('lamps draw amber for blocked and a reduced-motion pulse for running', async () => {
  expect(railSvg({ kind: 'row', lamp: 'blocked', colour: '#5e8cd1', line: 'full' })).toContain(TOKENS.warning)
  const running = railSvg({ kind: 'row', lamp: 'running', colour: '#5e8cd1', line: 'full' })
  expect(running).toContain('prefers-reduced-motion')
  expect(running).toContain('stroke="#5e8cd1"')
})

test('the pane draws the Platform above now, the ask, the fuel gauge and the PR link', async ($, on) => {
  const rows = [
    row('me', 1, { groupId: 'cg-ledger', recap: 'Adding group tabs.' }),
    row('v', 7, { groupId: 'cg-eval', status: 'review_ready', recap: 'The landing-page report is live.', prs: [{ prNumber: 1, url: 'https://github.com/x/y/pull/1', state: 'open' }], branch: 'phase-4' }),
    blocked('b', 2 * 24 * 60, 'pick option A or B in the box below', { groupId: 'cg-lantern', title: 'Choose the LedgerLoop colour tokens' }),
  ]
  const w = await world($, on, { rows, groups: GROUPS, sessionId: 'me', contextPercent: 84 })
  const ui = await w.mount('desktop')
  const texts = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  const at = (s: string) => texts.findIndex((t: string) => t.includes(s))
  expect(at('PLATFORM')).toBeGreaterThanOrEqual(0)
  expect(at('PLATFORM')).toBeLessThan(at('now'))
  expect(texts).toContain('pick option A or B in the box below')
  expect(texts).toContain('1 of 3 blocked')
  expect(texts).toContain(HANDOFF_LINE)
  expect(texts).toContain('context 84%')
  expect(await ui.find({ key: 'chip:v:br' })).toBeDefined()
  expect((await ui.find({ key: 'chip:pr:v:1' }))?.children?.[0]).toMatchObject({ type: 'Svg', props: { alt: '#1 open' } })
  expect(await ui.find({ key: 'pr:v:1' })).toBeDefined()
  // The Platform row is not drawn a second time on the rail.
  expect(texts.filter((t: string) => t === 'Choose the LedgerLoop colour tokens').length).toBe(1)
  expect(w.titles[w.titles.length - 1]).toBe('Trips · 1 waiting')
  await ui.unmount()
})
