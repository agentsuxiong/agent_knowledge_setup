// /admin/api：管理後台專用介面（登入、Git 倉庫設定、OpenRouter 設定、API 金鑰、同步、示例資料）。
import express from 'express';
import { requireAdmin, HttpError } from './auth.js';
import { GitRepo } from '../git/repo.js';
import { seedInventory } from '../seed/inventory.js';

function requireLogin(req, res, next) {
  if (!req.principal || req.authVia !== 'session') return next(new HttpError(401, '請先登入後台', 'unauthorized'));
  next();
}

export function adminRouter(ctx) {
  const r = express.Router();
  const S = () => ctx.store;

  r.post('/login', (req, res) => {
    const { token, principal } = ctx.auth.login(req.body || {});
    res.setHeader('Set-Cookie', ctx.auth.cookieFor(token, req));
    res.json({ data: principal });
  });
  r.post('/logout', (req, res) => {
    ctx.auth.logout(req);
    res.setHeader('Set-Cookie', ctx.auth.clearCookie());
    res.json({ data: { ok: true } });
  });
  r.get('/me', requireLogin, (req, res) => res.json({ data: req.principal }));

  r.get('/overview', requireLogin, async (req, res) => {
    res.json({
      data: {
        health: S().health({ windowDays: Number(req.query.days) || 7 }),
        git: { ...S().repo.status, head: await S().repo.head(), subdir: S().subdir, loadErrors: S().loadErrors },
        llm: { enabled: ctx.llm.enabled, model: ctx.llm.model },
        log: await S().repo.log({ limit: 8 })
      }
    });
  });
  r.get('/log', requireLogin, async (req, res) => res.json({ data: await S().repo.log({ limit: Math.min(200, Number(req.query.limit) || 50) }) }));

  // ---- 設定
  r.get('/settings', requireAdmin, (req, res) => {
    res.json({
      data: {
        git: ctx.settings.publicSection('git'),
        llm: ctx.settings.publicSection('llm'),
        server: ctx.settings.publicSection('server'),
        adminPasswordFromEnv: !!ctx.env.ADMIN_PASSWORD,
        gitStatus: S().repo.status,
        repoDir: S().repo.dir,
        rules: S().config
      }
    });
  });
  r.post('/settings/git/test', requireAdmin, async (req, res) => {
    const cur = ctx.settings.section('git');
    const url = req.body?.url || cur.url;
    if (!url) throw new HttpError(400, '請填寫倉庫地址', 'invalid_input');
    const token = req.body?.token && !String(req.body.token).startsWith('已設定') ? req.body.token : cur.token;
    res.json({ data: await GitRepo.test({ url, token, username: req.body?.username || cur.username, branch: req.body?.branch || cur.branch }) });
  });
  r.put('/settings/git', requireAdmin, async (req, res) => {
    const before = structuredClone(ctx.settings.data.git);
    ctx.settings.update('git', req.body || {});
    try {
      await ctx.reconfigure();
    } catch (err) {
      ctx.settings.data.git = before;
      ctx.settings.save();
      await ctx.reconfigure().catch(() => {});
      throw new HttpError(400, `無法使用該倉庫：${err.message}`, 'git_error');
    }
    res.json({ data: { git: ctx.settings.publicSection('git'), status: S().repo.status, repoDir: S().repo.dir } });
  });
  r.put('/settings/llm', requireAdmin, (req, res) => {
    ctx.settings.update('llm', req.body || {});
    res.json({ data: ctx.settings.publicSection('llm') });
  });
  r.post('/settings/llm/test', requireAdmin, async (req, res) => {
    const out = await ctx.llm.chat({ messages: [{ role: 'user', content: '只回答 JSON：{"ok": true}' }], json: true, maxTokens: 20 });
    res.json({ data: { ok: true, model: out.model, reply: out.content.slice(0, 200) } });
  });
  r.put('/settings/server', requireAdmin, (req, res) => {
    ctx.settings.update('server', req.body || {});
    res.json({ data: ctx.settings.publicSection('server') });
  });
  r.put('/password', requireAdmin, (req, res) => {
    ctx.settings.setAdminPassword(req.body?.password);
    res.json({ data: { ok: true } });
  });

  // ---- API 金鑰
  r.get('/keys', requireAdmin, (req, res) => res.json({ data: ctx.settings.listApiKeys() }));
  r.post('/keys', requireAdmin, (req, res) => res.status(201).json({ data: ctx.settings.createApiKey(req.body || {}) }));
  r.patch('/keys/:id', requireAdmin, (req, res) => res.json({ data: ctx.settings.setApiKeyDisabled(req.params.id, req.body?.disabled) }));
  r.delete('/keys/:id', requireAdmin, (req, res) => {
    ctx.settings.deleteApiKey(req.params.id);
    res.json({ data: { ok: true } });
  });

  // ---- 維護
  r.post('/sync', requireAdmin, async (req, res) => res.json({ data: await S().sync() }));
  r.post('/seed', requireAdmin, async (req, res) => res.status(201).json({ data: await seedInventory(ctx, req.principal) }));
  r.post('/maintenance/expiry', requireAdmin, async (req, res) => res.json({ data: await ctx.runExpirySweep() }));
  r.post('/maintenance/flush', requireAdmin, async (req, res) => res.json({ data: { commit: await S().flushLazy() } }));

  r.use((req, res, next) => next(new HttpError(404, `未知端點 ${req.method} ${req.originalUrl}`, 'not_found')));
  return r;
}
