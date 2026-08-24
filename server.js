const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8765);
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'athena-sessions.json');

const defaultSession = () => ({
  schemaVersion: '0.2',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  athlete: {
    sport: '球类', sportDetail: '', stage: '1-3', injury: 'unknown',
    goal: 'break-sitting', roleImportance: 8, pastTraining: 10, currentActivity: 3
  },
  today: {
    sitMinutes: 42, burden: 0, responses: [], todayFeel: 'unknown',
    symptoms: { chest: false, syncope: false, breath: false, injury: false },
    testCompleted: false, testTier: '未完成', fatigue: 3, pain: 1,
    restingHr: 62, testHr: 102, testRpe: 3
  },
  events: [{ time: '09:10', event: '入场检查', action: 'safety gate', result: '通过', tone: 'good' }]
});

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { sessions: {} };
  }
}

function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
  fs.renameSync(tempFile, DB_FILE);
}

function sessionId(req, res) {
  const cookies = String(req.headers.cookie || '').split(';').reduce((all, item) => {
    const [key, ...value] = item.trim().split('=');
    if (key) all[key] = value.join('=');
    return all;
  }, {});
  let id = cookies.athena_session;
  if (!id || !/^[a-f0-9-]{20,80}$/.test(id)) {
    id = crypto.randomUUID();
    res.setHeader('Set-Cookie', `athena_session=${id}; Path=/; SameSite=Lax; Max-Age=31536000`);
  }
  return id;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function getSession(db, id) {
  if (!db.sessions[id]) db.sessions[id] = defaultSession();
  return db.sessions[id];
}

function mergeSession(session, payload) {
  if (payload.athlete && typeof payload.athlete === 'object') {
    session.athlete = { ...session.athlete, ...payload.athlete };
  }
  if (payload.today && typeof payload.today === 'object') {
    session.today = {
      ...session.today,
      ...payload.today,
      symptoms: { ...session.today.symptoms, ...(payload.today.symptoms || {}) }
    };
  }
  if (Array.isArray(payload.events)) session.events = payload.events.slice(-200);
  session.updatedAt = new Date().toISOString();
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, requested));
  if (!file.startsWith(ROOT) || path.extname(file) !== '.html') {
    res.writeHead(404); res.end('Not found'); return;
  }
  fs.readFile(file, (error, content) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const db = readDb();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, service: 'athena-api', version: '0.2.0', time: new Date().toISOString() });
    return;
  }

  if (url.pathname === '/api/session') {
    const id = sessionId(req, res);
    const session = getSession(db, id);
    if (req.method === 'GET') {
      writeDb(db);
      sendJson(res, 200, { sessionId: id, ...session });
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      try {
        mergeSession(session, await readJson(req));
        writeDb(db);
        sendJson(res, 200, { sessionId: id, ...session });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }
    if (req.method === 'DELETE') {
      delete db.sessions[id];
      const replacementId = crypto.randomUUID();
      db.sessions[replacementId] = defaultSession();
      writeDb(db);
      res.setHeader('Set-Cookie', `athena_session=${replacementId}; Path=/; SameSite=Lax; Max-Age=31536000`);
      sendJson(res, 200, { deleted: true, sessionId: replacementId, ...db.sessions[replacementId] });
      return;
    }
  }

  if (url.pathname === '/api/events' && req.method === 'POST') {
    const id = sessionId(req, res);
    const session = getSession(db, id);
    try {
      const payload = await readJson(req);
      if (!payload.event || !payload.action) throw new Error('event and action are required');
      session.events = [...session.events, {
        time: payload.time || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        event: String(payload.event).slice(0, 100), action: String(payload.action).slice(0, 100),
        result: String(payload.result || '').slice(0, 100), tone: ['good', 'warn', 'stop'].includes(payload.tone) ? payload.tone : 'good'
      }].slice(-200);
      session.updatedAt = new Date().toISOString();
      writeDb(db);
      sendJson(res, 200, { sessionId: id, event: session.events.at(-1), updatedAt: session.updatedAt });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) { sendJson(res, 404, { error: 'API route not found' }); return; }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ATHENA dynamic server running at http://127.0.0.1:${PORT}/`);
});
