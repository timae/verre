const express = require('express');
const { createClient } = require('redis');
const path = require('path');
const crypto = require('crypto');

const pool = require('./db');
const { optionalAuth } = require('./middleware/auth');
const { uploadImage, deleteImage } = require('./lib/s3');
const authRoutes = require('./routes/auth');
const meRoutes = require('./routes/me');

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(optionalAuth);

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
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

const k = {
  meta:    (c) => `s:${c}:meta`,
  wines:   (c) => `s:${c}:wines`,
  rating:  (c, user, wid) => `s:${c}:r:${user}:${wid}`,
  users:   (c) => `s:${c}:users`,
};

const TTL = 48 * 60 * 60;

async function touch(code) {
  const keys = await redis.keys(`s:${code}:*`);
  for (const key of keys) await redis.expire(key, TTL);
}

function sanitizeImageDataUrl(value) {
  if (!value || typeof value !== 'string') return '';
  if (!value.startsWith('data:image/')) return '';
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
      ? (existing.image || existing.imageUrl || '')
      : sanitizeImageDataUrl(body.image),
    imageUrl: body.imageUrl === undefined ? (existing.imageUrl || '') : String(body.imageUrl || ''),
  };
}

// ── Postgres archival helpers ─────────────────
async function pgUpsertSession(code, meta) {
  await pool.query(
    `INSERT INTO sessions (code, host_name, name, created_at)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
     ON CONFLICT (code) DO UPDATE SET name = COALESCE(EXCLUDED.name, sessions.name)`,
    [code, meta.host, meta.name || null, meta.createdAt]
  );
}

function isHost(meta, req) {
  // authenticated: match by userId if stored, else fall through to name
  if (req.user) {
    if (meta.hostUserId) return req.user.userId === meta.hostUserId;
    // old session without hostUserId — allow authenticated user if name matches
  }
  const userName = req.body?.userName || req.query?.userName || req.body?.hostName;
  return !!userName && userName === meta.host;
}

async function pgUpsertWine(sessionCode, wine) {
  const { rows } = await pool.query('SELECT id FROM sessions WHERE code = $1', [sessionCode]);
  if (!rows[0]) return;
  const sessionId = rows[0].id;
  await pool.query(
    `INSERT INTO wines (id, session_id, name, producer, vintage, grape, style, image_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, producer = EXCLUDED.producer,
       vintage = EXCLUDED.vintage, grape = EXCLUDED.grape,
       style = EXCLUDED.style, image_url = COALESCE(EXCLUDED.image_url, wines.image_url)`,
    [wine.id, sessionId, wine.name, wine.producer || null, wine.vintage || null,
     wine.grape || null, wine.type || null, wine.imageUrl || null]
  );
}

async function pgUpsertRating(wine, ratingScore, flavors, notes, userName, userId) {
  await pool.query(
    `INSERT INTO ratings (wine_id, user_id, rater_name, score, flavors, notes, rated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (wine_id, rater_name) DO UPDATE SET
       score = EXCLUDED.score, flavors = EXCLUDED.flavors,
       notes = EXCLUDED.notes, rated_at = NOW()`,
    [wine.id, userId || null, userName, ratingScore, JSON.stringify(flavors || {}), notes || null]
  );
}

async function pgUpsertHof(wine, userName, userId, sessionCode, ratingScore) {
  await pool.query(
    `INSERT INTO hall_of_fame (wine_name, producer, vintage, style, score, rater_name, user_id, session_code, rated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (wine_name, rater_name) DO UPDATE SET
       score = EXCLUDED.score, rated_at = NOW(), user_id = EXCLUDED.user_id`,
    [wine.name, wine.producer || null, wine.vintage || null, wine.type || null,
     ratingScore, userName, userId || null, sessionCode]
  );
}

// ── Routes: Auth & Me ────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/me', meRoutes);

// ── API routes ───────────────────────────────

// POST /api/session — create a new session
app.post('/api/session', async (req, res) => {
  const { hostName, sessionName } = req.body;
  if (!hostName) return res.status(400).json({ error: 'hostName required' });

  let code;
  for (let i = 0; i < 10; i++) {
    code = genCode();
    const exists = await redis.exists(k.meta(code));
    if (!exists) break;
  }

  const meta = {
    host: hostName,
    name: sessionName ? String(sessionName).trim().slice(0, 80) : '',
    createdAt: Date.now(),
    hostUserId: req.user?.userId || null,
  };
  await redis.set(k.meta(code), JSON.stringify(meta), { EX: TTL });
  await redis.set(k.wines(code), '[]', { EX: TTL });
  await redis.sAdd(k.users(code), hostName);
  await redis.expire(k.users(code), TTL);

  // archive session to postgres if user is authenticated
  if (req.user) {
    try {
      await pool.query(
        `INSERT INTO sessions (code, host_user_id, host_name, name, created_at)
         VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
         ON CONFLICT (code) DO NOTHING`,
        [code, req.user.userId, hostName, meta.name || null, meta.createdAt]
      );
    } catch (err) {
      console.error('pg session create error:', err.message);
    }
  }

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

// PATCH /api/session/:code/name — rename session (host only)
app.patch('/api/session/:code/name', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const raw = await redis.get(k.meta(c));
  if (!raw) return res.status(404).json({ error: 'session not found' });
  const meta = JSON.parse(raw);
  if (!isHost(meta, req)) return res.status(403).json({ error: 'only the host can rename this session' });
  const name = String(req.body.name || '').trim().slice(0, 80);
  meta.name = name;
  await redis.set(k.meta(c), JSON.stringify(meta), { EX: TTL });
  await touch(c);
  // update postgres too
  try { await pool.query(`UPDATE sessions SET name=$1 WHERE code=$2`, [name || null, c]); } catch {}
  res.json({ ok: true, name });
});

// POST /api/session/:code/visit — record that a logged-in user joined this session
app.post('/api/session/:code/visit', async (req, res) => {
  if (!req.user) return res.json({ ok: true }); // no-op for anonymous
  const c = req.params.code.toUpperCase();
  const meta = await redis.get(k.meta(c));
  if (!meta) return res.status(404).json({ error: 'session not found' });
  try {
    await pgUpsertSession(c, JSON.parse(meta));
    await pool.query(
      `INSERT INTO session_members (user_id, session_code) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.userId, c]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('visit error:', err.message);
    res.json({ ok: true }); // non-fatal
  }
});

// POST /api/session/:code/wines — add a wine
app.post('/api/session/:code/wines', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const raw = await redis.get(k.wines(c));
  if (!raw) return res.status(404).json({ error: 'not found' });
  const meta = JSON.parse(await redis.get(k.meta(c)) || '{}');
  if (!isHost(meta, req)) return res.status(403).json({ error: 'only the host can add wines' });

  const wines = JSON.parse(raw);
  const next = buildWinePayload(req.body);
  if (next.error) return res.status(400).json({ error: next.error });

  const wine = { id: Date.now().toString(), ...next };

  // upload image to S3 if present
  if (wine.image && wine.image.startsWith('data:image/')) {
    try {
      const url = await uploadImage(wine.id, wine.image);
      if (url) {
        wine.imageUrl = url;
        wine.image = ''; // don't store base64 in Redis if we have S3
      }
    } catch (err) {
      console.error('s3 upload error:', err.message);
    }
  }

  wines.push(wine);
  await redis.set(k.wines(c), JSON.stringify(wines), { EX: TTL });
  await touch(c);

  // archive to postgres
  if (req.user) {
    try {
      const meta = JSON.parse(await redis.get(k.meta(c)) || '{}');
      await pgUpsertSession(c, meta);
      await pgUpsertWine(c, wine);
    } catch (err) {
      console.error('pg wine upsert error:', err.message);
    }
  }

  res.json(wine);
});

// PATCH /api/session/:code/wines/:wineId — update an existing wine
app.patch('/api/session/:code/wines/:wineId', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const raw = await redis.get(k.wines(c));
  if (!raw) return res.status(404).json({ error: 'not found' });
  const meta = JSON.parse(await redis.get(k.meta(c)) || '{}');
  if (!isHost(meta, req)) return res.status(403).json({ error: 'only the host can edit wines' });

  const wines = JSON.parse(raw);
  const idx = wines.findIndex(w => w.id === req.params.wineId);
  if (idx === -1) return res.status(404).json({ error: 'wine not found' });

  const next = buildWinePayload(req.body, wines[idx]);
  if (next.error) return res.status(400).json({ error: next.error });

  // upload new image to S3 if provided
  if (next.image && next.image.startsWith('data:image/')) {
    try {
      const url = await uploadImage(req.params.wineId, next.image);
      if (url) { next.imageUrl = url; next.image = ''; }
    } catch (err) {
      console.error('s3 upload error:', err.message);
    }
  }

  wines[idx] = { ...wines[idx], ...next };
  await redis.set(k.wines(c), JSON.stringify(wines), { EX: TTL });
  await touch(c);

  if (req.user) {
    try { await pgUpsertWine(c, wines[idx]); } catch (err) { console.error('pg wine patch error:', err.message); }
  }

  res.json(wines[idx]);
});

// POST /api/session/:code/wines/reorder — reorder the session wines
app.post('/api/session/:code/wines/reorder', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const raw = await redis.get(k.wines(c));
  if (!raw) return res.status(404).json({ error: 'not found' });
  const meta = JSON.parse(await redis.get(k.meta(c)) || '{}');
  if (!isHost(meta, req)) return res.status(403).json({ error: 'only the host can reorder wines' });

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
  const meta = JSON.parse(await redis.get(k.meta(c)) || '{}');
  if (!isHost(meta, req)) return res.status(403).json({ error: 'only the host can delete wines' });

  let wines = JSON.parse(raw);
  wines = wines.filter(w => w.id !== req.params.wineId);
  await redis.set(k.wines(c), JSON.stringify(wines), { EX: TTL });

  const ratingKeys = await redis.keys(`s:${c}:r:*:${req.params.wineId}`);
  for (const rk of ratingKeys) await redis.del(rk);

  // best-effort S3 cleanup
  deleteImage(req.params.wineId).catch(() => {});

  await touch(c);
  res.json({ ok: true });
});

// POST /api/session/:code/wines/:wineId/bookmark — save wine to account
app.post('/api/session/:code/wines/:wineId/bookmark', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  const c = req.params.code.toUpperCase();
  const { wineId } = req.params;
  const wines = JSON.parse(await redis.get(k.wines(c)) || '[]');
  const wine = wines.find(w => w.id === wineId);
  if (!wine) return res.status(404).json({ error: 'wine not found' });
  try {
    const meta = JSON.parse(await redis.get(k.meta(c)) || '{}');
    await pgUpsertSession(c, meta);
    await pgUpsertWine(c, wine);
    await pool.query(
      `INSERT INTO bookmarks (user_id, wine_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.userId, wineId]
    );
    res.json({ ok: true, bookmarked: true });
  } catch (err) {
    console.error('bookmark error:', err);
    res.status(500).json({ error: 'failed to bookmark wine' });
  }
});

// DELETE /api/session/:code/wines/:wineId/bookmark — remove bookmark
app.delete('/api/session/:code/wines/:wineId/bookmark', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  await pool.query(
    `DELETE FROM bookmarks WHERE user_id = $1 AND wine_id = $2`,
    [req.user.userId, req.params.wineId]
  );
  res.json({ ok: true, bookmarked: false });
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

  const wines = JSON.parse(await redis.get(k.wines(c)) || '[]');
  const wine = wines.find(w => w.id === wineId);

  // archive to postgres for authenticated users
  if (req.user && wine) {
    try {
      const meta = JSON.parse(await redis.get(k.meta(c)) || '{}');
      await pgUpsertSession(c, meta);
      await pgUpsertWine(c, wine);
      await pgUpsertRating(wine, ratingScore, flavors, notes, userName, req.user.userId);
    } catch (err) {
      console.error('pg rating archive error:', err.message);
    }
  }

  // HoF: write to postgres (authenticated) or Redis fallback (anonymous)
  if (ratingScore === 5 && wine) {
    if (req.user) {
      try {
        await pgUpsertHof(wine, userName, req.user.userId, c, ratingScore);
      } catch (err) {
        console.error('pg hof error:', err.message);
      }
    } else {
      // anonymous fallback: Redis hof (existing behaviour)
      try { await redisAddToHof(wine, userName, c); } catch {}
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

async function redisAddToHof(wine, rater, sessionCode) {
  const raw = await redis.get(HOF_KEY);
  const hof = raw ? JSON.parse(raw) : [];
  const idx = hof.findIndex(e => e.wineName === wine.name && e.rater === rater);
  if (idx !== -1) hof.splice(idx, 1);
  hof.unshift({
    wineName: wine.name, producer: wine.producer || '', vintage: wine.vintage || '',
    type: wine.type, grape: wine.grape || '', score: 5, rater, sessionCode, at: Date.now(),
  });
  if (hof.length > HOF_MAX) hof.length = HOF_MAX;
  await redis.set(HOF_KEY, JSON.stringify(hof));
}

// GET /api/hof — Hall of Fame (Postgres preferred, Redis fallback)
app.get('/api/hof', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT h.wine_name AS "wineName", h.producer, h.vintage, h.style AS type, h.score,
              h.rater_name AS rater, h.session_code AS "sessionCode", h.rated_at AS at,
              u.name AS "accountName"
       FROM hall_of_fame h
       LEFT JOIN users u ON u.id = h.user_id
       ORDER BY h.rated_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch {
    // Postgres not available — fall back to Redis
    const raw = await redis.get(HOF_KEY);
    res.json(raw ? JSON.parse(raw) : []);
  }
});

// ── Start ────────────────────────────────────
const PORT = process.env.PORT || 8080;

async function start() {
  await redis.connect();
  console.log('redis connected');

  if (process.env.DATABASE_URL) {
    try {
      await pool.query('SELECT 1');
      console.log('postgres connected');
    } catch (err) {
      console.error('postgres connection failed:', err.message);
    }
  } else {
    console.log('postgres: no DATABASE_URL set, running without persistence');
  }

  app.listen(PORT, () => console.log(`verre listening on :${PORT}`));
}

start().catch(err => {
  console.error('startup failed:', err);
  process.exit(1);
});
