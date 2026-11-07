// /api/v1：生產型 API（三方智能體生產與管理知識）+ 消費型 API（獲取結構化知識與自然語言答案）。
import path from 'node:path';
import express from 'express';
import { requireRole, requireAdmin, HttpError } from './auth.js';
import { buildPrompt, buildSchema } from '../services/prompt.js';
import { buildOpenApi } from './openapi.js';
import { RuleError } from '../store/validity.js';
import { kindOfId } from '../store/model.js';

const consumer = requireRole('consumer');
const contributor = requireRole('contributor');
const owner = requireRole('owner');

const list = v => (v === undefined || v === '' ? undefined : String(v).split(',').map(s => s.trim()).filter(Boolean));

function ok(res, data, extra = {}, status = 200) {
  res.status(status).json({ data, ...extra });
}

function txOut(res, out, status = 200) {
  res.status(status).json({ data: out.result, commit: out.commit, warnings: out.warnings });
}

export function baseUrlOf(ctx, req) {
  const configured = ctx.settings.value('server.publicBaseUrl');
  if (configured) return configured.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

/** 批量提交中的 "$ref:名字" 替換。 */
function resolveRefs(value, refs, index) {
  if (typeof value === 'string' && value.startsWith('$ref:')) {
    const name = value.slice(5);
    if (!refs.has(name)) throw new RuleError(`第 ${index} 條引用了未定義的 ref「${name}」（ref 必須在前面的條目中定義）`, 400, 'unknown_ref');
    return refs.get(name);
  }
  if (Array.isArray(value)) return value.map(v => resolveRefs(v, refs, index));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, refs, index)]));
  return value;
}

export function v1Router(ctx) {
  const r = express.Router();
  const S = () => ctx.store;

  // ------------------------------------------------------------ 公開：教程、Schema、OpenAPI
  r.get('/prompt', (req, res) => {
    const role = req.query.role === 'consumer' ? 'consumer' : 'producer';
    const markdown = buildPrompt({ store: S(), baseUrl: baseUrlOf(ctx, req), role });
    if (req.query.format === 'json') return ok(res, { role, format: 'markdown', prompt: markdown, version: '0.1' });
    res.type('text/markdown; charset=utf-8').send(markdown);
  });
  r.get('/prompt/:role', (req, res) => {
    if (!['producer', 'consumer'].includes(req.params.role)) throw new HttpError(404, 'role 必須為 producer 或 consumer', 'not_found');
    const markdown = buildPrompt({ store: S(), baseUrl: baseUrlOf(ctx, req), role: req.params.role });
    if (req.query.format === 'json') return ok(res, { role: req.params.role, format: 'markdown', prompt: markdown, version: '0.1' });
    res.type('text/markdown; charset=utf-8').send(markdown);
  });
  r.get('/schema', (req, res) => ok(res, buildSchema(S())));
  r.get('/openapi.json', (req, res) => res.json(buildOpenApi(baseUrlOf(ctx, req))));
  r.get('/status', (req, res) => ok(res, { ok: true, version: '0.1.0', llm: ctx.llm.enabled ? { provider: 'openrouter', model: ctx.llm.model } : null, git: req.principal ? { remote: S().repo.status.remote, branch: S().repo.status.branch } : undefined }));

  // ------------------------------------------------------------ 消費：讀取
  r.get('/resolve', consumer, (req, res) => {
    const text = String(req.query.text || '');
    if (!text) throw new HttpError(400, 'text 必填', 'invalid_input');
    const out = S().resolveTerms(text);
    ok(res, { ...out, canonical: out.canonical.map(id => S().subjectSummary(S().subjects.get(id))) });
  });
  r.get('/subjects', consumer, (req, res) => ok(res, S().listSubjects({ q: req.query.q, type: req.query.type, domain: req.query.domain, level: req.query.level, limit: Number(req.query.limit) || 500 })));
  r.get('/subjects/:id', consumer, (req, res) => ok(res, S().card(req.params.id, { includeHistory: req.query.history === '1' })));
  r.get('/subjects/:id/context', consumer, (req, res) => {
    const card = S().card(req.params.id);
    const neighborIds = new Set();
    for (const rel of [...(card.relations?.outgoing || []), ...(card.relations?.incoming || [])]) for (const s of [rel.from, rel.to]) if (s && s.id !== req.params.id) neighborIds.add(s.id);
    const neighbors = [...neighborIds].map(id => {
      const s = S().subjects.get(id);
      return { ...S().subjectSummary(s), definition: s.definition, l0Assertions: s.assertions.filter(a => a.validity.level === 'L0').map(a => ({ id: a.id, type: a.type, content: a.content })) };
    });
    ok(res, { ...card, neighbors });
  });
  r.get('/subjects/:id/history', consumer, async (req, res) => {
    S().getSubject(req.params.id);
    ok(res, await S().repo.log({ limit: 50, file: path.join(S().subdir, 'subjects', `${req.params.id}.yaml`) }));
  });
  r.get('/objects', consumer, (req, res) => ok(res, S().listObjects({ category: req.query.category, status: req.query.status, q: req.query.q })));
  r.get('/objects/:id', consumer, (req, res) => {
    const o = S().getObject(req.params.id);
    ok(res, { ...o, boundSubjects: S().bindingsOfObject(o.id).map(({ subject, binding }) => ({ ...S().subjectSummary(subject), bindingId: binding.id, bindingLevel: binding.validity.level })), actions: (o.actionIds || []).map(id => S().actions.get(id)).filter(Boolean) });
  });
  r.get('/assertions', consumer, (req, res) => ok(res, S().listAssertions({ level: req.query.level, type: req.query.type, subjectId: req.query.subjectId, q: req.query.q, pending: req.query.pending === '1' })));
  r.get('/relations', consumer, (req, res) => ok(res, S().listRelations({ type: req.query.type, level: req.query.level, subjectId: req.query.subjectId })));
  r.get('/items/:id', consumer, (req, res) => {
    const ref = S().getItem(req.params.id);
    ok(res, { kind: ref.kind, subject: S().subjectSummary(ref.subject), ...(ref.kind === 'relation' ? S().relationView(ref.item) : ref.item) });
  });
  r.get('/graph', consumer, (req, res) => ok(res, S().graph({
    domain: req.query.domain, types: list(req.query.types), relationTypes: list(req.query.relationTypes), levels: list(req.query.levels),
    focus: req.query.focus, depth: Math.min(4, Number(req.query.depth) || 2), includeAliases: req.query.aliases !== '0', includeE1: req.query.e1 === '1'
  })));
  r.get('/actions', consumer, (req, res) => ok(res, [...S().actions.values()]));
  r.get('/pipelines', consumer, (req, res) => ok(res, [...S().pipelines.values()]));

  // ------------------------------------------------------------ 消費：問答、取值、反饋
  r.post('/ask', consumer, async (req, res) => {
    const out = await ctx.ask.ask(req.body || {}, req.principal);
    ok(res, out);
  });
  r.post('/actions/:id/invoke', consumer, async (req, res) => ok(res, await ctx.actions.fetchValue(req.params.id, req.body?.inputs || {}, req.principal)));
  r.post('/feedback', consumer, async (req, res) => {
    const out = await S().tx(req.principal, o => `[反饋] ${o.id} → ${o.targetId}`, t => S().submitFeedback(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });

  // ------------------------------------------------------------ 生產：主體、客體、綁定、斷言、關係
  r.post('/subjects', contributor, async (req, res) => {
    const out = await S().tx(req.principal, s => `[生產] 新增主體 ${s.id} ${s.name}（${s.type}）`, t => S().createSubject(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.patch('/subjects/:id', contributor, async (req, res) => {
    const out = await S().tx(req.principal, `[生產] 修改主體 ${req.params.id}`, t => S().updateSubject(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.delete('/subjects/:id', requireAdmin, async (req, res) => {
    const out = await S().tx(req.principal, `[管理] 刪除主體 ${req.params.id}`, t => S().deleteSubject(t, req.params.id, req.principal));
    txOut(res, out);
  });
  r.post('/objects', contributor, async (req, res) => {
    const out = await S().tx(req.principal, o => `[生產] 登記客體 ${o.id} ${o.name}`, t => S().createObject(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.patch('/objects/:id', contributor, async (req, res) => {
    const out = await S().tx(req.principal, `[生產] 修改客體 ${req.params.id}${req.body?.status === '下線' ? '（下線）' : ''}`, t => S().updateObject(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.delete('/objects/:id', requireAdmin, async (req, res) => {
    const out = await S().tx(req.principal, `[管理] 刪除客體 ${req.params.id}`, t => S().deleteObject(t, req.params.id, req.principal));
    txOut(res, out);
  });
  r.post('/subjects/:id/bindings', contributor, async (req, res) => {
    const out = await S().tx(req.principal, b => `[生產] 綁定 ${b.id}：${req.params.id} ← ${b.objectId}（${b.validity.level}）`, t => S().createBinding(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.post('/subjects/:id/assertions', contributor, async (req, res) => {
    const out = await S().tx(req.principal, a => `[生產] 新增斷言 ${a.id} → ${req.params.id}（${a.type}，${a.validity.level}）`, t => S().createAssertion(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.patch('/assertions/:id', contributor, async (req, res) => {
    const out = await S().tx(req.principal, `[生產] 修改斷言 ${req.params.id}`, t => S().updateAssertion(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.post('/relations', contributor, async (req, res) => {
    const out = await S().tx(req.principal, x => `[生產] 新增關係 ${x.id}：${x.from} –${x.type}→ ${x.to}（${x.validity.level}）`, t => S().createRelation(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.delete('/relations/:id', requireAdmin, async (req, res) => {
    const out = await S().tx(req.principal, `[管理] 刪除關係 ${req.params.id}`, t => S().deleteRelation(t, req.params.id, req.principal));
    txOut(res, out);
  });

  r.post('/batch', contributor, async (req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'items 必須為非空陣列', 'invalid_input');
    if (items.length > 500) throw new HttpError(400, '單批最多 500 條', 'invalid_input');
    const message = `[批量] ${String(req.body.message || '批量提交').slice(0, 100)}（${items.length} 條）`;
    const st = S();
    const out = await st.tx(req.principal, message, t => {
      const refs = new Map();
      const results = [];
      items.forEach((it, i) => {
        try {
          const d = resolveRefs(it.data || {}, refs, i);
          let r2;
          switch (it.op) {
            case 'subject.create': r2 = st.createSubject(t, d, req.principal); break;
            case 'subject.update': r2 = st.updateSubject(t, d.id, d, req.principal); break;
            case 'object.create': r2 = st.createObject(t, d, req.principal); break;
            case 'object.update': r2 = st.updateObject(t, d.id, d, req.principal); break;
            case 'binding.create': r2 = st.createBinding(t, d.subjectId, d, req.principal); break;
            case 'assertion.create': r2 = st.createAssertion(t, d.subjectId, d, req.principal); break;
            case 'assertion.update': r2 = st.updateAssertion(t, d.id, d, req.principal); break;
            case 'relation.create': r2 = st.createRelation(t, d, req.principal); break;
            case 'evidence.add': r2 = st.addEvidence(t, d.id, d, req.principal); break;
            case 'conflict.create': r2 = st.reportConflict(t, d, req.principal); break;
            case 'feedback.create': r2 = st.submitFeedback(t, d, req.principal); break;
            default: throw new RuleError(`未知 op「${it.op}」`, 400, 'unknown_op');
          }
          if (it.ref) refs.set(String(it.ref), r2.id);
          results.push({ index: i, op: it.op, ref: it.ref || null, id: r2.id, level: r2.validity?.level ?? r2.level ?? null });
        } catch (err) {
          err.message = `第 ${i} 條（${it.op}${it.ref ? ` ref=${it.ref}` : ''}）：${err.message}；整批已回滾`;
          err.index = i;
          throw err;
        }
      });
      return { results, refs: Object.fromEntries(refs) };
    });
    txOut(res, out, 201);
  });

  // ------------------------------------------------------------ 有效性：證據、校驗、確認、失效
  r.post('/items/:id/evidence', contributor, async (req, res) => {
    const out = await S().tx(req.principal, x => `[證據] ${req.params.id} 補充證據（${x.level}）`, t => S().addEvidence(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.post('/validate/:id', contributor, async (req, res) => ok(res, await ctx.actions.validateItem(req.params.id, req.principal, { actionId: req.body?.actionId })));
  r.post('/validate-all', owner, async (req, res) => ok(res, await ctx.actions.validateAll(req.principal, { onlyPending: req.body?.onlyPending === true })));
  r.post('/items/:id/confirm', owner, async (req, res) => {
    const out = await S().tx(req.principal, `[確認] ${req.params.id} → L0（負責人 ${req.principal.name}）`, t => S().confirm(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.post('/items/:id/invalidate', owner, async (req, res) => {
    const out = await S().tx(req.principal, `[失效] ${req.params.id} → E1：${String(req.body?.reason || '').slice(0, 60)}`, t => S().invalidateItem(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });

  // ------------------------------------------------------------ 治理：衝突、反饋、缺口、重驗隊列、指標
  r.get('/conflicts', contributor, (req, res) => ok(res, [...S().conflicts.values()].filter(c => !req.query.status || c.status === req.query.status).sort((a, b) => b.id.localeCompare(a.id))));
  r.post('/conflicts', contributor, async (req, res) => {
    const out = await S().tx(req.principal, c => `[衝突] ${c.id}：${c.a} ↔ ${c.b}（雙方降為 L1）`, t => S().reportConflict(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.post('/conflicts/:id/resolve', owner, async (req, res) => {
    const out = await S().tx(req.principal, c => `[裁決] ${c.id}：${c.winner} → L0，${c.loser} → E1`, t => S().resolveConflict(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.get('/feedback', contributor, (req, res) => ok(res, [...S().feedback.values()].filter(f => !req.query.status || f.status === req.query.status).sort((a, b) => b.id.localeCompare(a.id))));
  r.post('/feedback/:id/close', owner, async (req, res) => {
    const out = await S().tx(req.principal, `[反饋] 關閉 ${req.params.id}`, t => S().closeFeedback(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.get('/gaps', contributor, (req, res) => ok(res, [...S().gaps.values()].filter(g => !req.query.status || g.status === req.query.status).sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))));
  r.post('/gaps/:id/close', owner, async (req, res) => {
    const out = await S().tx(req.principal, `[缺口] 關閉 ${req.params.id}`, t => S().closeGap(t, req.params.id, req.body || {}));
    txOut(res, out);
  });
  r.get('/queue', contributor, (req, res) => ok(res, S().revalidationQueue()));
  r.get('/metrics', contributor, (req, res) => ok(res, S().health({ windowDays: Number(req.query.days) || 7 })));

  // ------------------------------------------------------------ 動力層配置（負責人）
  r.post('/pipelines', owner, async (req, res) => {
    const out = await S().tx(req.principal, p => `[動力層] 管道 ${p.id} ${p.name}`, t => S().upsertPipeline(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.put('/pipelines/:id', owner, async (req, res) => {
    if (!S().pipelines.has(req.params.id)) throw new HttpError(404, `找不到管道 ${req.params.id}`, 'not_found');
    const out = await S().tx(req.principal, `[動力層] 更新管道 ${req.params.id}`, t => S().upsertPipeline(t, { ...req.body, id: req.params.id }, req.principal));
    txOut(res, out);
  });
  r.post('/pipelines/:id/test', owner, async (req, res) => ok(res, await ctx.actions.testPipeline(req.params.id)));
  r.post('/actions', owner, async (req, res) => {
    const out = await S().tx(req.principal, a => `[動力層] Action ${a.id} ${a.name}（${a.kind}）`, t => S().upsertAction(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.put('/actions/:id', owner, async (req, res) => {
    if (!S().actions.has(req.params.id)) throw new HttpError(404, `找不到 Action ${req.params.id}`, 'not_found');
    const out = await S().tx(req.principal, `[動力層] 更新 Action ${req.params.id}`, t => S().upsertAction(t, { ...req.body, id: req.params.id }, req.principal));
    txOut(res, out);
  });

  // ------------------------------------------------------------ 規則參數（管理員）
  r.get('/config', consumer, (req, res) => ok(res, S().config));
  r.put('/config', requireAdmin, async (req, res) => {
    const out = await S().tx(req.principal, '[規則] 更新規則參數', t => S().updateConfig(t, req.body || {}, req.principal));
    txOut(res, out);
  });

  r.use((req, res, next) => next(new HttpError(404, `未知端點 ${req.method} ${req.baseUrl}${req.path}`, 'not_found')));
  return r;
}

export { kindOfId };
