import { Context, Hono } from 'hono';
import { Env } from './types';
import { getCurrentUser } from './core/session';

export const wikiRouter = new Hono<{ Bindings: Env }>();
type WikiContext = Context<{ Bindings: Env }>;
type WikiComment = { id: string; article_id: string; user_id: string; name: string | null; body: string; created_at: number };

function sameOrigin(c: WikiContext): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(c.req.url).origin;
  } catch { return false; }
}

function validArticleId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}

wikiRouter.get('/session', async (c) => {
  const user = await getCurrentUser(c);
  return user
    ? c.json({ signedIn: true, name: user.name })
    : c.json({ signedIn: false, name: null });
});

wikiRouter.get('/articles/:articleId/comments', async (c) => {
  const articleId = c.req.param('articleId');
  if (!validArticleId(articleId)) return c.json({ error: 'Некорректная статья.' }, 400);
  const { results } = await c.env.DB.prepare(`
    SELECT c.id, c.article_id, c.user_id, u.name, c.body, c.created_at
    FROM wiki_comments c JOIN users u ON u.id = c.user_id
    WHERE c.article_id = ? ORDER BY c.created_at, c.id LIMIT 200
  `).bind(articleId).all<WikiComment>();
  const user = await getCurrentUser(c);
  const comments = (results || []).map((comment) => ({
    id: comment.id,
    article_id: comment.article_id,
    name: comment.name,
    body: comment.body,
    created_at: comment.created_at,
    canDelete: Boolean(user && comment.user_id === user.id),
  }));
  return c.json({ comments, signedIn: Boolean(user) }, 200, { 'Cache-Control': 'no-store' });
});

wikiRouter.post('/articles/:articleId/comments', async (c) => {
  if (!sameOrigin(c)) return c.json({ error: 'Запрос отклонён: проверьте источник.' }, 403);
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: 'Войдите через Google, чтобы оставить комментарий.' }, 401);
  const articleId = c.req.param('articleId');
  if (!validArticleId(articleId)) return c.json({ error: 'Некорректная статья.' }, 400);
  let body = '';
  try {
    const payload = await c.req.json<{ body?: unknown }>();
    if (typeof payload.body === 'string') body = payload.body.trim();
  } catch { return c.json({ error: 'Не удалось прочитать комментарий.' }, 400); }
  if (!body || body.length > 5000) return c.json({ error: 'Комментарий должен содержать от 1 до 5 000 символов.' }, 400);
  const since = Math.floor(Date.now() / 1000) - 60;
  const recent = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM wiki_comments WHERE user_id = ? AND created_at >= ?')
    .bind(user.id, since).first<{ count: number }>();
  if ((recent?.count || 0) >= 3) return c.json({ error: 'Можно отправить не больше трёх комментариев в минуту.' }, 429);
  const id = `wcom_${crypto.randomUUID().replace(/-/g, '')}`;
  const createdAt = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare('INSERT INTO wiki_comments (id, article_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, articleId, user.id, body, createdAt).run();
  return c.json({ comment: { id, article_id: articleId, name: user.name, body, created_at: createdAt } }, 201);
});

wikiRouter.delete('/articles/:articleId/comments/:commentId', async (c) => {
  if (!sameOrigin(c)) return c.json({ error: 'Запрос отклонён: проверьте источник.' }, 403);
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: 'Войдите через Google.' }, 401);
  const articleId = c.req.param('articleId');
  const commentId = c.req.param('commentId');
  if (!validArticleId(articleId)) return c.json({ error: 'Некорректная статья.' }, 400);
  const result = await c.env.DB.prepare('DELETE FROM wiki_comments WHERE id = ? AND article_id = ? AND user_id = ?')
    .bind(commentId, articleId, user.id).run();
  if (!result.meta.changes) return c.json({ error: 'Комментарий не найден или принадлежит другому пользователю.' }, 404);
  return c.json({ ok: true });
});
