const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/me/sessions — all sessions the user has visited
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at,
              COUNT(DISTINCT r.id) AS wines_rated,
              ROUND(AVG(r.score), 1) AS avg_score
       FROM session_members sm
       JOIN sessions s ON s.code = sm.session_code
       LEFT JOIN wines w ON w.session_id = s.id
       LEFT JOIN ratings r ON r.wine_id = w.id AND r.user_id = $1
       WHERE sm.user_id = $1
       GROUP BY s.id, s.code, s.host_name, s.created_at, sm.joined_at
       ORDER BY sm.joined_at DESC
       LIMIT 50`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('me/sessions error:', err);
    res.status(500).json({ error: 'failed to fetch sessions' });
  }
});

// GET /api/me/ratings — all ratings across all sessions
router.get('/ratings', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.score, r.flavors, r.notes, r.rated_at,
              w.name AS wine_name, w.producer, w.vintage, w.style, w.category, w.image_url,
              s.code AS session_code, s.created_at AS session_date
       FROM ratings r
       JOIN wines w ON w.id = r.wine_id
       JOIN sessions s ON s.id = w.session_id
       WHERE r.user_id = $1
       ORDER BY r.rated_at DESC
       LIMIT 200`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('me/ratings error:', err);
    res.status(500).json({ error: 'failed to fetch ratings' });
  }
});

// GET /api/me/bookmarks — all saved wines
router.get('/bookmarks', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.saved_at, w.id AS wine_id, w.name, w.producer, w.vintage,
              w.style, w.category, w.image_url, w.purchase_url,
              s.code AS session_code
       FROM bookmarks b
       JOIN wines w ON w.id = b.wine_id
       JOIN sessions s ON s.id = w.session_id
       WHERE b.user_id = $1
       ORDER BY b.saved_at DESC`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('me/bookmarks error:', err);
    res.status(500).json({ error: 'failed to fetch bookmarks' });
  }
});

// GET /api/me/profile — aggregated flavour profile across all ratings
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const fl = ['floral','citrus','stone','tropical','herbal','oak','body','tannin','acid','sweet'];
    const weightedAvg = fl.map(f =>
      `ROUND((SUM((flavors->>'${f}')::numeric * score) / NULLIF(SUM(CASE WHEN (flavors->>'${f}')::numeric > 0 THEN score ELSE 0 END), 0))::numeric, 2) AS ${f}`
    ).join(', ');
    const { rows } = await pool.query(
      `SELECT ${weightedAvg},
              COUNT(*)                          AS total_rated,
              ROUND(AVG(score)::numeric, 1)     AS avg_score,
              COUNT(CASE WHEN score = 5 THEN 1 END) AS five_star
       FROM ratings
       WHERE user_id = $1 AND score > 0`,
      [req.user.userId]
    );
    res.json(rows[0] || {});
  } catch (err) {
    console.error('me/profile error:', err);
    res.status(500).json({ error: 'failed to fetch profile' });
  }
});

module.exports = router;
