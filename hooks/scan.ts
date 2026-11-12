// The transcript scanner, run as `python3 -I -c SCAN_PY` by register.tsx.
export const SCAN_PY = `# Lists Claude Code sessions touched in the last 30 days, archived ones too, newest
# first, as JSON, desktop sessions only, with the desktop app's lineage (parentLocalId),
# its turn summary (status, needs_action, recap), PRs, branch and sidebar group.
# Prints { "sessions": [...], "groups": [...] }. Reads only the head and tail of
# each transcript, caches by mtime between runs, and never writes an app file.
import datetime, glob, json, os, re, sys, tempfile, time

ROOT = os.path.expanduser('~/.claude/projects')
DESKTOP = os.path.expanduser('~/Library/Application Support/Claude/claude-code-sessions')
# Read-only: the sidebar groups and which session sits in which group.
CONFIG = os.path.expanduser('~/Library/Application Support/Claude/claude_desktop_config.json')
CACHE = os.path.join(tempfile.gettempdir(), 'trips-scan-cache-v1.json')
STATUSES = ('blocked', 'review_ready', 'completed')
NL = chr(10)
RETURN_GLYPH = chr(0x23CE)
TICK = chr(96)
# A Markdown link [text](url), spelled with re.escape so this source holds no backslash.
LINK = re.compile(re.escape('[') + '([^' + re.escape(']') + ']*)' + re.escape('](') + '[^)]*' + re.escape(')'))
DAY = 24 * 3600
WINDOW = 30 * DAY
TAIL = 512 * 1024
HEAD = 64 * 1024

def lines(blob):
    for raw in blob.splitlines():
        if raw.startswith(b'{'):
            try:
                yield json.loads(raw)
            except ValueError:
                pass

def first_text(rec):
    msg = rec.get('message') or {}
    c = msg.get('content')
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        for part in c:
            if isinstance(part, dict) and part.get('type') == 'text':
                return part.get('text', '')
    return ''

def stamp(rec):
    # A message's own ISO time, in epoch seconds, or 0 when it has none.
    raw = rec.get('timestamp') or ''
    try:
        return datetime.datetime.fromisoformat(raw.replace('Z', '+00:00')).timestamp()
    except ValueError:
        return 0

def is_message(rec):
    # Only a user or agent message counts as activity: no meta rows, no
    # bookkeeping lines (cost-state, titles) that other tools append later.
    return rec.get('type') in ('user', 'assistant') and not rec.get('isMeta') and not rec.get('isSidechain')

def read(path, size):
    with open(path, 'rb') as f:
        head = f.read(HEAD)
        if size > TAIL:
            f.seek(size - TAIL)
        else:
            f.seek(0)
        tail = f.read()
    cwd, first = '', ''
    for rec in lines(head):
        cwd = cwd or rec.get('cwd', '')
        if not first and rec.get('type') == 'user' and not rec.get('isMeta'):
            t = first_text(rec).strip()
            if t and not t.startswith('<'):
                first = t
    title, ai, last, last_msg = '', '', '', 0
    for rec in lines(tail):
        kind = rec.get('type')
        if is_message(rec):
            last_msg = max(last_msg, stamp(rec))
        if kind == 'custom-title':
            title = rec.get('customTitle', title)
        elif kind == 'ai-title':
            ai = rec.get('aiTitle', ai)
        elif kind == 'last-prompt':
            last = rec.get('lastPrompt', last)
        cwd = cwd or rec.get('cwd', '')
    return {
        'title': title or ai or first[:80],
        'lastMessage': last_msg,
        'project': os.path.basename(cwd.rstrip('/')) if cwd else '',
        'lastPrompt': ' '.join(last.split())[:160],
    }

def plain(text):
    # Markdown and the return glyph out, whitespace folded.
    s = (text or '').replace(RETURN_GLYPH, NL)
    s = LINK.sub(lambda m: m.group(1), s)
    s = re.sub('[*_#>' + TICK + ']+', '', s)
    return ' '.join(s.split())

def first_sentence(text):
    # The report's first sentence: up to the first stop, the glyph or a line end.
    s = (text or '').replace(RETURN_GLYPH, NL).strip()
    s = s.split(NL)[0] if s else ''
    s = plain(s)
    for n, ch in enumerate(s):
        if ch in '.!?' and (n + 1 == len(s) or s[n + 1] == ' '):
            return s[:n + 1]
    return s

def summary_fields(d):
    # The app's own turn summary, recap and PRs from one desktop record.
    pts = d.get('postTurnSummary')
    pts = pts if isinstance(pts, dict) else {}
    status = pts.get('status_category')
    twu = d.get('turnWrapUp')
    recap = twu.get('description') if isinstance(twu, dict) else ''
    wrap_up = recap or ''
    report = d.get('lastTurnReport') if isinstance(d.get('lastTurnReport'), str) else ''
    if not recap and isinstance(d.get('lastTurnReport'), str):
        recap = first_sentence(d['lastTurnReport'])
    prs = []
    for pr in d.get('prs') or []:
        if isinstance(pr, dict) and isinstance(pr.get('prNumber'), int):
            prs.append({'prNumber': pr['prNumber'], 'url': str(pr.get('url') or ''), 'state': str(pr.get('state') or '').lower()})
    branch = d.get('branch')
    tree = d.get('worktreePath')
    return {
        'worktreePath': tree if isinstance(tree, str) else '',
        'status': status if status in STATUSES else '',
        'nextAction': ' '.join(str(pts.get('needs_action') or '').split())[:240],
        'summaryId': str(pts.get('summarizes_uuid') or ''),
        'recap': plain(recap or '')[:240],
        # The daily summary reads these: the whole wrap-up and the turn report.
        'wrapUp': plain(wrap_up)[:400],
        'report': plain(report)[:400],
        'detail': plain(str(pts.get('status_detail') or ''))[:400],
        'branch': branch if isinstance(branch, str) else '',
        'prs': prs,
    }

def sidebar(cache, keep):
    # The desktop sidebar's groups per <account>/<org> scope, from the app's
    # config file, read only. Cached by mtime: the file holds other prefs too.
    try:
        st = os.stat(CONFIG)
    except OSError:
        return {}
    hit = cache.get(CONFIG)
    if hit and hit['mtime'] == st.st_mtime:
        keep[CONFIG] = hit
        return hit['info']
    try:
        with open(CONFIG) as f:
            prefs = (json.load(f).get('preferences') or {}).get('epitaxyPrefs') or {}
    except (OSError, ValueError, AttributeError):
        return {}
    scopes = {}
    raw = prefs.get('dframe-group-scopes')
    for scope, v in (raw.items() if isinstance(raw, dict) else []):
        if not isinstance(v, dict):
            continue
        groups = [{'id': g['id'], 'name': str(g.get('name') or '')} for g in v.get('groups') or []
                  if isinstance(g, dict) and isinstance(g.get('id'), str)]
        assign = v.get('assignments')
        scopes[scope] = {'groups': groups, 'assignments': assign if isinstance(assign, dict) else {}}
    keep[CONFIG] = {'mtime': st.st_mtime, 'size': st.st_size, 'info': scopes}
    return scopes

def desktop_sessions(cache, keep):
    # The desktop app's own record per Code tab session: its local_ id, title,
    # archive flag and last activity, keyed by the CLI session id.
    found = {}
    for path in glob.glob(os.path.join(DESKTOP, '*', '*', 'local_*.json')):
        try:
            st = os.stat(path)
        except OSError:
            continue
        hit = cache.get(path)
        if hit and hit['mtime'] == st.st_mtime:
            info = hit['info']
        else:
            try:
                with open(path) as f:
                    d = json.load(f)
            except (OSError, ValueError):
                continue
            info = {k: d.get(k) for k in ('sessionId', 'cliSessionId', 'title', 'cwd', 'createdAt', 'lastActivityAt', 'isArchived', 'isStarred', 'forkedFromSessionId')}
            spawned = d.get('spawnedFrom')
            info['spawnedFrom'] = spawned.get('sessionId') if isinstance(spawned, dict) else None
            info.update(summary_fields(d))
        # <account>/<org>: the two folders above the record, the config's scope key.
        info['scope'] = os.path.basename(os.path.dirname(os.path.dirname(path))) + '/' + os.path.basename(os.path.dirname(path))
        keep[path] = {'mtime': st.st_mtime, 'size': st.st_size, 'info': info}
        cli = info.get('cliSessionId') or (info.get('sessionId') or '').replace('local_', '')
        if cli:
            found[cli] = info
    return found

def main():
    now = time.time()
    try:
        with open(CACHE) as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    keep = {}
    scopes = sidebar(cache, keep)
    desk = desktop_sessions(cache, keep)
    out, seen = [], set()
    names = {}
    groups, listed = [], set()
    for scope in scopes.values():
        for g in scope['groups']:
            names[g['id']] = g['name']
            if g['id'] not in listed:
                listed.add(g['id'])
                groups.append(g)

    def add(sid, info, mtime_s, d):
        lt = time.localtime(mtime_s)
        title = (d and d.get('title')) or info.get('title') or sid[:8]
        cwd = (d and d.get('cwd')) or ''
        project = os.path.basename(cwd.rstrip('/')) if cwd else info.get('project', '')
        dd = d or {}
        parent = dd.get('spawnedFrom') or dd.get('forkedFromSessionId') or ''
        created = dd.get('createdAt') or 0
        days = (datetime.date.fromtimestamp(now) - datetime.date.fromtimestamp(mtime_s)).days
        local = dd.get('sessionId') or ''
        scope = scopes.get(dd.get('scope') or '') or {}
        gid = (scope.get('assignments') or {}).get('code:' + local, '') if local else ''
        gid = gid if isinstance(gid, str) and gid in names else ''
        out.append({
            'id': sid, 'localId': (d and d.get('sessionId')) or '',
            'title': title, 'project': project, 'lastPrompt': info.get('lastPrompt', ''),
            'mtimeMs': int(mtime_s * 1000),
            'clock': time.strftime('%H:%M', lt), 'hour': time.strftime('%H:00', lt),
            'isToday': days == 0, 'daysAgo': days, 'weekday': time.strftime('%a', lt),
            'parentLocalId': parent if isinstance(parent, str) else '',
            'createdAtMs': int(created) if isinstance(created, (int, float)) else 0,
            'isArchived': bool(dd.get('isArchived')), 'isStarred': bool(dd.get('isStarred')),
            'status': dd.get('status') or '', 'nextAction': dd.get('nextAction') or '',
            'summaryId': dd.get('summaryId') or '', 'recap': dd.get('recap') or '',
            'wrapUp': dd.get('wrapUp') or '', 'report': dd.get('report') or '', 'detail': dd.get('detail') or '',
            'groupId': gid, 'groupName': names.get(gid, ''),
            'branch': dd.get('branch') or '', 'prs': dd.get('prs') or [],
            'worktreePath': dd.get('worktreePath') or '',
        })
        seen.add(sid)

    for path in glob.glob(os.path.join(ROOT, '*', '*.jsonl')):
        if 'observer-sessions' in path:
            continue
        sid = os.path.basename(path)[:-6]
        d = desk.get(sid)
        # Trips come from desktop sessions only: no record, no row, no read.
        if not d or not d.get('sessionId'):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        # A file older than the window holds no message inside it either.
        if now - st.st_mtime > WINDOW:
            continue
        hit = cache.get(path)
        if hit and hit['mtime'] == st.st_mtime and hit['size'] == st.st_size:
            info = hit['info']
        else:
            try:
                info = read(path, st.st_size)
            except OSError:
                continue
        keep[path] = {'mtime': st.st_mtime, 'size': st.st_size, 'info': info}
        # Activity is the last message, never the file time: other tools append
        # bookkeeping lines to old transcripts. No message in the tail: skip it.
        active = info.get('lastMessage') or 0
        if now - active > WINDOW:
            continue
        add(sid, info, active, d)

    # Desktop sessions whose transcript lives elsewhere (another config dir).
    for sid, d in desk.items():
        active = (d.get('lastActivityAt') or 0) / 1000
        if sid in seen or not d.get('sessionId') or now - active > WINDOW:
            continue
        add(sid, {}, active, d)

    out.sort(key=lambda r: r['mtimeMs'], reverse=True)
    try:
        with open(CACHE, 'w') as f:
            json.dump(keep, f)
    except OSError:
        pass
    json.dump({'sessions': out, 'groups': groups}, sys.stdout)

main()
`
