/** One pull request the desktop app bound to a session. */
export type SessionPr = {
  prNumber: number
  url: string
  /** Lower case as the app reports it: `open`, `merged`, `closed`. */
  state: string
}

/** One sidebar group of the desktop app, in sidebar order. */
export type SidebarGroup = { id: string; name: string }

/** The app's own turn summary category, '' when the record has none. */
export type SessionStatus = 'blocked' | 'review_ready' | 'completed' | ''

export type SessionRow = {
  /** The CLI session id: the transcript's file name. */
  id: string
  /** The desktop app's `local_` id, empty for a terminal-only session. */
  localId: string
  title: string
  project: string
  lastPrompt: string
  mtimeMs: number
  /** Local wall-clock time of the last write, `HH:MM`. */
  clock: string
  /** Local hour bucket of the last write, `HH:00`. */
  hour: string
  isToday: boolean
  /** Local calendar days between the last write and the scan, 0 for today. */
  daysAgo: number
  /** Local short weekday name of the last write, `Mon`. */
  weekday: string
  /** The desktop `local_` id of the parent (spawnedFrom or forkedFrom), or ''. */
  parentLocalId: string
  createdAtMs: number
  isArchived: boolean
  isStarred: boolean
  /** postTurnSummary.status_category. */
  status: SessionStatus
  /** postTurnSummary.needs_action: what the session asks of the person. */
  nextAction: string
  /** postTurnSummary.summarizes_uuid: one value per summary, so one per flip. */
  summaryId: string
  /** turnWrapUp.description, else the first sentence of lastTurnReport. */
  recap: string
  /** turnWrapUp.description in full, plain, 400 characters at most (0.6.0). */
  wrapUp?: string
  /** lastTurnReport, plain, 400 characters at most (0.6.0). */
  report?: string
  /** postTurnSummary.status_detail, plain, 400 characters at most (0.6.0). */
  detail?: string
  /** The sidebar group from the desktop config, '' when unassigned. */
  groupId: string
  groupName: string
  branch: string
  prs: SessionPr[]
  /** The session's git worktree, '' when it has none: archiving deletes it. */
  worktreePath: string
}

/** One hourly update of the daily summary, as stored in days/YYYY-MM-DD.json. */
export type JournalVersion = {
  /** ISO time of the write. */
  at: string
  /** Local hour of the slot, 0 to 23: one writer per hour. */
  hour: number
  lines: string[]
  /** No session was touched since the last version: no model call. */
  quiet?: boolean
  /** Ids of the sessions the model read. */
  sources: string[]
  /** How many entries this run added (0.6.0 entries). */
  entries?: number
  /** Why the lines were kept from before: the call failed or the reply was short. */
  reason?: string
  /** Written by /trips setup from the transcripts, not by the hourly tick. */
  backfill?: boolean
}

/** One interstitial note: what a session just finished, and what comes next. */
export type JournalEntry = {
  /** The session's turn-end time (its mtimeMs). */
  at: number
  sessionId: string
  /** A short session or project name, 4 words at most. */
  label: string
  /** One sentence: the concrete thing finished or changed. */
  done: string
  /** One short sentence, the next step, or ''. */
  next: string
}

/** The closing summary of a day. */
export type JournalClose = { at: string; lines: string[]; reason?: string }

/** One day file. */
export type JournalDay = {
  date: string
  /** Today's current lines: the newest good version's. */
  lines: string[]
  versions: JournalVersion[]
  /** The entry trail, oldest first; absent on a day written before entries. */
  entries?: JournalEntry[]
  closed: boolean
  close?: JournalClose
}

export type JournalScale = 'day' | 'week' | 'month' | 'year'

/** A week, month or year rollup, with the child summaries it was written from. */
export type JournalRollup = {
  kind: 'week' | 'month' | 'year'
  key: string
  at: string
  lines: string[]
  reason?: string
  children: Array<{ key: string; lines: string[] }>
}

/** The keys of every stored file, sorted, per folder. */
export type JournalLists = { days: string[]; weeks: string[]; months: string[]; years: string[] }

declare module 'claude-code' {
  interface PluginState {
    'trips': {
      sessions: SessionRow[]
      /** The sidebar groups in sidebar order, read from the desktop config. */
      groups: SidebarGroup[]
      scannedAt: number
      restingOpen: boolean
      /** How many Sidings sessions are drawn, 30 more per press, back to 30 on close. */
      restingShown: number
      archiveOpen: boolean
      /** isRunning by desktop `local_` id from the host, null when the host did not answer. */
      running: Record<string, boolean> | null
      /** The group filter: a group id, or 'ALL'. */
      groupFilter: string
      /** The Platform shows every waiting row, not only the newest five. */
      platformOpen: boolean
      /** The Depot search text. */
      query: string
      /** The row id whose Reply field is open, or ''. */
      replyOpen: string
      replyDraft: string
      /** `<id>:<summaryId>` of blocked rows the person marked Done. */
      dismissed: string[]
      /** Row ids whose last reply reached neither the host nor session.send. */
      undeliverable: string[]
      /** The Trips pane is drawn in this session: the band chip hides while it is. */
      paneUp: boolean
      /** Parked rows whose Undo row still shows, with the time it ends. */
      undoParks: Array<{ id: string; localId: string; title: string; until: number }>
      /** Trips-only Depot marks by `local_` id: when, and the summary they parked. */
      parked: Record<string, { at: number; summaryId: string }>
      /** Today's day file as last read, null before the first read. */
      journalDay: JournalDay | null
      journalLists: JournalLists
      /** Minutes east of UTC, from the journal store's last read. */
      journalTz: number
      /** Which part of the card is open: none, today's timeline, or the journal browser. */
      journalOpen: '' | 'timeline' | 'journal'
      journalScale: JournalScale
      /** The period the browser shows, '' for the newest. */
      journalKey: string
      /** Loaded files for the browser, by path (days/2026-11-11). */
      journalDocs: Record<string, JournalDay | JournalRollup | null>
      /** An update runs in this session now. */
      journalBusy: boolean
    }
  }
}
