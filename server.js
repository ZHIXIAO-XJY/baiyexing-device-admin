'use strict';
/**
 * 白夜行 · 设备管理后台（无第三方依赖）
 * 启动：node admin-server/server.js
 * 环境变量：
 *   ADMIN_PASSWORD=你的密码 PORT=8787 HOST=0.0.0.0
 *   ALLOWED_ORIGINS=https://zhixiao-xjy.github.io,http://localhost:8899
 *   TRUST_PROXY=1  HTTPS=1
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const ROOT = __dirname;
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const DEVICES_FILE = path.join(DATA, 'devices.json');
const ADMIN_HTML = path.join(ROOT, 'admin.html');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const SESSION_MS = 12 * 60 * 60 * 1000;
const ONLINE_MS = 90 * 1000;
const sessions = new Map();
const loginHits = new Map();
let state = { admin: null };
let devices = { devices: [] };
let saveQueue = Promise.resolve();

const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
function cors(req) {
  const origin = req.headers.origin || '';
  const defaults = 'https://zhixiao-xjy.github.io,http://localhost:8899,http://127.0.0.1:8899';
  const allowed = String(process.env.ALLOWED_ORIGINS || defaults).split(',').map((s) => s.trim()).filter(Boolean);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  const ok = !origin || local || allowed.includes(origin);
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': ok && origin ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, X-Device-Token',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    }
  };
}
function json(req, res, status, obj) {
  const c = cors(req);
  res.writeHead(status, { ...c.headers, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
async function body(req, max = 64 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid json'), { status: 400 }); }
}
function ip(req) {
  if (process.env.TRUST_PROXY === '1') {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).split(',')[0].trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}
function cookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}
async function atomicWrite(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
function save() {
  saveQueue = saveQueue.then(() => Promise.all([atomicWrite(STATE_FILE, state), atomicWrite(DEVICES_FILE, devices)]));
  return saveQueue;
}
async function load() {
  await fs.mkdir(DATA, { recursive: true });
  try { state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch { state = { admin: null }; }
  try { devices = JSON.parse(await fs.readFile(DEVICES_FILE, 'utf8')); } catch { devices = { devices: [] }; }
  if (!Array.isArray(devices.devices)) devices.devices = [];
  if (!state.admin) {
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    state.admin = { salt, hash, createdAt: now() };
    await save();
    if (!process.env.ADMIN_PASSWORD) {
      console.log('\n=== 白夜行后台初始管理员 ===');
      console.log('账号：admin');
      console.log('密码：' + password);
      console.log('登录后请修改 ADMIN_PASSWORD 并重启。\n');
    }
  } else if (process.env.ADMIN_PASSWORD) {
    // 重新设置 ADMIN_PASSWORD 并重启即可轮换管理员密码。
    const hash = (await scrypt(process.env.ADMIN_PASSWORD, state.admin.salt, 64)).toString('hex');
    if (!safeEqual(hash, state.admin.hash)) {
      state.admin.hash = hash;
      state.admin.updatedAt = now();
      await save();
      console.log('管理员密码已按 ADMIN_PASSWORD 更新。');
    }
  }
}
function session(req) {
  const sid = cookie(req, 'fc_admin');
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s || Date.now() - s.last > SESSION_MS) { if (sid) sessions.delete(sid); return null; }
  s.last = Date.now();
  return { sid, ...s };
}
function cleanDevice(d) {
  return {
    id: d.id, name: d.name || '', platform: d.platform || 'web', appVersion: d.appVersion || '',
    ip: d.ip || '', ipSource: d.ipSource || '', firstSeen: d.firstSeen, lastSeen: d.lastSeen,
    revoked: !!d.revoked, revokeReason: d.revokeReason || '', projectTitle: d.projectTitle || '',
    mode: d.mode || '', sceneCount: Number(d.sceneCount) || 0, currentView: d.currentView || '',
    userAgent: d.userAgent || ''
  };
}
function loginLimited(req) {
  const key = ip(req); const t = Date.now();
  const hit = loginHits.get(key) || { count: 0, reset: t + 15 * 60 * 1000 };
  if (t > hit.reset) { hit.count = 0; hit.reset = t + 15 * 60 * 1000; }
  hit.count++; loginHits.set(key, hit);
  return hit.count > 10;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const c = cors(req);
  if (!c.ok) return json(req, res, 403, { error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') { res.writeHead(204, c.headers); return res.end(); }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
    const html = await fs.readFile(ADMIN_HTML, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
    return res.end(html);
  }
  const STATIC = {
    '/admin-manifest.webmanifest': ['admin-manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    '/admin-sw.js': ['admin-sw.js', 'text/javascript; charset=utf-8'],
    '/admin-icon-192.png': ['admin-icon-192.png', 'image/png'],
    '/admin-icon-512.png': ['admin-icon-512.png', 'image/png'],
    '/admin-apple-touch.png': ['admin-apple-touch.png', 'image/png']
  };
  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    const data = await fs.readFile(path.join(ROOT, file));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    return res.end(data);
  }
  if (req.method === 'GET' && url.pathname === '/api/health') return json(req, res, 200, { ok: true, service: 'baiyexing-device-admin' });

  if (req.method === 'POST' && url.pathname === '/api/device/register') {
    const d = await body(req);
    const deviceId = String(d.deviceId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) return json(req, res, 400, { error: 'invalid deviceId' });
    let item = devices.devices.find((x) => x.id === deviceId);
    if (item?.revoked) return json(req, res, 403, { error: 'DEVICE_REVOKED', message: item.revokeReason || '设备已被管理员下线' });
    if (!item) { item = { id: deviceId, firstSeen: now() }; devices.devices.push(item); }
    const token = crypto.randomBytes(32).toString('base64url');
    Object.assign(item, {
      name: String(d.name || '').slice(0, 80), platform: String(d.platform || 'web').slice(0, 30),
      appVersion: String(d.appVersion || '').slice(0, 30), tokenHash: sha(token),
      ip: ip(req), ipSource: process.env.TRUST_PROXY === '1' ? 'proxy' : 'socket',
      lastSeen: now(), revoked: false, revokeReason: '',
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300)
    });
    await save();
    return json(req, res, 200, { ok: true, token, device: cleanDevice(item) });
  }

  if (req.method === 'POST' && url.pathname === '/api/device/heartbeat') {
    const d = await body(req);
    const token = String(req.headers['x-device-token'] || '');
    if (!token) return json(req, res, 401, { error: 'missing device token' });
    const item = devices.devices.find((x) => x.id === String(d.deviceId || '').trim() && x.tokenHash === sha(token));
    if (!item) return json(req, res, 401, { error: 'invalid device' });
    if (item.revoked) return json(req, res, 403, { error: 'DEVICE_REVOKED', message: item.revokeReason || '设备已被管理员下线' });
    item.ip = ip(req);
    item.ipSource = process.env.TRUST_PROXY === '1' ? 'proxy' : 'socket';
    item.lastSeen = now();
    item.projectTitle = String(d.projectTitle || item.projectTitle || '').slice(0, 120);
    item.mode = String(d.mode || item.mode || '').slice(0, 30);
    item.sceneCount = Math.max(0, Number(d.sceneCount) || 0);
    item.currentView = String(d.currentView || item.currentView || '').slice(0, 50);
    item.userAgent = String(req.headers['user-agent'] || item.userAgent || '').slice(0, 300);
    await save();
    return json(req, res, 200, { ok: true, serverTime: now(), onlineWindowMs: ONLINE_MS });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    if (loginLimited(req)) return json(req, res, 429, { error: 'too many attempts' });
    const d = await body(req);
    const hash = (await scrypt(String(d.password || ''), state.admin.salt, 64)).toString('hex');
    if (!safeEqual(hash, state.admin.hash)) return json(req, res, 401, { error: 'invalid credentials' });
    const sid = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    sessions.set(sid, { csrf, last: Date.now() });
    const secure = process.env.HTTPS === '1' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `fc_admin=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`);
    return json(req, res, 200, { ok: true, csrf });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    sessions.delete(cookie(req, 'fc_admin'));
    res.setHeader('Set-Cookie', 'fc_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(req, res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/session') {
    const s = session(req);
    if (!s) return json(req, res, 401, { error: 'unauthorized' });
    return json(req, res, 200, { ok: true, csrf: s.csrf });
  }

  if (url.pathname.startsWith('/api/admin/')) {
    const s = session(req);
    if (!s) return json(req, res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
      const t = Date.now();
      return json(req, res, 200, {
        total: devices.devices.length,
        online: devices.devices.filter((d) => !d.revoked && t - Date.parse(d.lastSeen || 0) < ONLINE_MS).length,
        revoked: devices.devices.filter((d) => d.revoked).length,
        generatedAt: now()
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/devices') {
      return json(req, res, 200, { devices: devices.devices.map(cleanDevice).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))) });
    }
    const m = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)\/(revoke|restore)$/);
    if (req.method === 'POST' && m) {
      if (!safeEqual(req.headers['x-csrf-token'] || '', s.csrf)) return json(req, res, 403, { error: 'csrf' });
      const d = await body(req);
      const item = devices.devices.find((x) => x.id === decodeURIComponent(m[1]));
      if (!item) return json(req, res, 404, { error: 'device not found' });
      item.revoked = m[2] === 'revoke';
      item.revokeReason = item.revoked ? String(d.reason || '管理员下线').slice(0, 120) : '';
      await save();
      return json(req, res, 200, { ok: true, device: cleanDevice(item) });
    }
    return json(req, res, 404, { error: 'not found' });
  }
  return json(req, res, 404, { error: 'not found' });
}

load().then(() => {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('REQ_ERROR', e && e.message);
      if (!res.headersSent) json(req, res, e.status || 500, { error: 'internal error' });
      else res.end();
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`白夜行设备后台：http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/admin`);
    console.log(`监听地址：${HOST}:${PORT}`);
  });
}).catch((e) => { console.error(e); process.exit(1); });
