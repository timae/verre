# Social Feed — Implementation Plan

## Context

Verre already has the social graph implicitly — users who share tasting sessions know each other. This feature makes that graph explicit and adds a public social layer: standalone wine check-ins (log a bottle outside a session), a feed of activity from people you follow or have tasted with, and public profile pages. The feed is accounts-only and fully optional — users can keep everything private.

---

## New Database Tables

```sql
-- Who follows whom
CREATE TABLE follows (
  follower_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

-- Standalone wine check-ins (no session required)
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
  is_public   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON follows (following_id);
CREATE INDEX ON checkins (user_id, created_at DESC);
```

---

## Feed Item Types

The feed aggregates three sources into one chronological stream:

| Type | Source | Shown when |
|---|---|---|
| `checkin` | `checkins` table | User you follow posts a check-in |
| `badge` | `user_badges` table | User you follow earns a badge |
| `session` | `session_members` table | User you follow joins/hosts a session |

Each item has: author (name, id), timestamp, type, and type-specific payload.

---

## API Routes

```
POST   /api/checkins                  Create a check-in (auth required)
GET    /api/checkins/[id]             Get single check-in
DELETE /api/checkins/[id]            Delete own check-in
GET    /api/feed                      Paginated social feed (auth required)
POST   /api/users/[id]/follow        Follow a user
DELETE /api/users/[id]/follow        Unfollow a user
GET    /api/users/[id]               Public profile data
GET    /api/users/[id]/checkins      Public check-ins for a user
GET    /api/users/search?q=          Search users by name
```

### Feed query logic

```sql
-- People I should see in my feed:
-- 1. Users I explicitly follow
-- 2. Users I've shared a session with (tasting buddies)

WITH my_network AS (
  SELECT following_id AS user_id FROM follows WHERE follower_id = $me
  UNION
  SELECT sm2.user_id
  FROM session_members sm1
  JOIN session_members sm2 ON sm2.session_code = sm1.session_code
  WHERE sm1.user_id = $me AND sm2.user_id <> $me
),
feed_checkins AS (
  SELECT 'checkin' AS type, c.created_at, c.user_id, c.id AS item_id
  FROM checkins c
  JOIN my_network n ON n.user_id = c.user_id
  WHERE c.is_public = true
),
feed_badges AS (
  SELECT 'badge' AS type, ub.earned_at AS created_at, ub.user_id, ub.badge_id AS item_id
  FROM user_badges ub
  JOIN my_network n ON n.user_id = ub.user_id
  WHERE ub.earned_at > NOW() - INTERVAL '30 days'
),
feed_sessions AS (
  SELECT 'session' AS type, sm.joined_at AS created_at, sm.user_id, sm.session_code AS item_id
  FROM session_members sm
  JOIN my_network n ON n.user_id = sm.user_id
)
SELECT * FROM feed_checkins
UNION ALL SELECT * FROM feed_badges
UNION ALL SELECT * FROM feed_sessions
ORDER BY created_at DESC
LIMIT 50 OFFSET $cursor
```

---

## Pages & Components

### `/me/feed` — Social Feed
- Chronological feed of check-ins, badges, session joins
- "Check in a wine" button at top → opens check-in modal
- Feed item card per type with appropriate visuals
- Empty state: "Follow people or join sessions to see activity here"
- Added to sidebar nav and mobile bottom nav

### `/u/[name]` — Public Profile
- Available to anyone (no auth required to view)
- Shows: display name, level + XP bar, badge count, wines rated, sessions joined
- Recent public check-ins (polar chart + score + notes)
- Follow / Unfollow button (auth required to follow)
- Link from session modal participant list

### Check-in Modal
- Same UX as wine rating detail: photo, stars, type-specific flavour sliders, notes
- Public / private toggle
- Posted as a standalone `checkins` row, not tied to any session

### Follow buttons
- In session modal: next to each participant name (if you don't already follow them)
- On `/u/[name]` profile page header
- In feed items next to author name

---

## Components to Build

```
app/
  me/feed/page.tsx                  Feed page (auth required)
  u/[name]/page.tsx                 Public profile (no auth required)
  api/
    checkins/route.ts               POST create, GET list
    checkins/[id]/route.ts          GET single, DELETE
    feed/route.ts                   GET paginated feed
    users/[id]/route.ts             GET public profile
    users/[id]/follow/route.ts      POST follow, DELETE unfollow
    users/[id]/checkins/route.ts    GET public check-ins
    users/search/route.ts           GET search

components/
  social/
    FeedClient.tsx                  Feed list with polling
    FeedItem.tsx                    Card per item type (checkin/badge/session)
    CheckinModal.tsx                Log a wine standalone
    ProfileHeader.tsx               Public profile header + stats
    FollowButton.tsx                Follow/unfollow with optimistic UI
    CheckinCard.tsx                 Reusable check-in display card
```

---

## Privacy Model

- Check-ins are public by default, can be set private at creation
- Private check-ins only visible to the author
- Following is public (others can see your followers/following count)
- Badge unlocks in the feed can be disabled in profile settings (extends existing `DashboardSettings`)
- Session joins in the feed: only session name shown, not wine details

---

## Rollout Order

1. **DB migration** — `follows` + `checkins` tables
2. **Follow API** — `/api/users/[id]/follow` POST/DELETE + GET profile
3. **Follow button** — add to session modal participant list
4. **Check-in API** — `/api/checkins` POST/GET
5. **Check-in modal** — reuses existing rating screen components
6. **Feed API** — `/api/feed` with the union query
7. **Feed page** — `/me/feed` with feed items
8. **Public profile** — `/u/[name]`
9. **Nav** — add Feed item to sidebar + mobile nav
10. **Badge integration** — badge unlock events appear in feed

---

## Verification

- Follow a user from session modal → their check-ins appear in your feed
- Post a check-in → appears on your public profile and in followers' feeds
- Set check-in to private → not visible in feed or profile to others
- Unfollow → their items disappear from feed on next load
- `/u/[name]` accessible without login, follow button requires auth
- Feed empty state shown when no network activity in last 30 days
