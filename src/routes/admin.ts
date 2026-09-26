import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { statSync } from 'node:fs';
import type { AppContext } from '../appContext.js';
import { StatsRepo } from '../storage/statsRepo.js';
import { MODELS } from '../translate/openaiToAnthropic/modelMetadata.js';
import { renderDashboardShell } from './adminDashboard.js';

const PROCESS_STARTED_AT = Date.now();

/**
 * /admin/*: login flow, dashboard SPA and its JSON API (/admin/api/*).
 * Auth: bearer header OR cookie set by /admin/login. If `ADMIN_TOKEN` is
 * unset, every /admin/* endpoint returns 404.
 */
export function adminRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/admin/login', (c) => {
    const expected = ctx.env.ADMIN_TOKEN;
    if (!expected || expected.length < 16) {
      return c.json({ error: { message: 'not_found' } }, 404);
    }
    const provided = c.req.query('token');
    if (typeof provided === 'string' && provided.length > 0) {
      if (!constantTimeEq(provided, expected)) {
        return c.html(renderLoginPage('Invalid token.'), 401);
      }
      return loginSuccess(c, expected);
    }
    return c.html(renderLoginPage(null), 200);
  });

  app.post('/admin/login', async (c) => {
    const expected = ctx.env.ADMIN_TOKEN;
    if (!expected || expected.length < 16) {
      return c.json({ error: { message: 'not_found' } }, 404);
    }
    let token = '';
    try {
      const ct = c.req.header('content-type') ?? '';
      if (ct.includes('application/x-www-form-urlencoded')) {
        const body = await c.req.parseBody();
        token = typeof body.token === 'string' ? body.token : '';
      } else if (ct.includes('application/json')) {
        const body = (await c.req.json()) as { token?: string };
        token = body.token ?? '';
      }
    } catch {
    }
    if (!constantTimeEq(token, expected)) {
      return c.html(renderLoginPage('Invalid token.'), 401);
    }
    return loginSuccess(c, expected);
  });

  app.get('/admin/logout', (c) => {
    c.header(
      'set-cookie',
      'admin_session=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    );
    return c.html(
      '<!doctype html><html><body style="font-family:system-ui;background:#0a1120;color:#e5e7eb;padding:2rem;text-align:center"><p>Logged out. <a href="/admin/login" style="color:#93c5fd">Sign in again</a>.</p></body></html>',
    );
  });

  // Everything registered below requires admin auth.
  app.use('/admin/*', adminAuth(ctx.env.ADMIN_TOKEN));

  app.get('/admin/dashboard', (c) => c.html(renderDashboardShell()));

  app.get('/admin/api/system', (c) => {
    let dbSize = 0;
    try {
      dbSize = statSync(ctx.env.DATABASE_PATH).size;
    } catch {
      // File may not exist on a fresh boot.
    }
    const memUsage = process.memoryUsage();
    const uptimeMs = Date.now() - PROCESS_STARTED_AT;
    let migrations: string[] = [];
    try {
      migrations = ctx.db
        .prepare<[], { name: string }>('SELECT name FROM _migrations ORDER BY name')
        .all()
        .map((r) => r.name);
    } catch {
      // _migrations table may not exist on older DBs
    }
    return c.json({
      version: ctx.env.GATEWAY_VERSION,
      nodeVersion: process.versions.node,
      pid: process.pid,
      hostname: os.hostname(),
      platform: `${process.platform} ${process.arch}`,
      uptimeMs,
      uptimeHuman: humanDuration(uptimeMs),
      memoryRss: memUsage.rss,
      memoryHuman: humanBytes(memUsage.rss),
      dbPath: ctx.env.DATABASE_PATH,
      dbSize,
      dbSizeHuman: humanBytes(dbSize),
      migrations,
    });
  });

  app.get('/admin/api/stats', (c) => {
    const range = Number(c.req.query('rangeHours') ?? '24');
    const sinceMs = Date.now() - Math.max(1, Math.min(24 * 90, range)) * 60 * 60 * 1000;
    const repo = new StatsRepo(ctx.db);
    return c.json({
      rangeHours: range,
      overall: repo.overall(sinceMs),
      latencyByModel: repo.latencyByModel(sinceMs),
      perKey: repo.perKey(sinceMs),
    });
  });

  app.get('/admin/api/oauth-status', async (c) => c.json(await ctx.tokenManager.getStatus()));

  app.get('/admin/api/keys', (c) => {
    const rows = ctx.apiKeys.list().map((r) => ({
      id: r.id,
      name: r.name,
      keyPrefix: r.keyPrefix,
      rateLimitRpm: r.rateLimitRpm,
      rateLimitTpm: r.rateLimitTpm,
      dailyTokenBudget: r.dailyTokenBudget,
      enabled: r.enabled,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
      expiresAt: r.expiresAt,
    }));
    return c.json({ data: rows });
  });

  app.post('/admin/api/keys', async (c) => {
    let body: {
      name?: string;
      rateLimitRpm?: number;
      rateLimitTpm?: number;
      dailyTokenBudget?: number | null;
      expiresInDays?: number | null;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: { message: 'invalid JSON', type: 'invalid_request_error' } }, 400);
    }
    const name = (body.name ?? '').trim();
    if (!name || name.length > 64 || !/^[\w.\- ]+$/.test(name)) {
      return c.json(
        {
          error: {
            message: 'name is required (1-64 characters: letters, digits, _ - . and spaces)',
            type: 'invalid_request_error',
          },
        },
        400,
      );
    }
    if (ctx.apiKeys.list().some((k) => k.name === name && !k.revokedAt)) {
      return c.json(
        { error: { message: `An active key named "${name}" already exists`, type: 'conflict' } },
        409,
      );
    }

    const expiresAt =
      body.expiresInDays && body.expiresInDays > 0
        ? Date.now() + Math.floor(body.expiresInDays) * 24 * 60 * 60 * 1000
        : null;

    const opts: Parameters<typeof ctx.apiKeys.create>[0] = {
      name,
      ...(typeof body.rateLimitRpm === 'number' ? { rateLimitRpm: body.rateLimitRpm } : {}),
      ...(typeof body.rateLimitTpm === 'number' ? { rateLimitTpm: body.rateLimitTpm } : {}),
      ...(typeof body.dailyTokenBudget === 'number' || body.dailyTokenBudget === null
        ? { dailyTokenBudget: body.dailyTokenBudget }
        : {}),
      ...(expiresAt !== null ? { expiresAt } : {}),
    };

    const result = await ctx.apiKeys.create(opts);
    return c.json(
      {
        plaintext: result.plaintext,
        row: {
          id: result.row.id,
          name: result.row.name,
          keyPrefix: result.row.keyPrefix,
          rateLimitRpm: result.row.rateLimitRpm,
          rateLimitTpm: result.row.rateLimitTpm,
          dailyTokenBudget: result.row.dailyTokenBudget,
          createdAt: result.row.createdAt,
          expiresAt: result.row.expiresAt,
        },
      },
      201,
    );
  });

  app.post('/admin/api/keys/:id/revoke', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || id <= 0) {
      return c.json(
        { error: { message: 'invalid id', type: 'invalid_request_error' } },
        400,
      );
    }
    const ok = ctx.apiKeys.revokeById(id);
    if (!ok) {
      return c.json(
        { error: { message: 'key not found, or already revoked', type: 'not_found' } },
        404,
      );
    }
    return c.json({ ok: true });
  });

  // PATCH /admin/api/keys/:id — edits the limits of an existing key.
  // Body: { rateLimitRpm?, rateLimitTpm?, dailyTokenBudget?, expiresInDays? }
  // Absent fields are left alone; `null` (for dailyTokenBudget) drops the
  // quota. `expiresInDays = 0` drops the expiry, making the key perpetual.
  app.patch('/admin/api/keys/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || id <= 0) {
      return c.json(
        { error: { message: 'invalid id', type: 'invalid_request_error' } },
        400,
      );
    }
    let body: {
      rateLimitRpm?: number;
      rateLimitTpm?: number;
      dailyTokenBudget?: number | null;
      expiresInDays?: number | null;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: { message: 'invalid JSON', type: 'invalid_request_error' } }, 400);
    }

    const updates: Parameters<typeof ctx.apiKeys.updateById>[1] = {};
    if (typeof body.rateLimitRpm === 'number' && body.rateLimitRpm > 0) {
      updates.rateLimitRpm = body.rateLimitRpm;
    }
    if (typeof body.rateLimitTpm === 'number' && body.rateLimitTpm > 0) {
      updates.rateLimitTpm = body.rateLimitTpm;
    }
    if (body.dailyTokenBudget !== undefined) {
      updates.dailyTokenBudget = body.dailyTokenBudget;
    }
    if (body.expiresInDays !== undefined) {
      if (body.expiresInDays === null || body.expiresInDays === 0) {
        updates.expiresAt = null;
      } else if (typeof body.expiresInDays === 'number' && body.expiresInDays > 0) {
        updates.expiresAt = Date.now() + Math.floor(body.expiresInDays) * 24 * 60 * 60 * 1000;
      }
    }

    const updated = ctx.apiKeys.updateById(id, updates);
    if (!updated) {
      return c.json(
        { error: { message: 'key not found', type: 'not_found' } },
        404,
      );
    }
    return c.json({
      row: {
        id: updated.id,
        name: updated.name,
        keyPrefix: updated.keyPrefix,
        rateLimitRpm: updated.rateLimitRpm,
        rateLimitTpm: updated.rateLimitTpm,
        dailyTokenBudget: updated.dailyTokenBudget,
        enabled: updated.enabled,
        createdAt: updated.createdAt,
        lastUsedAt: updated.lastUsedAt,
        revokedAt: updated.revokedAt,
        expiresAt: updated.expiresAt,
      },
    });
  });

  app.get('/admin/api/models', (c) => c.json({ data: MODELS }));

  return app;
}

function adminAuth(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    if (!expectedToken || expectedToken.length < 16) {
      return c.json({ error: { message: 'not_found' } }, 404);
    }
    const fromHeader = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const fromCookie = readCookie(c.req.header('cookie'), 'admin_session') ?? '';
    if (constantTimeEq(fromHeader, expectedToken) || constantTimeEq(fromCookie, expectedToken)) {
      await next();
      return;
    }
    const accept = c.req.header('accept') ?? '';
    if (c.req.method === 'GET' && accept.includes('text/html')) {
      return c.redirect('/admin/login', 302);
    }
    return c.json({ error: { message: 'unauthorized', type: 'authentication_error' } }, 401);
  };
}

function loginSuccess(c: Context, expected: string): Response {
  const cookie = `admin_session=${encodeURIComponent(expected)}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}`;
  c.header('set-cookie', cookie);
  return c.redirect('/admin/dashboard', 302);
}

function constantTimeEq(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function renderLoginPage(error: string | null): string {
  const safeError = error
    ? error.replace(/[&<>"']/g, (ch) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
      )
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ai-api-bridge · login</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0a1120; color: #e5e7eb; }
  .card { background: #111827; border: 1px solid #182236; border-radius: 12px; padding: 2rem; width: 100%; max-width: 380px; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
  h1 { margin: 0 0 .25rem; font-size: 1.2rem; }
  p.sub { margin: 0 0 1.5rem; color: #6b7280; font-size: .85rem; }
  label { font-size: .7rem; text-transform: uppercase; color: #9ca3af; letter-spacing: .05em; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .8rem; margin: .3rem 0 1rem; border-radius: 8px; background: #0a1120; border: 1px solid #182236; color: #e5e7eb; font-family: ui-monospace, monospace; font-size: .9rem; }
  input:focus { outline: none; border-color: #3b82f6; }
  button { width: 100%; padding: .65rem; border-radius: 8px; background: linear-gradient(90deg,#3b82f6,#6366f1); border: 0; color: white; font-weight: 600; cursor: pointer; }
  button:hover { opacity: .9; }
  .err { color: #f87171; font-size: .85rem; margin: 0 0 1rem; }
</style></head>
<body>
  <form class="card" method="POST" action="/admin/login">
    <h1>ai-api-bridge</h1>
    <p class="sub">Enter the admin token to open the dashboard.</p>
    ${safeError ? `<p class="err">${safeError}</p>` : ''}
    <label for="token">Admin Token</label>
    <input type="password" id="token" name="token" autofocus required autocomplete="off" />
    <button type="submit">Sign in</button>
  </form>
</body></html>`;
}
