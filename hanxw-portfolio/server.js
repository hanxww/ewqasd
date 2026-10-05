'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const PORT = Number(process.env.PORT || 3000);
const TELEGRAM_USERNAME = String(process.env.TELEGRAM_USERNAME || 'hanxw').replace(/^@/, '').trim();
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const ANALYTICS_KEY = String(process.env.ANALYTICS_KEY || '').trim();
const ANALYTICS_SALT = String(process.env.ANALYTICS_SALT || 'hanxw-portfolio').trim();
const MAX_BODY = 24 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

function blankAnalytics() {
  return {
    createdAt: new Date().toISOString(),
    pageViews: 0,
    visitors: [],
    sessions: [],
    formSubmits: 0,
    telegramOpens: 0,
    clicks: {},
    sections: {},
    pages: {},
    daily: {}
  };
}

function loadAnalytics() {
  try { return { ...blankAnalytics(), ...JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8')) }; }
  catch { return blankAnalytics(); }
}

let analytics = loadAnalytics();
let writeChain = Promise.resolve();

function persist() {
  const snapshot = JSON.stringify(analytics, null, 2);
  writeChain = writeChain.then(async () => {
    const tmp = ANALYTICS_FILE + '.tmp';
    await fs.promises.writeFile(tmp, snapshot, 'utf8');
    await fs.promises.rename(tmp, ANALYTICS_FILE);
  }).catch(err => console.error('analytics write failed:', err.message));
}

function hashId(v) {
  if (!v) return '';
  return crypto.createHash('sha256').update(ANALYTICS_SALT + ':' + String(v)).digest('hex').slice(0, 32);
}

function safeName(v, fallback = 'unknown') {
  const s = String(v || '').toLowerCase().replace(/[^a-z0-9_\-]/g, '').slice(0, 80);
  return s || fallback;
}

function inc(obj, key, n = 1) { obj[key] = (Number(obj[key]) || 0) + n; }

function today() {
  const key = new Date().toISOString().slice(0, 10);
  if (!analytics.daily[key]) {
    analytics.daily[key] = { pageViews: 0, sessions: 0, visitors: 0, formSubmits: 0, telegramOpens: 0, worksReached: 0 };
  }
  return analytics.daily[key];
}

function identify(visitorId, sessionId) {
  const d = today();
  const vh = hashId(visitorId);
  const sh = hashId(sessionId);
  if (vh && !analytics.visitors.includes(vh)) { analytics.visitors.push(vh); d.visitors += 1; }
  if (sh && !analytics.sessions.includes(sh)) { analytics.sessions.push(sh); d.sessions += 1; }
  if (analytics.visitors.length > 50000) analytics.visitors = analytics.visitors.slice(-50000);
  if (analytics.sessions.length > 100000) analytics.sessions = analytics.sessions.slice(-100000);
}

function recordEvent(event) {
  const type = safeName(event.type);
  const name = safeName(event.name, '');
  const page = safeName(event.page || 'portfolio');
  identify(event.visitorId, event.sessionId);
  const d = today();
  if (type === 'page_view') {
    analytics.pageViews += 1; d.pageViews += 1; inc(analytics.pages, page);
  } else if (type === 'click' && name) {
    inc(analytics.clicks, name);
  } else if (type === 'section_view' && name) {
    inc(analytics.sections, name);
    if (name === 'works') d.worksReached += 1;
  }
  persist();
}

function clean(v, max) {
  return String(v || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(text);
}

function plain(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}

const limits = new Map();
function allowLead(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const arr = (limits.get(ip) || []).filter(ts => now - ts < 10 * 60 * 1000);
  if (arr.length >= 5) return false;
  arr.push(now);
  limits.set(ip, arr);
  return true;
}

async function telegramLead(data) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_NOT_CONFIGURED');
  const lines = [
    '📩 Новая заявка с портфолио hanxw',
    '',
    'Имя: ' + data.name,
    'Контакт: ' + data.contact,
    data.company ? 'Компания / ниша: ' + data.company : '',
    'Задача: ' + (data.task || data.message || '—'),
    '',
    'Источник: ' + (data.source || 'portfolio'),
    'Страница: ' + (data.path || '/'),
    'Время: ' + new Date().toISOString()
  ].filter(Boolean);
  const r = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: lines.join('\n'), disable_web_page_preview: true })
  });
  const result = await r.json().catch(() => ({}));
  if (!r.ok || !result.ok) throw new Error('TELEGRAM_SEND_FAILED');
}

const drafts = {
  generic: 'Здравствуйте, хочу обсудить разработку сайта/бота.',
  landing: 'Здравствуйте, хочу обсудить разработку лендинга.',
  bot: 'Здравствуйте, хочу обсудить разработку Telegram-бота.',
  automation: 'Здравствуйте, хочу обсудить сайт + Telegram-бот + CRM + автоматизацию.',
  detailing: 'Здравствуйте, хочу похожий сайт для автосервиса или детейлинга.',
  beauty: 'Здравствуйте, хочу похожий сайт с онлайн-записью для beauty-бизнеса.'
};

function stats() {
  const visitors = analytics.visitors.length;
  const visits = analytics.sessions.length;
  const worksReached = Number(analytics.sections.works || 0);
  const formSubmits = Number(analytics.formSubmits || 0);
  const telegramOpens = Number(analytics.telegramOpens || 0);
  const pct = (n, d) => d ? Math.round((n / d) * 1000) / 10 : 0;
  const daily = Object.entries(analytics.daily)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([date, value]) => ({ date, ...value }));
  return {
    summary: {
      visitors, visits, pageViews: analytics.pageViews, worksReached, formSubmits, telegramOpens,
      worksReachRate: pct(worksReached, visits),
      formConversion: pct(formSubmits, visits),
      telegramConversion: pct(telegramOpens, visits)
    },
    clicks: analytics.clicks,
    sections: analytics.sections,
    pages: analytics.pages,
    daily,
    updatedAt: new Date().toISOString()
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function staticFile(urlPath, res) {
  let pathname = decodeURIComponent(urlPath.split('?')[0]);
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/stats') pathname = '/stats.html';
  if (pathname.includes('..') || pathname.startsWith('/data/') || pathname.split('/').some(x => x.startsWith('.'))) {
    return plain(res, 404, 'Not found');
  }
  const ext = path.extname(pathname).toLowerCase();
  if (!MIME[ext]) return plain(res, 404, 'Not found');
  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return plain(res, 404, 'Not found');
  const st = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext],
    'Content-Length': st.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN'
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      telegramUsernameConfigured: Boolean(TELEGRAM_USERNAME),
      telegramFormConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      analyticsConfigured: Boolean(ANALYTICS_KEY)
    });
  }

  if (req.method === 'GET' && url.pathname === '/go/telegram') {
    const kind = safeName(url.searchParams.get('kind') || 'generic');
    const source = safeName(url.searchParams.get('source') || 'unknown');
    const draft = drafts[kind] || drafts.generic;
    analytics.telegramOpens += 1;
    today().telegramOpens += 1;
    inc(analytics.clicks, 'telegram_redirect_' + source);
    persist();
    res.writeHead(302, {
      Location: 'https://t.me/' + encodeURIComponent(TELEGRAM_USERNAME) + '?text=' + encodeURIComponent(draft),
      'Cache-Control': 'no-store'
    });
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/api/event') {
    try {
      const body = await readJson(req);
      if (['page_view', 'click', 'section_view'].includes(safeName(body.type))) recordEvent(body);
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 400, { ok: false });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/lead') {
    if (!allowLead(req)) return json(res, 429, { error: 'Слишком много попыток. Попробуйте чуть позже.' });
    try {
      const raw = await readJson(req);
      if (clean(raw.website, 100)) return json(res, 200, { ok: true });
      const data = {
        name: clean(raw.name, 80),
        contact: clean(raw.contact, 160),
        company: clean(raw.company, 120),
        task: clean(raw.task, 3000),
        message: clean(raw.message, 3000),
        source: clean(raw.source, 100),
        path: clean(raw.path, 300),
        sessionId: clean(raw.sessionId, 120)
      };
      if (!data.name || !data.contact) return json(res, 400, { error: 'Укажите имя и Telegram/телефон.' });
      await telegramLead(data);
      analytics.formSubmits += 1;
      today().formSubmits += 1;
      inc(analytics.clicks, 'form_success_' + safeName(data.source || 'portfolio'));
      identify('', data.sessionId);
      persist();
      return json(res, 200, { ok: true });
    } catch (e) {
      if (e.message === 'TELEGRAM_NOT_CONFIGURED') {
        return json(res, 503, { error: 'Форма ещё не подключена к Telegram на сервере.' });
      }
      console.error('lead error:', e.message);
      return json(res, 502, { error: 'Не удалось отправить заявку. Напишите в Telegram.' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const key = url.searchParams.get('key') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!ANALYTICS_KEY || !safeEqual(key, ANALYTICS_KEY)) return json(res, 401, { error: 'Неверный ключ аналитики.' });
    return json(res, 200, stats());
  }

  if (req.method === 'GET') return staticFile(url.pathname, res);
  return plain(res, 405, 'Method not allowed');
});

server.listen(PORT, '0.0.0.0', () => console.log('hanxw portfolio listening on :' + PORT));
