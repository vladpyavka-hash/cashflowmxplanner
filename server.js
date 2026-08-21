const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null) process.env[k] = v;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const POSTER_TOKEN = process.env.POSTER_TOKEN || '';
const DEFAULT_FX = Number(process.env.MXN_PER_USD || 18.5);

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dateCompact(s) { return String(s || '').replace(/-/g, ''); }
function first(o, keys) { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; }

async function poster(method, params = {}) {
  if (!POSTER_TOKEN) throw new Error('POSTER_TOKEN не задан в .env');
  const u = new URL(`https://joinposter.com/api/${method}`);
  u.searchParams.set('token', POSTER_TOKEN);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers: { Accept: 'application/json' } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Poster HTTP ${r.status}`);
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
  return data.response ?? data;
}

function unwrapRows(v) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object') return [];
  for (const k of ['transactions', 'data', 'rows', 'items']) if (Array.isArray(v[k])) return v[k];
  return [];
}

function txAmountMinor(t) {
  return num(first(t, ['payed_sum', 'payedSum', 'sum', 'transaction_sum', 'total_sum', 'total', 'amount']));
}
function txSpotId(t) {
  return String(first(t, ['spot_id', 'spotId', 'spot']) ?? 'unknown');
}
function txDate(t) {
  const raw = String(first(t, ['date_close', 'close_date', 'dateClose', 'date', 'created_at']) || '');
  const m = raw.match(/(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw.slice(0, 10);
}
function isClosed(t) {
  const status = String(first(t, ['status', 'transaction_status', 'state']) ?? '').toLowerCase();
  if (status && ['deleted', 'cancelled', 'canceled', 'void'].includes(status)) return false;
  const del = first(t, ['delete', 'deleted', 'is_deleted']);
  return !(String(del) === '1' || del === true);
}

async function getDashboard(from, to, fx) {
  const raw = await poster('dash.getTransactions', { dateFrom: dateCompact(from), dateTo: dateCompact(to) });
  const txs = unwrapRows(raw).filter(isClosed);
  let spots = [];
  try { spots = unwrapRows(await poster('spots.getSpots')); } catch (_) {}
  const spotNames = new Map(spots.map(s => [String(first(s, ['spot_id', 'id']) ?? ''), String(first(s, ['spot_name', 'name']) || '')]));

  const stores = new Map();
  const days = new Map();
  let totalMinor = 0;
  for (const t of txs) {
    const amount = txAmountMinor(t);
    const sid = txSpotId(t);
    const day = txDate(t) || 'unknown';
    totalMinor += amount;
    if (!stores.has(sid)) stores.set(sid, { spotId: sid, name: spotNames.get(sid) || `Магазин ${sid}`, revenueMinor: 0, checks: 0 });
    const s = stores.get(sid); s.revenueMinor += amount; s.checks += 1;
    if (!days.has(day)) days.set(day, { date: day, revenueMinor: 0, checks: 0 });
    const d = days.get(day); d.revenueMinor += amount; d.checks += 1;
  }

  const minorToMxn = v => v / 100;
  const mxnToUsd = v => v / fx;
  const normalizedStores = [...stores.values()].map(s => {
    const revenueMxn = minorToMxn(s.revenueMinor);
    const revenueUsd = mxnToUsd(revenueMxn);
    return { ...s, revenueMxn, revenueUsd, avgCheckUsd: s.checks ? revenueUsd / s.checks : 0, share: totalMinor ? s.revenueMinor / totalMinor : 0 };
  }).sort((a, b) => b.revenueUsd - a.revenueUsd);
  const daily = [...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(d => {
    const revenueUsd = mxnToUsd(minorToMxn(d.revenueMinor));
    return { date: d.date, checks: d.checks, revenueUsd, avgCheckUsd: d.checks ? revenueUsd / d.checks : 0 };
  });
  const totalUsd = mxnToUsd(minorToMxn(totalMinor));
  return {
    from, to, fx, currency: 'USD', sourceCurrency: 'MXN',
    totals: { revenueUsd: totalUsd, checks: txs.length, avgCheckUsd: txs.length ? totalUsd / txs.length : 0, stores: normalizedStores.length },
    stores: normalizedStores,
    daily
  };
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, decodeURIComponent(target)));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(file).toLowerCase();
  const types = { '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (u.pathname === '/api/poster/health') return json(res, 200, { configured: Boolean(POSTER_TOKEN), fx: DEFAULT_FX });
    if (u.pathname === '/api/poster/dashboard') {
      const today = new Date().toISOString().slice(0,10);
      const from = u.searchParams.get('from') || `${today.slice(0,8)}01`;
      const to = u.searchParams.get('to') || today;
      const fx = Number(u.searchParams.get('fx') || DEFAULT_FX);
      if (!Number.isFinite(fx) || fx <= 0) return json(res, 400, { error: 'Некорректный MXN_PER_USD' });
      return json(res, 200, await getDashboard(from, to, fx));
    }
    serveStatic(req, res, u.pathname);
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
}).listen(PORT, () => console.log(`Cashflow / Poster dashboard: http://localhost:${PORT}/poster.html`));
