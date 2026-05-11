# Community Rankings — Hall of Fame v2

## Problem with the current HoF

The existing `hall_of_fame` table is a binary log of 5-star events. It answers "who gave a perfect score to what" — not "which wines are actually the best." A wine rated 4.8★ by 12 people across 5 sessions is far more valuable information than a wine rated 5★ once by one person.

---

## What this builds

A **global community ranking** of wines derived from the `ratings` table. Not personal (your best wines), not session-scoped — across all users and all sessions on the platform.

### Qualification rules

A wine must have:
- **≥ 3 total ratings** (score > 0)
- **≥ 2 distinct sessions** it appeared in

This prevents a single group of friends gaming the list. Both conditions must hold simultaneously.

### Matching logic

Wines are matched across sessions by **normalised name** (`LOWER(TRIM(name))`). The same bottle tasted in two different sessions appears as one entry in the rankings. Producer and vintage are taken from the most common values in the matching group.

### Ranking

- Primary sort: **average score** (descending)
- Tiebreak: **rating count** (more data = more confidence)
- No Bayesian weighting for now — straightforward average. Revisit if spam emerges.

### Filters

- **Type:** All · Red · White · Sparkling · Rosé · Non-alc
- **Period:** All-time only (weekly/monthly withheld until data volume justifies it)

### Confidence display

Every entry shows sample size honestly:
`4.7★ · 8 ratings · 3 sessions`

No hiding thin data behind big numbers.

---

## What stays from the old HoF

The "Perfect 5s" wall (from the `hall_of_fame` table) remains as a secondary section below the rankings. It serves a different emotional purpose: exceptional moments, not statistical best. The two coexist on the same page.

---

## API

`GET /api/hof/rankings?type=all`

Returns top 50 qualifying wines with: normalised name, display name, producer, vintage, style, image_url, avg_score, rating_count, session_count, user_count.

No auth required. Fully public.

---

## Out of scope (for now)

- Time-period filters (need more data)
- Bayesian ranking (overkill at current scale)  
- Wine identity deduplication beyond name normalisation (too complex, marginal gain)
- Personal "your top wines" list (separate feature)
- Minimum unique-user threshold (session_count ≥ 2 is the proxy for now)
