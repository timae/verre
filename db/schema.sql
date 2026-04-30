-- Verre persistent schema
-- Run once against Nine Eco PostgreSQL:
--   psql --host $FQDN --dbname $USER --username $USER -f db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(64)  NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(16)  NOT NULL DEFAULT 'taster', -- 'taster' | 'vendor' | 'admin'
  pro           BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           SERIAL PRIMARY KEY,
  code         CHAR(4)      NOT NULL UNIQUE,
  host_user_id INTEGER      REFERENCES users(id),
  host_name    VARCHAR(64)  NOT NULL,
  name         VARCHAR(255),
  blind        BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ  NOT NULL,
  archived_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wines (
  id           VARCHAR(20)  PRIMARY KEY,
  session_id   INTEGER      NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  producer     VARCHAR(255),
  vintage      CHAR(4),
  grape        VARCHAR(255),
  category     VARCHAR(32)  NOT NULL DEFAULT 'wine',
  style        VARCHAR(64),
  image_url    TEXT,
  purchase_url TEXT,
  revealed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ratings (
  id          SERIAL PRIMARY KEY,
  wine_id     VARCHAR(20)  NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
  user_id     INTEGER      REFERENCES users(id),
  rater_name  VARCHAR(64)  NOT NULL,
  is_host     BOOLEAN      NOT NULL DEFAULT FALSE,
  score       SMALLINT     NOT NULL CHECK (score BETWEEN 0 AND 5),
  flavors     JSONB        NOT NULL DEFAULT '{}',
  notes       TEXT,
  rated_at    TIMESTAMPTZ  NOT NULL,
  UNIQUE (wine_id, user_id),
  UNIQUE (wine_id, rater_name)
);

CREATE TABLE IF NOT EXISTS session_members (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_code CHAR(4) NOT NULL,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, session_code)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id       SERIAL PRIMARY KEY,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wine_id  VARCHAR(20) NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, wine_id)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS address     VARCHAR(255);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS date_from   TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS date_to     TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS timezone    VARCHAR(64);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS link        VARCHAR(512);

CREATE TABLE IF NOT EXISTS badges (
  id          VARCHAR(60)  PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(255) NOT NULL,
  icon        VARCHAR(10)  NOT NULL,
  category    VARCHAR(30)  NOT NULL,
  rarity      VARCHAR(20)  NOT NULL DEFAULT 'common',
  xp_reward   INTEGER      NOT NULL DEFAULT 50
);

CREATE TABLE IF NOT EXISTS user_badges (
  id         SERIAL       PRIMARY KEY,
  user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id   VARCHAR(60)  NOT NULL REFERENCES badges(id),
  earned_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  seen       BOOLEAN      NOT NULL DEFAULT FALSE,
  UNIQUE (user_id, badge_id)
);

CREATE TABLE IF NOT EXISTS hall_of_fame (
  id           SERIAL PRIMARY KEY,
  wine_name    VARCHAR(255) NOT NULL,
  producer     VARCHAR(255),
  vintage      CHAR(4),
  category     VARCHAR(32)  NOT NULL DEFAULT 'wine',
  style        VARCHAR(64),
  score        SMALLINT     NOT NULL,
  rater_name   VARCHAR(64)  NOT NULL,
  user_id      INTEGER      REFERENCES users(id),
  session_code CHAR(4),
  rated_at     TIMESTAMPTZ  NOT NULL,
  UNIQUE (wine_name, rater_name)
);
