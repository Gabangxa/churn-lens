// Founder-only local monitor. Run as `railway run npm run monitor` so the
// linked Railway service's env vars (CRON_SECRET, RAILWAY_PUBLIC_DOMAIN) are
// injected without ever being pasted into a shell history. Binds to
// 127.0.0.1 only — this holds a secret capable of triggering cron routes
// (see /api/admin/status), so it must never be reachable off-box.
//
// CommonJS + Node 20 APIs only, no new dependencies (matches scripts/migrate.js).
'use strict';

const http = require('node:http');
const { execFile } = require('node:child_process');

const RING_SIZE = 300;
// Must exceed one fetch batch, or keys from the start of a batch are evicted
// before the batch ends and the next poll re-pushes the whole thing as new.
const DEDUPE_SIZE = 2 * 200; // 2 * LOG_FETCH_LINES; kept literal to sit next to RING_SIZE
const STATUS_TIMEOUT_MS = 10_000;
// `railway logs` only streams to a TTY; with stdout piped it prints the recent
// backlog and exits 0 (verified with CLI 5.45). So the tail is a poll: fetch
// the last LOG_FETCH_LINES every LOG_POLL_MS and dedupe against the ring.
const LOG_POLL_MS = 15_000;
const LOG_FETCH_LINES = 200;
const LOG_FETCH_TIMEOUT_MS = 30_000;
const LOG_FETCH_MAX_BUFFER = 16 * 1024 * 1024;
// A single log line can carry a whole HTML error page (the 404 body of a
// failed cron call, for instance). Keep the head, note the cut.
const MAX_MESSAGE_CHARS = 600;

function resolveTarget() {
  const raw =
    process.env.MONITOR_TARGET_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
  return raw ? raw.replace(/\/+$/, '') : null;
}

const target = resolveTarget();
const cronSecret = process.env.CRON_SECRET;

if (!target || !cronSecret) {
  console.error(
    'monitor: missing target or secret — run via `railway run npm run monitor`, or set MONITOR_TARGET_URL and CRON_SECRET',
  );
  process.exit(1);
}

const port = Number(process.env.MONITOR_PORT) || 5199;

// ---------------------------------------------------------------------------
// Log tail: periodic `railway logs --json --lines N`, deduped, kept as a
// bounded ring buffer the page pages through via /api/logs?since=<seq>.
// ---------------------------------------------------------------------------

const logRing = []; // { seq, timestamp, level, message, source }
let nextSeq = 1;

// Every fetch returns overlapping backlog, so the same line would otherwise
// be pushed again each poll. The dedupe set is bounded (DEDUPE_SIZE) — an
// entry old enough to have scrolled well out of the tail is allowed to repeat.
const dedupeKeys = new Set();
const dedupeOrder = [];

function rememberDedupeKey(key) {
  dedupeKeys.add(key);
  dedupeOrder.push(key);
  if (dedupeOrder.length > DEDUPE_SIZE) dedupeKeys.delete(dedupeOrder.shift());
}

function pushLogEntry(entry) {
  logRing.push({ seq: nextSeq++, ...entry });
  if (logRing.length > RING_SIZE) logRing.shift();
}

function truncateMessage(message) {
  if (message.length <= MAX_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_MESSAGE_CHARS)} …[${message.length - MAX_MESSAGE_CHARS} more chars]`;
}

function pushRailwayLine(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { timestamp: new Date().toISOString(), level: 'info', message: raw };
  }
  const timestamp = parsed.timestamp ?? new Date().toISOString();
  const message = parsed.message ?? raw;
  // Dedupe on the full message: two distinct lines may share a truncated head.
  const key = `${timestamp}|${message}`;
  if (dedupeKeys.has(key)) return;
  rememberDedupeKey(key);
  pushLogEntry({ timestamp, level: parsed.level ?? 'info', message: truncateMessage(message), source: 'railway' });
}

function pushMonitorLine(message, level) {
  pushLogEntry({ timestamp: new Date().toISOString(), level, message, source: 'monitor' });
}

const tail = {
  child: null, // the in-flight `railway logs` process, if any
  fetches: 0,
  failures: 0,
  lastFetchAt: null,
  lastOkAt: null,
  lastError: null,
  timer: null,
  shuttingDown: false,
};

function fetchLogsOnce() {
  if (tail.child || tail.shuttingDown) return; // previous fetch still running
  tail.fetches += 1;
  tail.lastFetchAt = new Date().toISOString();

  tail.child = execFile(
    'railway',
    ['logs', '--json', '--lines', String(LOG_FETCH_LINES)],
    { env: process.env, timeout: LOG_FETCH_TIMEOUT_MS, maxBuffer: LOG_FETCH_MAX_BUFFER },
    (err, stdout, stderr) => {
      tail.child = null;
      if (err) {
        // ENOENT (CLI missing), non-zero exit (not logged in / not linked),
        // or the timeout. Say so once per state change, not once per poll.
        tail.failures += 1;
        const detail = stderr && stderr.trim() ? stderr.trim().split('\n')[0] : err.message;
        if (tail.lastError !== detail) pushMonitorLine(`monitor: railway logs fetch failed: ${detail}`, 'warn');
        tail.lastError = detail;
        return;
      }
      if (tail.lastError !== null) pushMonitorLine('monitor: railway logs fetch recovered', 'info');
      tail.lastError = null;
      tail.lastOkAt = new Date().toISOString();
      for (const line of stdout.split('\n')) {
        if (line.trim()) pushRailwayLine(line);
      }
    },
  );
}

fetchLogsOnce();
tail.timer = setInterval(fetchLogsOnce, LOG_POLL_MS);
tail.timer.unref();

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleStatus(res) {
  let upstream;
  try {
    upstream = await fetch(`${target}/api/admin/status`, {
      method: 'GET',
      headers: { authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
  } catch (err) {
    sendJson(res, 502, { error: err.message, target });
    return;
  }

  // Body read failures are rare but not impossible (connection dropped
  // mid-stream) — treat like any other upstream failure.
  const text = await upstream.text().catch(() => null);
  if (text === null) {
    sendJson(res, 502, { error: 'failed to read upstream response body', target });
    return;
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  sendJson(res, upstream.status, body);
}

function handleLogs(res, url) {
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : 0;
  sendJson(res, 200, {
    lines: logRing.filter((entry) => entry.seq > since),
    latestSeq: logRing.length > 0 ? logRing[logRing.length - 1].seq : since,
    tail: {
      ok: tail.lastError === null && tail.lastOkAt !== null,
      fetches: tail.fetches,
      failures: tail.failures,
      lastFetchAt: tail.lastFetchAt,
      lastOkAt: tail.lastOkAt,
      lastError: tail.lastError,
      pollMs: LOG_POLL_MS,
    },
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  // Loopback binding stops off-box traffic, not the founder's own browser: a
  // DNS-rebinding page could otherwise read /api/status from a foreign origin.
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    sendJson(res, 403, { error: 'bad host' });
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/') {
    const html = renderPage();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  if (url.pathname === '/api/status') {
    // handleStatus already handles its own network/parse errors; this catch
    // is a last-resort net so a bug there can't hang the request.
    handleStatus(res).catch((err) => sendJson(res, 502, { error: `monitor: unexpected error: ${err.message}`, target }));
    return;
  }

  if (url.pathname === '/api/logs') {
    handleLogs(res, url);
    return;
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`monitor: http://127.0.0.1:${port} -> ${target}`);
});

server.on('error', (err) => {
  console.error(`monitor: server error: ${err.message}`);
  process.exit(1);
});

function shutdown() {
  tail.shuttingDown = true;
  if (tail.timer) clearInterval(tail.timer);
  if (tail.child) tail.child.kill('SIGTERM');
  server.close(() => process.exit(0));
  // Don't hang forever on shutdown if a keep-alive connection stalls close().
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Page: a single inline HTML/CSS/JS document, no external assets or CDNs.
// All dynamic values are inserted via textContent, never innerHTML.
// ---------------------------------------------------------------------------

function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChurnLens Monitor</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f5f6f8; color: #1a1a1a; }
  header { padding: 16px 20px; background: #fff; border-bottom: 1px solid #ddd; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header .meta { font-size: 13px; color: #555; }
  #errorBanner { display: none; background: #b3261e; color: #fff; padding: 10px 20px; font-size: 14px; }
  main { display: grid; grid-template-columns: 1fr; gap: 16px; padding: 16px 20px; }
  @media (min-width: 900px) {
    main { grid-template-columns: 1fr 1fr; }
    #logsPanel { grid-column: 1 / -1; }
  }
  .panel { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 14px 16px; }
  .panel h2 { margin: 0 0 10px; font-size: 15px; }
  .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 13px; border-bottom: 1px solid #f0f0f0; }
  .row:last-child { border-bottom: none; }
  .ok { color: #1a7a1a; } .warn { color: #a06a00; } .bad { color: #b3261e; font-weight: 600; } .muted { color: #888; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 8px; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #f0f0f0; white-space: nowrap; }
  tr.status-succeeded td.status { color: #1a7a1a; }
  tr.status-running td.status { color: #a06a00; }
  tr.status-failed td.status { color: #b3261e; }
  tr.action-exhausted td.action { color: #b3261e; font-weight: 600; }
  tr.due-false { color: #999; }
  #logsPanel .controls { display: flex; gap: 16px; align-items: center; margin-bottom: 8px; font-size: 13px; }
  #logsPanel .tailStatus { font-size: 12.5px; color: #555; margin-bottom: 8px; }
  #logView { height: 360px; overflow-y: auto; background: #14161a; color: #d8dde3; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; padding: 8px 10px; border-radius: 4px; }
  #logView .line { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
  #logView .line.level-error { color: #ff8a80; }
  #logView .line.source-monitor { color: #8a94a3; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>ChurnLens Monitor</h1>
  <div class="meta">target: <span id="targetUrl"></span> &middot; last status: <span id="generatedAt">never</span></div>
</header>
<div id="errorBanner"></div>
<main>
  <section class="panel" id="systemPanel">
    <h2>System</h2>
    <div id="systemBody"><div class="row muted">waiting for first status fetch&hellip;</div></div>
  </section>
  <section class="panel" id="schedulerPanel">
    <h2>Scheduler &amp; pipeline</h2>
    <div id="schedulerBody"><div class="row muted">waiting for first status fetch&hellip;</div></div>
  </section>
  <section class="panel" id="activityPanel">
    <h2>Activity</h2>
    <div id="activityBody"><div class="row muted">waiting for first status fetch&hellip;</div></div>
  </section>
  <section class="panel" id="logsPanel">
    <h2>Logs</h2>
    <div class="tailStatus" id="tailStatus"></div>
    <div class="controls">
      <label><input type="checkbox" id="cronOnly"> cron only</label>
      <label><input type="checkbox" id="errorsOnly"> errors only</label>
    </div>
    <div id="logView"></div>
  </section>
</main>
<script>
(function () {
  var TARGET = ${JSON.stringify(target).replace(/</g, '\\u003c')};
  var RING_SIZE = ${RING_SIZE};
  document.getElementById('targetUrl').textContent = TARGET;
  var latestSeq = 0; // watermark for /api/logs?since=

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function row(container, label, value, cls) {
    var r = el('div', 'row');
    var l = el('span'); l.textContent = label;
    var v = el('span', cls || ''); v.textContent = value;
    r.appendChild(l); r.appendChild(v);
    container.appendChild(r);
  }

  function humanizeUptime(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds)) return 'unavailable';
    var s = Math.floor(seconds);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var parts = [];
    if (d) parts.push(d + 'd');
    if (h) parts.push(h + 'h');
    if (m) parts.push(m + 'm');
    if (!d && !h) parts.push(s + 's');
    return parts.join(' ');
  }

  function minutesAgo(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 60000 : null; }
  function agoLabel(iso) {
    if (!iso) return 'never';
    var mins = minutesAgo(iso);
    return mins < 1 ? 'just now' : Math.round(mins) + ' min ago';
  }

  function renderSystem(status) {
    var body = document.getElementById('systemBody');
    clear(body);
    var app = status.app || {};
    row(body, 'Uptime', humanizeUptime(app.uptimeSec));
    row(body, 'Node version', app.nodeVersion || 'unavailable');
    row(body, 'RSS (MB)', app.rssMb != null ? String(app.rssMb) : 'unavailable');
    row(body, 'Commit', app.commit ? app.commit.slice(0, 7) : 'unavailable');
    row(body, 'Environment', app.environment || 'unavailable');
    var db = status.db || {};
    row(body, 'DB', db.ok ? 'ok (' + db.latencyMs + ' ms)' : 'DOWN' + (db.error ? ': ' + db.error : ''), db.ok ? 'ok' : 'bad');
    var legalOk = status.legal && status.legal.footerReady;
    row(body, 'Legal footer', legalOk ? 'ready' : 'NOT ready', legalOk ? 'ok' : 'warn');
    (status.errors || []).forEach(function (msg) { row(body, 'error', msg, 'bad'); });
  }

  function renderScheduler(status) {
    var body = document.getElementById('schedulerBody');
    clear(body);
    var sched = status.scheduler || {};
    row(body, 'Enabled', sched.enabled ? 'yes' : 'NO', sched.enabled ? 'ok' : 'bad');
    row(body, 'Started at', sched.startedAt || 'unavailable');
    var mins = minutesAgo(sched.lastPollAt);
    row(body, 'Last poll', agoLabel(sched.lastPollAt), mins != null && mins > 20 ? 'warn' : '');
    if (sched.lastPollError) row(body, 'Last poll error', sched.lastPollError, 'bad');

    var pipeline = status.pipeline;
    if (!pipeline) {
      var u = el('div', 'row muted'); u.textContent = 'pipeline unavailable'; body.appendChild(u);
      return;
    }
    row(body, 'Week of', pipeline.weekOf + ' (today ' + pipeline.today + ')');

    var table = el('table');
    var headRow = el('tr');
    ['job', 'keyed by', 'due at', 'due', 'status', 'attempts', 'action', 'processed', 'failed', 'ran at', 'error'].forEach(function (h) {
      var th = el('th'); th.textContent = h; headRow.appendChild(th);
    });
    var thead = el('thead'); thead.appendChild(headRow); table.appendChild(thead);

    var tbody = el('tbody');
    (pipeline.jobs || []).forEach(function (job) {
      var tr = el('tr');
      var classes = [];
      if (job.status) classes.push('status-' + job.status);
      if (job.action === 'exhausted') classes.push('action-exhausted');
      if (job.due === false) classes.push('due-false');
      tr.className = classes.join(' ');
      function cell(text, cls) {
        var td = el('td', cls || ''); td.textContent = text == null ? '' : String(text); tr.appendChild(td);
      }
      cell(job.job); cell(job.keyedBy); cell(job.dueAt); cell(job.due);
      cell(job.status, 'status');
      cell((job.attempts != null ? job.attempts : '?') + '/' + pipeline.maxAttempts);
      cell(job.action, 'action'); cell(job.processed); cell(job.failed); cell(job.ranAt); cell(job.error);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  }

  function renderActivity(status) {
    var body = document.getElementById('activityBody');
    clear(body);
    var a = status.activity;
    if (!a) {
      var u = el('div', 'row muted'); u.textContent = 'unavailable'; body.appendChild(u);
      return;
    }
    function section(label, pairs) {
      var h = el('div', 'row'); var strong = el('strong'); strong.textContent = label; h.appendChild(strong);
      body.appendChild(h);
      pairs.forEach(function (p) { row(body, p[0], p[1] == null ? 'unavailable' : String(p[1])); });
    }
    section('Orgs', [
      ['total', a.orgs && a.orgs.total], ['connected', a.orgs && a.orgs.connected],
      ['paid', a.orgs && a.orgs.paid], ['pending deletion', a.orgs && a.orgs.pendingDeletion],
    ]);
    section('Logins', [['last 24h', a.logins && a.logins.last24h], ['last 7d', a.logins && a.logins.last7d]]);
    section('Login links', [
      ['requested 24h', a.loginLinks && a.loginLinks.requested24h], ['used 24h', a.loginLinks && a.loginLinks.used24h],
    ]);
    section('Surveys', [
      ['responded today', a.surveys && a.surveys.respondedToday], ['responded 7d', a.surveys && a.surveys.responded7d],
      ['awaiting email', a.surveys && a.surveys.awaitingEmail],
    ]);
    section('Digest', [['sends this week', a.digestSendsThisWeek]]);
    section('Unsubscribes', [['total', a.unsubscribesTotal]]);
  }

  function pollStatus() {
    fetch('/api/status')
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; }); })
      .then(function (result) {
        var banner = document.getElementById('errorBanner');
        if (!result.ok) {
          banner.style.display = 'block';
          banner.textContent = 'Status fetch failed (' + result.status + '): ' + (result.body && result.body.error ? result.body.error : 'unknown error');
          return;
        }
        banner.style.display = 'none';
        document.getElementById('generatedAt').textContent = result.body.generatedAt || 'unknown';
        renderSystem(result.body);
        renderScheduler(result.body);
        renderActivity(result.body);
      })
      .catch(function (err) {
        var banner = document.getElementById('errorBanner');
        banner.style.display = 'block';
        banner.textContent = 'Status fetch failed: ' + err.message;
      });
  }

  function matchesFilter(line) {
    var cronOnly = document.getElementById('cronOnly').checked;
    var errorsOnly = document.getElementById('errorsOnly').checked;
    if (cronOnly && line.message.indexOf('[cron]') === -1) return false;
    if (errorsOnly && line.level !== 'error') return false;
    return true;
  }

  function appendLine(line) {
    var view = document.getElementById('logView');
    var atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 4;
    var div = el('div', 'line level-' + line.level + ' source-' + line.source);
    div.textContent = line.timestamp + ' [' + line.level + '] ' + line.message;
    div.dataset.level = line.level;
    div.dataset.message = line.message;
    div.style.display = matchesFilter(line) ? '' : 'none';
    view.appendChild(div);
    while (view.children.length > RING_SIZE) view.removeChild(view.firstChild);
    if (atBottom) view.scrollTop = view.scrollHeight;
  }

  function reapplyFilter() {
    var view = document.getElementById('logView');
    Array.prototype.forEach.call(view.children, function (node) {
      node.style.display = matchesFilter({ level: node.dataset.level, message: node.dataset.message }) ? '' : 'none';
    });
  }
  document.getElementById('cronOnly').addEventListener('change', reapplyFilter);
  document.getElementById('errorsOnly').addEventListener('change', reapplyFilter);

  function pollLogs() {
    fetch('/api/logs?since=' + latestSeq)
      .then(function (res) { return res.json(); })
      .then(function (body) {
        (body.lines || []).forEach(appendLine);
        latestSeq = body.latestSeq;
        var t = body.tail || {};
        var text = 'railway logs: ' + (t.ok ? 'ok' : 'FAILING') + ' · polled every ' + Math.round((t.pollMs || 0) / 1000) + 's';
        if (t.lastOkAt) text += ' · last fetch ' + t.lastOkAt;
        text += ' · fetches ' + t.fetches + ', failures ' + t.failures;
        if (t.lastError) text += ' · ' + t.lastError;
        var tailNode = document.getElementById('tailStatus');
        tailNode.textContent = text;
        tailNode.className = t.ok ? 'tailStatus' : 'tailStatus bad';
      })
      .catch(function () {
        // Transient log-poll failures are non-fatal (next poll retries); the
        // status banner already surfaces the more important upstream health.
      });
  }

  pollStatus();
  pollLogs();
  setInterval(pollStatus, 15000);
  setInterval(pollLogs, 5000);
})();
</script>
</body>
</html>`;
}
