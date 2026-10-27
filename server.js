// SKAM Voice - السيرفر (نسخة 2): مدى الصوت (همس/عادي/صراخ) + مكالمات الجوال + سبيكر
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const SECRET = process.env.SECRET || 'CHANGE_ME';
const PORT = process.env.PORT || 3000;

// مدى الصوت حسب وضع المتكلم: 1 همس، 2 عادي، 3 صراخ (بوحدة studs)
const RANGES = {
  1: { full: 2,  max: 15 },
  2: { full: +process.env.FULL_DIST || 8, max: +process.env.MAX_DIST || 60 },
  3: { full: 20, max: 120 },
};
const SPK = { full: 3, max: 25 }; // مدى سماع السبيكر حول صاحب الجوال

const players = new Map(); // token -> {userId,name,pos,muted,mode,ws}
let activeCalls = [];      // [{a,b,spkA,spkB}] بالـ userId

const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const byUserId = id => [...players.values()].find(p => p.userId === id);
const connected = () => [...players.values()].filter(p => p.ws);
const dist = (a, b) => Math.hypot(a.pos[0]-b.pos[0], a.pos[1]-b.pos[1], a.pos[2]-b.pos[2]);
const fall = (d, r) => d <= r.full ? 1 : d >= r.max ? 0 : Math.pow(1 - (d - r.full) / (r.max - r.full), 2);

function pushVolumes() {
  const list = connected();
  const byId = new Map(list.map(p => [p.userId, p]));
  for (const a of list) {
    const vols = {};
    for (const b of list) {
      if (a === b) continue;
      vols[b.userId] = +fall(dist(a, b), RANGES[b.mode] || RANGES[2]).toFixed(3);
    }
    for (const c of activeCalls) {
      const A = byId.get(c.a), B = byId.get(c.b);
      if (a === A && B) vols[B.userId] = 1;            // طرفا المكالمة يسمعون بعض بأي مسافة
      else if (a === B && A) vols[A.userId] = 1;
      else if (a !== A && a !== B && A && B) {         // السبيكر: اللي حول الجوال يسمعون الطرف الثاني
        if (c.spkA) vols[B.userId] = Math.max(vols[B.userId] || 0, 0.8 * fall(dist(a, A), SPK));
        if (c.spkB) vols[A.userId] = Math.max(vols[A.userId] || 0, 0.8 * fall(dist(a, B), SPK));
      }
    }
    send(a.ws, { type: 'vol', vols });
  }
}

function setMute(o, v) {
  o.muted = v;
  send(o.ws, { type: 'muted', muted: v });
  for (const q of connected()) if (q !== o) send(q.ws, { type: 'peer-mute', userId: o.userId, muted: v });
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
      if (!o) { o = { userId: p.userId, name: p.name, pos: [0,0,0], muted: false, mode: 2, ws: null }; players.set(p.token, o); }
      o.name = p.name; o.pos = [p.x, p.y, p.z];
      o.mode = [1, 2, 3].includes(p.mode) ? p.mode : 2;
    }
    activeCalls = (Array.isArray(b.calls) ? b.calls : []).slice(0, 100)
      .map(c => ({ a: +c.a, b: +c.b, spkA: !!c.spkA, spkB: !!c.spkB }));
    for (const [t, o] of players) if (!seen.has(t)) {
      if (o.ws) { send(o.ws, { type: 'kicked' }); o.ws.close(); }
      players.delete(t);
    }
    const states = {};
    for (const [t, o] of players) states[t] = { connected: !!o.ws, muted: o.muted };
    pushVolumes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ states }));
  }
  if (req.method === 'POST' && (req.url === '/api/mute' || req.url === '/api/toggle')) {
    const b = await readBody(req);
    if (!b || b.secret !== SECRET) { res.writeHead(403); return res.end(); }
    const o = players.get(b.token);
    if (o && o.ws) setMute(o, typeof b.muted === 'boolean' ? b.muted : !o.muted);
    res.writeHead(200); return res.end('ok');
  }
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
      setMute(me, !!m.muted);
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
