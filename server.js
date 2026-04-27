const express = require('express');
const { createClient } = require('redis');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Redis ────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = createClient({
  url: REDIS_URL,
  socket: {
    tls: REDIS_URL.startsWith('rediss://'),
    rejectUnauthorized: false,
  },
});
redis.on('error', err => console.error('redis err:', err));

// ── Helpers ──────────────────────────────────
function genCode() {
  // 4 hex chars = 65k combos, plenty for tasting sessions
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

const k = {
  meta:    (c) => `s:${c}:meta`,
  wines:   (c) => `s:${c}:wines`,
  rating:  (c, user, wid) => `s:${c}:r:${user}:${wid}`,
  ratings: (c) => `s:${c}:r:*`,
  users:   (c) => `s:${c}:users`,
};

// TTL: sessions expire after 48 hours
const TTL = 48 * 60 * 60;

async function touch(code) {
  // refresh TTL on all keys for this session
  const keys = await redis.keys(`s:${code}:*`);
  for (const key of keys) await redis.expire(key, TTL);
}

function sanitizeImageDataUrl(value) {
  if (!value || typeof value !== 'string') return '';
  if (!value.startsWith('data:image/')) return '';
  // Keep payloads bounded since images live in Redis with the wine record.
  if (value.length > 1_500_000) return '';
  return value;
}

function buildWinePayload(body, existing = {}) {
  const name = String(body.name || '').trim();
  const type = String(body.type || '').trim();
  if (!name) return { error: 'name required' };
  if (!['red', 'white', 'spark', 'rose', 'nonalc'].includes(type)) {
    return { error: 'valid type required' };
  }
  return {
    name,
    producer: String(body.producer || '').trim(),
    vintage: String(body.vintage || '').trim().slice(0, 4),
    grape: String(body.grape || '').trim(),
    type,
    image: body.image === undefined
      ? (existing.image || '')
      : sanitizeImageDataUrl(body.image),
  };
}

// ── API routes ───────────────────────────────

// POST /api/session — create a new session
app.post('/api/session', async (req, res) => {
  const { hostName } = req.body;
  if (!hostName) return res.status(400).json({ error: 'hostName required' });

  let code;
  // ensure unique code
  for (let i = 0; i < 10; i++) {
    code = genCode();
    const exists = await redis.exists(k.meta(code));
    if (!exists) break;
  }

  await redis.set(k.meta(code), JSON.stringify({
    host: hostName,
    createdAt: Date.now(),
  }), { EX: TTL });

  await redis.set(k.wines(code), '[]', { EX: TTL });
  await redis.sAdd(k.users(code), hostName);
  await redis.expire(k.users(code), TTL);

  res.json({ code });
});

// POST /api/session/join — join an existing session
app.post('/api/session/join', async (req, res) => {
  const { code, userName } = req.body;
  if (!code || !userName) return res.status(400).json({ error: 'code and userName required' });

  const meta = await redis.get(k.meta(code.toUpperCase()));
  if (!meta) return res.status(404).json({ error: 'session not found' });

  const c = code.toUpperCase();
  await redis.sAdd(k.users(c), userName);
  await touch(c);

  res.json({ ...JSON.parse(meta), code: c });
});

// GET /api/session/:code — get session info + participants
app.get('/api/session/:code', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const meta = await redis.get(k.meta(c));
  if (!meta) return res.status(404).json({ error: 'not found' });

  const users = await redis.sMembers(k.users(c));
  res.json({ ...JSON.parse(meta), code: c, users });
});

// GET /api/session/:code/wines — get wine list
app.get('/api/session/:code/wines', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const raw = await redis.get(k.wines(c));
  if (!raw) return res.status(404).json({ error: 'not found' });
  res.json(JSON.parse(raw));
});

// POST /api/session/:code/wines — add a wine
app.post('/api/session/:code/wines', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const raw = await redis.get(k.wines(c));
  if (!raw) return res.status(404).json({ error: 'not found' });

  const wines = JSON.parse(raw);
  const next = buildWinePayload(req.body);
  if (next.error) return res.status(400).json({ error: next.error });

  const wine = {
    id: Date.now().toString(),
    ...next,
  };
  wines.push(wine);
  await redis.set(k.wines(c), JSON.stringify(wines), { EX: TTL });
  await touch(c);
  res.json(wine);
});

// PATCH /api/session/:code/wines/:wineId — update an existing wine
app.patch('/api/session/:code/wines/:wineId', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const raw = await redis.get(k.wines(c));
  if (!raw) return res.status(404).json({ error: 'not found' });

  const wines = JSON.parse(raw);
  const idx = wines.findIndex(w => w.id === req.params.wineId);
  if (idx === -1) return res.status(404).json({ error: 'wine not found' });

  const next = buildWinePayload(req.body, wines[idx]);
  if (next.error) return res.status(400).json({ error: next.error });

  wines[idx] = { ...wines[idx], ...next };
  await redis.set(k.wines(c), JSON.stringify(wines), { EX: TTL });
  await touch(c);
  res.json(wines[idx]);
});

// POST /api/session/:code/wines/reorder — reorder the session wines
app.post('/api/session/:code/wines/reorder', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const raw = await redis.get(k.wines(c));
  if (!raw) return res.status(404).json({ error: 'not found' });

  const wines = JSON.parse(raw);
  const orderedIds = Array.isArray(req.body.orderedIds) ? req.body.orderedIds.map(String) : [];
  if (orderedIds.length !== wines.length) {
    return res.status(400).json({ error: 'orderedIds length mismatch' });
  }

  const byId = new Map(wines.map(w => [w.id, w]));
  if (orderedIds.some(id => !byId.has(id)) || new Set(orderedIds).size !== wines.length) {
    return res.status(400).json({ error: 'orderedIds must include each wine exactly once' });
  }

  const reordered = orderedIds.map(id => byId.get(id));
  await redis.set(k.wines(c), JSON.stringify(reordered), { EX: TTL });
  await touch(c);
  res.json(reordered);
});

// DELETE /api/session/:code/wines/:wineId — delete a wine
app.delete('/api/session/:code/wines/:wineId', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const raw = await redis.get(k.wines(c));
  if (!raw) return res.status(404).json({ error: 'not found' });

  let wines = JSON.parse(raw);
  wines = wines.filter(w => w.id !== req.params.wineId);
  await redis.set(k.wines(c), JSON.stringify(wines), { EX: TTL });

  // also delete all ratings for this wine
  const ratingKeys = await redis.keys(`s:${c}:r:*:${req.params.wineId}`);
  for (const rk of ratingKeys) await redis.del(rk);

  await touch(c);
  res.json({ ok: true });
});

// POST /api/session/:code/rate — submit a rating
app.post('/api/session/:code/rate', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const { userName, wineId, score, flavors, notes } = req.body;
  if (!userName || !wineId) return res.status(400).json({ error: 'userName and wineId required' });

  const ratingScore = score || 0;
  await redis.set(k.rating(c, userName, wineId), JSON.stringify({
    score: ratingScore,
    flavors: flavors || {},
    notes: notes || '',
    at: Date.now(),
  }), { EX: TTL });

  if (ratingScore === 5) {
    const wines = JSON.parse(await redis.get(k.wines(c)) || '[]');
    const wine = wines.find(w => w.id === wineId);
    if (wine) {
      await addToHof({
        wineName: wine.name,
        producer: wine.producer || '',
        vintage: wine.vintage || '',
        type: wine.type,
        grape: wine.grape || '',
        score: 5,
        rater: userName,
        sessionCode: c,
        at: Date.now(),
      });
    }
  }

  await touch(c);
  res.json({ ok: true });
});

// GET /api/session/:code/ratings — get ALL ratings (all users, all wines)
app.get('/api/session/:code/ratings', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const keys = await redis.keys(`s:${c}:r:*`);
  const result = {};

  for (const key of keys) {
    // key format: s:CODE:r:USERNAME:WINEID
    const parts = key.split(':');
    const user = parts[3];
    const wineId = parts[4];
    const val = await redis.get(key);
    if (!result[user]) result[user] = {};
    result[user][wineId] = JSON.parse(val);
  }

  res.json(result);
});

// GET /api/session/:code/ratings/:userName — get ratings for one user
app.get('/api/session/:code/ratings/:userName', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const user = req.params.userName;
  const keys = await redis.keys(`s:${c}:r:${user}:*`);
  const result = {};

  for (const key of keys) {
    const wineId = key.split(':').pop();
    result[wineId] = JSON.parse(await redis.get(key));
  }

  res.json(result);
});

// DELETE /api/session/:code/rate/:wineId — delete one user's rating for a wine
app.delete('/api/session/:code/rate/:wineId', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const { userName } = req.body;
  if (!userName) return res.status(400).json({ error: 'userName required' });
  await redis.del(k.rating(c, userName, req.params.wineId));
  await touch(c);
  res.json({ ok: true });
});

// ── Hall of Fame ──────────────────────────────
const HOF_KEY = 'hof';
const HOF_MAX = 100;

async function addToHof(entry) {
  const raw = await redis.get(HOF_KEY);
  const hof = raw ? JSON.parse(raw) : [];
  // replace existing entry for same rater+wine combo (identified by name+rater)
  const idx = hof.findIndex(e => e.wineName === entry.wineName && e.rater === entry.rater);
  if (idx !== -1) hof.splice(idx, 1);
  hof.unshift(entry);
  if (hof.length > HOF_MAX) hof.length = HOF_MAX;
  await redis.set(HOF_KEY, JSON.stringify(hof));
}

// GET /api/hof — get the Hall of Fame
app.get('/api/hof', async (req, res) => {
  const raw = await redis.get(HOF_KEY);
  res.json(raw ? JSON.parse(raw) : []);
});

// ── Start ────────────────────────────────────
const PORT = process.env.PORT || 8080;

async function start() {
  await redis.connect();
  console.log('redis connected');
  app.listen(PORT, () => console.log(`verre listening on :${PORT}`));
}

start().catch(err => {
  console.error('startup failed:', err);
  process.exit(1);
});
