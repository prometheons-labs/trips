// Test helper only: stands in for the engine, the scanner, the host's session
// tools and the store beneath the plugin. Nothing here reaches a real session:
// every $.mcp.call and $.session.send lands in the lists below.
import { mock } from 'claude-code/testing'

import type { SessionRow, SidebarGroup } from '../types'
import { GROUPS, NOW } from './fixture'
import { BACKFILL_PY } from './backfill-scan'
import { JOURNAL_PY } from './journal-store'

export const PANE = {
  plugin: 'trips',
  component: 'Pane',
  requestId: 'trips',
  props: {
    title: 'Trips',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

export const BAND = {
  plugin: 'trips',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

export type WorldOptions = {
  rows: SessionRow[]
  groups?: SidebarGroup[]
  /** isRunning by local id, or 'fail' when the host does not answer. */
  running?: Record<string, boolean> | 'fail'
  sessionId?: string
  contextPercent?: number
  store?: Record<string, unknown>
  /** The scanner exits 1, so only the stored rows draw. */
  scanFails?: boolean
  /** The host's send_message answers isError. */
  sendMessageFails?: boolean
  /** The host's send_message reply text, "delivered" or "queued". */
  sendWord?: string
  /** $.session.send reports not delivered. */
  sessionSendFails?: boolean
  /** The host's mark_completed answers isError. */
  markFails?: boolean
  /** ui.open answers isPlaced false (a narrow surface, unasked) until the test calls allowPlace. */
  firstOpenUnplaced?: boolean
  /** The pane is placed but a tab behind another pane (isShown false). */
  paneBehind?: boolean
  /** The clock's start, NOW when not given. */
  now?: number
  /** The daily summary's store and model. */
  journal?: JournalWorld
  /** What $.session.surfaces() answers: ['desktop'] when not given, [] for a plain -p run. */
  surfaces?: string[]
}

export type ModelSeen = { model: string; system?: string; prompt: string }
/** The fake model: a reply text, null for an api-error, or a whole result. */
export type ModelFn = (e: ModelSeen) => string | null | Record<string, unknown>

export type JournalWorld = {
  /** Files of ~/.claude/trips-journal by path without .json: `days/2026-11-11`. */
  files?: Record<string, unknown>
  tzOffsetMin?: number
  /** A lease another session holds. */
  lease?: { holder: string; expiry: number }
  model?: ModelFn
  /** Every store write exits non-zero, until setWriteFails(false). */
  writeFails?: boolean
  /** What the backfill's transcript scan prints, per local day. */
  transcripts?: Record<string, unknown[]>
  /** The transcript scan exits 1. */
  scanFails?: boolean
}

export type McpSeen = { server: string; tool: string; args: Record<string, unknown> }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function world($: any, on: any, options: WorldOptions) {
  // The store in memory, readable by the test (the test's $ has no store noun).
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  on('store.get', async (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', async (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: options.now ?? NOW })
  // The journal store in memory: the Python store's five ops, same rules.
  const jfs = new Map<string, unknown>(Object.entries(options.journal?.files ?? {}))
  const jwrites: string[] = []
  const jops: string[] = []
  /** The journal folder each store op was given (argv 6). */
  const jroots: string[] = []
  /** The days each backfill scan asked for. */
  const bscans: string[][] = []
  let lease: { holder: string; expiry: number } | undefined = options.journal?.lease
  const tz = options.journal?.tzOffsetMin ?? 0
  let writeFails = options.journal?.writeFails === true
  const leaseHolders: string[] = []
  const models: ModelSeen[] = []
  let modelFn: ModelFn = options.journal?.model ?? (() => null)
  const listOf = (dir: string) => [...jfs.keys()].filter(k => k.startsWith(`${dir}/`)).map(k => k.slice(dir.length + 1)).sort()
  const copy = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v)) as unknown)
  const journalOp = (op: string, arg: Record<string, unknown>): unknown => {
    jops.push(op)
    // A test that names no journal has no store: the journal stays empty and out of its way.
    if (!options.journal) throw new Error('no journal store in this test')
    if (op === 'state') {
      const days = listOf('days')
      const recent: Record<string, unknown> = {}
      for (const k of days.slice(-Number(arg.recent ?? 3))) recent[k] = copy(jfs.get(`days/${k}`))
      return { root: '/home/test/.claude/trips-journal', tzOffsetMin: tz, lists: { days, weeks: listOf('weeks'), months: listOf('months'), years: listOf('years') }, recent }
    }
    if (op === 'read') return { files: Object.fromEntries((arg.paths as string[]).map(p => [p, copy(jfs.get(p))])) }
    if (op === 'write') {
      if (writeFails) throw new Error('disk full')
      for (const w of arg.writes as Array<{ path: string; data: unknown }>) {
        jfs.set(w.path, copy(w.data))
        jwrites.push(w.path)
      }
      return { written: (arg.writes as Array<{ path: string }>).map(w => w.path) }
    }
    if (op === 'lease') {
      const now = Number(arg.now)
      leaseHolders.push(String(arg.holder))
      if (lease && lease.holder !== arg.holder && lease.expiry >= now) return { held: false, holder: lease.holder }
      lease = { holder: String(arg.holder), expiry: now + Number(arg.ttlMs) }
      return { held: true, holder: arg.holder }
    }
    if (op === 'release') {
      if (lease?.holder === arg.holder) lease = undefined
      return { released: true }
    }
    if (op === 'mark') {
      const cur = jfs.get('start') as { from?: string } | undefined
      if (cur && String(cur.from ?? '') <= String(arg.from ?? '')) return { mark: cur, written: false }
      const mark = { at: String(arg.at ?? ''), mode: String(arg.mode ?? ''), from: String(arg.from ?? '') }
      jfs.set('start', mark)
      jwrites.push('start')
      return { mark, written: true }
    }
    throw new Error(`unknown op ${op}`)
  }
  const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  on('model.complete', async (_: unknown, e: ModelSeen) => {
    models.push({ model: e.model, system: e.system, prompt: String(e.prompt) })
    const r = modelFn(e)
    if (r === null) return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } }
    if (typeof r === 'string') return { value: { isAnswered: true, text: r, usage } }
    return { value: { usage, ...r } }
  })
  const toasts: string[] = []
  const titles: string[] = []
  const mcp: McpSeen[] = []
  const sent: Array<{ to: unknown; text: string }> = []
  let payload = { sessions: options.rows, groups: options.groups ?? GROUPS }
  let running = options.running ?? 'fail'
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

  on('process.run', async (_: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    if (e.argv[0] !== 'python3') return ok('')
    if (e.argv[3] === BACKFILL_PY) {
      const days = (JSON.parse(e.argv[4] ?? '{}') as { days: string[] }).days
      bscans.push(days)
      if (options.journal?.scanFails) return { value: { exitCode: 1, stdout: '', stderr: 'no transcripts', isStdoutTruncated: false, isStderrTruncated: false } }
      const t = options.journal?.transcripts ?? {}
      return ok(JSON.stringify({ days: Object.fromEntries(days.map(d => [d, t[d] ?? []])), files: 1 }))
    }
    if (e.argv[3] === JOURNAL_PY) {
      jroots.push(e.argv[6] ?? '')
      try {
        return ok(JSON.stringify(journalOp(e.argv[4] ?? '', JSON.parse(e.argv[5] ?? '{}') as Record<string, unknown>)))
      } catch (err) {
        return { value: { exitCode: 1, stdout: '', stderr: String(err), isStdoutTruncated: false, isStderrTruncated: false } }
      }
    }
    if (options.scanFails) return { value: { exitCode: 1, stdout: '', stderr: 'no python', isStdoutTruncated: false, isStderrTruncated: false } }
    return ok(JSON.stringify(payload))
  })
  const spawns: string[][] = []
  const runs: string[][] = []
  on('process.spawn', async function* (_: unknown, e: { argv: string[] }) {
    spawns.push(e.argv)
    return { value: { code: 0, signal: null } }
  })
  on('mcp.call', async (_: unknown, e: McpSeen) => {
    mcp.push({ server: e.server, tool: e.tool, args: e.args })
    if (e.tool === 'list_sessions') {
      if (running === 'fail') return { deny: 'no such server' }
      const list = Object.entries(running).map(([sessionId, isRunning]) => ({ sessionId, isRunning }))
      return { value: { content: [{ type: 'text', text: JSON.stringify(list) }], isError: false } }
    }
    if (e.tool === 'send_message') {
      if (options.sendMessageFails) return { value: { content: [{ type: 'text', text: 'session not found' }], isError: true } }
      return { value: { content: [{ type: 'text', text: `Message ${options.sendWord ?? 'delivered'}.` }], isError: false } }
    }
    if (e.tool === 'mark_completed' && options.markFails) return { value: { content: [{ type: 'text', text: 'refused' }], isError: true } }
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } }
  })
  on('session.send', async (_: unknown, e: { to: unknown; text: string }) => {
    sent.push({ to: e.to, text: e.text })
    return options.sessionSendFails ? { isDelivered: false, reason: 'not running' } : { isDelivered: true }
  })
  on('session.id', async () => ({ value: options.sessionId ?? 'me' }))
  on('session.surfaces', async () => ({ value: options.surfaces ?? ['desktop'] }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: options.contextPercent }, rateLimits: [] },
  }))
  on('session.start', async (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', async (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  const opens: string[] = []
  let placed = false
  let canPlace = !options.firstOpenUnplaced
  on('ui.open', async (_: unknown, e: { id: string; title?: string }) => {
    opens.push(e.id)
    titles.push(e.title ?? '')
    placed = canPlace
    return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.close', async () => {
    placed = false
    return { value: undefined }
  })
  on('ui.panes', async () => ({
    value: [{ id: 'trips', title: titles[titles.length - 1] ?? 'Trips', isShown: placed && !options.paneBehind, isFocused: false, isPlaced: placed }],
  }))
  on('ui.toast', async (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))

  await $.session.start({ cwd: '/workspace', surface: 'desktop', isInteractive: true })
  await clock.settle()

  return {
    clock,
    store,
    toasts,
    titles,
    opens,
    mcp,
    sent,
    /** The journal store's files, the paths written in order, and the ops run. */
    jfs,
    jwrites,
    jops,
    jroots,
    bscans,
    /** Every model.complete request. */
    models,
    setModel(fn: ModelFn) {
      modelFn = fn
    },
    lease: () => lease,
    /** The holder named by every lease op, in order. */
    leaseHolders,
    setWriteFails(fails: boolean) {
      writeFails = fails
    },
    /** Moves the clock to `ms` and lets the work it woke settle. */
    async at(ms: number) {
      await clock.advance(ms - clock.now())
      await clock.settle()
    },
    /** Every argv the plugin spawned or ran. */
    spawns,
    runs,
    /** The next scan prints these rows. */
    setRows(rows: SessionRow[]) {
      payload = { ...payload, sessions: rows }
    },
    setRunning(next: Record<string, boolean> | 'fail') {
      running = next
    },
    /** One tick: the 5 s timer fires and its scan settles. */
    async tick() {
      await clock.advance(5000)
      await clock.settle()
    },
    mount(surface: 'desktop' | 'terminal' | 'mobile' = 'desktop') {
      return $.ui.mount({ ...PANE, surface })
    },
    /** From now on an open is placed, as the person's own press places it. */
    allowPlace() {
      canPlace = true
    },
    mountBand(surface: 'desktop' | 'terminal' = 'desktop') {
      return $.ui.mount({ ...BAND, surface })
    },
  }
}
