// 知識庫存儲：以 Git 倉庫中的 YAML 檔案為唯一事實來源，記憶體中維護索引。
// 每個寫入操作 = 一個事務 = 一次 Git 提交（作者為提交知識的人、智能體或管道）。
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {
  SUBJECT_TYPES, RELATION_TYPES, ASSERTION_TYPES, OBJECT_CATEGORIES, OBJECT_STATUS, ACTION_KINDS, PIPELINE_TYPES,
  DEFAULT_EXPIRY_DAYS, DEFAULT_DOMAINS, LEVEL_INFO, LEVEL_RANK, ID_PREFIX, kindOfId, maxLevel
} from './model.js';
import {
  RuleError, normalizeValidity, hasEvidence, sourceOf, capSubmittedLevel, transition, setPending, clearPending,
  demoteToL1, promoteToL0, invalidate, addDays, isExpired
} from './validity.js';

const DIRS = {
  subject: 'subjects',
  object: 'objects',
  relation: 'relations',
  action: 'actions',
  pipeline: 'pipelines',
  conflict: 'governance/conflicts',
  feedback: 'governance/feedback',
  gap: 'governance/gaps'
};
const COLLECTION = { subject: 'subjects', object: 'objects', relation: 'relations', action: 'actions', pipeline: 'pipelines', conflict: 'conflicts', feedback: 'feedback', gap: 'gaps' };

const nowIso = () => new Date().toISOString();
const clean = v => (typeof v === 'string' ? v.trim() : v);
const notFound = (what, id) => new RuleError(`找不到${what} ${id}`, 404, 'not_found');

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0 && k !== 'history') continue;
      const c = compact(v);
      if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out;
  }
  return value;
}

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

class Mutex {
  constructor() { this.p = Promise.resolve(); }
  run(fn) {
    const next = this.p.then(fn, fn);
    this.p = next.catch(() => {});
    return next;
  }
}

export class KnowledgeStore {
  constructor({ repo, subdir = 'knowledge', autoPush = true, logger = console }) {
    this.repo = repo;
    this.subdir = subdir.replace(/^\/+|\/+$/g, '') || 'knowledge';
    this.autoPush = autoPush;
    this.logger = logger;
    this.mutex = new Mutex();
    this.lazyDirty = new Set();
    this.pushTimer = null;
    this.pushing = Promise.resolve();
    this.resetMemory();
  }

  get root() {
    return path.join(this.repo.dir, this.subdir);
  }

  resetMemory() {
    for (const c of Object.values(COLLECTION)) this[c] = new Map();
    this.assertionIndex = new Map();
    this.bindingIndex = new Map();
    this.counters = new Map();
    this.config = { domains: DEFAULT_DOMAINS, expiryDays: structuredClone(DEFAULT_EXPIRY_DAYS), highFrequencyRatio: 0.2, validationIntervalHours: 24 };
    this.usage = { subjects: {} };
    this.loadErrors = [];
  }

  // ---------------------------------------------------------------- 載入與持久化
  async init() {
    await this.repo.init();
    if (this.repo.url) {
      try {
        await this.repo.pull();
      } catch (err) {
        this.logger.warn?.(`[knowledge] 拉取遠端失敗：${err.message}`);
      }
    }
    await fs.mkdir(this.root, { recursive: true });
    const readme = path.join(this.root, 'README.md');
    const configFile = path.join(this.root, 'config.yaml');
    let created = false;
    try { await fs.access(readme); } catch { await fs.writeFile(readme, KNOWLEDGE_README); created = true; }
    try { await fs.access(configFile); } catch { await fs.writeFile(configFile, YAML.stringify(this.config, { lineWidth: 0 })); created = true; }
    if (created) {
      const hash = await this.repo.commit('初始化知識倉庫結構', { paths: [this.subdir] });
      if (hash && this.autoPush) this.schedulePush();
    }
    await this.load();
    return this;
  }

  async readYamlDir(dir) {
    const full = path.join(this.root, dir);
    let names = [];
    try { names = await fs.readdir(full); } catch { return []; }
    const out = [];
    for (const name of names.filter(n => n.endsWith('.yaml') || n.endsWith('.yml')).sort()) {
      const file = path.join(dir, name);
      try {
        const doc = YAML.parse(await fs.readFile(path.join(this.root, file), 'utf8'));
        if (doc && typeof doc === 'object' && doc.id) out.push(doc);
        else this.loadErrors.push({ file, error: '缺少 id 欄位' });
      } catch (err) {
        this.loadErrors.push({ file, error: err.message });
      }
    }
    return out;
  }

  async load() {
    this.resetMemory();
    try {
      const cfg = YAML.parse(await fs.readFile(path.join(this.root, 'config.yaml'), 'utf8')) || {};
      this.config = {
        ...this.config,
        ...cfg,
        expiryDays: {
          assertion: { ...DEFAULT_EXPIRY_DAYS.assertion, ...(cfg.expiryDays?.assertion || {}) },
          relation: { ...DEFAULT_EXPIRY_DAYS.relation, ...(cfg.expiryDays?.relation || {}) },
          binding: { ...DEFAULT_EXPIRY_DAYS.binding, ...(cfg.expiryDays?.binding || {}) }
        },
        domains: Array.isArray(cfg.domains) && cfg.domains.length ? cfg.domains : DEFAULT_DOMAINS
      };
    } catch { /* 使用預設 */ }
    try {
      this.usage = YAML.parse(await fs.readFile(path.join(this.root, 'stats/usage.yaml'), 'utf8')) || { subjects: {} };
      this.usage.subjects ||= {};
    } catch { this.usage = { subjects: {} }; }

    for (const [kind, dir] of Object.entries(DIRS)) {
      for (const doc of await this.readYamlDir(dir)) {
        if (kind === 'subject') {
          doc.assertions = (doc.assertions || []).map(a => ({ ...a, validity: normalizeValidity(a.validity) }));
          doc.bindings = (doc.bindings || []).map(b => ({ ...b, validity: normalizeValidity(b.validity) }));
          doc.tags ||= [];
          doc.ownerIds ||= [];
          for (const a of doc.assertions) this.assertionIndex.set(a.id, doc.id);
          for (const b of doc.bindings) this.bindingIndex.set(b.id, doc.id);
        }
        if (kind === 'relation') doc.validity = normalizeValidity(doc.validity);
        if (kind === 'object') doc.actionIds ||= [];
        this[COLLECTION[kind]].set(doc.id, doc);
        this.bumpCounter(doc.id);
        if (kind === 'subject') {
          for (const a of doc.assertions) this.bumpCounter(a.id);
          for (const b of doc.bindings) this.bumpCounter(b.id);
        }
      }
    }
  }

  bumpCounter(id) {
    const m = /^(.*)-(\d+)$/.exec(id || '');
    if (!m) return;
    const n = Number(m[2]);
    if (n > (this.counters.get(m[1]) || 0)) this.counters.set(m[1], n);
  }

  nextId(prefix) {
    const n = (this.counters.get(prefix) || 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, '0')}`;
  }

  fileOf(kind, id) {
    return path.join(DIRS[kind], `${id}.yaml`);
  }

  serialize(kind, doc) {
    let body = doc;
    if (kind === 'subject') {
      const { level, ...rest } = doc;
      body = rest;
    }
    return YAML.stringify(compact(body), { lineWidth: 0 });
  }

  async writeFileRel(rel, content) {
    const full = path.join(this.root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }

  async persist(t) {
    for (const key of t.touched) {
      const [kind, id] = key.split(':');
      const doc = this[COLLECTION[kind]].get(id);
      if (doc) await this.writeFileRel(this.fileOf(kind, id), this.serialize(kind, doc));
    }
    for (const key of t.removed) {
      const [kind, id] = key.split(':');
      await fs.rm(path.join(this.root, this.fileOf(kind, id)), { force: true });
    }
    if (t.configChanged) await this.writeFileRel('config.yaml', YAML.stringify(this.config, { lineWidth: 0 }));
    await this.writeLazy();
  }

  async writeLazy() {
    for (const key of this.lazyDirty) {
      if (key === 'usage') await this.writeFileRel('stats/usage.yaml', YAML.stringify(this.usage, { lineWidth: 0 }));
      else {
        const [kind, id] = key.split(':');
        const doc = this[COLLECTION[kind]].get(id);
        if (doc) await this.writeFileRel(this.fileOf(kind, id), this.serialize(kind, doc));
      }
    }
    this.lazyDirty.clear();
  }

  /**
   * 執行一個寫入事務。fn 只修改記憶體並以 t.touch() 標記；成功後寫檔並提交。
   * 任何錯誤都會丟棄記憶體修改並從磁碟重新載入。
   */
  tx(principal, message, fn) {
    return this.mutex.run(async () => {
      const t = {
        touched: new Set(),
        removed: new Set(),
        warnings: [],
        configChanged: false,
        touch: (kind, id) => t.touched.add(`${kind}:${id}`),
        remove: (kind, id) => { t.removed.add(`${kind}:${id}`); t.touched.delete(`${kind}:${id}`); },
        warn: w => t.warnings.push(w)
      };
      let result;
      try {
        result = await fn(t);
      } catch (err) {
        await this.load();
        throw err;
      }
      try {
        await this.persist(t);
      } catch (err) {
        await this.revertWorkingTree();
        throw err;
      }
      const src = sourceOf(principal);
      const commit = await this.repo.commit(typeof message === 'function' ? message(result) : message, {
        authorName: src.name || src.id,
        authorEmail: `${src.id}@${src.kind}.knowledge`,
        paths: [this.subdir]
      });
      if (commit && this.autoPush) this.schedulePush();
      return { result, commit, warnings: t.warnings };
    });
  }

  async revertWorkingTree() {
    if (await this.repo.hasCommits()) {
      await this.repo.git(['checkout', 'HEAD', '--', this.subdir]).catch(() => {});
      await this.repo.git(['clean', '-fdq', '--', this.subdir]).catch(() => {});
    }
    await this.load();
  }

  schedulePush() {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushing = this.pushing.then(() => this.repo.push()).catch(err => this.logger.warn?.(`[knowledge] 推送失敗：${err.message}`));
    }, 300);
  }

  async flushPush() {
    clearTimeout(this.pushTimer);
    if (!this.repo.url) return;
    this.pushing = this.pushing.then(() => this.repo.push());
    return this.pushing;
  }

  /** 提交使用統計、知識缺口等低頻但頻繁累積的變更。 */
  flushLazy(message = '更新使用統計與知識缺口') {
    return this.mutex.run(async () => {
      if (!this.lazyDirty.size) return null;
      await this.writeLazy();
      const hash = await this.repo.commit(message, { paths: [this.subdir] });
      if (hash && this.autoPush) this.schedulePush();
      return hash;
    });
  }

  /** 從遠端拉取（例如有人直接在 Git 中編輯了知識），有變化則重新載入。 */
  sync() {
    return this.mutex.run(async () => {
      await this.writeLazy();
      await this.repo.commit('更新使用統計與知識缺口', { paths: [this.subdir] });
      const changed = await this.repo.pull();
      if (changed) await this.load();
      if (this.repo.url) await this.repo.push().catch(() => {});
      return { changed, status: this.repo.status };
    });
  }

  // ---------------------------------------------------------------- 查詢
  subjectLevel(subject) {
    const levels = (subject.bindings || []).filter(b => b.validity.level !== 'E1').map(b => b.validity.level);
    return maxLevel(levels) || 'L2';
  }

  getSubject(id) {
    const s = this.subjects.get(id);
    if (!s) throw notFound('主體', id);
    return s;
  }

  getObject(id) {
    const o = this.objects.get(id);
    if (!o) throw notFound('客體', id);
    return o;
  }

  /** 按 ID 取得帶有效性的條目（綁定、斷言、關係）。 */
  getItem(id) {
    const kind = kindOfId(id);
    if (kind === 'assertion') {
      const sid = this.assertionIndex.get(id);
      const subject = sid && this.subjects.get(sid);
      const item = subject?.assertions.find(a => a.id === id);
      if (!item) throw notFound('斷言', id);
      return { kind, item, subject };
    }
    if (kind === 'binding') {
      const sid = this.bindingIndex.get(id);
      const subject = sid && this.subjects.get(sid);
      const item = subject?.bindings.find(b => b.id === id);
      if (!item) throw notFound('綁定', id);
      return { kind, item, subject };
    }
    if (kind === 'relation') {
      const item = this.relations.get(id);
      if (!item) throw notFound('關係', id);
      return { kind, item, subject: this.subjects.get(item.from) };
    }
    throw new RuleError(`${id} 不是帶有效性的條目（只有綁定 B-、斷言 A-、關係 R- 帶有效性）`, 400, 'not_validity_item');
  }

  touchItem(t, ref) {
    if (ref.kind === 'relation') t.touch('relation', ref.item.id);
    else t.touch('subject', ref.subject.id);
  }

  subjectSummary(s) {
    if (!s) return null;
    return { id: s.id, name: s.name, type: s.type, domain: s.domain, level: s.type === '別名' ? null : this.subjectLevel(s) };
  }

  aliasTargets(aliasSubject) {
    return [...this.relations.values()].filter(r => r.type === '別名' && r.from === aliasSubject.id && r.validity.level !== 'E1').map(r => r.to);
  }

  aliasesOf(subjectId) {
    return [...this.relations.values()]
      .filter(r => r.type === '別名' && r.to === subjectId && r.validity.level !== 'E1')
      .map(r => {
        const a = this.subjects.get(r.from);
        const targets = a ? this.aliasTargets(a) : [];
        return { id: r.from, name: a?.name, relationId: r.id, level: r.validity.level, ambiguous: targets.length > 1, targets };
      });
  }

  actionsForSubject(subject) {
    const ids = new Set();
    for (const b of subject.bindings || []) {
      if (b.validity.level === 'E1') continue;
      const obj = this.objects.get(b.objectId);
      if (!obj || obj.status === '下線') continue;
      for (const aid of obj.actionIds || []) ids.add(aid);
    }
    return [...ids].map(id => this.actions.get(id)).filter(Boolean);
  }

  listSubjects({ q, type, domain, level, limit = 500 } = {}) {
    const nq = q ? String(q).toLowerCase() : '';
    const out = [];
    for (const s of this.subjects.values()) {
      if (type && s.type !== type) continue;
      if (domain && s.domain !== domain) continue;
      const lvl = s.type === '別名' ? null : this.subjectLevel(s);
      if (level && lvl !== level) continue;
      if (nq) {
        const hay = [s.id, s.name, s.definition, ...(s.tags || []), ...this.aliasesOf(s.id).map(a => a.name)].join(' ').toLowerCase();
        if (!hay.includes(nq)) continue;
      }
      out.push({
        id: s.id, name: s.name, type: s.type, domain: s.domain, owner: s.owner, definition: s.definition,
        level: lvl, assertions: s.assertions.length, bindings: s.bindings.length,
        aliasOf: s.type === '別名' ? this.aliasTargets(s) : undefined,
        usage: this.usage.subjects[s.id]?.count || 0,
        pending: [...s.assertions, ...s.bindings].filter(x => x.validity.pending).length,
        updatedAt: s.updatedAt
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
  }

  listAssertions({ level, type, subjectId, q, pending } = {}) {
    const out = [];
    const nq = q ? String(q).toLowerCase() : '';
    for (const s of this.subjects.values()) {
      if (subjectId && s.id !== subjectId) continue;
      for (const a of s.assertions) {
        if (level && a.validity.level !== level) continue;
        if (type && a.type !== type) continue;
        if (pending && !a.validity.pending) continue;
        if (nq && !`${a.id} ${a.content} ${s.name}`.toLowerCase().includes(nq)) continue;
        out.push({ ...a, subject: this.subjectSummary(s) });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  listRelations({ type, level, subjectId } = {}) {
    return [...this.relations.values()]
      .filter(r => (!type || r.type === type) && (!level || r.validity.level === level) && (!subjectId || r.from === subjectId || r.to === subjectId))
      .map(r => this.relationView(r))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  relationView(r) {
    return { ...r, fromSubject: this.subjectSummary(this.subjects.get(r.from)), toSubject: this.subjectSummary(this.subjects.get(r.to)) };
  }

  listObjects({ category, status, q } = {}) {
    const nq = q ? String(q).toLowerCase() : '';
    return [...this.objects.values()]
      .filter(o => (!category || o.category === category) && (!status || o.status === status) && (!nq || `${o.id} ${o.name} ${o.locator || ''}`.toLowerCase().includes(nq)))
      .map(o => ({ ...o, boundSubjects: this.bindingsOfObject(o.id).map(({ subject, binding }) => ({ ...this.subjectSummary(subject), bindingId: binding.id, bindingLevel: binding.validity.level })) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  bindingsOfObject(objectId) {
    const out = [];
    for (const s of this.subjects.values()) for (const b of s.bindings) if (b.objectId === objectId) out.push({ subject: s, binding: b });
    return out;
  }

  /** 結構化知識卡：智能體消費的核心數據結構。 */
  card(subjectId, { includeHistory = false } = {}) {
    const s = this.getSubject(subjectId);
    const strip = v => (includeHistory ? v : { ...v, history: undefined });
    const levelUsage = lvl => LEVEL_INFO[lvl]?.usage;
    if (s.type === '別名') {
      const targets = this.aliasTargets(s).map(id => this.subjectSummary(this.subjects.get(id)));
      return {
        subject: { id: s.id, name: s.name, type: s.type, domain: s.domain, definition: s.definition || null },
        alias: { targets, ambiguous: targets.length > 1, guidance: targets.length > 1 ? '別名多義：必須先消歧或向用戶確認指哪一個規範主體' : '請改用規範主體取知識' }
      };
    }
    const bindings = s.bindings.map(b => ({ id: b.id, level: b.validity.level, usage: levelUsage(b.validity.level), object: this.objects.get(b.objectId) || { id: b.objectId, missing: true }, note: b.note, validity: strip(b.validity) }));
    const assertions = s.assertions.map(a => ({ id: a.id, type: a.type, content: a.content, structured: a.structured || null, level: a.validity.level, usage: levelUsage(a.validity.level), replacedBy: a.validity.replacedBy || null, invalidReason: a.validity.invalidReason || null, validity: strip(a.validity) }));
    const rel = r => ({ id: r.id, type: r.type, level: r.validity.level, usage: levelUsage(r.validity.level), from: this.subjectSummary(this.subjects.get(r.from)), to: this.subjectSummary(this.subjects.get(r.to)), validity: strip(r.validity) });
    const actions = this.actionsForSubject(s).map(a => ({ id: a.id, name: a.name, kind: a.kind, inputs: a.inputs || [], output: a.output || null, description: a.description || null }));
    return {
      subject: { id: s.id, name: s.name, type: s.type, domain: s.domain, definition: s.definition, owner: s.owner, level: this.subjectLevel(s), levelNote: '綜合層級 = 所有有效客體綁定中的最高層級；沒有有效綁定時為 L2', errorCost: s.errorCost ?? 3, tags: s.tags, updatedAt: s.updatedAt },
      aliases: this.aliasesOf(s.id),
      bindings,
      assertions,
      relations: {
        outgoing: [...this.relations.values()].filter(r => r.from === s.id).map(rel),
        incoming: [...this.relations.values()].filter(r => r.to === s.id && r.type !== '別名').map(rel)
      },
      actions,
      dynamicValueNote: actions.some(a => a.kind === '取值') ? '動態值不作為知識存儲；回答數量、狀態等動態值時必須調用取值 Action' : null,
      levels: LEVEL_INFO
    };
  }

  graph({ domain, types, relationTypes, levels, focus, depth = 2, includeAliases = true, includeE1 = false } = {}) {
    let subjectIds;
    const relOk = r => (!relationTypes?.length || relationTypes.includes(r.type)) && (!levels?.length || levels.includes(r.validity.level)) && (includeE1 || r.validity.level !== 'E1') && (includeAliases || r.type !== '別名');
    if (focus) {
      this.getSubject(focus);
      subjectIds = new Set([focus]);
      let frontier = [focus];
      for (let d = 0; d < depth; d++) {
        const next = [];
        for (const r of this.relations.values()) {
          if (!relOk(r)) continue;
          for (const [a, b] of [[r.from, r.to], [r.to, r.from]]) if (frontier.includes(a) && !subjectIds.has(b)) { subjectIds.add(b); next.push(b); }
        }
        frontier = next;
      }
    } else subjectIds = new Set(this.subjects.keys());
    const nodes = [...subjectIds]
      .map(id => this.subjects.get(id))
      .filter(s => s && (!domain || s.domain === domain || s.id === focus) && (!types?.length || types.includes(s.type)) && (includeAliases || s.type !== '別名'))
      .map(s => ({ id: s.id, name: s.name, type: s.type, domain: s.domain, level: s.type === '別名' ? null : this.subjectLevel(s), usage: this.usage.subjects[s.id]?.count || 0, assertions: s.assertions.length }));
    const ids = new Set(nodes.map(n => n.id));
    const edges = [...this.relations.values()].filter(r => relOk(r) && ids.has(r.from) && ids.has(r.to)).map(r => ({ id: r.id, from: r.from, to: r.to, type: r.type, level: r.validity.level }));
    return { nodes, edges };
  }

  /** 術語解析：在文本中找出主體名稱或別名（最長匹配），別名解析為規範主體。 */
  resolveTerms(text) {
    const lower = String(text || '').toLowerCase();
    const hits = [];
    for (const s of this.subjects.values()) {
      for (const term of [s.name, s.id]) {
        if (!term) continue;
        const t = term.toLowerCase();
        let from = 0;
        let idx;
        while ((idx = lower.indexOf(t, from)) !== -1) {
          // 拉丁字母術語需要詞邊界，避免 "ATP" 命中 "ATPX"。
          const before = lower[idx - 1];
          const after = lower[idx + t.length];
          const latin = /^[a-z0-9_-]+$/i.test(t);
          if (!latin || ((!before || !/[a-z0-9]/i.test(before)) && (!after || !/[a-z0-9]/i.test(after)))) hits.push({ start: idx, end: idx + t.length, term: text.substr(idx, t.length), subject: s });
          from = idx + 1;
        }
      }
    }
    hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const taken = [];
    const kept = [];
    for (const h of hits) {
      if (taken.some(([s, e]) => h.start < e && h.end > s)) continue;
      taken.push([h.start, h.end]);
      kept.push(h);
    }
    kept.sort((a, b) => a.start - b.start);
    const canonical = [];
    const ambiguous = [];
    const aliasHits = [];
    for (const h of kept) {
      if (h.subject.type === '別名') {
        const targets = this.aliasTargets(h.subject);
        aliasHits.push({ term: h.term, aliasId: h.subject.id, targets });
        if (targets.length > 1) ambiguous.push({ term: h.term, aliasId: h.subject.id, candidates: targets.map(id => this.subjectSummary(this.subjects.get(id))) });
        else if (targets.length === 1 && !canonical.includes(targets[0])) canonical.push(targets[0]);
      } else if (!canonical.includes(h.subject.id)) canonical.push(h.subject.id);
    }
    return { canonical, ambiguous, aliasHits, matches: kept.map(h => ({ term: h.term, id: h.subject.id, type: h.subject.type, start: h.start, end: h.end })) };
  }

  // ---------------------------------------------------------------- 有效期
  expiryDaysFor(kind, item, subject) {
    if (subject?.expiryDays) return Number(subject.expiryDays);
    const cfg = this.config.expiryDays;
    if (kind === 'assertion') return cfg.assertion[item.type] ?? 90;
    if (kind === 'relation') return cfg.relation[item.type] ?? 90;
    if (kind === 'binding') return cfg.binding[this.objects.get(item.objectId)?.category] ?? 90;
    return 90;
  }

  allValidityItems() {
    const out = [];
    for (const s of this.subjects.values()) {
      for (const a of s.assertions) out.push({ kind: 'assertion', item: a, subject: s });
      for (const b of s.bindings) out.push({ kind: 'binding', item: b, subject: s });
    }
    for (const r of this.relations.values()) out.push({ kind: 'relation', item: r, subject: this.subjects.get(r.from) });
    return out;
  }

  // ---------------------------------------------------------------- 權限輔助
  assertCanContribute(principal) {
    if (!principal) throw new RuleError('需要身份驗證', 401, 'unauthorized');
    if (!principal.isAdmin && !['contributor', 'owner'].includes(principal.role) && principal.kind !== 'pipeline') throw new RuleError('此身份只有消費權限，不能提交知識', 403, 'forbidden');
  }

  assertOwner(principal, subject) {
    if (!principal) throw new RuleError('需要身份驗證', 401, 'unauthorized');
    if (principal.kind === 'agent') throw new RuleError('智能體不能晉升、裁決或判定失效；請由負責人確認或通過 Action 校驗', 403, 'agent_cannot_promote');
    if (principal.kind === 'pipeline') throw new RuleError('管道只能按校驗結果定級自己同步的知識', 403, 'forbidden');
    if (!principal.isAdmin && principal.role !== 'owner') throw new RuleError('只有負責人可以執行此操作', 403, 'forbidden');
    if (!principal.isAdmin && subject?.ownerIds?.length && !subject.ownerIds.includes(principal.id)) throw new RuleError(`你不是 ${subject.id} 的指定負責人`, 403, 'forbidden');
  }

  // ---------------------------------------------------------------- 驗證輔助
  validateEvidence(evidence, t) {
    const e = { objectIds: [], actionId: null, sourceRef: null, ...(evidence || {}) };
    e.objectIds = (Array.isArray(e.objectIds) ? e.objectIds : [e.objectIds]).filter(Boolean).map(String);
    for (const oid of e.objectIds) if (!this.objects.has(oid)) throw new RuleError(`證據客體 ${oid} 不存在；請先登記客體`, 422, 'unknown_object');
    if (e.actionId && !this.actions.has(e.actionId)) throw new RuleError(`Action ${e.actionId} 不存在`, 422, 'unknown_action');
    e.sourceRef = clean(e.sourceRef) || null;
    for (const oid of e.objectIds) if (this.objects.get(oid).status === '下線') t?.warn(`證據客體 ${oid} 已下線`);
    return e;
  }

  buildValidity(input, principal, t) {
    const v = normalizeValidity({});
    v.evidence = this.validateEvidence(input.evidence, t);
    v.invalidReason = clean(input.invalidReason) || null;
    v.replacedBy = clean(input.replacedBy) || null;
    const { level, warnings, method } = capSubmittedLevel({ requested: input.level, principal, validity: v });
    warnings.forEach(w => t.warn(w));
    v.level = level;
    v.method = method;
    v.source = sourceOf(principal);
    v.history = [{ at: nowIso(), from: null, to: level, reason: '提交', by: v.source.id }];
    if (level === 'E1') v.expiresAt = null;
    return v;
  }

  finalizePipelineL0(v, kind, item, subject, principal) {
    if (v.level === 'L0') {
      v.verifiedBy = principal.id;
      v.verifiedAt = nowIso();
      v.expiresAt = addDays(v.verifiedAt, this.expiryDaysFor(kind, item, subject));
    }
  }

  // ---------------------------------------------------------------- 寫操作（在事務內調用）
  createSubject(t, input, principal) {
    this.assertCanContribute(principal);
    const name = clean(input.name);
    if (!name) throw new RuleError('主體名稱必填', 400, 'invalid_input');
    if (!SUBJECT_TYPES[input.type]) throw new RuleError(`主體類型必須為：${Object.keys(SUBJECT_TYPES).join('、')}`, 400, 'invalid_type');
    const dup = [...this.subjects.values()].find(s => s.name.toLowerCase() === name.toLowerCase());
    if (dup) throw new RuleError(`名稱「${name}」已被 ${dup.id}（${dup.type}）使用；同名概念請用別名或更精確的規範名`, 409, 'duplicate_name');
    const domainCode = clean(input.domain) || this.config.domains[0]?.code || 'GEN';
    if (!this.config.domains.some(d => d.code === domainCode)) throw new RuleError(`未知領域 ${domainCode}；可用：${this.config.domains.map(d => d.code).join(', ')}`, 400, 'invalid_domain');
    if (input.type !== '別名' && !clean(input.definition)) t.warn('建議填寫定義：一句話說明它是什麼、不是什麼');
    const id = this.nextId(`${ID_PREFIX.subject}-${domainCode}`);
    const s = {
      id, name, type: input.type, domain: domainCode,
      definition: clean(input.definition) || null,
      owner: clean(input.owner) || null,
      ownerIds: Array.isArray(input.ownerIds) ? input.ownerIds : [],
      errorCost: input.errorCost ? Math.min(5, Math.max(1, Number(input.errorCost))) : 3,
      expiryDays: input.expiryDays ? Number(input.expiryDays) : null,
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      createdAt: nowIso(), updatedAt: nowIso(), createdBy: sourceOf(principal),
      bindings: [], assertions: []
    };
    this.subjects.set(id, s);
    t.touch('subject', id);
    if (s.type === '別名') {
      const targets = Array.isArray(input.aliasOf) ? input.aliasOf : input.aliasOf ? [input.aliasOf] : [];
      if (!targets.length) t.warn('別名主體應通過「別名」關係指向至少一個規範主體（aliasOf）');
      for (const to of targets) this.createRelation(t, { from: id, type: '別名', to, level: input.aliasLevel, evidence: input.evidence }, principal);
    }
    return s;
  }

  updateSubject(t, id, patch, principal) {
    this.assertCanContribute(principal);
    const s = this.getSubject(id);
    if (patch.type && patch.type !== s.type) throw new RuleError('主體類型不可修改；請新建主體並把舊主體相關知識轉為 E1', 409, 'immutable_type');
    if (patch.name !== undefined) {
      const name = clean(patch.name);
      if (!name) throw new RuleError('名稱不可為空', 400);
      const dup = [...this.subjects.values()].find(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase());
      if (dup) throw new RuleError(`名稱「${name}」已被 ${dup.id} 使用`, 409, 'duplicate_name');
      s.name = name;
    }
    for (const k of ['definition', 'owner']) if (patch[k] !== undefined) s[k] = clean(patch[k]) || null;
    if (patch.errorCost !== undefined) s.errorCost = Math.min(5, Math.max(1, Number(patch.errorCost) || 3));
    if (patch.expiryDays !== undefined && Number(patch.expiryDays || 0) !== Number(s.expiryDays || 0)) {
      this.assertOwner(principal, s);
      s.expiryDays = patch.expiryDays ? Number(patch.expiryDays) : null;
    }
    if (patch.ownerIds !== undefined) {
      this.assertOwner(principal, s);
      s.ownerIds = Array.isArray(patch.ownerIds) ? patch.ownerIds : [];
    }
    if (patch.tags !== undefined) s.tags = Array.isArray(patch.tags) ? patch.tags.map(String) : [];
    s.updatedAt = nowIso();
    t.touch('subject', id);
    return s;
  }

  deleteSubject(t, id, principal) {
    if (!principal?.isAdmin) throw new RuleError('只有管理員可以刪除主體（正常情況請將知識轉為 E1，E1 不刪除）', 403, 'forbidden');
    this.getSubject(id);
    for (const r of [...this.relations.values()]) if (r.from === id || r.to === id) { this.relations.delete(r.id); t.remove('relation', r.id); }
    const s = this.subjects.get(id);
    for (const a of s.assertions) this.assertionIndex.delete(a.id);
    for (const b of s.bindings) this.bindingIndex.delete(b.id);
    this.subjects.delete(id);
    t.remove('subject', id);
  }

  createObject(t, input, principal) {
    this.assertCanContribute(principal);
    const name = clean(input.name);
    if (!name) throw new RuleError('客體名稱必填', 400, 'invalid_input');
    if (!OBJECT_CATEGORIES[input.category]) throw new RuleError(`客體類別必須為：${Object.keys(OBJECT_CATEGORIES).join('、')}`, 400, 'invalid_category');
    const locator = clean(input.locator) || null;
    if (locator) {
      const dup = [...this.objects.values()].find(o => o.category === input.category && o.locator === locator && o.status !== '下線');
      if (dup) throw new RuleError(`定位 ${locator} 已登記為 ${dup.id}`, 409, 'duplicate_object');
    }
    const actionIds = (input.actionIds || []).map(String);
    for (const a of actionIds) if (!this.actions.has(a)) throw new RuleError(`Action ${a} 不存在`, 422, 'unknown_action');
    if (input.category === '物理' && actionIds.length) t.warn('物理客體在 MVP 只登記，不接管道');
    const id = this.nextId(ID_PREFIX.object);
    const o = {
      id, name, category: input.category, kind: clean(input.kind) || null, locator,
      description: clean(input.description) || null,
      actionIds, status: OBJECT_STATUS.includes(input.status) ? input.status : '在用',
      createdAt: nowIso(), updatedAt: nowIso(), createdBy: sourceOf(principal)
    };
    this.objects.set(id, o);
    t.touch('object', id);
    return o;
  }

  updateObject(t, id, patch, principal) {
    this.assertCanContribute(principal);
    const o = this.getObject(id);
    const locatorChanged = patch.locator !== undefined && (clean(patch.locator) || null) !== o.locator;
    for (const k of ['name', 'kind', 'locator', 'description']) if (patch[k] !== undefined) o[k] = clean(patch[k]) || null;
    if (locatorChanged) {
      const by = sourceOf(principal).id;
      for (const ref of this.allValidityItems()) {
        const v = ref.item.validity;
        const uses = ref.kind === 'binding' ? ref.item.objectId === o.id : v.evidence.objectIds.includes(o.id);
        if (uses && v.level !== 'E1' && demoteToL1(v, 'object_changed', { by, note: `客體 ${o.id} 定位變更` })) this.touchItem(t, ref);
      }
      t.warn(`客體 ${o.id} 定位已變更：相關綁定與證據知識已降為 L1，需重新校驗或確認`);
    }
    if (patch.actionIds !== undefined) {
      for (const a of patch.actionIds) if (!this.actions.has(a)) throw new RuleError(`Action ${a} 不存在`, 422, 'unknown_action');
      o.actionIds = patch.actionIds;
    }
    if (patch.status !== undefined && patch.status !== o.status) {
      if (!OBJECT_STATUS.includes(patch.status)) throw new RuleError('狀態必須為 在用 / 下線', 400);
      if (patch.status === '下線') this.takeObjectOffline(t, o, patch.reason || '客體下線', principal);
      else { o.status = '在用'; t.warn('客體恢復在用；已轉為 E1 的綁定不會自動恢復，請重新提交綁定'); }
    }
    o.updatedAt = nowIso();
    t.touch('object', id);
    return o;
  }

  /** 客體下線：相關綁定轉為 E1；以它為證據的斷言和關係降為 L1，等待負責人處理。 */
  takeObjectOffline(t, o, reason, principal) {
    o.status = '下線';
    o.offlineAt = nowIso();
    o.offlineReason = reason;
    t.touch('object', o.id);
    const by = sourceOf(principal).id;
    const affected = { bindings: [], demoted: [] };
    for (const ref of this.allValidityItems()) {
      const v = ref.item.validity;
      if (ref.kind === 'binding' && ref.item.objectId === o.id) {
        if (v.level !== 'E1') {
          invalidate(v, { reason: `客體 ${o.id} 已下線：${reason}`, by });
          affected.bindings.push(ref.item.id);
          this.touchItem(t, ref);
        }
      } else if (v.evidence.objectIds.includes(o.id) && v.level !== 'E1') {
        demoteToL1(v, 'object_offline', { by, note: `證據客體 ${o.id} 已下線` });
        affected.demoted.push(ref.item.id);
        this.touchItem(t, ref);
      }
    }
    return affected;
  }

  deleteObject(t, id, principal) {
    if (!principal?.isAdmin) throw new RuleError('只有管理員可以刪除客體（正常情況請標記下線）', 403, 'forbidden');
    this.getObject(id);
    if (this.bindingsOfObject(id).length) throw new RuleError('客體仍被綁定，不能刪除；請改為標記下線', 409, 'in_use');
    this.objects.delete(id);
    t.remove('object', id);
  }

  createBinding(t, subjectId, input, principal) {
    this.assertCanContribute(principal);
    const s = this.getSubject(subjectId);
    if (s.type === '別名') throw new RuleError('別名主體自身不掛客體、斷言或其他關係；知識只掛在規範主體上', 422, 'alias_rule');
    const o = this.getObject(input.objectId);
    if (s.bindings.some(b => b.objectId === o.id && b.validity.level !== 'E1')) throw new RuleError(`${s.id} 已綁定客體 ${o.id}`, 409, 'duplicate_binding');
    const evidence = { ...(input.evidence || {}), objectIds: [o.id, ...((input.evidence?.objectIds) || []).filter(x => x !== o.id)] };
    const b = { id: this.nextId(ID_PREFIX.binding), objectId: o.id, note: clean(input.note) || null, createdAt: nowIso() };
    b.validity = this.buildValidity({ ...input, evidence }, principal, t);
    if (o.status === '下線' && b.validity.level !== 'E1') invalidate(b.validity, { reason: `客體 ${o.id} 已下線`, by: sourceOf(principal).id });
    this.finalizePipelineL0(b.validity, 'binding', b, s, principal);
    s.bindings.push(b);
    this.bindingIndex.set(b.id, s.id);
    s.updatedAt = nowIso();
    t.touch('subject', s.id);
    return b;
  }

  createAssertion(t, subjectId, input, principal) {
    this.assertCanContribute(principal);
    const s = this.getSubject(subjectId);
    if (s.type === '別名') throw new RuleError('別名主體自身不掛客體、斷言或其他關係；請把斷言掛在規範主體上', 422, 'alias_rule');
    if (!ASSERTION_TYPES[input.type]) throw new RuleError(`斷言類型必須為：${Object.keys(ASSERTION_TYPES).join('、')}`, 400, 'invalid_type');
    const content = clean(input.content);
    if (!content) throw new RuleError('斷言內容必填（自然語言一句話）', 400, 'invalid_input');
    if ((content.match(/[。；;]/g) || []).length > 1) t.warn('一條斷言只說一件事；內容看起來包含多個陳述，建議拆分以便單獨驗證、單獨失效');
    const dup = s.assertions.find(a => a.content === content && a.validity.level !== 'E1');
    if (dup) throw new RuleError(`相同內容的斷言已存在：${dup.id}`, 409, 'duplicate_assertion');
    if (input.replacedBy && !this.assertionIndex.has(input.replacedBy)) throw new RuleError(`替代者 ${input.replacedBy} 不存在`, 422, 'unknown_replacement');
    const a = { id: this.nextId(ID_PREFIX.assertion), type: input.type, content, structured: input.structured && input.structured.key ? { key: String(input.structured.key), value: input.structured.value } : null, createdAt: nowIso() };
    a.validity = this.buildValidity(input, principal, t);
    const bound = new Set(s.bindings.map(b => b.objectId));
    for (const oid of a.validity.evidence.objectIds) if (!bound.has(oid)) t.warn(`證據客體 ${oid} 尚未綁定到 ${s.id}；斷言的證據通常是主體已綁定的客體`);
    this.finalizePipelineL0(a.validity, 'assertion', a, s, principal);
    s.assertions.push(a);
    this.assertionIndex.set(a.id, s.id);
    s.updatedAt = nowIso();
    t.touch('subject', s.id);
    return a;
  }

  updateAssertion(t, id, patch, principal) {
    this.assertCanContribute(principal);
    const ref = this.getItem(id);
    if (ref.kind !== 'assertion') throw new RuleError(`${id} 不是斷言`, 400);
    const a = ref.item;
    if (a.validity.level === 'E1') throw new RuleError('E1 知識不修改；請提交新斷言作為替代者', 409, 'invalid_transition');
    let changed = false;
    if (patch.content !== undefined && clean(patch.content) !== a.content) { a.content = clean(patch.content); changed = true; }
    if (patch.structured !== undefined) { a.structured = patch.structured?.key ? { key: String(patch.structured.key), value: patch.structured.value } : null; changed = true; }
    if (patch.type !== undefined && patch.type !== a.type) {
      if (!ASSERTION_TYPES[patch.type]) throw new RuleError('未知斷言類型', 400);
      a.type = patch.type; changed = true;
    }
    if (changed && principal.kind !== 'pipeline') {
      const ceiling = hasEvidence(a.validity) ? 'L1' : 'L2';
      if (a.validity.level === 'L0' || a.validity.level === 'L1') {
        if (a.validity.level !== ceiling) transition(a.validity, ceiling, { reason: '內容修改，需重新驗證', by: sourceOf(principal).id });
        if (a.validity.level === 'L1') setPending(a.validity, 'object_changed', '內容修改，需重新驗證');
        t.warn(`內容已修改，層級調整為 ${a.validity.level}，需重新校驗或確認`);
      }
    }
    a.updatedAt = nowIso();
    ref.subject.updatedAt = nowIso();
    t.touch('subject', ref.subject.id);
    return a;
  }

  createRelation(t, input, principal) {
    this.assertCanContribute(principal);
    const def = RELATION_TYPES[input.type];
    if (!def) throw new RuleError(`關係類型必須為閉集之一：${Object.keys(RELATION_TYPES).join('、')}；新增類型須經負責人評審`, 400, 'invalid_relation_type');
    const from = this.getSubject(input.from);
    const to = this.getSubject(input.to);
    if (from.id === to.id) throw new RuleError('關係的起點與終點不能相同', 422, 'self_relation');
    if (from.type === '別名' && input.type !== '別名') throw new RuleError('別名主體只通過「別名」關係指向規範主體', 422, 'alias_rule');
    if (!def.from.includes(from.type) || !def.to.includes(to.type)) {
      throw new RuleError(`「${input.type}」的方向為 ${def.direction}；${from.name}（${from.type}）→ ${to.name}（${to.type}）不符合`, 422, 'relation_direction');
    }
    const dup = [...this.relations.values()].find(r => r.from === from.id && r.to === to.id && r.type === input.type && r.validity.level !== 'E1');
    if (dup) throw new RuleError(`關係已存在：${dup.id}`, 409, 'duplicate_relation');
    const r = { id: this.nextId(ID_PREFIX.relation), from: from.id, type: input.type, to: to.id, note: clean(input.note) || null, createdAt: nowIso() };
    r.validity = this.buildValidity(input, principal, t);
    if (r.type === '擁有' && r.validity.level === 'L0') this.assertSingleOwner(r);
    this.finalizePipelineL0(r.validity, 'relation', r, from, principal);
    this.relations.set(r.id, r);
    t.touch('relation', r.id);
    return r;
  }

  deleteRelation(t, id, principal) {
    if (!principal?.isAdmin) throw new RuleError('只有管理員可以刪除關係（正常情況請轉為 E1）', 403, 'forbidden');
    if (!this.relations.has(id)) throw notFound('關係', id);
    this.relations.delete(id);
    t.remove('relation', id);
  }

  assertSingleOwner(r) {
    const other = [...this.relations.values()].find(x => x.id !== r.id && x.type === '擁有' && x.to === r.to && x.validity.level === 'L0');
    if (other) throw new RuleError(`每個業務對象或指標原則上只有一條 L0「擁有」關係；${r.to} 已有 ${other.id}。請先登記衝突並裁決`, 409, 'single_owner');
  }

  /** 補充證據：L2 → L1。 */
  addEvidence(t, id, input, principal) {
    this.assertCanContribute(principal);
    const ref = this.getItem(id);
    const v = ref.item.validity;
    if (v.level === 'E1') throw new RuleError('E1 知識不再補充證據', 409, 'invalid_transition');
    const extra = this.validateEvidence(input, t);
    v.evidence.objectIds = [...new Set([...v.evidence.objectIds, ...extra.objectIds])];
    if (extra.sourceRef) v.evidence.sourceRef = extra.sourceRef;
    if (extra.actionId) v.evidence.actionId = extra.actionId;
    if (v.level === 'L2' && hasEvidence(v)) transition(v, 'L1', { reason: '補充客體證據', by: sourceOf(principal).id });
    this.touchItem(t, ref);
    return { id, level: v.level, evidence: v.evidence };
  }

  /** 負責人確認：L1 → L0（或續期）。智能體不能晉升。 */
  confirm(t, id, input, principal) {
    const ref = this.getItem(id);
    this.assertOwner(principal, ref.subject);
    const v = ref.item.validity;
    if (ref.kind === 'binding' && this.objects.get(ref.item.objectId)?.status === '下線') throw new RuleError('客體已下線，綁定不能晉升', 409, 'object_offline');
    if (ref.kind === 'relation' && ref.item.type === '擁有') this.assertSingleOwner(ref.item);
    const at = nowIso();
    const days = Number(input?.expiryDays) || this.expiryDaysFor(ref.kind, ref.item, ref.subject);
    promoteToL0(v, { method: 'manual', by: principal.id, expiresAt: addDays(at, days), note: clean(input?.note), at });
    this.touchItem(t, ref);
    this.resolveFeedbackFor(t, id, `負責人 ${principal.name || principal.id} 已確認`);
    return { id, level: v.level, expiresAt: v.expiresAt };
  }

  /** 判定失效：→ E1，保留並指向替代者。 */
  invalidateItem(t, id, input, principal) {
    const ref = this.getItem(id);
    this.assertOwner(principal, ref.subject);
    if (input?.replacedBy) this.getItem(input.replacedBy);
    invalidate(ref.item.validity, { reason: clean(input?.reason), replacedBy: clean(input?.replacedBy), by: principal.id });
    this.touchItem(t, ref);
    this.resolveFeedbackFor(t, id, `負責人判定失效：${input?.reason}`);
    return { id, level: 'E1', replacedBy: ref.item.validity.replacedBy };
  }

  /** Action 校驗結果寫回有效性。 */
  applyValidationResult(t, id, { outcome, actionId, detail, objectId }, principal) {
    const ref = this.getItem(id);
    const v = ref.item.validity;
    const by = actionId || sourceOf(principal).id;
    let effect = 'none';
    if (outcome === 'pass') {
      if (v.level === 'E1') effect = 'skipped_e1';
      else {
        if (objectId && !v.evidence.objectIds.includes(objectId)) v.evidence.objectIds.push(objectId);
        const at = nowIso();
        promoteToL0(v, { method: 'auto', by, actionId, expiresAt: addDays(at, this.expiryDaysFor(ref.kind, ref.item, ref.subject)), at });
        effect = 'promoted_L0';
      }
    } else if (outcome === 'mismatch') {
      if (demoteToL1(v, 'mismatch', { by, note: detail })) effect = 'demoted_L1';
    } else if (outcome === 'missing' && objectId) {
      const res = this.takeObjectOffline(t, this.getObject(objectId), `校驗發現客體不存在：${detail || ''}`, principal);
      effect = 'object_offline';
      this.touchItem(t, ref);
      return { id, effect, level: v.level, affected: res };
    }
    v.lastCheck = { at: nowIso(), actionId, outcome, detail: detail || null };
    this.touchItem(t, ref);
    return { id, effect, level: v.level };
  }

  // ---------------------------------------------------------------- 衝突、反饋、缺口
  reportConflict(t, input, principal) {
    this.assertCanContribute(principal);
    const a = this.getItem(input.a);
    const b = this.getItem(input.b);
    if (a.item.id === b.item.id) throw new RuleError('衝突的兩條知識不能相同', 400);
    const by = sourceOf(principal).id;
    const id = this.nextId(ID_PREFIX.conflict);
    for (const ref of [a, b]) {
      if (ref.item.validity.level === 'E1') throw new RuleError(`${ref.item.id} 已是 E1，不參與衝突`, 409);
      demoteToL1(ref.item.validity, 'conflict', { by, note: `與 ${(ref === a ? b : a).item.id} 矛盾（${id}）` });
      this.touchItem(t, ref);
    }
    const c = { id, a: a.item.id, b: b.item.id, note: clean(input.note) || null, status: 'open', createdAt: nowIso(), reportedBy: sourceOf(principal), subjects: [...new Set([a.subject?.id, b.subject?.id].filter(Boolean))] };
    this.conflicts.set(id, c);
    t.touch('conflict', id);
    return c;
  }

  /** 裁決衝突：一方回到 L0，另一方轉為 E1。 */
  resolveConflict(t, id, input, principal) {
    const c = this.conflicts.get(id);
    if (!c) throw notFound('衝突', id);
    if (c.status !== 'open') throw new RuleError('衝突已裁決', 409);
    const winnerId = input.winner;
    if (![c.a, c.b].includes(winnerId)) throw new RuleError('winner 必須是衝突雙方之一', 400);
    const loserId = winnerId === c.a ? c.b : c.a;
    const winner = this.getItem(winnerId);
    const loser = this.getItem(loserId);
    this.assertOwner(principal, winner.subject);
    const at = nowIso();
    promoteToL0(winner.item.validity, { method: 'manual', by: principal.id, expiresAt: addDays(at, this.expiryDaysFor(winner.kind, winner.item, winner.subject)), note: `裁決 ${id}`, at });
    invalidate(loser.item.validity, { reason: clean(input.reason) || `衝突裁決 ${id}：以 ${winnerId} 為準`, replacedBy: winnerId, by: principal.id });
    this.touchItem(t, winner);
    this.touchItem(t, loser);
    Object.assign(c, { status: 'resolved', winner: winnerId, loser: loserId, resolvedAt: at, resolvedBy: sourceOf(principal), reason: clean(input.reason) || null });
    t.touch('conflict', id);
    return c;
  }

  submitFeedback(t, input, principal) {
    if (!principal) throw new RuleError('需要身份驗證', 401, 'unauthorized');
    const targetId = clean(input.targetId);
    const comment = clean(input.comment);
    if (!targetId || !comment) throw new RuleError('targetId 與 comment 必填', 400, 'invalid_input');
    let wasLevel = null;
    let subjectId = null;
    const kind = kindOfId(targetId);
    if (kind === 'subject') { this.getSubject(targetId); subjectId = targetId; }
    else {
      const ref = this.getItem(targetId);
      wasLevel = ref.item.validity.level;
      subjectId = ref.subject?.id || null;
      if (wasLevel !== 'E1') {
        demoteToL1(ref.item.validity, 'feedback', { by: sourceOf(principal).id, note: comment });
        this.touchItem(t, ref);
      }
    }
    const f = { id: this.nextId(ID_PREFIX.feedback), targetId, subjectId, comment, question: clean(input.question) || null, wasLevel, status: 'open', createdAt: nowIso(), source: sourceOf(principal) };
    this.feedback.set(f.id, f);
    t.touch('feedback', f.id);
    return f;
  }

  resolveFeedbackFor(t, targetId, resolution) {
    for (const f of this.feedback.values()) {
      if (f.targetId === targetId && f.status === 'open') {
        f.status = 'resolved';
        f.resolution = resolution;
        f.resolvedAt = nowIso();
        t.touch('feedback', f.id);
      }
    }
  }

  closeFeedback(t, id, input, principal) {
    const f = this.feedback.get(id);
    if (!f) throw notFound('反饋', id);
    if (principal.kind === 'agent') throw new RuleError('智能體不能關閉反饋', 403, 'forbidden');
    f.status = 'resolved';
    f.resolution = clean(input?.resolution) || '已處理';
    f.resolvedAt = nowIso();
    t.touch('feedback', id);
    return f;
  }

  /** 未收錄：記為知識缺口（延遲提交，避免每次查詢一個提交）。 */
  recordGap({ question, subjectIds = [], principal, reason }) {
    const norm = normalizeText(question).slice(0, 200);
    if (!norm) return null;
    let g = [...this.gaps.values()].find(x => x.normalized === norm && x.status === 'open');
    const at = nowIso();
    if (!g) {
      g = { id: this.nextId(ID_PREFIX.gap), question: String(question).slice(0, 500), normalized: norm, subjectIds, reason: reason || null, status: 'open', count: 0, occurrences: [], firstAt: at, lastAt: at };
      this.gaps.set(g.id, g);
    }
    g.count += 1;
    g.lastAt = at;
    g.occurrences = [...(g.occurrences || []), { at, by: sourceOf(principal).id }].slice(-50);
    g.subjectIds = [...new Set([...(g.subjectIds || []), ...subjectIds])];
    this.lazyDirty.add(`gap:${g.id}`);
    return g;
  }

  closeGap(t, id, input) {
    const g = this.gaps.get(id);
    if (!g) throw notFound('知識缺口', id);
    g.status = 'resolved';
    g.resolution = clean(input?.resolution) || '已補充知識';
    g.resolvedAt = nowIso();
    t.touch('gap', id);
    return g;
  }

  recordUsage(subjectIds) {
    const at = nowIso();
    for (const id of new Set(subjectIds)) {
      if (!this.subjects.has(id)) continue;
      const u = (this.usage.subjects[id] ||= { count: 0, lastAt: null, recent: [] });
      u.count += 1;
      u.lastAt = at;
      u.recent = [...(u.recent || []), at].slice(-100);
    }
    this.lazyDirty.add('usage');
  }

  // ---------------------------------------------------------------- Action 與管道
  upsertPipeline(t, input, principal) {
    this.assertOwner(principal);
    if (!PIPELINE_TYPES[input.type]) throw new RuleError(`管道類型必須為：${Object.keys(PIPELINE_TYPES).join('、')}`, 400);
    if (!clean(input.name)) throw new RuleError('管道名稱必填', 400);
    if (input.type === 'http' && !/^https?:\/\//.test(input.baseUrl || '')) throw new RuleError('http 管道需要 baseUrl（http/https）', 400);
    for (const v of Object.values(input.headers || {})) if (/^(bearer|basic)\s+[a-z0-9._-]{12,}/i.test(String(v)) && !String(v).includes('${env:')) throw new RuleError('請勿把憑證明文寫入知識倉庫；使用 ${env:變數名} 引用環境變數', 400, 'secret_in_repo');
    const id = input.id && this.pipelines.has(input.id) ? input.id : this.nextId(ID_PREFIX.pipeline);
    const p = { id, name: clean(input.name), type: input.type, description: clean(input.description) || null, baseUrl: clean(input.baseUrl) || null, headers: input.headers || {}, timeoutMs: Number(input.timeoutMs) || 8000, routes: Array.isArray(input.routes) ? input.routes : [], updatedAt: nowIso() };
    this.pipelines.set(id, p);
    t.touch('pipeline', id);
    return p;
  }

  upsertAction(t, input, principal) {
    this.assertOwner(principal);
    if (!ACTION_KINDS[input.kind]) throw new RuleError('Action 種類必須為 校驗 / 取值（MVP 只讀不寫）', 400);
    if (!clean(input.name)) throw new RuleError('Action 名稱必填', 400);
    if (!this.pipelines.has(input.pipelineId)) throw new RuleError(`管道 ${input.pipelineId} 不存在`, 422);
    if (input.request?.method && !['GET', 'HEAD', 'POST'].includes(String(input.request.method).toUpperCase())) throw new RuleError('MVP 只讀：請求方法限 GET / HEAD / POST（查詢類）', 400);
    const id = input.id && this.actions.has(input.id) ? input.id : this.nextId(ID_PREFIX.action);
    const a = {
      id, name: clean(input.name), kind: input.kind, description: clean(input.description) || null,
      objectKinds: Array.isArray(input.objectKinds) ? input.objectKinds : [],
      pipelineId: input.pipelineId,
      request: { method: (input.request?.method || 'GET').toUpperCase(), path: input.request?.path || '/', query: input.request?.query || {}, body: input.request?.body ?? null },
      inputs: Array.isArray(input.inputs) ? input.inputs : [],
      output: input.output || null,
      check: input.kind === '校驗' ? { mode: input.check?.mode || 'exists' } : null,
      permission: ['consumer', 'contributor', 'owner'].includes(input.permission) ? input.permission : 'consumer',
      updatedAt: nowIso()
    };
    this.actions.set(id, a);
    t.touch('action', id);
    return a;
  }

  // ---------------------------------------------------------------- 保鮮觸發器
  /** 時間觸發：L0 有效期到期 → L1，排入重驗隊列。 */
  expirySweep(t, now = Date.now()) {
    const expired = [];
    for (const ref of this.allValidityItems()) {
      if (isExpired(ref.item.validity, now)) {
        demoteToL1(ref.item.validity, 'expired', { by: 'system', note: `有效期至 ${ref.item.validity.expiresAt}` });
        this.touchItem(t, ref);
        expired.push(ref.item.id);
      }
    }
    return expired;
  }

  updateConfig(t, patch, principal) {
    if (!principal?.isAdmin) throw new RuleError('只有管理員可以修改規則參數', 403, 'forbidden');
    if (patch.domains) {
      if (!Array.isArray(patch.domains) || patch.domains.some(d => !/^[A-Z]{2,6}$/.test(d.code) || !d.name)) throw new RuleError('領域代碼須為 2–6 個大寫字母，並有名稱', 400);
      this.config.domains = patch.domains;
    }
    if (patch.expiryDays) {
      for (const k of ['assertion', 'relation', 'binding']) Object.assign(this.config.expiryDays[k], patch.expiryDays[k] || {});
    }
    if (patch.highFrequencyRatio !== undefined) this.config.highFrequencyRatio = Math.min(1, Math.max(0.01, Number(patch.highFrequencyRatio)));
    if (patch.validationIntervalHours !== undefined) this.config.validationIntervalHours = Math.max(0, Number(patch.validationIntervalHours));
    t.configChanged = true;
    return this.config;
  }

  // ---------------------------------------------------------------- 治理視圖
  revalidationQueue() {
    const out = [];
    for (const ref of this.allValidityItems()) {
      const v = ref.item.validity;
      if (!v.pending || v.level === 'E1') continue;
      const usage = this.usage.subjects[ref.subject?.id]?.count || 0;
      const cost = ref.subject?.errorCost ?? 3;
      out.push({
        id: ref.item.id, kind: ref.kind, level: v.level, pending: v.pending,
        subject: this.subjectSummary(ref.subject),
        summary: ref.kind === 'assertion' ? ref.item.content : ref.kind === 'binding' ? `綁定客體 ${ref.item.objectId}（${this.objects.get(ref.item.objectId)?.name || '?'}）` : `${this.subjects.get(ref.item.from)?.name} –${ref.item.type}→ ${this.subjects.get(ref.item.to)?.name}`,
        usage, errorCost: cost, priority: (usage + 1) * cost,
        hasValidateAction: !!(v.evidence.actionId || this.findValidateAction(ref))
      });
    }
    return out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }

  /**
   * 校驗 Action 是否足以證明該條目：
   *  - 綁定：客體存在即可（exists）。
   *  - 斷言：必須比對內容（equals + 斷言帶結構化值）；客體存在不代表陳述正確。
   *  - 關係：exists 且請求模板引用了關係本身（{item.from} / {item.to} 等）。
   */
  actionSuits(action, ref) {
    if (action?.kind !== '校驗') return false;
    const mode = action.check?.mode || 'exists';
    if (ref.kind === 'binding') return mode === 'exists';
    if (ref.kind === 'assertion') return mode === 'equals' && !!ref.item.structured;
    if (ref.kind === 'relation') return mode === 'exists' && JSON.stringify(action.request || {}).includes('{item.');
    return false;
  }

  findValidateAction(ref) {
    const v = ref.item.validity;
    const objectIds = ref.kind === 'binding' ? [ref.item.objectId] : v.evidence.objectIds;
    const preferred = v.evidence.actionId && this.actions.get(v.evidence.actionId);
    if (preferred && this.actionSuits(preferred, ref)) {
      const oid = objectIds.find(id => this.objects.get(id)?.actionIds?.includes(preferred.id)) || objectIds[0];
      if (oid) return { action: preferred, objectId: oid };
    }
    for (const oid of objectIds) {
      const o = this.objects.get(oid);
      if (!o || o.status === '下線') continue;
      for (const aid of o.actionIds || []) {
        const a = this.actions.get(aid);
        if (this.actionSuits(a, ref)) return { action: a, objectId: oid };
      }
    }
    return null;
  }

  levelDistribution() {
    const dist = { binding: {}, assertion: {}, relation: {} };
    for (const k of Object.keys(dist)) for (const l of Object.keys(LEVEL_RANK)) dist[k][l] = 0;
    for (const ref of this.allValidityItems()) dist[ref.kind][ref.item.validity.level] += 1;
    const subjects = { L0: 0, L1: 0, L2: 0 };
    for (const s of this.subjects.values()) if (s.type !== '別名') subjects[this.subjectLevel(s)] += 1;
    return { ...dist, subject: subjects };
  }

  /** 健康指標（試點期每週查看）。 */
  health({ windowDays = 7 } = {}) {
    const since = Date.now() - windowDays * 86400000;
    const canonical = [...this.subjects.values()].filter(s => s.type !== '別名');
    const used = canonical.map(s => ({ s, count: this.usage.subjects[s.id]?.count || 0 })).filter(x => x.count > 0).sort((a, b) => b.count - a.count);
    const ratio = this.config.highFrequencyRatio || 0.2;
    const hot = used.length ? used.slice(0, Math.max(1, Math.ceil(used.length * ratio))).map(x => x.s) : canonical;
    const hasL0 = s => this.subjectLevel(s) === 'L0' || s.assertions.some(a => a.validity.level === 'L0');
    const covered = hot.filter(hasL0).length;
    const gaps = [...this.gaps.values()];
    const fb = [...this.feedback.values()];
    const queue = this.revalidationQueue();
    return {
      l0Coverage: { value: hot.length ? covered / hot.length : null, covered, total: hot.length, basis: used.length ? `被高頻問到的前 ${Math.round(ratio * 100)}% 主體` : '尚無使用數據，按全部規範主體計算' },
      pendingRevalidation: { value: queue.length, byReason: queue.reduce((m, q) => ({ ...m, [q.pending.reason]: (m[q.pending.reason] || 0) + 1 }), {}) },
      uncoveredQueries: { value: gaps.reduce((n, g) => n + (g.occurrences || []).filter(o => Date.parse(o.at) >= since).length, 0), total: gaps.reduce((n, g) => n + (g.count || 0), 0), openGaps: gaps.filter(g => g.status === 'open').length },
      l0ErrorFeedback: { value: fb.filter(f => f.wasLevel === 'L0' && Date.parse(f.createdAt) >= since).length, total: fb.filter(f => f.wasLevel === 'L0').length },
      windowDays,
      totals: { subjects: canonical.length, aliases: this.subjects.size - canonical.length, objects: this.objects.size, relations: this.relations.size, assertions: canonical.reduce((n, s) => n + s.assertions.length, 0), actions: this.actions.size, pipelines: this.pipelines.size, openConflicts: [...this.conflicts.values()].filter(c => c.status === 'open').length, openFeedback: fb.filter(f => f.status === 'open').length },
      levels: this.levelDistribution(),
      topSubjects: used.slice(0, 10).map(x => ({ ...this.subjectSummary(x.s), usage: x.count, hasL0: hasL0(x.s) }))
    };
  }
}

const KNOWLEDGE_README = `# 私有領域知識庫

本目錄由「供應鏈技術知識體系」服務自動維護，也可以直接在 Git 中審閱與編輯（服務會定期拉取並重新載入）。

| 路徑 | 內容 |
| --- | --- |
| \`config.yaml\` | 領域代碼、有效期初值等規則參數 |
| \`subjects/S-*.yaml\` | 主體；其下掛「客體綁定 bindings」與「斷言 assertions」 |
| \`objects/O-*.yaml\` | 客體（數字 / 制度 / 物理） |
| \`relations/R-*.yaml\` | 主體之間的關係（10 種閉集），帶有效性 |
| \`actions/ACT-*.yaml\` | Action（校驗 / 取值，只讀） |
| \`pipelines/P-*.yaml\` | 管道（數據源連接；憑證以 \`\${env:變數}\` 引用，不入庫） |
| \`governance/\` | 衝突、反饋、知識缺口 |
| \`stats/usage.yaml\` | 主體被使用次數（用於重驗優先級與 L0 覆蓋率） |

有效性層級：L0 可靠 / L1 參考 / L2 探索 / E1 失效。人或智能體提交的知識最高 L1；
L0 只能通過 Action 校驗或負責人確認晉升。E1 不刪除。
`;
