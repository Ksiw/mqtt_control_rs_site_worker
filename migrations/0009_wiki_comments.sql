CREATE TABLE IF NOT EXISTS wiki_comments (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_comments_article_time
  ON wiki_comments(article_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_wiki_comments_user_time
  ON wiki_comments(user_id, created_at);
