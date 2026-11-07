// 服務入口：組裝 Git 持久化、知識庫、API 與管理後台，並啟動保鮮排程。
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Settings } from './config.js';
import { GitRepo } from './git/repo.js';
import { KnowledgeStore } from './store/store.js';
import { RuleError } from './store/validity.js';
import { ActionRunner } from './services/actions.js';
import { AskService } from './services/ask.js';
import { LlmClient } from './services/llm.js';
import { Auth, HttpError } from './api/auth.js';
import { v1Router } from './api/v1.js';
import { adminRouter } from './api/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(here, '..', 'web');
const SYSTEM = Object.freeze({ id: 'system', name: '保鮮觸發器', kind: 'system', role: 'owner', isAdmin: false });

export async function createServer({ dataDir = process.env.DATA_DIR || path.join(here, '..', 'data'), env = process.env, fetchImpl = globalThis.fetch, logger = console, schedulers = true } = {}) {
  const settings = new Settings(dataDir, env);
  const ctx = { settings, env, logger, dataDir, fetch: fetchImpl };
  ctx.llm = new LlmClient({ settings, fetchImpl });
  ctx.auth = new Auth(ctx);

  /** 依 Git 設定（重新）建立知識庫；切換倉庫時調用。 */
  ctx.reconfigure = async () => {
    const g = settings.section('git');
    const slug = crypto.createHash('sha1').update(`${g.url || 'local'}#${g.branch}`).digest('hex').slice(0, 12);
    const dir = env.KNOWLEDGE_REPO_DIR || path.join(dataDir, 'repos', slug);
    const repo = new GitRepo({ dir, url: g.url, branch: g.branch, token: g.token, username: g.username, authorName: g.authorName, authorEmail: g.authorEmail });
    const store = new KnowledgeStore({ repo, subdir: g.subdir, autoPush: g.autoPush !== false, logger });
    await store.init();
    if (ctx.store) await ctx.store.flushLazy().catch(() => {});
    ctx.store = store;
    ctx.actions = new ActionRunner({ store, env, fetchImpl });
    ctx.ask = new AskService({ store, actions: ctx.actions, llm: ctx.llm, logger });
    return store;
  };

  ctx.runExpirySweep = async () => {
    const out = await ctx.store.tx(SYSTEM, r => `[保鮮] ${r.length} 條 L0 知識到期，降為 L1 並排入重驗`, t => ctx.store.expirySweep(t));
    return { expired: out.result, commit: out.commit };
  };

  await ctx.reconfigure();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '4mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(ctx.auth.middleware());
  app.use('/api/v1', v1Router(ctx));
  app.use('/admin/api', adminRouter(ctx));
  app.use(express.static(WEB_DIR, { index: 'index.html', maxAge: '5m' }));
  app.get('/', (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let code = err.code || 'internal_error';
    if (err.type === 'entity.parse.failed') { status = 400; code = 'invalid_json'; }
    if (!(err instanceof RuleError) && !(err instanceof HttpError) && status >= 500) logger.error?.(`[knowledge] ${req.method} ${req.originalUrl}`, err);
    const body = { error: { code: typeof code === 'string' ? code : 'error', message: status >= 500 && !(err instanceof RuleError) && !(err instanceof HttpError) && !err.code ? '服務內部錯誤' : err.message } };
    if (err.index !== undefined) body.error.index = err.index;
    if (err.missing) body.error.missing = err.missing;
    res.status(status).json(body);
  });

  const timers = [];
  const every = (ms, fn) => timers.push(setInterval(() => fn().catch(err => logger.warn?.(`[knowledge] 排程任務失敗：${err.message}`)), ms));
  if (schedulers) {
    every(30000, () => ctx.store.flushLazy());
    every(Math.max(15, Number(settings.value('git.pullIntervalSec')) || 60) * 1000, async () => { if (ctx.store.repo.url) await ctx.store.sync(); });
    every(3600 * 1000, ctx.runExpirySweep);
    let lastValidation = Date.now();
    every(10 * 60 * 1000, async () => {
      const hours = Number(ctx.store.config.validationIntervalHours) || 0;
      if (!hours || Date.now() - lastValidation < hours * 3600 * 1000) return;
      lastValidation = Date.now();
      await ctx.actions.validateAll(SYSTEM, {});
    });
    ctx.runExpirySweep().catch(err => logger.warn?.(`[knowledge] 到期檢查失敗：${err.message}`));
  }

  let server;
  return {
    app,
    ctx,
    listen(port = Number(env.PORT) || 8080, host = env.HOST || '0.0.0.0') {
      return new Promise(resolve => { server = app.listen(port, host, () => resolve(server)); });
    },
    async close() {
      timers.forEach(clearInterval);
      await ctx.store.flushLazy().catch(() => {});
      await ctx.store.flushPush().catch(() => {});
      if (server) await new Promise(r => server.close(r));
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const srv = await createServer();
  const port = Number(process.env.PORT) || 8080;
  await srv.listen(port);
  const g = srv.ctx.store.repo.status;
  console.log(`[knowledge] 服務已啟動：http://localhost:${port}`);
  console.log(`[knowledge] 知識倉庫：${g.remote || '本地倉庫（未配置遠端）'} · 分支 ${g.branch} · 目錄 ${srv.ctx.store.repo.dir}`);
  console.log(`[knowledge] 智能體教程：http://localhost:${port}/api/v1/prompt`);
  if (srv.ctx.settings.generatedAdminPassword) console.log(`[knowledge] 初始管理員密碼：${srv.ctx.settings.generatedAdminPassword}`);
  const shutdown = async () => { await srv.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
