CREATE TABLE IF NOT EXISTS workspace (
 id integer PRIMARY KEY CHECK (id=1), store_id text NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE IF NOT EXISTS sheets (name text PRIMARY KEY, position integer NOT NULL);
CREATE TABLE IF NOT EXISTS topics (
 id text PRIMARY KEY, sheet text NOT NULL REFERENCES sheets(name),
 topic text NOT NULL, service text NOT NULL DEFAULT '', owner text NOT NULL DEFAULT '',
 topic_type text NOT NULL DEFAULT '', priority text NOT NULL DEFAULT '',
 status text NOT NULL CHECK(status IN ('Aktif','Askıda','Kapandı')),
 closing_date text NOT NULL DEFAULT '', current_note text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS weekly_updates (
 topic_id text NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
 id text NOT NULL, date text NOT NULL, note text NOT NULL, position integer NOT NULL,
 PRIMARY KEY(topic_id,id)
);
CREATE TABLE IF NOT EXISTS app_users (
 username text PRIMARY KEY, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, username text NOT NULL REFERENCES app_users(username) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS operations (
 id text PRIMARY KEY, payload_hash text NOT NULL, revision bigint NOT NULL,
 actor text NOT NULL, changed_topics jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS topics_sheet_idx ON topics(sheet);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
