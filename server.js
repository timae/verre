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

function normalizeWineText(raw) {
  return String(raw || '')
    .replace(/[|]/g, 'I')
    .replace(/[{}[\]()<>]/g, ' ')
    .replace(/[•·]/g, ' ')
    .replace(/[_~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreWineLine(line) {
  const clean = normalizeWineText(line);
  if (!clean) return -1;
  const letters = (clean.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  const digits = (clean.match(/\d/g) || []).length;
  const junk = (clean.match(/[^A-Za-zÀ-ÿ0-9 '&.-]/g) || []).length;
  const lengthScore = Math.max(0, 22 - Math.abs(clean.length - 18));
  return letters * 2 - digits * 2 - junk * 4 + lengthScore;
}

function parseWineText(rawLines) {
  const lines = rawLines
    .map(line => normalizeWineText(line))
    .filter(Boolean);
  const text = lines.join(' ');
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  const upper = text.toUpperCase();
  const skip = /^(WINE|VIN|PRODUCE OF|PRODUCT OF|CONTAINS|ALC|VOL|750ML|75CL|ESTATE BOTTLED)$/i;
  const filtered = lines
    .filter(line => line.length > 2 && line.length < 50 && !skip.test(line))
    .filter(line => {
      const letters = (line.match(/[A-Za-zÀ-ÿ]/g) || []).length;
      const junk = (line.match(/[^A-Za-zÀ-ÿ0-9 '&.-]/g) || []).length;
      return letters >= 2 && junk <= Math.max(2, Math.floor(line.length * 0.12));
    });

  const titleLines = filtered
    .filter(line => !/^\d+$/.test(line) && !/\b(19|20)\d{2}\b/.test(line))
    .sort((a, b) => scoreWineLine(b) - scoreWineLine(a))
    .slice(0, 3)
    .sort((a, b) => lines.indexOf(a) - lines.indexOf(b));

  const name = titleLines.length
    ? titleLines.join(' ').replace(/\s{2,}/g, ' ').trim()
    : (filtered[0] || '');
  const producer = filtered.find(line =>
    line !== name && !name.includes(line) && !/\b(19|20)\d{2}\b/.test(line) && line.length > 4
  ) || '';

  const grapeKeywords = ['PINOT NOIR', 'CHARDONNAY', 'RIESLING', 'MERLOT', 'CABERNET', 'SYRAH', 'SHIRAZ', 'SAUVIGNON', 'MALBEC', 'TEMPRANILLO', 'CHENIN', 'GAMAY', 'NEBBIOLO', 'SANGIOVESE', 'PET-NAT', 'PET NAT', 'CUVEE', 'BRUT', 'ROSE'];
  const grape = grapeKeywords.find(k => upper.includes(k)) || '';

  let type = 'unknown';
  if (/\bROSE\b|\bROSÉ\b/.test(upper)) type = 'rose';
  else if (/\bBRUT\b|\bCHAMPAGNE\b|\bSPARKLING\b|\bCREMANT\b|\bCAVA\b|\bPROSECCO\b|\bPET NAT\b|\bPET-NAT\b/.test(upper)) type = 'spark';
  else if (/\bBLANC\b|\bBIANCO\b|\bWHITE\b|\bCHARDONNAY\b|\bRIESLING\b|\bSAUVIGNON BLANC\b|\bCHENIN\b/.test(upper)) type = 'white';
  else if (/\bRED\b|\bROUGE\b|\bROSSO\b|\bPINOT NOIR\b|\bMERLOT\b|\bCABERNET\b|\bMALBEC\b|\bSYRAH\b|\bSHIRAZ\b|\bTEMPRANILLO\b|\bSANGIOVESE\b|\bNEBBIOLO\b/.test(upper)) type = 'red';

  return {
    name,
    producer,
    vintage: yearMatch ? yearMatch[0] : '',
    grape,
    type,
    notes: filtered.slice(0, 6).join(' • '),
  };
}

function sanitizeImageDataUrl(value) {
  if (!value || typeof value !== 'string') return '';
  if (!value.startsWith('data:image/')) return '';
  // Keep payloads bounded since images live in Redis with the wine record.
  if (value.length > 1_500_000) return '';
  return value;
}

function extractResponseJson(payload) {
  if (payload?.output_parsed && typeof payload.output_parsed === 'object') return payload.output_parsed;
  const chunks = [];
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) chunks.push(payload.output_text.trim());
  for (const item of payload?.output || []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (typeof part?.text === 'string' && part.text.trim()) chunks.push(part.text.trim());
    }
  }
  for (const chunk of chunks) {
    try {
      return JSON.parse(chunk);
    } catch (_) {}
  }
  throw new Error('could not parse model output');
}

async function runOpenAiWineScan({ apiKey, image }) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                'Read this wine bottle label and extract the visible bottle information.',
                'Return JSON only.',
                'If a field is unclear, use an empty string.',
                'Use type only from: red, white, spark, rose, nonalc, unknown.',
                'Put short visible fragments into lines and a brief summary into notes.',
              ].join(' '),
            },
            {
              type: 'input_image',
              image_url: image,
              detail: 'high',
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'wine_label',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              producer: { type: 'string' },
              vintage: { type: 'string' },
              grape: { type: 'string' },
              type: {
                type: 'string',
                enum: ['red', 'white', 'spark', 'rose', 'nonalc', 'unknown'],
              },
              notes: { type: 'string' },
              lines: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['name', 'producer', 'vintage', 'grape', 'type', 'notes', 'lines'],
          },
        },
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || 'OpenAI request failed';
    const err = new Error(String(message));
    err.status = response.status;
    throw err;
  }

  const parsed = extractResponseJson(payload);
  const rawLines = Array.isArray(parsed.lines) ? parsed.lines.map(line => String(line || '')).filter(Boolean) : [];
  return {
    ...parseWineText(rawLines),
    ...parsed,
    lines: rawLines,
  };
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

// POST /api/session/:code/wines/extract-label — extract bottle info via OpenAI using the caller's API key
app.post('/api/session/:code/wines/extract-label', async (req, res) => {
  const c = req.params.code.toUpperCase();
  const meta = await redis.get(k.meta(c));
  if (!meta) return res.status(404).json({ error: 'not found' });
  const image = sanitizeImageDataUrl(req.body.image);
  const apiKey = String(req.body.apiKey || '').trim();
  if (!image) return res.status(400).json({ error: 'image required' });
  if (!apiKey) return res.status(400).json({ error: 'api key required' });

  try {
    const extracted = await runOpenAiWineScan({ apiKey, image });
    await touch(c);
    res.json(extracted);
  } catch (err) {
    console.error('label extraction failed:', err);
    const status = err?.status === 401 ? 401 : err?.status === 429 ? 429 : 502;
    res.status(status).json({ error: String(err?.message || 'label extraction failed') });
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

  await touch(c);
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
