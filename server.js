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
    const key = s.slice(0, i).trim();
    let value = s.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const POSTER_TOKEN = process.env.POSTER_TOKEN || '';
const DEFAULT_FX = Number(process.env.MXN_PER_USD || 18.5);

function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function first(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== '') return obj[key];
  }
  return null;
}

function compactDate(s) {
  return String(s || '').replace(/-/g, '');
}

async function poster(method, params = {}) {
  if (!POSTER_TOKEN) throw new Error('POSTER_TOKEN не задан в .env');
  const url = new URL(`https://joinposter.com/api/${method}`);
  url.searchParams.set('token', POSTER_TOKEN);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Poster HTTP ${response.status}`);
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
  return data.response ?? data;
}

async function posterTry(methods, params = {}) {
  for (const method of methods) {
    try {
      return await poster(method, params);
    } catch (_) {}
  }
  return null;
}

function rows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['transactions', 'clients', 'spots', 'products', 'users', 'employees', 'data', 'rows', 'items', 'response']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function normalizeDate(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (/^\d{10,13}$/.test(raw)) {
    let n = Number(raw);
    if (n < 1e12) n *= 1000;
    const d = new Date(n);
    if (Number.isFinite(d.getTime())) return d.toISOString().slice(0, 10);
  }
  let m = raw.match(/^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = raw.match(/^(\d{2})[./-](\d{2})[./-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

const txDate = t => normalizeDate(first(t, ['date_close','close_date','dateClose','date_start','dateStart','date','created_at','createdAt','time','timestamp']));
const txAmount = t => num(first(t, ['payed_sum','payedSum','sum','transaction_sum','total_sum','total','amount']));
const txSpot = t => String(first(t, ['spot_id','spotId','spot']) ?? 'unknown');
const txClient = t => {
  const v = first(t, ['client_id','clientId','client']);
  return v == null || String(v) === '0' ? '' : String(v);
};
const txUser = t => String(first(t, ['user_id','userId','waiter_id','employee_id','cashier_id']) ?? 'unknown');
const txUserName = t => String(first(t, ['user_name','waiter_name','employee_name','cashier_name']) || '');

function isClosed(t) {
  const status = String(first(t, ['status','transaction_status','state']) ?? '').toLowerCase();
  if (['deleted','cancelled','canceled','void'].includes(status)) return false;
  const deleted = first(t, ['delete','deleted','is_deleted']);
  return !(String(deleted) === '1' || deleted === true);
}

function dateRange(from, to) {
  const out = [];
  let d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function clientRegistrationDate(c) {
  return normalizeDate(first(c, ['date_activ','date_active','date_created','created_at','createdAt','date_register','registration_date','date']));
}

function clientVisits(c) {
  return num(first(c, ['visits','visits_count','visit_count','total_visits','transactions_count','purchases_count','orders_count','count_visits']));
}

async function getDashboard(from, to, fx) {
  const txs = rows(await poster('dash.getTransactions', {
    dateFrom: compactDate(from),
    dateTo: compactDate(to)
  })).filter(isClosed);

  const spots = rows(await posterTry(['spots.getSpots']) || []);
  const clients = rows(await posterTry(['clients.getClients']) || []);
  const spotNames = new Map(spots.map(s => [
    String(first(s, ['spot_id','id']) ?? ''),
    String(first(s, ['spot_name','name']) || '')
  ]));
  const clientMap = new Map(clients.map(c => [String(first(c, ['client_id','id']) ?? ''), c]));

  const stores = new Map();
  const days = new Map();
  const network = { registered: new Set(), newClients: new Set(), returning: new Set() };
  let totalMinor = 0;
  let invalidDates = 0;

  for (const t of txs) {
    const amount = txAmount(t);
    const sid = txSpot(t);
    const day = txDate(t);
    const cid = txClient(t);
    totalMinor += amount;

    if (!stores.has(sid)) {
      stores.set(sid, {
        spotId: sid,
        name: spotNames.get(sid) || `Магазин ${sid}`,
        revenueMinor: 0,
        checks: 0,
        registered: new Set(),
        newClients: new Set(),
        returning: new Set(),
        byDay: {}
      });
    }

    const store = stores.get(sid);
    store.revenueMinor += amount;
    store.checks += 1;

    if (!day) {
      invalidDates += 1;
      continue;
    }

    if (!store.byDay[day]) {
      store.byDay[day] = {
        revenueMinor: 0,
        checks: 0,
        registered: new Set(),
        newClients: new Set(),
        returning: new Set()
      };
    }
    if (!days.has(day)) {
      days.set(day, {
        date: day,
        revenueMinor: 0,
        checks: 0,
        registered: new Set(),
        newClients: new Set(),
        returning: new Set()
      });
    }

    const storeDay = store.byDay[day];
    const networkDay = days.get(day);
    storeDay.revenueMinor += amount;
    storeDay.checks += 1;
    networkDay.revenueMinor += amount;
    networkDay.checks += 1;

    if (cid) {
      const client = clientMap.get(cid);
      const regDate = client ? clientRegistrationDate(client) : null;
      const visits = client ? clientVisits(client) : 0;
      const isNew = regDate === day;
      const isReturning = visits > 1 && !isNew;

      for (const set of [store.registered, storeDay.registered, networkDay.registered, network.registered]) set.add(cid);
      if (isNew) for (const set of [store.newClients, storeDay.newClients, networkDay.newClients, network.newClients]) set.add(cid);
      if (isReturning) for (const set of [store.returning, storeDay.returning, networkDay.returning, network.returning]) set.add(cid);
    }
  }

  const dates = dateRange(from, to);
  const toUsd = minor => minor / 100 / fx;

  const normalizedStores = [...stores.values()].map(store => {
    const byDay = {};
    for (const day of dates) {
      const q = store.byDay[day] || {
        revenueMinor: 0,
        checks: 0,
        registered: new Set(),
        newClients: new Set(),
        returning: new Set()
      };
      const revenueUsd = toUsd(q.revenueMinor);
      byDay[day] = {
        revenueUsd,
        checks: q.checks,
        avgCheckUsd: q.checks ? revenueUsd / q.checks : 0,
        registeredClients: q.registered.size,
        newClients: q.newClients.size,
        returningClients: q.returning.size
      };
    }
    const revenueUsd = toUsd(store.revenueMinor);
    return {
      spotId: store.spotId,
      name: store.name,
      revenueUsd,
      checks: store.checks,
      avgCheckUsd: store.checks ? revenueUsd / store.checks : 0,
      share: totalMinor ? store.revenueMinor / totalMinor : 0,
      registeredClients: store.registered.size,
      newClients: store.newClients.size,
      returningClients: store.returning.size,
      byDay
    };
  }).sort((a, b) => b.revenueUsd - a.revenueUsd);

  const daily = dates.map(day => {
    const d = days.get(day) || {
      revenueMinor: 0,
      checks: 0,
      registered: new Set(),
      newClients: new Set(),
      returning: new Set()
    };
    const revenueUsd = toUsd(d.revenueMinor);
    return {
      date: day,
      revenueUsd,
      checks: d.checks,
      avgCheckUsd: d.checks ? revenueUsd / d.checks : 0,
      registeredClients: d.registered.size,
      newClients: d.newClients.size,
      returningClients: d.returning.size
    };
  });

  const totalUsd = toUsd(totalMinor);
  return {
    from,
    to,
    fx,
    dates,
    totals: {
      revenueUsd: totalUsd,
      checks: txs.length,
      avgCheckUsd: txs.length ? totalUsd / txs.length : 0,
      stores: normalizedStores.length,
      registeredClients: network.registered.size,
      newClients: network.newClients.size,
      returningClients: network.returning.size
    },
    stores: normalizedStores,
    daily,
    diagnostics: {
      transactions: txs.length,
      invalidDates,
      clientsLoaded: clients.length,
      returningMethod: 'CRM visit count > 1'
    }
  };
}

async function getProducts(from, to, fx) {
  const raw = await poster('dash.getProductsSales', {
    dateFrom: compactDate(from),
    dateTo: compactDate(to)
  });
  const productRows = rows(raw);
  const map = new Map();

  for (const p of productRows) {
    const id = String(first(p, ['product_id','productId','id']) ?? 'unknown');
    const name = String(first(p, ['product_name','name']) || `Product ${id}`);
    const qty = num(first(p, ['count','quantity','qty','product_count']));
    const minor = num(first(p, ['sum','revenue','total','payed_sum','sales_sum']));
    if (!map.has(id)) map.set(id, { id, name, qty: 0, revenueMinor: 0 });
    const item = map.get(id);
    item.qty += qty;
    item.revenueMinor += minor;
  }

  const products = [...map.values()].map(item => {
    const revenueUsd = item.revenueMinor / 100 / fx;
    return {
      ...item,
      revenueUsd,
      avgPriceUsd: item.qty ? revenueUsd / item.qty : 0
    };
  }).sort((a, b) => b.revenueUsd - a.revenueUsd);

  const totalRevenueUsd = products.reduce((sum, p) => sum + p.revenueUsd, 0);
  return {
    products: products.map(p => ({
      ...p,
      share: totalRevenueUsd ? p.revenueUsd / totalRevenueUsd : 0
    })),
    totalRevenueUsd,
    diagnostics: { rows: productRows.length }
  };
}

async function getSalespeople(from, to, fx) {
  const txs = rows(await poster('dash.getTransactions', {
    dateFrom: compactDate(from),
    dateTo: compactDate(to)
  })).filter(isClosed);

  const users = rows(await posterTry(['access.getEmployees','users.getUsers','settings.getEmployees']) || []);
  const names = new Map(users.map(u => [
    String(first(u, ['user_id','employee_id','id']) ?? ''),
    String(first(u, ['name','user_name','employee_name','first_name']) || '')
  ]));

  const map = new Map();
  for (const t of txs) {
    const id = txUser(t);
    const name = txUserName(t) || names.get(id) || `Сотрудник ${id}`;
    const amount = txAmount(t);
    const clientId = txClient(t);
    if (!map.has(id)) map.set(id, { id, name, revenueMinor: 0, checks: 0, registeredChecks: 0 });
    const person = map.get(id);
    person.revenueMinor += amount;
    person.checks += 1;
    if (clientId) person.registeredChecks += 1;
  }

  return {
    salespeople: [...map.values()].map(person => {
      const revenueUsd = person.revenueMinor / 100 / fx;
      return {
        ...person,
        revenueUsd,
        avgCheckUsd: person.checks ? revenueUsd / person.checks : 0,
        registrationRate: person.checks ? person.registeredChecks / person.checks : 0
      };
    }).sort((a, b) => b.revenueUsd - a.revenueUsd)
  };
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, decodeURIComponent(target)));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/poster/health') {
      return json(res, 200, { configured: Boolean(POSTER_TOKEN), fx: DEFAULT_FX });
    }

    const today = new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get('from') || today.slice(0, 8) + '01';
    const to = url.searchParams.get('to') || today;
    const fx = Number(url.searchParams.get('fx') || DEFAULT_FX);
    if (!Number.isFinite(fx) || fx <= 0) return json(res, 400, { error: 'Некорректный MXN_PER_USD' });

    if (url.pathname === '/api/poster/dashboard') return json(res, 200, await getDashboard(from, to, fx));
    if (url.pathname === '/api/poster/products') return json(res, 200, await getProducts(from, to, fx));
    if (url.pathname === '/api/poster/salespeople') return json(res, 200, await getSalespeople(from, to, fx));
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}).listen(PORT, () => {
  console.log(`Cashflow / Poster dashboard: http://localhost:${PORT}/poster.html`);
});
