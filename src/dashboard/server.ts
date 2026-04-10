import express from 'express';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const app = express();
const PORT = 3001;

const LOGS_FILE = path.resolve('data/combined.log');
const TRADES_FILE = path.resolve('data/trades.jsonl');

// ── SSE: stream new log lines in real time ────────────────────────────────────
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send last 50 lines on connect
  if (fs.existsSync(LOGS_FILE)) {
    const lines = fs.readFileSync(LOGS_FILE, 'utf-8').trim().split('\n').slice(-50);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch { /* skip malformed */ }
    }
  }

  // Watch for new lines
  let fileSize = fs.existsSync(LOGS_FILE) ? fs.statSync(LOGS_FILE).size : 0;
  const watcher = fs.watchFile(LOGS_FILE, { interval: 500 }, (curr) => {
    if (curr.size <= fileSize) return;
    const stream = fs.createReadStream(LOGS_FILE, { start: fileSize, encoding: 'utf-8' });
    fileSize = curr.size;
    let buffer = '';
    stream.on('data', (chunk) => { buffer += chunk; });
    stream.on('end', () => {
      for (const line of buffer.split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          res.write(`data: ${JSON.stringify(entry)}\n\n`);
        } catch { /* skip */ }
      }
    });
  });

  req.on('close', () => fs.unwatchFile(LOGS_FILE, watcher as unknown as () => void));
});

// ── Trades ────────────────────────────────────────────────────────────────────
app.get('/api/trades', (_req, res) => {
  if (!fs.existsSync(TRADES_FILE)) return res.json([]);
  const lines = fs.readFileSync(TRADES_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  const trades = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  res.json(trades.reverse()); // newest first
});

// ── Metrics ───────────────────────────────────────────────────────────────────
app.get('/api/metrics', (_req, res) => {
  if (!fs.existsSync(TRADES_FILE)) return res.json({ total: 0, open: 0, closed: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 });

  const lines = fs.readFileSync(TRADES_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  const trades = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const closed = trades.filter((t: any) => t.pnl !== undefined);
  const wins = closed.filter((t: any) => t.pnl > 0);

  res.json({
    total: trades.length,
    open: trades.length - closed.length,
    closed: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    winRate: closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : '0.0',
    totalPnl: closed.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0).toFixed(2),
  });
});

// ── Dashboard HTML ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wall Street Wolf — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0e1a; --surface: #111827; --border: #1f2937;
      --green: #10b981; --red: #ef4444; --yellow: #f59e0b;
      --blue: #3b82f6; --text: #f3f4f6; --muted: #6b7280;
    }
    body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
    header { padding: 20px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
    .badge { padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; background: #064e3b; color: var(--green); }
    .badge.offline { background: #450a0a; color: var(--red); }
    main { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto 1fr; gap: 16px; padding: 20px 24px; height: calc(100vh - 65px); }
    .metrics { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .card .value { font-size: 26px; font-weight: 700; }
    .card .value.green { color: var(--green); }
    .card .value.red { color: var(--red); }
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
    .panel-header { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); display: flex; justify-content: space-between; align-items: center; }
    /* Logs */
    #log-container { flex: 1; overflow-y: auto; padding: 12px; font-family: 'Menlo', 'Monaco', monospace; font-size: 12px; line-height: 1.6; }
    .log-line { padding: 2px 0; border-bottom: 1px solid #1a2030; }
    .log-line .ts { color: var(--muted); margin-right: 8px; }
    .log-line.info .lvl { color: var(--blue); }
    .log-line.warn .lvl { color: var(--yellow); }
    .log-line.error .lvl { color: var(--red); }
    .log-line .msg { color: var(--text); }
    /* Trades */
    #trades-container { flex: 1; overflow-y: auto; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 10px 14px; text-align: left; font-size: 11px; color: var(--muted); text-transform: uppercase; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); }
    td { padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 12px; }
    .yes { color: var(--green); font-weight: 600; }
    .no { color: var(--red); font-weight: 600; }
    .open { color: var(--yellow); font-weight: 600; }
    .empty { padding: 40px; text-align: center; color: var(--muted); }
  </style>
</head>
<body>
  <header>
    <h1>🐺 Wall Street Wolf</h1>
    <span class="badge" id="status-badge">CONECTANDO...</span>
    <span style="margin-left:auto; color: var(--muted); font-size:12px;" id="last-update">—</span>
  </header>
  <main>
    <div class="metrics">
      <div class="card"><div class="label">Total Trades</div><div class="value" id="m-total">—</div></div>
      <div class="card"><div class="label">Abiertos</div><div class="value" id="m-open">—</div></div>
      <div class="card"><div class="label">Cerrados</div><div class="value" id="m-closed">—</div></div>
      <div class="card"><div class="label">Win Rate</div><div class="value" id="m-winrate">—</div></div>
      <div class="card"><div class="label">Wins / Losses</div><div class="value" id="m-wl">—</div></div>
      <div class="card"><div class="label">P&L Total</div><div class="value" id="m-pnl">—</div></div>
    </div>
    <div class="panel">
      <div class="panel-header"><span>Logs en tiempo real</span><span id="log-count">0 líneas</span></div>
      <div id="log-container"></div>
    </div>
    <div class="panel">
      <div class="panel-header"><span>Trades</span><button onclick="loadTrades()" style="background:none;border:none;color:var(--blue);cursor:pointer;font-size:11px;">↺ Actualizar</button></div>
      <div id="trades-container"><p class="empty">Cargando...</p></div>
    </div>
  </main>

  <script>
    let logCount = 0;

    // ── Metrics ──────────────────────────────────────────────────────────────
    async function loadMetrics() {
      try {
        const r = await fetch('/api/metrics');
        const m = await r.json();
        document.getElementById('m-total').textContent = m.total;
        document.getElementById('m-open').textContent = m.open;
        document.getElementById('m-closed').textContent = m.closed;
        document.getElementById('m-winrate').textContent = m.winRate + '%';
        document.getElementById('m-wl').textContent = m.wins + ' / ' + m.losses;
        const pnlEl = document.getElementById('m-pnl');
        const pnl = parseFloat(m.totalPnl);
        pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + m.totalPnl;
        pnlEl.className = 'value ' + (pnl >= 0 ? 'green' : 'red');
        document.getElementById('last-update').textContent = 'Actualizado: ' + new Date().toLocaleTimeString();
      } catch(e) {}
    }

    // ── Trades ───────────────────────────────────────────────────────────────
    async function loadTrades() {
      try {
        const r = await fetch('/api/trades');
        const trades = await r.json();
        const container = document.getElementById('trades-container');
        if (!trades.length) { container.innerHTML = '<p class="empty">No hay trades aún — el bot está escaneando mercados.</p>'; return; }
        container.innerHTML = '<table><thead><tr><th>Mercado</th><th>Dir</th><th>Precio</th><th>Tamaño</th><th>Plataforma</th><th>P&L</th><th>Estado</th></tr></thead><tbody>' +
          trades.map(t => \`<tr>
            <td title="\${t.question ?? ''}">\${(t.marketId ?? '').substring(0,20)}...</td>
            <td class="\${t.direction}">\${(t.direction ?? '').toUpperCase()}</td>
            <td>\${t.entryPrice ? (t.entryPrice * 100).toFixed(1) + '¢' : '—'}</td>
            <td>\${t.size ? '$' + t.size.toFixed(2) : '—'}</td>
            <td>\${t.platform ?? '—'}</td>
            <td class="\${t.pnl === undefined ? '' : t.pnl >= 0 ? 'yes' : 'no'}">\${t.pnl !== undefined ? (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2) : '—'}</td>
            <td class="\${t.closedAt ? (t.pnl >= 0 ? 'yes' : 'no') : 'open'}">\${t.closedAt ? (t.pnl >= 0 ? 'WON' : 'LOST') : 'ABIERTO'}</td>
          </tr>\`).join('') + '</tbody></table>';
      } catch(e) {}
    }

    // ── SSE Logs ─────────────────────────────────────────────────────────────
    const logContainer = document.getElementById('log-container');
    const badge = document.getElementById('status-badge');

    const es = new EventSource('/api/logs/stream');
    es.onopen = () => { badge.textContent = 'EN VIVO'; badge.className = 'badge'; };
    es.onerror = () => { badge.textContent = 'DESCONECTADO'; badge.className = 'badge offline'; };
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data);
        const div = document.createElement('div');
        div.className = 'log-line ' + (entry.level ?? 'info');
        const ts = (entry.timestamp ?? '').replace('T', ' ').substring(0, 19);
        div.innerHTML = '<span class="ts">' + ts + '</span><span class="lvl">[' + (entry.level ?? '').toUpperCase() + ']</span> <span class="msg">' + (entry.message ?? '') + '</span>';
        logContainer.appendChild(div);
        logContainer.scrollTop = logContainer.scrollHeight;
        logCount++;
        document.getElementById('log-count').textContent = logCount + ' líneas';
      } catch(e) {}
    };

    // ── Polling ──────────────────────────────────────────────────────────────
    loadMetrics();
    loadTrades();
    setInterval(() => { loadMetrics(); loadTrades(); }, 10000);
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`\n🐺 Wall Street Wolf Dashboard → http://localhost:${PORT}\n`);
});
