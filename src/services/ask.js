// 消費型問答：按「智能體使用規約」處理一個問題，返回結構化知識 + 自然語言答案。
// 1 解析術語（別名 → 規範主體，多義先消歧） 2 判斷動態值（調用取值 Action） 3 按層級作答
// 4 引用 ID 與層級 5 未收錄就說未收錄並記為知識缺口 6 接收反饋（見 feedback API）
import { LEVEL_INFO, LEVEL_RANK } from '../store/model.js';
import { RuleError } from '../store/validity.js';

const DYNAMIC_RE = /多少|幾個|几个|幾件|几件|還有|还有|剩餘|剩余|當前|当前|目前|現在|现在|實時|实时|此刻|狀態|状态|在途|餘量|余量|how many|current|status/i;
const HISTORY_RE = /以前|之前|過去|过去|曾經|曾经|原來|原来|舊|旧|改成|變更|变更|歷史|历史|是不是不|previous|used to/i;
const DEFINITION_RE = /是什麼|是什么|什麼是|什么是|指什麼|指什么|怎麼算|怎么算|如何計算|如何计算|怎麼計算|怎么计算|定義|定义|口徑|口径|含義|含义|意思|what is|how .*calculat/i;
const STOP_PHRASES = ['是什麼', '是什么', '什麼是', '什么是', '指什麼', '指什么', '怎麼算', '怎么算', '如何計算', '如何计算', '怎麼', '怎么', '什麼', '什么', '為什麼', '为什么', '多少', '多久', '會不會', '会不会', '能不能', '可不可以', '可以', '是不是', '有沒有', '有没有', '請問', '请问', '一下', '嗎', '吗', '呢', '吧', '啊'];
const STOP_CHARS = new Set([...'的了是在有和與与及或也都就還还會会能要把被從从到對对為为於于個个這这那哪些麼么樣样何請请問问一下幾几啥誰谁裡里時候嗎吗呢吧啊會出現']);

const LEVEL_LABEL = { L0: 'L0 可靠', L1: 'L1 參考，未經驗證', L2: 'L2 探索，僅供拓展思路，不作結論', E1: 'E1 已失效' };

function residualOf(question, terms) {
  let r = String(question || '');
  for (const t of [...terms].sort((a, b) => b.length - a.length)) if (t) r = r.split(t).join(' ');
  for (const p of STOP_PHRASES) r = r.split(p).join(' ');
  r = r.replace(/SKU-\d+/gi, ' ');
  return r;
}

function tokensOf(text) {
  const t = String(text || '').toLowerCase();
  const chars = new Set([...t.replace(/[^\p{Script=Han}]/gu, '')].filter(c => !STOP_CHARS.has(c)));
  const bigrams = new Set();
  for (const seg of t.split(/[^\p{Script=Han}]+/u)) for (let i = 0; i + 1 < seg.length; i++) bigrams.add(seg.slice(i, i + 2));
  const words = new Set((t.match(/[a-z][a-z0-9_.]{1,}/g) || []));
  return { chars, bigrams, words };
}

function overlapScore(q, text) {
  const lower = String(text || '').toLowerCase();
  let score = 0;
  for (const b of q.bigrams) if (lower.includes(b)) score += 2;
  for (const c of q.chars) if (lower.includes(c)) score += 1;
  for (const w of q.words) if (lower.includes(w)) score += 2;
  return score;
}

export class AskService {
  constructor({ store, actions, llm, logger = console }) {
    this.store = store;
    this.actions = actions;
    this.llm = llm;
    this.logger = logger;
  }

  /** 沒有精確命中時：名稱前綴模糊匹配（例如「可售」→「可售庫存」）。 */
  fuzzyResolve(question, spans = []) {
    const q = String(question || '');
    const scored = [];
    const free = (start, end) => !spans.some(([s, e]) => start < e && end > s);
    for (const s of this.store.subjects.values()) {
      const name = s.name;
      if (!name || name.length < 3) continue;
      outer: for (let len = name.length - 1; len >= Math.max(2, Math.ceil(name.length / 2)); len--) {
        const prefix = name.slice(0, len);
        let from = 0;
        let idx;
        while ((idx = q.indexOf(prefix, from)) !== -1) {
          if (free(idx, idx + len)) { scored.push({ s, len }); break outer; }
          from = idx + 1;
        }
      }
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.len - a.len);
    const best = scored.filter(x => x.len === scored[0].len);
    const ids = [];
    const ambiguous = [];
    const resolveOne = s => (s.type === '別名' ? this.store.aliasTargets(s) : [s.id]);
    const all = [...new Set(best.flatMap(x => resolveOne(x.s)))];
    if (all.length === 1) ids.push(all[0]);
    else if (all.length > 1) ambiguous.push({ term: best[0].s.name.slice(0, best[0].len), aliasId: null, candidates: all.map(id => this.store.subjectSummary(this.store.subjects.get(id))) });
    return { canonical: ids, ambiguous, fuzzy: best.map(x => ({ term: x.s.name.slice(0, x.len), id: x.s.id })) };
  }

  async llmPickSubjects(question) {
    if (!this.llm?.enabled) return [];
    const catalog = [...this.store.subjects.values()].slice(0, 400).map(s => `${s.id}\t${s.name}\t${s.type}`).join('\n');
    try {
      const { json } = await this.llm.chatJson({
        messages: [
          { role: 'system', content: '你負責把問題中的術語對應到知識庫主體目錄。只能從目錄中選擇；沒有對應就返回空陣列。輸出 JSON：{"subjectIds": ["S-..."]}' },
          { role: 'user', content: `目錄（ID\t名稱\t類型）：\n${catalog}\n\n問題：${question}` }
        ],
        maxTokens: 200
      });
      const ids = Array.isArray(json?.subjectIds) ? json.subjectIds.filter(id => this.store.subjects.has(id)) : [];
      const out = new Set();
      for (const id of ids) {
        const s = this.store.subjects.get(id);
        if (s.type === '別名') this.store.aliasTargets(s).forEach(x => out.add(x));
        else out.add(id);
      }
      return [...out];
    } catch (err) {
      this.logger.warn?.(`[ask] LLM 術語解析失敗：${err.message}`);
      return [];
    }
  }

  extractInputs(action, question, given = {}) {
    const inputs = { ...given };
    for (const def of action.inputs || []) {
      if (inputs[def.name]) continue;
      if (def.pattern) {
        const m = new RegExp(def.pattern, 'i').exec(question);
        if (m) { inputs[def.name] = m[0].toUpperCase(); continue; }
      }
      if (def.fromObjects) {
        const objs = [...this.store.objects.values()].filter(o => o.category === def.fromObjects && o.status !== '下線');
        const hit = objs.filter(o => question.includes(o.name)).sort((a, b) => b.name.length - a.name.length)[0];
        if (hit) inputs[def.name] = hit.locator || hit.name;
      }
    }
    return inputs;
  }

  async llmExtractInputs(action, question, inputs) {
    if (!this.llm?.enabled) return inputs;
    const missing = (action.inputs || []).filter(d => d.required && !inputs[d.name]);
    if (!missing.length) return inputs;
    const options = {};
    for (const d of missing) if (d.fromObjects) options[d.name] = [...this.store.objects.values()].filter(o => o.category === d.fromObjects).map(o => ({ value: o.locator || o.name, name: o.name }));
    try {
      const { json } = await this.llm.chatJson({
        messages: [
          { role: 'system', content: '從問題中抽取 API 參數。只能使用問題中明確出現的信息；不確定就留空。輸出 JSON：{"inputs": {"參數名": "值"}}' },
          { role: 'user', content: JSON.stringify({ question, parameters: missing.map(d => ({ name: d.name, label: d.label, pattern: d.pattern || null, options: options[d.name] || null })) }) }
        ],
        maxTokens: 200
      });
      return { ...inputs, ...Object.fromEntries(Object.entries(json?.inputs || {}).filter(([k, v]) => v && missing.some(d => d.name === k))) };
    } catch {
      return inputs;
    }
  }

  /** 為作答挑選條目：按相關度與層級排序。 */
  selectItems(card, qTokens, intents) {
    const items = [];
    for (const a of card.assertions) items.push({ id: a.id, kind: 'assertion', type: a.type, level: a.level, text: a.content, structured: a.structured, replacedBy: a.replacedBy, invalidReason: a.invalidReason, score: overlapScore(qTokens, `${a.type} ${a.content} ${a.structured ? a.structured.key + ' ' + a.structured.value : ''}`) });
    for (const r of [...card.relations.outgoing, ...card.relations.incoming]) {
      const text = `${r.from?.name} –${r.type}→ ${r.to?.name}`;
      items.push({ id: r.id, kind: 'relation', type: r.type, level: r.level, text, score: overlapScore(qTokens, `${r.type} ${r.from?.name} ${r.to?.name}`) });
    }
    for (const b of card.bindings) items.push({ id: b.id, kind: 'binding', type: b.object?.category, level: b.level, text: `客體：${b.object?.name}${b.object?.locator ? `（${b.object.locator}）` : ''}`, score: overlapScore(qTokens, `${b.object?.name} ${b.object?.locator || ''} ${b.object?.kind || ''}`) });
    const hasResidual = qTokens.chars.size + qTokens.bigrams.size + qTokens.words.size > 0;
    let selected;
    if (!hasResidual || (intents.definition && !intents.history)) {
      selected = items.filter(i => i.kind === 'assertion' && i.type === '定義' && i.level !== 'E1');
      if (hasResidual) selected = [...selected, ...items.filter(i => i.score > 0 && i.level !== 'E1' && !selected.includes(i))];
    } else {
      selected = items.filter(i => i.score > 0 && (i.level !== 'E1' || intents.history));
    }
    if (intents.history) {
      for (const e of items.filter(i => i.level === 'E1' && i.kind === 'assertion' && (i.score > 0 || !hasResidual))) if (!selected.includes(e)) selected.push(e);
    }
    const best = Math.max(0, ...items.map(i => i.score));
    selected.sort((a, b) => b.score - a.score || LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
    return { selected: selected.slice(0, 8), best, hasResidual };
  }

  templateAnswer({ cards, realtime, intents, qTokens }) {
    const lines = [];
    const citations = [];
    let covered = false;
    for (const rt of realtime) {
      covered = true;
      const inputs = Object.entries(rt.inputs).map(([k, v]) => `${k}=${v}`).join('，');
      lines.push(`實時取值：${rt.label || rt.name}（${inputs}）＝ ${rt.value}${rt.unit || ''}。來源：取值 Action ${rt.actionId}「${rt.name}」，經管道「${rt.pipeline?.name}」於 ${rt.fetchedAt} 讀取；動態值不使用任何存儲值。`);
      citations.push({ id: rt.actionId, kind: 'action', level: null, content: rt.name });
    }
    for (const card of cards) {
      const s = card.subject;
      const { selected, hasResidual } = this.selectItems(card, qTokens, intents);
      const useDefinitionField = !selected.some(i => i.kind === 'assertion' && i.type === '定義') && s.definition && (intents.definition || !hasResidual) && !realtime.length;
      if (!selected.length && !useDefinitionField) continue;
      covered = true;
      lines.push(`${lines.length ? '\n' : ''}根據知識庫中的「${s.name}」（${s.id}，${s.type}，綜合層級 ${s.level}）：`);
      if (useDefinitionField) {
        const note = s.level === 'L0' ? 'L0 可靠' : s.level === 'L1' ? `${s.level} 參考，未經驗證` : `${s.level} 探索，僅供拓展思路，不作結論`;
        lines.push(`· 主體登記的定義：${s.definition}〔${s.id}·${note}；尚無定義類斷言〕`);
        citations.push({ id: s.id, kind: 'subject', level: s.level, content: s.definition, subjectId: s.id });
      }
      for (const it of selected) {
        citations.push({ id: it.id, kind: it.kind, level: it.level, content: it.text, subjectId: s.id });
        if (it.level === 'E1') {
          const rep = it.replacedBy ? card.assertions.find(a => a.id === it.replacedBy) : null;
          lines.push(`· 已失效（不得作為依據）：${it.text}〔${it.id}·E1〕${it.invalidReason ? `；失效原因：${it.invalidReason}` : ''}${rep ? `；現行替代者：${rep.content}〔${rep.id}·${rep.level}〕` : ''}`);
          if (rep && !citations.some(c => c.id === rep.id)) citations.push({ id: rep.id, kind: 'assertion', level: rep.level, content: rep.content, subjectId: s.id });
        } else if (it.level === 'L0') lines.push(`· ${it.text}〔${it.id}·L0 可靠〕`);
        else if (it.level === 'L1') lines.push(`· ${it.text}〔${it.id}·L1 參考，未經驗證〕`);
        else lines.push(`· （探索性知識，僅供拓展思路，不作結論）${it.text}〔${it.id}·L2〕`);
      }
    }
    return { covered, answer: lines.join('\n'), citations };
  }

  async llmAnswer({ question, cards, realtime, resolution, model }) {
    const slim = cards.map(c => ({
      subject: { id: c.subject.id, name: c.subject.name, type: c.subject.type, definition: c.subject.definition, level: c.subject.level },
      aliases: c.aliases.map(a => a.name),
      assertions: c.assertions.map(a => ({ id: a.id, type: a.type, content: a.content, structured: a.structured, level: a.level, invalidReason: a.invalidReason || undefined, replacedBy: a.replacedBy || undefined })),
      relations: [...c.relations.outgoing, ...c.relations.incoming].map(r => ({ id: r.id, text: `${r.from?.name}（${r.from?.id}） –${r.type}→ ${r.to?.name}（${r.to?.id}）`, level: r.level })),
      bindings: c.bindings.map(b => ({ id: b.id, object: `${b.object?.category}/${b.object?.kind || ''}：${b.object?.name}${b.object?.locator ? ` ${b.object.locator}` : ''}`, level: b.level })),
      actions: c.actions.map(a => ({ id: a.id, name: a.name, kind: a.kind }))
    }));
    const system = [
      '你是「供應鏈技術知識體系」的知識組織器，為智能體和用戶組織自然語言答案。你只能依據用戶消息中 knowledge 與 realtime 的內容回答，嚴格遵守：',
      '1. 每個結論後標註依據，格式〔知識ID·層級〕，例如〔A-0001·L0〕。給不出依據的內容不要寫。',
      '2. L0 可直接作為依據；L1 可以使用但必須明確寫「未經驗證」；L2 只能作為思路參考，必須寫明「不作結論」；E1 已失效，不得作為依據，若問題涉及，說明已失效並給出替代者。',
      '3. 庫存數量、訂單狀態等動態值只能使用 realtime 中的實時取值結果，並說明是實時取值；沒有 realtime 時不得給出任何數值。',
      '4. knowledge 中沒有能回答問題的內容時：covered=false，answer 寫「知識庫未收錄：…」並簡述缺什麼；絕不用行業通用知識、公開電商做法或常識補全。',
      '5. 使用與問題相同的語言（預設繁體中文），簡潔、直接。',
      '輸出 JSON：{"covered": boolean, "answer": string, "citations": [{"id": string, "level": string}], "missingInfo": string|null}'
    ].join('\n');
    const user = JSON.stringify({ question, aliasResolution: resolution, knowledge: slim, realtime }, null, 0);
    const r = await this.llm.chatJson({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 1200 });
    if (!r.json || typeof r.json.answer !== 'string') throw new Error('模型未返回有效 JSON');
    return { ...r.json, model: r.model, usage: r.usage };
  }

  async ask({ question, subjectIds = [], inputs = {}, compose = 'auto', model, includeKnowledge = true }, principal) {
    question = String(question || '').trim();
    if (!question) throw new RuleError('question 必填', 400, 'invalid_input');
    if (question.length > 2000) throw new RuleError('問題過長（上限 2000 字）', 400, 'invalid_input');
    const store = this.store;
    const intents = { dynamic: DYNAMIC_RE.test(question), history: HISTORY_RE.test(question), definition: DEFINITION_RE.test(question) };

    // 1. 解析術語
    let resolution = store.resolveTerms(question);
    let fuzzy = null;
    const explicit = (Array.isArray(subjectIds) ? subjectIds : [subjectIds]).filter(Boolean);
    for (const id of explicit) store.getSubject(id);
    if (!explicit.length) {
      // 精確命中之外的片段再做前綴模糊匹配（例如「還有多少可售」中的「可售」→「可售庫存」）。
      const exactEmpty = !resolution.canonical.length && !resolution.ambiguous.length;
      fuzzy = this.fuzzyResolve(question, resolution.matches.map(m => [m.start, m.end]));
      if (fuzzy && (exactEmpty || (fuzzy.canonical.length && !fuzzy.ambiguous.length))) {
        resolution = { ...resolution, canonical: [...new Set([...resolution.canonical, ...fuzzy.canonical])], ambiguous: [...resolution.ambiguous, ...(exactEmpty ? fuzzy.ambiguous : [])] };
      } else fuzzy = null;
    }
    let canonical = [...new Set([...explicit.flatMap(id => (store.subjects.get(id).type === '別名' ? store.aliasTargets(store.subjects.get(id)) : [id])), ...resolution.canonical])];
    const ambiguous = resolution.ambiguous.filter(a => !a.candidates.some(c => canonical.includes(c.id)));
    if (!canonical.length && !ambiguous.length && compose !== 'template') canonical = await this.llmPickSubjects(question);

    const base = { question, intents, resolution: { matches: resolution.matches, aliasHits: resolution.aliasHits, fuzzy: fuzzy?.fuzzy || null, ambiguous } };

    if (ambiguous.length) {
      const parts = ambiguous.map(a => `「${a.term}」可能指：${a.candidates.map(c => `${c.name}（${c.id}）`).join('、')}`);
      return {
        ...base, status: 'ambiguous',
        answer: `${parts.join('；')}。這是一詞多義的別名，請先確認您指的是哪一個，再據此回答。`,
        composer: { type: 'rule' }, citations: [], realtime: [],
        knowledge: includeKnowledge ? ambiguous.flatMap(a => a.candidates.map(c => store.card(c.id))) : undefined,
        next: { hint: '帶上 subjectIds 重新提問以消歧', candidates: ambiguous.flatMap(a => a.candidates) }
      };
    }

    if (!canonical.length) {
      const gap = store.recordGap({ question, subjectIds: [], principal, reason: '術語未命中任何主體' });
      return { ...base, status: 'uncovered', answer: '知識庫未收錄與此問題相關的主體。已記為知識缺口，不使用行業通用知識補全。', composer: { type: 'rule' }, citations: [], realtime: [], knowledge: includeKnowledge ? [] : undefined, gap: gap ? { id: gap.id, count: gap.count } : null };
    }

    store.recordUsage(canonical);
    const cards = canonical.map(id => store.card(id));

    // 2. 動態值：調用取值 Action，不使用任何存儲值
    const realtime = [];
    const needInputs = [];
    if (intents.dynamic && !intents.definition) {
      for (const card of cards) {
        for (const a of card.actions.filter(x => x.kind === '取值')) {
          const action = store.actions.get(a.id);
          let got = this.extractInputs(action, question, inputs);
          if ((action.inputs || []).some(d => d.required && !got[d.name])) got = await this.llmExtractInputs(action, question, got);
          const missing = (action.inputs || []).filter(d => d.required && !got[d.name]);
          if (missing.length) { needInputs.push({ actionId: action.id, name: action.name, missing: missing.map(d => ({ name: d.name, label: d.label || d.name, pattern: d.pattern || null })) }); continue; }
          try { realtime.push(await this.actions.fetchValue(action.id, got, principal)); }
          catch (err) { realtime.push({ actionId: action.id, name: action.name, inputs: got, error: err.message }); }
        }
      }
      if (!realtime.length && needInputs.length) {
        return {
          ...base, status: 'need_inputs',
          answer: `這是動態值，需要實時取值，不能使用存儲值。請補充參數：${needInputs.flatMap(n => n.missing.map(m => m.label)).join('、')}。`,
          composer: { type: 'rule' }, citations: [], realtime: [], needInputs, knowledge: includeKnowledge ? cards : undefined
        };
      }
    }
    const okRealtime = realtime.filter(r => !r.error);

    // 3–4. 按層級作答並引用
    const terms = [...resolution.matches.map(m => m.term), ...(fuzzy?.fuzzy || []).map(f => f.term), ...cards.map(c => c.subject.name), ...cards.flatMap(c => c.aliases.map(a => a.name))];
    const qTokens = tokensOf(residualOf(question, terms));
    let result;
    let composer = { type: 'template' };
    const useLlm = compose === 'llm' || (compose === 'auto' && this.llm?.enabled);
    if (useLlm) {
      try {
        const r = await this.llmAnswer({ question, cards, realtime: okRealtime, resolution: base.resolution, model });
        const known = new Map();
        for (const c of cards) {
          for (const a of c.assertions) known.set(a.id, { kind: 'assertion', level: a.level, content: a.content, subjectId: c.subject.id });
          for (const r2 of [...c.relations.outgoing, ...c.relations.incoming]) known.set(r2.id, { kind: 'relation', level: r2.level, content: `${r2.from?.name} –${r2.type}→ ${r2.to?.name}`, subjectId: c.subject.id });
          for (const b of c.bindings) known.set(b.id, { kind: 'binding', level: b.level, content: b.object?.name, subjectId: c.subject.id });
          known.set(c.subject.id, { kind: 'subject', level: c.subject.level, content: c.subject.name, subjectId: c.subject.id });
        }
        for (const rt of okRealtime) known.set(rt.actionId, { kind: 'action', level: null, content: rt.name });
        const citations = (r.citations || []).map(c => (typeof c === 'string' ? c : c?.id)).filter(id => known.has(id)).map(id => ({ id, ...known.get(id) }));
        result = { covered: r.covered !== false, answer: r.answer, citations: [...new Map(citations.map(c => [c.id, c])).values()], missingInfo: r.missingInfo || null };
        composer = { type: 'openrouter', model: r.model, usage: r.usage };
      } catch (err) {
        if (compose === 'llm') throw new RuleError(`自然語言組織失敗：${err.message}`, 502, 'llm_error');
        composer = { type: 'template', fallbackReason: err.message };
      }
    }
    if (!result) {
      const t = this.templateAnswer({ cards, realtime: okRealtime, intents, qTokens });
      result = { ...t, missingInfo: null };
      if (!t.covered) result.answer = '';
    }

    // 5. 未收錄就說未收錄
    if (!result.covered) {
      const gap = store.recordGap({ question, subjectIds: canonical, principal, reason: '命中主體但沒有能回答問題的知識' });
      const names = cards.map(c => `${c.subject.name}（${c.subject.id}）`).join('、');
      return {
        ...base, status: 'uncovered',
        answer: composer.type === 'openrouter' && result.answer ? result.answer : `知識庫未收錄：已找到相關主體 ${names}，但其中沒有能回答此問題的知識。已記為知識缺口，不使用行業通用知識補全。`,
        composer, citations: [], realtime, knowledge: includeKnowledge ? cards : undefined, gap: gap ? { id: gap.id, count: gap.count } : null, missingInfo: result.missingInfo
      };
    }
    const lowest = result.citations.filter(c => c.level).map(c => c.level);
    return {
      ...base, status: 'answered', answer: result.answer, composer, citations: result.citations, realtime,
      needInputs: needInputs.length ? needInputs : undefined,
      reliability: lowest.length ? { levels: [...new Set(lowest)], note: lowest.some(l => l !== 'L0') ? '答案包含非 L0 知識，請按層級標註使用' : '答案依據均為 L0' } : null,
      knowledge: includeKnowledge ? cards : undefined,
      usageRules: Object.fromEntries(Object.entries(LEVEL_INFO).map(([k, v]) => [k, v.usage]))
    };
  }
}

export { LEVEL_LABEL };
