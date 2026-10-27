// SKAM Voice - السيرفر (Node.js)
// متغيرات البيئة: SECRET (لازم تغيره)، MAX_DIST، FULL_DIST، PORT
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const SECRET = process.env.SECRET || 'CHANGE_ME';
const MAX = +process.env.MAX_DIST || 60;   // أبعد مسافة يسمع فيها (studs)
const FULL = +process.env.FULL_DIST || 8;  // أقل من هذي المسافة = صوت كامل
const PORT = process.env.PORT || 3000;

const players = new Map(); // token -> {userId,name,pos,muted,ws}

const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const byUserId = id => [...players.values()].find(p => p.userId === id);
const connected = () => [...players.values()].filter(p => p.ws);

function pushVolumes() {
  const list = connected();
  for (const a of list) {
    const vols = {};
    for (const b of list) {
      if (a === b) continue;
      const d = Math.hypot(a.pos[0]-b.pos[0], a.pos[1]-b.pos[1], a.pos[2]-b.pos[2]);
      let g = d <= FULL ? 1 : d >= MAX ? 0 : 1 - (d - FULL) / (MAX - FULL);
      vols[b.userId] = +(g * g).toFixed(3);
    }
    send(a.ws, { type: 'vol', vols });
  }
}

function readBody(req) {
  return new Promise(res => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(s)); } catch { res(null); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/sync') {
    const b = await readBody(req);
    if (!b || b.secret !== SECRET) { res.writeHead(403); return res.end(); }
    const seen = new Set();
    for (const p of b.players || []) {
      seen.add(p.token);
      let o = players.get(p.token);
      if (!o) { o = { userId: p.userId, name: p.name, pos: [0,0,0], muted: false, ws: null }; players.set(p.token, o); }
      o.name = p.name; o.pos = [p.x, p.y, p.z];
    }
    for (const [t, o] of players) if (!seen.has(t)) {   // اللاعب طلع من الماب
      if (o.ws) { send(o.ws, { type: 'kicked' }); o.ws.close(); }
      players.delete(t);
    }
    const states = {};
    for (const [t, o] of players) states[t] = { connected: !!o.ws, muted: o.muted };
    pushVolumes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ states }));
  }
  if (req.method === 'POST' && req.url === '/api/toggle') {
    const b = await readBody(req);
    if (!b || b.secret !== SECRET) { res.writeHead(403); return res.end(); }
    const o = players.get(b.token);
    if (o && o.ws) {
      o.muted = !o.muted;
      send(o.ws, { type: 'muted', muted: o.muted });
      for (const q of connected()) if (q !== o) send(q.ws, { type: 'peer-mute', userId: o.userId, muted: o.muted });
    }
    res.writeHead(200); return res.end('ok');
  }
  // الموقع
  fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('t');
  const me = players.get(token);
  if (!me) { send(ws, { type: 'error', msg: 'الرابط غير صالح أو انتهى. ادخل الماب وخذ رابط جديد.' }); return ws.close(); }
  if (me.ws) me.ws.close();
  me.ws = ws; me.muted = false;
  const peers = connected().filter(p => p !== me).map(p => ({ userId: p.userId, name: p.name, muted: p.muted }));
  send(ws, { type: 'hello', me: { userId: me.userId, name: me.name }, peers });
  for (const q of connected()) if (q !== me) send(q.ws, { type: 'peer-join', peer: { userId: me.userId, name: me.name } });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'signal') {
      const t = byUserId(m.to);
      if (t) send(t.ws, { type: 'signal', from: me.userId, data: m.data });
    } else if (m.type === 'mute') {
      me.muted = !!m.muted;
      for (const q of connected()) if (q !== me) send(q.ws, { type: 'peer-mute', userId: me.userId, muted: me.muted });
    }
  });
  ws.on('close', () => {
    if (me.ws === ws) {
      me.ws = null;
      for (const q of connected()) send(q.ws, { type: 'peer-leave', userId: me.userId });
    }
  });
});

server.listen(PORT, () => console.log('SKAM Voice running on :' + PORT));
