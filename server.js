const express = require('express');
const multer = require('multer');
const { createClient } = require('redis');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// ── Redis ────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';
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

async function extractWineFromImage(file) {
  const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'producer', 'vintage', 'grape', 'type', 'confidence', 'notes'],
    properties: {
      name: { type: 'string' },
      producer: { type: 'string' },
      vintage: { type: 'string' },
      grape: { type: 'string' },
      type: {
        type: 'string',
        enum: ['red', 'white', 'spark', 'rose', 'nonalc', 'unknown'],
      },
      confidence: { type: 'number' },
      notes: { type: 'string' },
    },
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: 'You extract wine label data from bottle photos. Return best-effort structured fields. Leave uncertain text blank. Use type=unknown when type cannot be inferred safely.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Extract bottle information from this photo for a wine tasting app. We need: name, producer, vintage, grape/style, and bottle type.',
            },
            {
              type: 'input_image',
              image_url: dataUrl,
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          strict: true,
          name: 'wine_label_extraction',
          schema,
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`vision request failed: ${response.status} ${detail}`);
  }

  const payload = await response.json();
  const output = payload.output_text ? JSON.parse(payload.output_text) : null;
  if (!output) throw new Error('vision response was empty');
  return output;
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
  const wine = {
    id: Date.now().toString(),
    name: req.body.name,
    producer: req.body.producer || '',
    vintage: req.body.vintage || '',
    grape: req.body.grape || '',
    type: req.body.type,
    image: sanitizeImageDataUrl(req.body.image),
  };
  wines.push(wine);
  await redis.set(k.wines(c), JSON.stringify(wines), { EX: TTL });
  await touch(c);
  res.json(wine);
});

// POST /api/session/:code/wines/extract-label — extract bottle info from a photo
app.post('/api/session/:code/wines/extract-label', upload.single('image'), async (req, res) => {
  const c = req.params.code.toUpperCase();
  const meta = await redis.get(k.meta(c));
  if (!meta) return res.status(404).json({ error: 'not found' });
  if (!OPENAI_API_KEY) return res.status(501).json({ error: 'OPENAI_API_KEY not configured' });
  if (!req.file) return res.status(400).json({ error: 'image required' });

  try {
    const extracted = await extractWineFromImage(req.file);
    await touch(c);
    res.json(extracted);
  } catch (err) {
    console.error('label extraction failed:', err);
    res.status(502).json({ error: 'label extraction failed' });
  }
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

  res.json({ ok: true });
});

// POST /api/session/:code/rate — submit a rating
app.post('/api/session/:code/rate', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const { userName, wineId, score, flavors, notes } = req.body;
  if (!userName || !wineId) return res.status(400).json({ error: 'userName and wineId required' });

  await redis.set(k.rating(c, userName, wineId), JSON.stringify({
    score: score || 0,
    flavors: flavors || {},
    notes: notes || '',
    at: Date.now(),
  }), { EX: TTL });

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
