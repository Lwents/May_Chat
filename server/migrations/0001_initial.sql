CREATE TABLE users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
 name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE conversations (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('direct','group')),
 direct_key TEXT UNIQUE, created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE TABLE members (
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, last_read_seq INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(conversation_id,user_id)
);
CREATE INDEX members_user ON members(user_id,conversation_id);
CREATE TABLE attachments (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, mime TEXT NOT NULL,
 size INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 conversation_id TEXT NOT NULL REFERENCES conversations(id), sender_id TEXT NOT NULL REFERENCES users(id),
 client_message_id TEXT NOT NULL, body TEXT NOT NULL,
 attachment_id TEXT REFERENCES attachments(id), created_at INTEGER NOT NULL,
 UNIQUE(sender_id,client_message_id)
);
CREATE INDEX messages_conversation_seq ON messages(conversation_id,seq);
CREATE TABLE calls (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 started_by TEXT NOT NULL REFERENCES users(id), mode TEXT NOT NULL CHECK(mode IN ('audio','video')),
 status TEXT NOT NULL CHECK(status IN ('ringing','active','ended')),
 created_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE UNIQUE INDEX calls_one_active ON calls(conversation_id) WHERE status != 'ended';
CREATE TABLE call_members (
 call_id TEXT NOT NULL REFERENCES calls(id), user_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN ('invited','joined','left')), PRIMARY KEY(call_id,user_id)
);
