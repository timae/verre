# Social Feed — Implementation Plan (v2)

## Context

Verre already has the social graph implicitly — users who share tasting sessions know each other. This feature makes that graph explicit: standalone wine check-ins (log a bottle anywhere, with location), a feed of activity from people you follow or have tasted with, and public profile pages. Feed is accounts-only and fully optional.

---

## Database Schema

### New tables

```sql
-- Explicit social graph
CREATE TABLE follows (
  follower_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);
CREATE INDEX ON follows (following_id);

-- Standalone wine check-ins with location
CREATE TABLE checkins (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wine_name   VARCHAR(255) NOT NULL,
  producer    VARCHAR(255),
  vintage     CHAR(4),
  grape       VARCHAR(255),
  type        VARCHAR(16),
  score       SMALLINT CHECK (score BETWEEN 0 AND 5),
  flavors     JSONB NOT NULL DEFAULT '{}',
  notes       TEXT,
  image_url   TEXT,
  -- Location fields
  venue_name  VARCHAR(255),          -- "Cave de la Tour", "Bar Centrale"
  city        VARCHAR(100),          -- "Zurich", "Basel"
  country     CHAR(2),               -- ISO 3166-1 alpha-2
  lat         NUMERIC(9,6),          -- optional coordinates
  lng         NUMERIC(9,6),
  -- Visibility
  is_public   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON checkins (user_id, created_at DESC);
CREATE INDEX ON checkins (city) WHERE city IS NOT NULL;

-- Simple heart reactions on check-ins
CREATE TABLE checkin_likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, checkin_id)
);
```

Migration already written: `prisma/migrations/20260504120000_add_social_feed/migration.sql`  
*(needs updating to include venue/location columns and checkin_likes)*

---

## Feed Item Types

Two types only — sessions are too noisy:

| Type | Source | Trigger |
|---|---|---|
| `checkin` | `checkins` table | User you follow posts a public check-in |
| `badge` | `user_badges` table | User you follow earns a badge (last 30 days) |

Each item: author (id, name), timestamp, type, payload.

### Feed query (cursor-based pagination)

```sql
WITH my_network AS (
  -- Explicit follows
  SELECT following_id AS user_id FROM follows WHERE follower_id = $me
  UNION
  -- Implicit tasting buddies (shared session)
  SELECT sm2.user_id
  FROM session_members sm1
  JOIN session_members sm2 ON sm2.session_code = sm1.session_code
  WHERE sm1.user_id = $me AND sm2.user_id <> $me
),
feed_checkins AS (
  SELECT 'checkin' AS type, c.created_at, c.user_id, c.id::text AS item_id,
         c.wine_name, c.producer, c.vintage, c.score, c.notes,
         c.venue_name, c.city, c.country, c.image_url,
         u.name AS author_name
  FROM checkins c
  JOIN my_network n ON n.user_id = c.user_id
  JOIN users u ON u.id = c.user_id
  WHERE c.is_public = true AND c.created_at < $cursor
),
feed_badges AS (
  SELECT 'badge' AS type, ub.earned_at AS created_at, ub.user_id, ub.badge_id AS item_id,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         u.name AS author_name
  FROM user_badges ub
  JOIN my_network n ON n.user_id = ub.user_id
  JOIN users u ON u.id = ub.user_id
  WHERE ub.earned_at > NOW() - INTERVAL '30 days'
    AND ub.earned_at < $cursor
)
SELECT * FROM feed_checkins
UNION ALL SELECT * FROM feed_badges
ORDER BY created_at DESC
LIMIT 20
```

Cursor = ISO timestamp of last seen item. First page: `$cursor = NOW()`.

---

## API Routes

```
POST   /api/checkins               Create check-in (auth, 20/hour rate limit)
DELETE /api/checkins/[id]          Delete own check-in
POST   /api/checkins/[id]/like     Like a check-in (auth)
DELETE /api/checkins/[id]/like     Unlike

GET    /api/feed?cursor=           Paginated feed (auth)

POST   /api/users/[id]/follow      Follow (auth, 60/hour rate limit)
DELETE /api/users/[id]/follow      Unfollow (auth)
GET    /api/users/[id]             Public profile — works by numeric ID
GET    /api/users/[id]/checkins    Public check-ins for a user
GET    /api/users/search?q=        Name search (NFKC-normalised, lib/displayName.ts)
```

**Note on profile URLs:** Use `/u/[id]` (numeric) not `/u/[name]` — names can change. Show name as the heading.

---

## Check-in Modal — UX

Reuses the rating screen components. Fields:

1. **Wine** — name (required), producer, vintage, grape, type chips
2. **Photo** — camera/gallery, resize client-side
3. **Score** — 1–5 stars
4. **Flavour sliders** — type-specific FL (red/white/spark/rosé)
5. **Notes** — free text
6. **Location** (optional collapsible section):
   - Venue name (free text, e.g. "Bärengasse 4" or "Cave de la Tour")
   - City (free text)
   - Country (dropdown or text)
   - "Use my location" button → `navigator.geolocation` → reverse geocode city via free Nominatim API or just store coords
7. **Visibility** — public / private toggle (default: public)

---

## Pages & Components

```
app/
  me/feed/page.tsx                    Feed (auth required, redirect to /login)
  u/[id]/page.tsx                     Public profile (no auth needed)
  api/
    checkins/route.ts                 POST create, rate-limited
    checkins/[id]/route.ts            DELETE (owner only)
    checkins/[id]/like/route.ts       POST like, DELETE unlike
    feed/route.ts                     GET cursor-paginated feed
    users/[id]/route.ts               GET public profile + stats
    users/[id]/follow/route.ts        POST/DELETE follow
    users/[id]/checkins/route.ts      GET public check-ins
    users/search/route.ts             GET search (NFKC match)

components/
  social/
    FeedClient.tsx          Feed list, loads more on scroll
    FeedItem.tsx            Renders checkin or badge card
    CheckinModal.tsx        Full check-in form with location
    CheckinCard.tsx         Reusable display card (used in feed + profile)
    LocationPicker.tsx      Venue/city/country + optional geolocation
    ProfileHeader.tsx       Avatar initial, level bar, stats, follow button
    FollowButton.tsx        Follow/unfollow with optimistic UI + rate limit
    LikeButton.tsx          ❤️ reaction with count, optimistic
```

---

## Nav

- `🌐 Feed` added to sidebar (between History and Saved) and mobile bottom nav
- Notification dot on Feed item when there are unread items (tracked client-side in localStorage, reset on page visit)

---

## Privacy Model

- Check-ins: public by default, private means only author sees them
- Following/follower counts visible on public profiles
- Badge events in feed: user can opt out in profile settings (existing `DashboardSettings`)
- Location is always optional — venue/city stored only if user explicitly fills it in

---

## Rate Limits (via lib/rateLimit.ts)

| Action | Limit |
|---|---|
| Create check-in | 20/hour per user |
| Follow/unfollow | 60/hour per user |
| Like/unlike | 120/hour per user |
| User search | 30/min per IP |

---

## Rollout Order

1. **DB migration** — apply updated SQL (adds location + checkin_likes)
2. **Follow API** — POST/DELETE + GET profile endpoint
3. **Check-in API** — POST create + DELETE
4. **Like API** — POST/DELETE
5. **Feed API** — cursor-paginated query
6. **Search API** — NFKC-normalised name search
7. **CheckinModal** — full form with location picker
8. **FeedClient + FeedItem** — feed page
9. **Public profile** `/u/[id]`
10. **Follow button** — in SessionPanel participant list + feed items + profile
11. **LikeButton** — on CheckinCard
12. **Nav** — Feed item in sidebar + mobile nav

---

## Verification

- Post check-in with venue "Cave de la Tour, Zurich" → appears in followers' feeds with location
- Set to private → not visible in feed or on profile to others
- Follow from session panel → their check-ins appear in feed within next load
- Like a check-in → count increments optimistically, persists on refresh
- `/u/42` accessible without login
- Search "sim" → finds "Simon" (NFKC match, case-insensitive)
- Rate limit: posting 21 check-ins in an hour → 429 with humanised wait message
