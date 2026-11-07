// 管理後台：知識管理與可視化。頁面只填內容區，Portal 外殼與樣式沿用視覺樣式包。
import {
  $, $$, esc, icon, shell, setHeading, toast, modal, closeModal, showError, download, copy, api, get, post, put, patch, del,
  setUnauthorizedHandler, level, pill, tag, idLink, fmtTime, ago, pct, panel, table, formData, field, input, select, textarea, markdown, LEVEL_TEXT
} from './core.js';
import { renderGraph, legend } from './graph.js';

const NAV = {
  title: '供應鏈知識體系',
  subtitle: 'KNOWLEDGE PORTAL',
  groups: [
    { id: 'overview', name: '總覽', en: 'OVERVIEW', icon: 'chart', pages: [
      { id: 'dashboard', name: '健康指標', desc: '試點期每週查看：L0 覆蓋率、待重驗數、未收錄查詢數、L0 錯誤反饋數。' },
      { id: 'changes', name: '變更記錄', icon: 'list', desc: '每次知識寫入都是知識 Git 倉庫中的一次提交。' }
    ] },
    { id: 'knowledge', name: '知識庫', en: 'KNOWLEDGE', icon: 'grid', pages: [
      { id: 'subjects', name: '主體', aliases: ['subject'], desc: '圖譜的節點；綜合層級由客體綁定計算得出，只讀。' },
      { id: 'assertions', name: '斷言', aliases: ['item'], icon: 'list', desc: '關於主體的具體陳述；一條只說一件事，單獨驗證、單獨失效。' },
      { id: 'objects', name: '客體', aliases: ['object'], desc: '主體在真實世界中的對應物，也是有效性的證據來源。' },
      { id: 'relations', name: '關係', icon: 'node', desc: '10 種關係類型的閉集；邊直接帶有效性。' }
    ] },
    { id: 'graph', name: '圖譜', en: 'GRAPH', icon: 'node', pages: [
      { id: 'graph', name: '知識圖譜', desc: '拖曳節點、滾輪縮放、拖曳空白處平移；點選節點查看主體。' },
      { id: 'levels', name: '層級分佈', icon: 'chart', desc: '有效性層級的分佈與遷移規則：只有校驗或確認能升到 L0，任何異常先降回 L1。' }
    ] },
    { id: 'governance', name: '治理', en: 'GOVERNANCE', icon: 'shield', pages: [
      { id: 'queue', name: '重驗隊列', desc: '按「被使用頻率 × 出錯代價」排序，先處理被問得最多、錯了代價最大的知識。' },
      { id: 'conflicts', name: '衝突裁決', desc: '兩條知識互相矛盾時雙方降為 L1；裁決後一方回到 L0，另一方轉為 E1。' },
      { id: 'feedback', name: '使用反饋', desc: '用戶或智能體指出知識有誤，觸發降級與重驗。' },
      { id: 'gaps', name: '知識缺口', desc: '智能體回答「未收錄」的問題，用於決定下一批要建設的內容。' }
    ] },
    { id: 'runtime', name: '動力層', en: 'RUNTIME', icon: 'bolt', pages: [
      { id: 'actions', name: 'Action', desc: '對某類客體的一次只讀管道交互：校驗（結果寫回有效性）與取值（實時讀取動態值）。' },
      { id: 'pipelines', name: '管道', icon: 'plug', desc: '到數據源的連接；憑證以 ${env:變數} 引用，不寫入知識倉庫。' }
    ] },
    { id: 'integration', name: '接入', en: 'INTEGRATION', icon: 'plug', pages: [
      { id: 'playground', name: '問答測試', desc: '模擬智能體調用消費型 API：結構化知識 + 自然語言答案。' },
      { id: 'prompt', name: '智能體教程', icon: 'list', desc: '三方智能體拉取此教程即可學會如何生產與消費知識。' },
      { id: 'keys', name: 'API 金鑰', adminOnly: true, icon: 'shield', desc: '為三方智能體、人和管道發放金鑰；角色決定可用的 API。' },
      { id: 'apidoc', name: 'API 參考', icon: 'list', desc: '生產型與消費型 API 端點一覽（OpenAPI 3.1）。' }
    ] },
    { id: 'settings', name: '設定', en: 'SETTINGS', icon: 'gear', adminOnly: true, pages: [
      { id: 'repo', name: '知識倉庫', desc: '使用你指定的 Git 倉庫作為私有領域知識的持久化存儲。' },
      { id: 'llm', name: '自然語言', desc: '消費型 API 經 OpenRouter 組織自然語言答案；未配置時使用規則模板。' },
      { id: 'rules', name: '規則參數', desc: '領域代碼、有效期初值等，保存在知識倉庫的 config.yaml。' },
      { id: 'account', name: '帳號', desc: '目前身份與管理員密碼。' }
    ] }
  ]
};

let me = null;
let schema = null;
let subjectsCache = null;
const isOwner = () => me && (me.isAdmin || me.role === 'owner');

function navFor() {
  return { ...NAV, groups: NAV.groups.map(g => ({ ...g, hidden: g.adminOnly && !me?.isAdmin, pages: g.pages.filter(p => !p.adminOnly || me?.isAdmin) })) };
}

function route() {
  const [page, ...rest] = decodeURIComponent(location.hash.slice(1)).split('/');
  return { page: page || 'dashboard', param: rest.join('/') || null };
}

const content = () => $('#content');
const setActions = html => ($('#page-actions').innerHTML = html);
const qs = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

async function subjectOptions(force = false) {
  if (!subjectsCache || force) subjectsCache = await get('/api/v1/subjects');
  return `<datalist id="subject-options">${subjectsCache.map(s => `<option value="${esc(s.id)} ${esc(s.name)}">`).join('')}</datalist>`;
}
const parseId = v => String(v || '').trim().split(/\s+/)[0];

function levelBar(counts, keys = ['L0', 'L1', 'L2', 'E1']) {
  const total = keys.reduce((n, k) => n + (counts[k] || 0), 0);
  const seg = keys.map(k => (counts[k] ? `<i class="${k}" style="width:${(counts[k] / Math.max(1, total)) * 100}%" title="${k} ${counts[k]}"></i>` : '')).join('');
  return { bar: `<div class="bar" role="img" aria-label="${keys.map(k => `${k} ${counts[k] || 0}`).join('，')}">${seg}</div>`, text: keys.map(k => `${k} ${counts[k] || 0}`).join(' · '), total };
}

function evidenceCell(v) {
  const e = v?.evidence || {};
  const parts = (e.objectIds || []).map(id => idLink(id));
  if (e.sourceRef) parts.push(`<span class="cell-sub" title="${esc(e.sourceRef)}">來源：${esc(e.sourceRef)}</span>`);
  if (e.actionId) parts.push(`<span class="cell-sub">校驗：${esc(e.actionId)}</span>`);
  return parts.join(' ') || '<span class="muted">無證據</span>';
}
const pendingCell = v => (v?.pending ? pill(v.pending.label || v.pending.reason, 'amber') : '');

function rowOps(id, lvl, { full = false } = {}) {
  const ops = [`<a class="text-btn" href="#item/${esc(id)}">詳情</a>`];
  if (lvl !== 'E1') ops.push(`<button class="text-btn" data-op="validate" data-id="${esc(id)}">校驗</button>`);
  if (isOwner() && (lvl === 'L1' || lvl === 'L0')) ops.push(`<button class="text-btn" data-op="confirm" data-id="${esc(id)}">${lvl === 'L0' ? '續期' : '確認'}</button>`);
  if (full) {
    if (lvl === 'L2' || lvl === 'L1') ops.push(`<button class="text-btn" data-op="evidence" data-id="${esc(id)}">補證據</button>`);
    if (lvl !== 'E1') ops.push(`<button class="text-btn" data-op="feedback" data-id="${esc(id)}">反饋有誤</button>`, `<button class="text-btn" data-op="conflict" data-id="${esc(id)}">登記衝突</button>`);
    if (isOwner() && lvl !== 'E1') ops.push(`<button class="text-btn" data-op="invalidate" data-id="${esc(id)}" style="color:var(--danger)">判定失效</button>`);
  }
  return `<div class="cell-actions">${ops.join('')}</div>`;
}

// ------------------------------------------------------------------ 條目操作（事件委派）
const OPS = {
  async validate(id) {
    const r = await post(`/api/v1/validate/${id}`);
    const d = r.data;
    toast(`${id} 校驗結果：${{ pass: '通過 → L0', mismatch: '不符 → L1', missing: '客體不存在 → 下線', error: '無法完成' }[d.outcome] || d.outcome}。${d.detail || ''}`, 6000);
    render();
  },
  confirm(id) {
    modal(`負責人確認 ${id}`, `<p class="notice">確認後晉升為 L0（人工驗證），有效期按規則參數計算；到期自動降為 L1 並排入重驗。</p>${field('確認說明（選填）', textarea('note', '', 'placeholder="例如：已對照口徑文檔 v3 核實"'))}${field('有效期（天，選填）', input('expiryDays', '', 'type="number" min="1" placeholder="留空使用預設"'))}`, {
      label: '確認為 L0',
      run: async () => { await post(`/api/v1/items/${id}/confirm`, formData($('#dialog-content'))); toast(`${id} 已確認為 L0`); render(); }
    });
  },
  invalidate(id) {
    modal(`判定失效 ${id}`, `<p class="notice warn">E1 不刪除：保留失效知識和替代者，智能體才能回答「以前是怎樣、現在改成了什麼」。</p>${field('失效原因', textarea('reason', '', 'required'))}${field('替代者 ID（選填）', input('replacedBy', '', 'placeholder="例如 A-0001"'))}`, {
      label: '轉為 E1',
      run: async () => { await post(`/api/v1/items/${id}/invalidate`, formData($('#dialog-content'))); toast(`${id} 已轉為 E1`); render(); }
    });
  },
  async evidence(id) {
    const objects = await get('/api/v1/objects');
    modal(`補充證據 ${id}`, `<p class="notice">補充客體證據或明確來源後，L2 升為 L1。</p>${field('證據客體（可多選）', `<select name="objectIds" multiple size="6">${objects.map(o => `<option value="${esc(o.id)}">${esc(o.id)} ${esc(o.name)}${o.status === '下線' ? '（下線）' : ''}</option>`).join('')}</select>`)}${field('明確來源（選填）', input('sourceRef', '', 'placeholder="文檔鏈接、評審記錄編號等"'))}`, {
      label: '提交證據',
      run: async () => { await post(`/api/v1/items/${id}/evidence`, formData($('#dialog-content'))); toast('證據已補充'); render(); }
    });
  },
  feedback(id) {
    modal(`反饋知識有誤 ${id}`, `<p class="notice warn">提交後，若該知識為 L0 將降為 L1 並排入重驗。</p>${field('哪裡有誤', textarea('comment', '', 'required'))}${field('相關問題（選填）', input('question'))}`, {
      label: '提交反饋',
      run: async () => { await post('/api/v1/feedback', { targetId: id, ...formData($('#dialog-content')) }); toast('反饋已提交'); render(); }
    });
  },
  conflict(id) {
    modal(`登記衝突 ${id}`, `<p class="notice warn">雙方都降為 L1，並通知負責人裁決。</p>${field('與哪條知識矛盾（ID）', input('b', '', 'placeholder="例如 A-0003 或 R-0002" required'))}${field('說明', textarea('note'))}`, {
      label: '登記衝突',
      run: async () => { const d = formData($('#dialog-content')); await post('/api/v1/conflicts', { a: id, b: d.b.trim(), note: d.note }); toast('衝突已登記'); render(); }
    });
  },
  offline(id) {
    modal(`標記客體下線 ${id}`, `<p class="notice warn">客體下線後，相關綁定轉為 E1；以它為證據的斷言和關係降為 L1，等待負責人處理。</p>${field('下線原因', input('reason', '', 'required placeholder="表刪除、接口廢棄、文檔作廢…"'))}`, {
      label: '確認下線',
      run: async () => { await patch(`/api/v1/objects/${id}`, { status: '下線', reason: formData($('#dialog-content')).reason }); toast(`${id} 已下線，相關知識已級聯處理`); render(); }
    });
  },
  async invoke(id) {
    const a = (await get('/api/v1/actions')).find(x => x.id === id);
    const objects = await get('/api/v1/objects?category=物理');
    const inputs = (a.inputs || []).map(d => field(`${d.label || d.name}${d.required ? '' : '（選填）'}`, d.fromObjects ? select(d.name, [['', '請選擇'], ...objects.map(o => [o.locator || o.name, o.name])]) : input(d.name, '', `placeholder="${esc(d.pattern || '')}"`))).join('');
    modal(`調用取值 Action ${id}`, `<p class="notice">${esc(a.name)}：實時讀取，不使用任何存儲值。</p>${inputs || '<p class="muted">此 Action 沒有輸入參數。</p>'}<div id="invoke-result"></div>`, {
      label: '調用',
      run: async () => {
        const r = await post(`/api/v1/actions/${id}/invoke`, { inputs: formData($('#dialog-content')) });
        $('#invoke-result').innerHTML = `<pre class="mono-block">${esc(JSON.stringify(r.data, null, 2))}</pre>`;
        return true;
      }
    });
  },
  async closeFeedback(id) {
    modal(`關閉反饋 ${id}`, field('處理結果', textarea('resolution', '', 'required')), { label: '關閉', run: async () => { await post(`/api/v1/feedback/${id}/close`, formData($('#dialog-content'))); render(); } });
  },
  async closeGap(id) {
    modal(`標記缺口已處理 ${id}`, field('處理結果', textarea('resolution', '', 'placeholder="已補充主體 / 斷言 …"')), { label: '標記已處理', run: async () => { await post(`/api/v1/gaps/${id}/close`, formData($('#dialog-content'))); render(); } });
  },
  async resolveConflict(id) {
    const c = (await get('/api/v1/conflicts')).find(x => x.id === id);
    const [a, b] = await Promise.all([get(`/api/v1/items/${c.a}`), get(`/api/v1/items/${c.b}`)]);
    const desc = x => esc(x.content || (x.kind === 'relation' ? `${x.fromSubject?.name} –${x.type}→ ${x.toSubject?.name}` : x.objectId));
    modal(`裁決衝突 ${id}`, `<p class="notice">勝出方回到 L0（負責人確認），另一方轉為 E1 並指向勝出方。</p><label class="check"><input type="radio" name="winner" value="${esc(c.a)}" checked> ${esc(c.a)}：${desc(a)}</label><label class="check"><input type="radio" name="winner" value="${esc(c.b)}"> ${esc(c.b)}：${desc(b)}</label>${field('裁決理由', textarea('reason'))}`, {
      label: '提交裁決',
      run: async () => { const winner = $('#dialog-content input[name=winner]:checked').value; await post(`/api/v1/conflicts/${id}/resolve`, { winner, reason: $('#dialog-content textarea').value }); toast('已裁決'); render(); }
    });
  }
};

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-op]');
  if (!b || !OPS[b.dataset.op]) return;
  e.preventDefault();
  b.disabled = true;
  try { await OPS[b.dataset.op](b.dataset.id, b.dataset); } catch (err) { showError(err); } finally { b.disabled = false; }
});

// ------------------------------------------------------------------ 頁面
const PAGES = {};

PAGES.dashboard = async () => {
  const o = await get('/admin/api/overview');
  const h = o.health;
  setActions(`<a class="button" href="#playground">問答測試</a>${me.isAdmin ? '<button class="button" id="run-expiry">執行到期檢查</button>' : ''}<a class="button primary" href="#subjects">管理知識</a>`);
  const empty = !h.totals.subjects;
  const stat = (label, value, sub, hint) => `<section class="panel stat"><small>${label}</small><div class="value">${value}${sub ? `<small>${sub}</small>` : ''}</div><p>${hint}</p></section>`;
  const lv = h.levels;
  const bars = [['主體', lv.subject, ['L0', 'L1', 'L2']], ['客體綁定', lv.binding], ['斷言', lv.assertion], ['關係', lv.relation]].map(([n, c, keys]) => {
    const b = levelBar(c, keys);
    return `<div class="bar-row"><span>${n}</span>${b.bar}<small class="muted">${b.text}</small></div>`;
  }).join('');
  const git = o.git;
  content().innerHTML = `${empty ? `<div class="notice warn" style="margin-bottom:12px">知識庫目前為空。${me.isAdmin ? '可在 <a href="#repo">設定 › 知識倉庫</a> 配置 Git 倉庫並載入庫存域示例資料，' : ''}或讓三方智能體按 <a href="#prompt">智能體教程</a> 提交知識。</div>` : ''}
  <div class="four-col">
    ${stat('L0 覆蓋率', pct(h.l0Coverage.value), h.l0Coverage.total ? `${h.l0Coverage.covered}/${h.l0Coverage.total}` : '', esc(h.l0Coverage.basis))}
    ${stat('待重驗數', h.pendingRevalidation.value, '條', Object.entries(h.pendingRevalidation.byReason).map(([k, v]) => `${{ expired: '到期', mismatch: '校驗不符', conflict: '衝突', feedback: '反饋', object_offline: '客體下線', object_changed: '內容修改' }[k] || k} ${v}`).join(' · ') || '已到期降級、尚未重驗的條目')}
    ${stat('未收錄查詢數', h.uncoveredQueries.value, `近 ${h.windowDays} 天`, `累計 ${h.uncoveredQueries.total} 次 · 未處理缺口 ${h.uncoveredQueries.openGaps} 個`)}
    ${stat('L0 錯誤反饋數', h.l0ErrorFeedback.value, `近 ${h.windowDays} 天`, `累計 ${h.l0ErrorFeedback.total} 次 · 應趨近於 0`)}
  </div>
  <div class="two-col" style="margin-top:12px">
    <div class="stack">
      ${panel('有效性層級分佈', `<div class="panel-body">${bars}</div>`, '<a class="text-btn" href="#levels">層級說明</a>')}
      ${panel('高頻主體', table(['主體', '類型', '#使用次數', '綜合層級', '有 L0 知識'], h.topSubjects.map(s => `<tr><td>${idLink(s.id)} ${esc(s.name)}</td><td>${esc(s.type)}</td><td class="numeric">${s.usage}</td><td>${level(s.level)}</td><td>${s.hasL0 ? pill('是', 'green') : pill('否', 'amber')}</td></tr>`), '尚無使用記錄：智能體通過消費型 API 提問後會累計'), '<a class="text-btn" href="#queue">重驗隊列</a>')}
    </div>
    <div class="stack">
      ${panel('知識倉庫', `<div class="panel-body"><dl class="kv">
        <dt>遠端</dt><dd>${esc(git.remote || '未配置（本地倉庫）')}</dd>
        <dt>分支 / HEAD</dt><dd>${esc(git.branch)} · <span class="mono">${esc(git.head || '—')}</span></dd>
        <dt>最近拉取</dt><dd>${ago(git.lastPullAt)}</dd><dt>最近推送</dt><dd>${ago(git.lastPushAt)}</dd>
        <dt>狀態</dt><dd>${git.lastError ? `<span class="badge red">同步異常</span> <span class="cell-sub">${esc(git.lastError)}</span>` : '<span class="badge green">正常</span>'}${git.loadErrors?.length ? ` <span class="badge amber">${git.loadErrors.length} 個檔案無法解析</span>` : ''}</dd>
        <dt>自然語言</dt><dd>${o.llm.enabled ? `OpenRouter · ${esc(o.llm.model)}` : '未配置（使用規則模板）'}</dd>
      </dl></div>`, me.isAdmin ? '<a class="text-btn" href="#repo">設定</a>' : '')}
      ${panel('知識規模', `<div class="panel-body"><dl class="kv">${[['規範主體', h.totals.subjects], ['別名', h.totals.aliases], ['斷言', h.totals.assertions], ['客體', h.totals.objects], ['關係', h.totals.relations], ['Action / 管道', `${h.totals.actions} / ${h.totals.pipelines}`], ['未裁決衝突', h.totals.openConflicts], ['未處理反饋', h.totals.openFeedback]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`)}
      ${panel('最近提交', `<div class="panel-body"><ul class="timeline">${o.log.map(l => `<li><strong>${esc(l.subject)}</strong><span class="cell-sub">${esc(l.author)} · ${ago(l.date)} · <span class="mono">${esc(l.hash)}</span></span></li>`).join('') || '<li>尚無提交</li>'}</ul></div>`, '<a class="text-btn" href="#changes">全部</a>')}
    </div>
  </div>`;
  $('#run-expiry')?.addEventListener('click', async () => { const r = await post('/admin/api/maintenance/expiry'); toast(`到期檢查完成：${r.data.expired.length} 條降為 L1`); render(); });
};

PAGES.changes = async () => {
  const log = await get('/admin/api/log?limit=150');
  content().innerHTML = panel(`提交記錄（${log.length}）`, table(['提交', '作者', '時間', '說明'], log.map(l => `<tr><td class="mono">${esc(l.hash)}</td><td>${esc(l.author)}<span class="cell-sub">${esc(l.email)}</span></td><td>${fmtTime(l.date)}</td><td class="wrap">${esc(l.subject)}</td></tr>`), '尚無提交'));
};

PAGES.subjects = async () => {
  const sc = schema;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  setActions('<button class="button primary" id="add-subject">新增主體</button>');
  content().innerHTML = panel('主體一覽', `<div class="toolbar"><label class="grow">搜索 <input id="f-q" placeholder="名稱、ID、定義、別名" value="${esc(params.get('q') || '')}"></label><label>類型 ${select('type', [['', '全部類型'], ...Object.keys(sc.subjectTypes)], '', 'id="f-type"')}</label><label>領域 ${select('domain', [['', '全部領域'], ...sc.domains.map(d => [d.code, `${d.code} ${d.name}`])], '', 'id="f-domain"')}</label><label>綜合層級 ${select('level', [['', '全部'], 'L0', 'L1', 'L2'], '', 'id="f-level"')}</label><small id="f-count" class="muted"></small></div><div id="subject-table"></div>`);
  const load = async () => {
    const list = await get('/api/v1/subjects?' + qs({ q: $('#f-q').value, type: $('#f-type').value, domain: $('#f-domain').value, level: $('#f-level').value }));
    $('#f-count').textContent = `${list.length} 個主體`;
    $('#subject-table').innerHTML = table(['ID', '名稱 / 定義', '類型', '領域', '綜合層級', '#斷言', '#待重驗', '#使用', '負責人'], list.map(s => `<tr><td>${idLink(s.id)}</td><td class="wrap"><a href="#subject/${esc(s.id)}"><strong>${esc(s.name)}</strong></a><span class="cell-sub">${s.type === '別名' ? `別名 → ${(s.aliasOf || []).map(id => esc(id)).join('、')}` : esc(s.definition || '（未填寫定義）')}</span></td><td>${esc(s.type)}</td><td>${esc(s.domain)}</td><td>${s.type === '別名' ? '<span class="muted">不適用</span>' : level(s.level)}</td><td class="numeric">${s.assertions}</td><td class="numeric">${s.pending ? pill(s.pending, 'amber') : 0}</td><td class="numeric">${s.usage}</td><td>${esc(s.owner || '—')}</td></tr>`), '沒有相符的主體');
  };
  let timer;
  $('#f-q').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 200); };
  ['#f-type', '#f-domain', '#f-level'].forEach(s => ($(s).onchange = load));
  await load();
  $('#add-subject').onclick = () => subjectDialog();
};

async function subjectDialog(existing) {
  const sc = schema;
  const opts = await subjectOptions(true);
  const s = existing || {};
  modal(existing ? `編輯主體 ${s.id}` : '新增主體', `${opts}
    ${field('名稱（規範名）', input('name', s.name, 'required'))}
    <div class="field-pair">${field('類型', select('type', Object.entries(sc.subjectTypes).map(([k, v]) => [k, `${k} — ${v.desc}`]), s.type || '指標', existing ? 'disabled' : 'id="subject-type"'))}${field('領域', select('domain', sc.domains.map(d => [d.code, `${d.code} ${d.name}`]), s.domain, existing ? 'disabled' : ''))}</div>
    ${field('定義', textarea('definition', s.definition, 'placeholder="一句話說明它是什麼、不是什麼"'))}
    <div class="field-pair">${field('負責人', input('owner', s.owner, 'placeholder="對該主體知識有效性負責的人"'))}${field('出錯代價（1–5）', input('errorCost', s.errorCost ?? 3, 'type="number" min="1" max="5"'), '用於重驗優先級')}</div>
    ${existing ? field('有效期覆蓋（天，選填）', input('expiryDays', s.expiryDays || '', 'type="number" min="1"'), '負責人可按主體調整有效期') : `<div id="alias-box" hidden>${field('別名指向的規範主體（多個用逗號分隔，表示一詞多義）', input('aliasOf', '', 'list="subject-options" placeholder="S-INV-0012 可售庫存"'))}</div>`}`, {
    label: existing ? '保存' : '新增',
    run: async () => {
      const d = formData($('#dialog-content'));
      if (existing) {
        await patch(`/api/v1/subjects/${s.id}`, { name: d.name, definition: d.definition, owner: d.owner, errorCost: Number(d.errorCost), expiryDays: d.expiryDays ? Number(d.expiryDays) : null });
        toast('已保存');
      } else {
        const body = { name: d.name, type: d.type, domain: d.domain, definition: d.definition, owner: d.owner, errorCost: Number(d.errorCost) };
        if (d.type === '別名') body.aliasOf = d.aliasOf.split(/[,，]/).map(parseId).filter(Boolean);
        const r = await post('/api/v1/subjects', body);
        toast(`已新增 ${r.data.id}`);
        location.hash = `subject/${r.data.id}`;
        return;
      }
      render();
    }
  });
  const typeSel = $('#subject-type');
  if (typeSel) { const sync = () => ($('#alias-box').hidden = typeSel.value !== '別名'); typeSel.onchange = sync; sync(); }
}

PAGES.subject = async ({ param: id }) => {
  const [card, history, graph] = await Promise.all([get(`/api/v1/subjects/${id}`), get(`/api/v1/subjects/${id}/history`), get(`/api/v1/graph?focus=${encodeURIComponent(id)}&depth=1`)]);
  const s = card.subject;
  setHeading(s.name, s.definition || '', `知識庫 › 主體 › ${s.id}`);
  document.title = `${s.name} · ${NAV.title}`;
  if (s.type === '別名') {
    setActions(me.isAdmin ? '<button class="button danger" id="del-subject">刪除</button>' : '');
    content().innerHTML = `<div class="two-col"><div class="stack">${panel('別名', `<div class="panel-body"><dl class="kv"><dt>ID</dt><dd>${tag(s.id)}</dd><dt>類型</dt><dd>別名</dd><dt>指向</dt><dd>${card.alias.targets.map(t => `${idLink(t.id)} ${esc(t.name)}`).join('<br>') || '—'}</dd></dl><p class="notice ${card.alias.ambiguous ? 'warn' : ''}" style="margin-top:10px">${esc(card.alias.guidance)}</p></div>`)}</div><div>${panel('版本歷史', historyHtml(history))}</div></div>`;
  } else {
    setActions(`<a class="button" href="#graph/${esc(s.id)}">在圖譜中查看</a><button class="button" id="edit-subject">編輯</button><button class="button" id="add-binding">綁定客體</button><button class="button" id="add-relation">新增關係</button><button class="button primary" id="add-assertion">新增斷言</button>${me.isAdmin ? '<button class="button danger" id="del-subject">刪除</button>' : ''}`);
    const assertionRows = card.assertions.map(a => `<tr><td>${idLink(a.id)}</td><td>${esc(a.type)}</td><td class="wrap">${esc(a.content)}${a.structured ? `<span class="cell-sub mono">${esc(a.structured.key)} = ${esc(a.structured.value)}</span>` : ''}${a.level === 'E1' ? `<span class="cell-sub">失效原因：${esc(a.invalidReason || '—')}${a.replacedBy ? `；替代者 ${idLink(a.replacedBy)}` : ''}</span>` : ''}</td><td>${level(a.level)} ${pendingCell(a.validity)}</td><td class="wrap">${evidenceCell(a.validity)}</td><td>${rowOps(a.id, a.level)}</td></tr>`);
    const bindingRows = card.bindings.map(b => `<tr><td>${idLink(b.id)}</td><td class="wrap">${idLink(b.object.id)} ${esc(b.object.name)}<span class="cell-sub">${esc(b.object.category)} · ${esc(b.object.kind || '')} ${b.object.locator ? '· ' + esc(b.object.locator) : ''}</span></td><td>${b.object.status === '下線' ? pill('下線', 'red') : pill('在用', 'green')}</td><td>${level(b.level)} ${pendingCell(b.validity)}</td><td>${esc(b.validity.method === 'auto' ? `Action 校驗（${b.validity.verifiedBy || ''}）` : b.validity.method === 'manual' ? `負責人確認（${b.validity.verifiedBy || ''}）` : '未驗證')}<span class="cell-sub">${b.validity.expiresAt ? `有效期至 ${fmtTime(b.validity.expiresAt)}` : ''}</span></td><td>${rowOps(b.id, b.level)}</td></tr>`);
    const relRow = (r, dir) => `<tr><td>${idLink(r.id)}</td><td>${dir === 'out' ? `<strong>${esc(s.name)}</strong>` : `${idLink(r.from.id)} ${esc(r.from.name)}`}</td><td>${pill(r.type, 'blue')}</td><td>${dir === 'out' ? `${idLink(r.to.id)} ${esc(r.to.name)}` : `<strong>${esc(s.name)}</strong>`}</td><td>${level(r.level)} ${pendingCell(r.validity)}</td><td>${rowOps(r.id, r.level)}</td></tr>`;
    content().innerHTML = `<div class="two-col"><div class="stack">
      ${panel(`斷言（${card.assertions.length}）`, table(['ID', '類型', '內容', '層級', '證據', '操作'], assertionRows, '尚無斷言。約束類斷言（否定性知識、邊界情況）最容易被智能體用常識補錯，建議優先收集。'))}
      ${panel(`客體綁定（${card.bindings.length}）`, table(['ID', '客體', '狀態', '層級', '驗證', '操作'], bindingRows, '尚無客體綁定：綜合層級為 L2'), '<span class="muted" style="font-size:11px">綜合層級 = 有效綁定中的最高層級</span>')}
      ${panel(`關係（${card.relations.outgoing.length + card.relations.incoming.length}）`, table(['ID', '起點', '關係', '終點', '層級', '操作'], [...card.relations.outgoing.map(r => relRow(r, 'out')), ...card.relations.incoming.map(r => relRow(r, 'in'))], '尚無關係'))}
    </div><div class="stack">
      ${panel('主體資訊', `<div class="panel-body"><dl class="kv"><dt>ID</dt><dd>${tag(s.id)}</dd><dt>類型 / 領域</dt><dd>${esc(s.type)} · ${esc(s.domain)}</dd><dt>綜合層級</dt><dd>${level(s.level)}<span class="cell-sub">${esc(s.levelNote)}</span></dd><dt>負責人</dt><dd>${esc(s.owner || '—')}</dd><dt>出錯代價</dt><dd>${s.errorCost} / 5</dd><dt>別名</dt><dd>${card.aliases.map(a => `${idLink(a.id, a.name)}${a.ambiguous ? ' <span class="badge amber">多義</span>' : ''}`).join(' ') || '—'}</dd><dt>更新</dt><dd>${fmtTime(s.updatedAt)}</dd></dl></div>`)}
      ${panel('可用 Action', `<div class="panel-body stack-sm">${card.actions.map(a => `<div class="library-item"><div><strong>${esc(a.name)}</strong><span class="cell-sub">${esc(a.id)} · ${esc(a.kind)}</span></div>${a.kind === '取值' ? `<button class="button" data-op="invoke" data-id="${esc(a.id)}">實時取值</button>` : pill('校驗', 'blue')}</div>`).join('') || '<p class="muted">綁定的客體沒有配置 Action。</p>'}${card.dynamicValueNote ? `<p class="notice">${esc(card.dynamicValueNote)}</p>` : ''}</div>`)}
      ${panel('一跳鄰域', `<div id="mini-graph" class="graph-canvas"></div>`)}
      ${panel('版本歷史', historyHtml(history))}
    </div></div>`;
    renderGraph($('#mini-graph'), graph, { focus: s.id, height: 300, onSelect: n => { if (n.id !== s.id) location.hash = `subject/${n.id}`; } });
    $('#edit-subject').onclick = () => subjectDialog({ ...s });
    $('#add-assertion').onclick = () => assertionDialog(s, card);
    $('#add-binding').onclick = () => bindingDialog(s);
    $('#add-relation').onclick = () => relationDialog({ from: `${s.id} ${s.name}` });
  }
  $('#del-subject')?.addEventListener('click', () => modal(`刪除主體 ${s.id}`, '<p class="notice warn">刪除會同時移除相關關係，僅用於清理錯誤錄入。正常情況請把知識轉為 E1（E1 不刪除）。</p>', { label: '確認刪除', run: async () => { await del(`/api/v1/subjects/${s.id}`); location.hash = 'subjects'; } }));
};

function historyHtml(history) {
  return `<div class="panel-body"><ul class="timeline">${history.map(l => `<li><strong>${esc(l.subject)}</strong><span class="cell-sub">${esc(l.author)} · ${fmtTime(l.date)} · <span class="mono">${esc(l.hash)}</span></span></li>`).join('') || '<li>尚無提交</li>'}</ul></div>`;
}

async function assertionDialog(s, card) {
  const sc = schema;
  const bound = card.bindings.filter(b => b.level !== 'E1');
  modal(`新增斷言 · ${s.name}`, `<p class="notice">你的提交：附客體證據最高 L1，無證據只能 L2。L0 只能通過 Action 校驗或負責人確認晉升。</p>
    ${field('類型', select('type', Object.entries(sc.assertionTypes).map(([k, v]) => [k, `${k} — ${v}`]), '定義'))}
    ${field('內容（一條只說一件事）', textarea('content', '', 'required'))}
    <div class="field-pair">${field('結構化鍵（選填）', input('key', '', 'placeholder="reserve.ttl"'))}${field('結構化值（選填）', input('value', '', 'placeholder="30m"'))}</div>
    ${field('證據客體（主體已綁定的客體，可多選）', `<select name="objectIds" multiple size="${Math.min(6, Math.max(2, bound.length))}">${bound.map(b => `<option value="${esc(b.object.id)}">${esc(b.object.id)} ${esc(b.object.name)}</option>`).join('')}</select>`)}
    ${field('明確來源（選填）', input('sourceRef', '', 'placeholder="文檔鏈接、評審記錄等"'))}`, {
    label: '提交',
    run: async () => {
      const d = formData($('#dialog-content'));
      const r = await post(`/api/v1/subjects/${s.id}/assertions`, { type: d.type, content: d.content, structured: d.key ? { key: d.key, value: d.value } : undefined, evidence: { objectIds: d.objectIds, sourceRef: d.sourceRef } });
      toast(`已新增 ${r.data.id}（${r.data.validity.level}）`);
      render();
    }
  });
}

async function bindingDialog(s) {
  const objects = (await get('/api/v1/objects?status=在用'));
  modal(`綁定客體 · ${s.name}`, `<p class="notice">綁定提交後為 L1；通過校驗 Action 或負責人確認後成為 L0，主體綜合層級隨之更新。</p>${field('客體', select('objectId', objects.map(o => [o.id, `${o.id} ${o.name}（${o.category}）`])))}${field('說明（選填）', input('note'))}<p class="muted" style="margin-top:8px">找不到客體？先到 <a href="#objects">客體</a> 頁登記。</p>`, {
    label: '綁定',
    run: async () => { const r = await post(`/api/v1/subjects/${s.id}/bindings`, formData($('#dialog-content'))); toast(`已綁定 ${r.data.id}`); render(); }
  });
}

async function relationDialog(preset = {}) {
  const sc = schema;
  const opts = await subjectOptions(true);
  const objects = await get('/api/v1/objects?status=在用');
  modal('新增關係', `${opts}<p class="notice">關係類型是閉集，方向必須符合定義；新增類型須經負責人評審。</p>
    ${field('起點主體', input('from', preset.from || '', 'list="subject-options" required'))}
    ${field('關係類型', select('type', Object.entries(sc.relationTypes).map(([k, v]) => [k, `${k}：${v.direction}`]), preset.type || '依賴'))}
    ${field('終點主體', input('to', preset.to || '', 'list="subject-options" required'))}
    ${field('證據客體（選填，可多選）', `<select name="objectIds" multiple size="4">${objects.map(o => `<option value="${esc(o.id)}">${esc(o.id)} ${esc(o.name)}</option>`).join('')}</select>`)}
    ${field('明確來源（選填）', input('sourceRef', '', 'placeholder="調用鏈、表血緣、設計文檔…"'))}`, {
    label: '新增',
    run: async () => {
      const d = formData($('#dialog-content'));
      const r = await post('/api/v1/relations', { from: parseId(d.from), type: d.type, to: parseId(d.to), evidence: { objectIds: d.objectIds, sourceRef: d.sourceRef } });
      toast(`已新增 ${r.data.id}（${r.data.validity.level}）`);
      render();
    }
  });
}

PAGES.item = async ({ param: id }) => {
  const it = await get(`/api/v1/items/${id}`);
  const v = it.validity;
  const kindName = { assertion: '斷言', binding: '客體綁定', relation: '關係' }[it.kind];
  const text = it.kind === 'assertion' ? it.content : it.kind === 'relation' ? `${it.fromSubject?.name} –${it.type}→ ${it.toSubject?.name}` : `綁定客體 ${it.objectId}`;
  setHeading(`${kindName} ${id}`, text, `知識庫 › ${kindName} › ${id}`);
  setActions(it.subject ? `<a class="button" href="#subject/${esc(it.subject.id)}">返回主體</a>` : '');
  content().innerHTML = `<div class="two-col"><div class="stack">
    ${panel('有效性', `<div class="panel-body"><dl class="kv">
      <dt>層級</dt><dd>${level(v.level)} ${pendingCell(v)}</dd>
      <dt>所屬主體</dt><dd>${it.subject ? `${idLink(it.subject.id)} ${esc(it.subject.name)}` : '—'}</dd>
      ${it.kind === 'assertion' ? `<dt>類型</dt><dd>${esc(it.type)}</dd><dt>內容</dt><dd>${esc(it.content)}</dd>${it.structured ? `<dt>結構化值</dt><dd class="mono">${esc(it.structured.key)} = ${esc(it.structured.value)}</dd>` : ''}` : ''}
      ${it.kind === 'relation' ? `<dt>關係</dt><dd>${idLink(it.from)} ${esc(it.fromSubject?.name)} –${esc(it.type)}→ ${idLink(it.to)} ${esc(it.toSubject?.name)}</dd>` : ''}
      ${it.kind === 'binding' ? `<dt>客體</dt><dd>${idLink(it.objectId)}</dd>` : ''}
      <dt>證據</dt><dd>${evidenceCell(v)}</dd>
      <dt>驗證方式</dt><dd>${esc({ auto: '自動（Action 校驗）', manual: '人工（負責人確認）', pipeline: '已註冊管道同步' }[v.method] || '未驗證')}</dd>
      <dt>驗證人與時間</dt><dd>${esc(v.verifiedBy || '—')} · ${fmtTime(v.verifiedAt)}</dd>
      <dt>有效期至</dt><dd>${fmtTime(v.expiresAt)}</dd>
      <dt>來源</dt><dd>${esc(v.source ? `${v.source.name || v.source.id}（${{ human: '人', agent: '智能體', pipeline: '管道', system: '系統' }[v.source.kind] || v.source.kind}）` : '—')}</dd>
      ${v.lastCheck ? `<dt>最近校驗</dt><dd>${esc(v.lastCheck.actionId)} · ${esc(v.lastCheck.outcome)} · ${fmtTime(v.lastCheck.at)}<span class="cell-sub">${esc(v.lastCheck.detail || '')}</span></dd>` : ''}
      ${v.level === 'E1' ? `<dt>失效原因</dt><dd>${esc(v.invalidReason || '—')}</dd><dt>替代者</dt><dd>${v.replacedBy ? idLink(v.replacedBy) : '—'}</dd>` : ''}
    </dl></div>`)}
    ${panel('操作', `<div class="panel-body">${rowOps(id, v.level, { full: true })}<p class="muted" style="margin-top:8px;font-size:12px">上行只有兩條路：補充證據（L2 → L1），以及校驗或確認（L1 → L0）。智能體不能晉升知識。</p></div>`)}
  </div><div>${panel('層級歷史', `<div class="panel-body"><ul class="timeline">${[...(v.history || [])].reverse().map(h => `<li><strong>${esc(h.from || '新建')} → ${esc(h.to)}</strong> ${esc(h.reason || '')}<span class="cell-sub">${esc(h.by || '')} · ${fmtTime(h.at)}${h.note ? ' · ' + esc(h.note) : ''}</span></li>`).join('') || '<li>無</li>'}</ul></div>`)}</div></div>`;
};

PAGES.assertions = async () => {
  const sc = schema;
  content().innerHTML = panel('斷言一覽', `<div class="toolbar"><label class="grow">搜索 <input id="f-q" placeholder="內容、ID、主體名"></label><label>類型 ${select('type', [['', '全部類型'], ...Object.keys(sc.assertionTypes)], '', 'id="f-type"')}</label><label>層級 ${select('level', [['', '全部'], 'L0', 'L1', 'L2', 'E1'], '', 'id="f-level"')}</label><label class="check"><input type="checkbox" id="f-pending"> 只看待重驗</label><small id="f-count" class="muted"></small></div><div id="a-table"></div>`);
  const load = async () => {
    const list = await get('/api/v1/assertions?' + qs({ q: $('#f-q').value, type: $('#f-type').value, level: $('#f-level').value, pending: $('#f-pending').checked ? '1' : '' }));
    $('#f-count').textContent = `${list.length} 條`;
    $('#a-table').innerHTML = table(['ID', '主體', '類型', '內容', '層級', '證據', '操作'], list.map(a => `<tr><td>${idLink(a.id)}</td><td>${idLink(a.subject.id)} ${esc(a.subject.name)}</td><td>${esc(a.type)}</td><td class="wrap">${esc(a.content)}${a.structured ? `<span class="cell-sub mono">${esc(a.structured.key)} = ${esc(a.structured.value)}</span>` : ''}</td><td>${level(a.validity.level)} ${pendingCell(a.validity)}</td><td class="wrap">${evidenceCell(a.validity)}</td><td>${rowOps(a.id, a.validity.level)}</td></tr>`));
  };
  let timer;
  $('#f-q').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 200); };
  ['#f-type', '#f-level', '#f-pending'].forEach(s => ($(s).onchange = load));
  await load();
};

PAGES.objects = async () => {
  const sc = schema;
  setActions('<button class="button primary" id="add-object">登記客體</button>');
  content().innerHTML = panel('客體一覽', `<div class="toolbar"><label class="grow">搜索 <input id="f-q" placeholder="名稱、ID、定位"></label><label>類別 ${select('category', [['', '全部類別'], ...Object.keys(sc.objectCategories)], '', 'id="f-cat"')}</label><label>狀態 ${select('status', [['', '全部'], '在用', '下線'], '', 'id="f-status"')}</label><small id="f-count" class="muted"></small></div><div id="o-table"></div>`);
  const load = async () => {
    const list = await get('/api/v1/objects?' + qs({ q: $('#f-q').value, category: $('#f-cat').value, status: $('#f-status').value }));
    $('#f-count').textContent = `${list.length} 個客體`;
    $('#o-table').innerHTML = table(['ID', '名稱', '類別 / 種類', '定位', '可用 Action', '狀態', '綁定主體', '操作'], list.map(o => `<tr><td>${idLink(o.id)}</td><td class="wrap"><a href="#object/${esc(o.id)}">${esc(o.name)}</a></td><td>${esc(o.category)}<span class="cell-sub">${esc(o.kind || '')}</span></td><td class="mono wrap">${esc(o.locator || '—')}</td><td>${(o.actionIds || []).map(tag).join(' ') || '—'}</td><td>${o.status === '下線' ? pill('下線', 'red') : pill('在用', 'green')}</td><td class="wrap">${o.boundSubjects.map(s => `${idLink(s.id, s.name)}`).join(' ') || '—'}</td><td>${o.status !== '下線' ? `<button class="text-btn" data-op="offline" data-id="${esc(o.id)}">標記下線</button>` : ''}</td></tr>`));
  };
  let timer;
  $('#f-q').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 200); };
  ['#f-cat', '#f-status'].forEach(s => ($(s).onchange = load));
  await load();
  $('#add-object').onclick = async () => {
    const actions = await get('/api/v1/actions');
    modal('登記客體', `${field('名稱', input('name', '', 'required placeholder="表字段 inventory.sku_stock.available_qty"'))}<div class="field-pair">${field('類別', select('category', Object.entries(sc.objectCategories).map(([k, v]) => [k, `${k} — ${v.desc}`]), '數字', 'id="obj-cat"'))}${field('種類', input('kind', '', 'list="kind-options" placeholder="表字段 / API / 配置項 / 口徑定義 / 倉庫"'))}</div><datalist id="kind-options">${Object.values(sc.objectCategories).flatMap(c => c.kinds).map(k => `<option value="${esc(k)}">`).join('')}</datalist>${field('定位', input('locator', '', 'placeholder="URI、庫表路徑、文檔鏈接等"'))}${field('說明（選填）', textarea('description'))}${field('可用 Action（可多選）', `<select name="actionIds" multiple size="4">${actions.map(a => `<option value="${esc(a.id)}">${esc(a.id)} ${esc(a.name)}（${esc(a.kind)}）</option>`).join('')}</select>`, '物理客體在 MVP 只登記，不接管道')}`, {
      label: '登記',
      run: async () => { const r = await post('/api/v1/objects', formData($('#dialog-content'))); toast(`已登記 ${r.data.id}`); render(); }
    });
  };
};

PAGES.object = async ({ param: id }) => {
  const o = await get(`/api/v1/objects/${id}`);
  setHeading(o.name, `${o.category} · ${o.kind || ''}`, `知識庫 › 客體 › ${o.id}`);
  setActions(`${o.status !== '下線' ? `<button class="button danger" data-op="offline" data-id="${esc(o.id)}">標記下線</button>` : ''}<button class="button" id="edit-actions">設定可用 Action</button>`);
  content().innerHTML = `<div class="two-col"><div class="stack">${panel('客體資訊', `<div class="panel-body"><dl class="kv"><dt>ID</dt><dd>${tag(o.id)}</dd><dt>類別 / 種類</dt><dd>${esc(o.category)} · ${esc(o.kind || '—')}</dd><dt>定位</dt><dd class="mono">${esc(o.locator || '—')}</dd><dt>狀態</dt><dd>${o.status === '下線' ? `${pill('下線', 'red')} ${esc(o.offlineReason || '')} ${fmtTime(o.offlineAt)}` : pill('在用', 'green')}</dd><dt>說明</dt><dd>${esc(o.description || '—')}</dd><dt>登記者</dt><dd>${esc(o.createdBy?.name || '—')} · ${fmtTime(o.createdAt)}</dd></dl></div>`)}
    ${panel('綁定的主體', table(['主體', '綁定', '層級'], o.boundSubjects.map(s => `<tr><td>${idLink(s.id)} ${esc(s.name)}</td><td>${idLink(s.bindingId)}</td><td>${level(s.bindingLevel)}</td></tr>`), '尚未綁定'))}</div>
    <div>${panel('可用 Action', `<div class="panel-body stack-sm">${o.actions.map(a => `<div class="library-item"><div><strong>${esc(a.name)}</strong><span class="cell-sub">${esc(a.id)} · ${esc(a.kind)}</span></div>${a.kind === '取值' ? `<button class="button" data-op="invoke" data-id="${esc(a.id)}">實時取值</button>` : pill('校驗', 'blue')}</div>`).join('') || '<p class="muted">未配置</p>'}</div>`)}</div></div>`;
  $('#edit-actions').onclick = async () => {
    const actions = await get('/api/v1/actions');
    modal(`可用 Action · ${o.id}`, field('Action（可多選）', `<select name="actionIds" multiple size="8">${actions.map(a => `<option value="${esc(a.id)}" ${o.actionIds.includes(a.id) ? 'selected' : ''}>${esc(a.id)} ${esc(a.name)}（${esc(a.kind)}）</option>`).join('')}</select>`), { label: '保存', run: async () => { await patch(`/api/v1/objects/${o.id}`, formData($('#dialog-content'))); render(); } });
  };
};

PAGES.relations = async () => {
  const sc = schema;
  setActions('<button class="button primary" id="add-relation">新增關係</button>');
  content().innerHTML = panel('關係一覽', `<div class="toolbar"><label>類型 ${select('type', [['', '全部類型'], ...Object.keys(sc.relationTypes)], '', 'id="f-type"')}</label><label>層級 ${select('level', [['', '全部'], 'L0', 'L1', 'L2', 'E1'], '', 'id="f-level"')}</label><small id="f-count" class="muted"></small></div><div id="r-table"></div>`);
  const load = async () => {
    const list = await get('/api/v1/relations?' + qs({ type: $('#f-type').value, level: $('#f-level').value }));
    $('#f-count').textContent = `${list.length} 條`;
    $('#r-table').innerHTML = table(['ID', '起點', '關係', '終點', '層級', '證據', '操作'], list.map(r => `<tr><td>${idLink(r.id)}</td><td>${idLink(r.from)} ${esc(r.fromSubject?.name)}</td><td>${pill(r.type, 'blue')}</td><td>${idLink(r.to)} ${esc(r.toSubject?.name)}</td><td>${level(r.validity.level)} ${pendingCell(r.validity)}</td><td class="wrap">${evidenceCell(r.validity)}</td><td>${rowOps(r.id, r.validity.level)}</td></tr>`));
  };
  ['#f-type', '#f-level'].forEach(s => ($(s).onchange = load));
  await load();
  $('#add-relation').onclick = () => relationDialog();
};

PAGES.graph = async ({ param }) => {
  const sc = schema;
  const opts = await subjectOptions();
  const focus = param || '';
  content().innerHTML = `${opts}<section class="panel"><div class="toolbar"><label class="grow">聚焦主體 <input id="g-focus" list="subject-options" placeholder="留空顯示全圖" value="${esc(focus ? `${focus}` : '')}"></label><label>深度 ${select('depth', [1, 2, 3], 2, 'id="g-depth"')}</label><label>領域 ${select('domain', [['', '全部'], ...sc.domains.map(d => [d.code, d.code + ' ' + d.name])], '', 'id="g-domain"')}</label><label>關係 ${select('rel', [['', '全部'], ...Object.keys(sc.relationTypes)], '', 'id="g-rel"')}</label><label class="check"><input type="checkbox" id="g-alias" checked> 別名</label><label class="check"><input type="checkbox" id="g-e1"> 含 E1</label><button class="button" id="g-reset">重置視圖</button></div>
    <div class="graph-wrap" style="border-top:1px solid var(--line)"><div id="graph" class="graph-canvas"></div><aside class="panel-body side-panel" id="g-side"><h3>主體詳情</h3><p class="muted" style="font-size:12px">點選圖中節點查看。</p></aside></div>${legend()}</section>`;
  let view;
  const draw = async () => {
    const f = parseId($('#g-focus').value);
    const data = await get('/api/v1/graph?' + qs({ focus: f, depth: $('#g-depth').value, domain: $('#g-domain').value, relationTypes: $('#g-rel').value, aliases: $('#g-alias').checked ? '1' : '0', e1: $('#g-e1').checked ? '1' : '' }));
    const height = window.innerWidth < 700 ? 420 : Math.max(480, Math.min(720, window.innerHeight - 260));
    view = renderGraph($('#graph'), data, { focus: f, height, onSelect: showNode });
  };
  async function showNode(n) {
    const card = await get(`/api/v1/subjects/${n.id}`);
    const s = card.subject;
    $('#g-side').innerHTML = `<h3>${esc(s.name)}</h3><div class="chip-row">${tag(s.id)} ${pill(s.type)} ${s.level ? level(s.level) : ''}</div><p style="font-size:12px;margin:8px 0">${esc(s.definition || card.alias?.guidance || '')}</p>${card.assertions ? `<dl class="kv"><dt>斷言</dt><dd>${card.assertions.length}（L0 ${card.assertions.filter(a => a.level === 'L0').length}）</dd><dt>綁定</dt><dd>${card.bindings.length}</dd><dt>關係</dt><dd>${card.relations.outgoing.length + card.relations.incoming.length}</dd></dl>` : ''}<div class="actions" style="margin-top:10px"><a class="button" href="#subject/${esc(s.id)}">打開主體</a><button class="button" id="g-focus-btn">以此為中心</button></div>`;
    $('#g-focus-btn').onclick = () => { $('#g-focus').value = `${s.id} ${s.name}`; draw(); };
  }
  ['#g-depth', '#g-domain', '#g-rel', '#g-alias', '#g-e1'].forEach(s => ($(s).onchange = draw));
  $('#g-focus').onchange = draw;
  $('#g-reset').onclick = () => view?.reset();
  await draw();
};

PAGES.levels = async () => {
  const [h, subjects] = await Promise.all([get('/api/v1/metrics'), get('/api/v1/subjects')]);
  const domains = schema.domains;
  const byDomain = domains.map(d => {
    const list = subjects.filter(s => s.domain === d.code && s.type !== '別名');
    const c = { L0: 0, L1: 0, L2: 0 };
    list.forEach(s => (c[s.level] += 1));
    return { d, c, total: list.length };
  });
  const diagram = `<svg class="migration" viewBox="0 0 760 320" role="img" aria-label="層級遷移：三個入口、五條遷移">
    <defs><marker id="mg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#7a8aa0"/></marker></defs>
    <g fill="none" stroke="#7a8aa0" stroke-width="1.3" marker-end="url(#mg)"><path d="M85 42v56"/><path d="M315 42v56"/><path d="M655 42v56"/><path d="M150 132h98"/><path d="M380 120h208"/><path d="M590 146h-208"/><path d="M315 164v108h103"/><path d="M655 164v108h-103"/></g>
    <g class="note"><text x="85" y="32" text-anchor="middle" class="note">人或智能體提交，無證據</text><text x="315" y="32" text-anchor="middle" class="note">人或智能體提交，附證據</text><text x="655" y="32" text-anchor="middle" class="note">註冊管道自動同步</text><text x="199" y="124" text-anchor="middle" class="note">補充客體證據</text><text x="484" y="112" text-anchor="middle" class="note">Action 校驗或負責人確認</text><text x="484" y="162" text-anchor="middle" class="note">到期、校驗不符、衝突、反饋錯誤</text><text x="323" y="222" class="note">確認不成立或過時</text><text x="647" y="222" text-anchor="end" class="note">客體下線或被證偽</text></g>
    <g><rect x="20" y="100" width="130" height="64" rx="8" fill="#fff" stroke="#d9a441"/><text x="85" y="128" text-anchor="middle" font-weight="650">L2 探索</text><text x="85" y="148" text-anchor="middle" class="note">無客體證據</text>
    <rect x="250" y="100" width="130" height="64" rx="8" fill="#fff" stroke="#147fe6"/><text x="315" y="128" text-anchor="middle" font-weight="650">L1 參考</text><text x="315" y="148" text-anchor="middle" class="note">有證據，未驗證</text>
    <rect x="590" y="100" width="130" height="64" rx="8" fill="#edf9f3" stroke="#248569" stroke-width="1.6"/><text x="655" y="128" text-anchor="middle" font-weight="650">L0 可靠</text><text x="655" y="148" text-anchor="middle" class="note">已驗證，在有效期內</text>
    <rect x="420" y="240" width="130" height="64" rx="8" fill="#fff0ef" stroke="#c9605d"/><text x="485" y="268" text-anchor="middle" font-weight="650">E1 失效</text><text x="485" y="288" text-anchor="middle" class="note">保留並指向替代者</text></g></svg>`;
  const lv = h.levels;
  content().innerHTML = `<div class="two-col"><div class="stack">${panel('層級遷移 · 三個入口、五條遷移', `<div class="panel-body">${diagram}<p class="notice" style="margin-top:10px">人或智能體都不能直接寫入 L0；智能體不能晉升自己或其他智能體提交的知識。衝突不設獨立狀態：雙方降為 L1，裁決後一方回到 L0、另一方轉為 E1。</p></div>`)}
    ${panel('按領域的主體綜合層級', table(['領域', '#主體', '分佈', 'L0', 'L1', 'L2'], byDomain.map(({ d, c, total }) => `<tr><td>${esc(d.code)} ${esc(d.name)}</td><td class="numeric">${total}</td><td style="min-width:160px">${levelBar(c, ['L0', 'L1', 'L2']).bar}</td><td class="numeric">${c.L0}</td><td class="numeric">${c.L1}</td><td class="numeric">${c.L2}</td></tr>`)))}</div>
    <div class="stack">${panel('按條目類型', `<div class="panel-body">${[['客體綁定', lv.binding], ['斷言', lv.assertion], ['關係', lv.relation]].map(([n, c]) => { const b = levelBar(c); return `<div class="bar-row"><span>${n}</span>${b.bar}<small class="muted">${b.text}</small></div>`; }).join('')}</div>`)}
    ${panel('層級用法', table(['層級', '條件', '智能體用法'], Object.entries(schema.levels).map(([k, v]) => `<tr><td>${level(k)}</td><td class="wrap-sm">${esc(v.condition)}</td><td class="wrap-sm">${esc(v.usage)}</td></tr>`)))}
    ${panel('有效期初值（天）', table(['條目', '類型', '#天數'], [...Object.entries(schema.expiryDays.assertion).map(([k, v]) => `<tr><td>斷言</td><td>${esc(k)}</td><td class="numeric">${v}</td></tr>`), ...Object.entries(schema.expiryDays.relation).map(([k, v]) => `<tr><td>關係</td><td>${esc(k)}</td><td class="numeric">${v}</td></tr>`), ...Object.entries(schema.expiryDays.binding).map(([k, v]) => `<tr><td>綁定</td><td>${esc(k)}客體</td><td class="numeric">${v}</td></tr>`)]))}</div></div>`;
};

PAGES.queue = async () => {
  const q = await get('/api/v1/queue');
  setActions(`${isOwner() ? '<button class="button" id="validate-pending">對隊列執行校驗</button>' : ''}${me.isAdmin ? '<button class="button" id="run-expiry">執行到期檢查</button>' : ''}`);
  content().innerHTML = panel(`待重驗（${q.length}）`, table(['#優先級', '條目', '主體', '內容', '原因', '層級', '#使用 × 代價', '操作'], q.map(x => `<tr><td class="numeric">${x.priority}</td><td>${idLink(x.id)}<span class="cell-sub">${esc({ assertion: '斷言', binding: '綁定', relation: '關係' }[x.kind])}</span></td><td>${x.subject ? `${idLink(x.subject.id)} ${esc(x.subject.name)}` : '—'}</td><td class="wrap">${esc(x.summary)}</td><td>${pill(x.pending.label, 'amber')}<span class="cell-sub">${esc(x.pending.note || '')} ${ago(x.pending.at)}</span></td><td>${level(x.level)}</td><td class="numeric">${x.usage} × ${x.errorCost}</td><td>${rowOps(x.id, x.level)}</td></tr>`), '沒有待重驗的知識'));
  $('#validate-pending')?.addEventListener('click', async () => { const r = await post('/api/v1/validate-all', { onlyPending: true }); toast(`校驗 ${r.data.total} 條：通過 ${r.data.passed}，不符 ${r.data.mismatched}，客體缺失 ${r.data.missing}，失敗 ${r.data.errors}`, 6000); render(); });
  $('#run-expiry')?.addEventListener('click', async () => { const r = await post('/admin/api/maintenance/expiry'); toast(`到期檢查完成：${r.data.expired.length} 條降為 L1`); render(); });
};

PAGES.conflicts = async () => {
  const list = await get('/api/v1/conflicts');
  setActions('<button class="button primary" id="add-conflict">登記衝突</button>');
  content().innerHTML = panel(`衝突（${list.length}）`, table(['ID', '知識 A', '知識 B', '說明', '狀態', '登記', '操作'], list.map(c => `<tr><td>${tag(c.id)}</td><td>${idLink(c.a)}${c.winner === c.a ? ' ' + pill('勝出', 'green') : ''}</td><td>${idLink(c.b)}${c.winner === c.b ? ' ' + pill('勝出', 'green') : ''}</td><td class="wrap">${esc(c.note || '—')}${c.reason ? `<span class="cell-sub">裁決：${esc(c.reason)}</span>` : ''}</td><td>${c.status === 'open' ? pill('待裁決', 'amber') : pill('已裁決', 'green')}</td><td>${esc(c.reportedBy?.name || '')}<span class="cell-sub">${fmtTime(c.createdAt)}</span></td><td>${c.status === 'open' && isOwner() ? `<button class="text-btn" data-op="resolveConflict" data-id="${esc(c.id)}">裁決</button>` : ''}</td></tr>`), '沒有衝突'));
  $('#add-conflict').onclick = () => modal('登記衝突', `<p class="notice warn">兩條知識互相矛盾時，雙方都降為 L1，並通知負責人裁決。</p><div class="field-pair">${field('知識 A（ID）', input('a', '', 'required placeholder="A-0001"'))}${field('知識 B（ID）', input('b', '', 'required placeholder="A-0007"'))}</div>${field('說明', textarea('note'))}`, { label: '登記', run: async () => { await post('/api/v1/conflicts', formData($('#dialog-content'))); render(); } });
};

PAGES.feedback = async () => {
  const list = await get('/api/v1/feedback');
  content().innerHTML = panel(`反饋（${list.length}）`, table(['ID', '目標', '原層級', '反饋', '來源', '狀態', '操作'], list.map(f => `<tr><td>${tag(f.id)}</td><td>${idLink(f.targetId)}</td><td>${level(f.wasLevel)}</td><td class="wrap">${esc(f.comment)}${f.question ? `<span class="cell-sub">問題：${esc(f.question)}</span>` : ''}${f.resolution ? `<span class="cell-sub">處理：${esc(f.resolution)}</span>` : ''}</td><td>${esc(f.source?.name || '')}<span class="cell-sub">${fmtTime(f.createdAt)}</span></td><td>${f.status === 'open' ? pill('待處理', 'amber') : pill('已處理', 'green')}</td><td>${f.status === 'open' && isOwner() ? `<button class="text-btn" data-op="closeFeedback" data-id="${esc(f.id)}">關閉</button>` : ''}</td></tr>`), '沒有反饋'));
};

PAGES.gaps = async () => {
  const list = await get('/api/v1/gaps');
  content().innerHTML = `<p class="notice" style="margin-bottom:12px">「未收錄就說未收錄」：智能體不會用行業通用知識補全，而是把問題記為知識缺口。按次數決定下一批要建設的內容。</p>${panel(`知識缺口（${list.length}）`, table(['ID', '問題', '#次數', '相關主體', '最近', '狀態', '操作'], list.map(g => `<tr><td>${tag(g.id)}</td><td class="wrap">${esc(g.question)}<span class="cell-sub">${esc(g.reason || '')}</span></td><td class="numeric">${g.count}</td><td>${(g.subjectIds || []).map(id => idLink(id)).join(' ') || '—'}</td><td>${ago(g.lastAt)}</td><td>${g.status === 'open' ? pill('待補充', 'amber') : pill('已處理', 'green')}</td><td>${g.status === 'open' && isOwner() ? `<button class="text-btn" data-op="closeGap" data-id="${esc(g.id)}">標記已處理</button>` : ''}</td></tr>`), '暫無知識缺口'))}`;
};

const ACTION_TEMPLATE = { name: '查詢可售庫存（SKU，倉庫）', kind: '取值', pipelineId: 'P-0001', objectKinds: ['API'], request: { method: 'GET', path: '/inventory/v1/availability', query: { sku: '{input.sku}', warehouse: '{input.warehouse}' } }, inputs: [{ name: 'sku', label: 'SKU', required: true, pattern: 'SKU-\\d+' }, { name: 'warehouse', label: '倉庫', required: true, fromObjects: '物理' }], output: { path: 'available_qty', unit: '件', label: '可售庫存' }, permission: 'consumer', description: '' };
const PIPELINE_TEMPLATE = { name: 'API 網關', type: 'http', baseUrl: 'https://gateway.internal.example', headers: { Authorization: 'Bearer ${env:GATEWAY_TOKEN}' }, timeoutMs: 8000, description: '' };

function jsonDialog(title, value, save) {
  modal(title, `${field('定義（JSON）', textarea('json', JSON.stringify(value, null, 2), 'class="code" spellcheck="false"'))}<p class="muted" style="font-size:12px;margin-top:6px">模板變量：{input.x}、{object.locator}、{item.structured.value}；管道憑證用 \${env:變數名}。MVP 只讀不寫。</p>`, {
    label: '保存',
    run: async () => {
      let body;
      try { body = JSON.parse($('#dialog-content textarea').value); } catch (e) { throw new Error('JSON 格式錯誤：' + e.message); }
      await save(body);
      toast('已保存');
      render();
    }
  });
}

PAGES.actions = async () => {
  const [list, pipelines] = await Promise.all([get('/api/v1/actions'), get('/api/v1/pipelines')]);
  setActions(isOwner() ? '<button class="button primary" id="add-action">新增 Action</button>' : '');
  content().innerHTML = panel(`Action（${list.length}）`, table(['ID', '名稱', '種類', '管道', '請求', '輸入 / 輸出', '調用權限', '操作'], list.map(a => `<tr><td>${tag(a.id)}</td><td class="wrap">${esc(a.name)}<span class="cell-sub">${esc(a.description || '')}</span></td><td>${pill(a.kind, a.kind === '校驗' ? 'blue' : 'green')}${a.check ? `<span class="cell-sub">${esc(a.check.mode)}</span>` : ''}</td><td>${esc(pipelines.find(p => p.id === a.pipelineId)?.name || a.pipelineId)}</td><td class="mono wrap">${esc(a.request.method)} ${esc(a.request.path)}</td><td class="wrap">${(a.inputs || []).map(i => tag(i.name)).join(' ') || '—'}${a.output?.path ? `<span class="cell-sub">輸出 ${esc(a.output.path)}</span>` : ''}</td><td>${esc(a.permission)}</td><td><div class="cell-actions">${a.kind === '取值' ? `<button class="text-btn" data-op="invoke" data-id="${esc(a.id)}">調用</button>` : ''}${isOwner() ? `<button class="text-btn edit-action" data-id="${esc(a.id)}">編輯</button>` : ''}</div></td></tr>`), '尚無 Action'));
  $('#add-action')?.addEventListener('click', () => jsonDialog('新增 Action', { ...ACTION_TEMPLATE, pipelineId: pipelines[0]?.id || 'P-0001' }, body => post('/api/v1/actions', body)));
  $$('.edit-action').forEach(b => (b.onclick = () => { const a = list.find(x => x.id === b.dataset.id); const { id, updatedAt, ...rest } = a; jsonDialog(`編輯 ${id}`, rest, body => put(`/api/v1/actions/${id}`, body)); }));
};

PAGES.pipelines = async () => {
  const list = await get('/api/v1/pipelines');
  setActions(isOwner() ? '<button class="button primary" id="add-pipeline">新增管道</button>' : '');
  content().innerHTML = `<p class="notice" style="margin-bottom:12px">管道屬於基礎設施，使用者通常只看到 Action。示意（mock）管道按路由返回模板結果；接入真實系統時改為 http 類型。</p>${panel(`管道（${list.length}）`, table(['ID', '名稱', '類型', '地址 / 路由', '說明', '操作'], list.map(p => `<tr><td>${tag(p.id)}</td><td>${esc(p.name)}</td><td>${pill(p.type === 'mock' ? '示意' : 'HTTP', p.type === 'mock' ? 'amber' : 'blue')}</td><td class="mono wrap">${esc(p.type === 'http' ? p.baseUrl : (p.routes || []).map(r => `${r.method || 'GET'} ${r.path}`).join('\n'))}</td><td class="wrap">${esc(p.description || '')}</td><td><div class="cell-actions">${isOwner() ? `<button class="text-btn test-pipe" data-id="${esc(p.id)}">測試</button><button class="text-btn edit-pipe" data-id="${esc(p.id)}">編輯</button>` : ''}</div></td></tr>`), '尚無管道'))}`;
  $('#add-pipeline')?.addEventListener('click', () => jsonDialog('新增管道', PIPELINE_TEMPLATE, body => post('/api/v1/pipelines', body)));
  $$('.edit-pipe').forEach(b => (b.onclick = () => { const p = list.find(x => x.id === b.dataset.id); const { id, updatedAt, ...rest } = p; jsonDialog(`編輯 ${id}`, rest, body => put(`/api/v1/pipelines/${id}`, body)); }));
  $$('.test-pipe').forEach(b => (b.onclick = async () => { const r = await post(`/api/v1/pipelines/${b.dataset.id}/test`); toast(`${b.dataset.id}：${r.data.ok ? '可用' : '不可用'}（${r.data.detail}）`, 5000); }));
};

PAGES.playground = async () => {
  const examples = ['可售庫存怎麼算？', '可售庫存以前是不是不扣安全庫存？', 'SKU-123 在上海一號倉還有多少可售？', '可售庫存會出現負數嗎？', '「可用庫存」指什麼？', '可售庫存多久同步到搜索系統？'];
  content().innerHTML = `<div class="two-col"><div class="stack">${panel('提問', `<div class="panel-body"><form id="ask-form">${field('問題', textarea('question', examples[0], 'required style="min-height:80px;font-family:inherit"'))}<div class="field-pair">${field('限定主體 ID（選填，用於消歧）', input('subjectIds', '', 'placeholder="S-INV-0012"'))}${field('自然語言組織', select('compose', [['auto', '自動（已配置 OpenRouter 則使用）'], ['llm', '強制 OpenRouter'], ['template', '規則模板']], 'auto'))}</div><div class="actions" style="margin-top:12px"><button class="button primary" type="submit">提問</button><span class="muted" style="font-size:11px">以目前登入身份調用 POST /api/v1/ask</span></div></form><div class="chip-row" style="margin-top:12px">${examples.map(q => `<button class="button example" type="button">${esc(q)}</button>`).join('')}</div></div>`)}<div id="ask-result" class="stack"></div></div>
    <div>${panel('智能體使用規約', `<div class="panel-body prose"><ol><li>解析術語：別名解析為規範主體；多義別名先消歧。</li><li>動態值調用取值 Action，不使用存儲值。</li><li>按層級作答：L0 直接依據；L1 標註未驗證；L2 只作思路；E1 不得作依據並給出替代者。</li><li>引用主體 ID、斷言 ID 和層級。</li><li>未收錄就說未收錄，記為知識缺口。</li><li>用戶指出有誤時提交反饋，觸發降級和重驗。</li></ol></div>`)}</div></div>`;
  $$('.example').forEach(b => (b.onclick = () => { $('#ask-form textarea').value = b.textContent; $('#ask-form').requestSubmit(); }));
  $('#ask-form').onsubmit = async e => {
    e.preventDefault();
    const d = formData($('#ask-form'));
    $('#ask-result').innerHTML = '<div class="panel panel-body muted">查詢中…</div>';
    try {
      const r = (await post('/api/v1/ask', { question: d.question, compose: d.compose, subjectIds: d.subjectIds ? d.subjectIds.split(/[,，\s]+/).filter(Boolean) : [] })).data;
      const statusPill = { answered: pill('已回答', 'green'), ambiguous: pill('需要消歧', 'amber'), uncovered: pill('知識庫未收錄', 'red'), need_inputs: pill('需要參數', 'amber') }[r.status];
      $('#ask-result').innerHTML = `${panel(`答案 ${statusPill}`, `<div class="panel-body"><div class="answer">${esc(r.answer)}</div><p class="muted" style="font-size:11px;margin-top:10px">組織方式：${esc(r.composer.type === 'openrouter' ? `OpenRouter · ${r.composer.model}` : r.composer.type === 'template' ? '規則模板' : '規則')}${r.composer.fallbackReason ? `（OpenRouter 失敗，已回退：${esc(r.composer.fallbackReason)}）` : ''}${r.gap ? ` · 已記為知識缺口 ${esc(r.gap.id)}` : ''}</p>${r.next?.candidates ? `<div class="chip-row" style="margin-top:8px">${r.next.candidates.map(c => `<button class="button disambig" data-id="${esc(c.id)}">指 ${esc(c.name)}</button>`).join('')}</div>` : ''}</div>`)}
        ${r.citations?.length ? panel('引用', table(['ID', '層級', '內容', ''], r.citations.map(c => `<tr><td>${idLink(c.id)}</td><td>${level(c.level)}</td><td class="wrap">${esc(c.content || '')}</td><td>${c.kind !== 'action' ? `<button class="text-btn" data-op="feedback" data-id="${esc(c.id)}">反饋有誤</button>` : ''}</td></tr>`))) : ''}
        ${r.realtime?.length ? panel('實時取值', `<pre class="mono-block">${esc(JSON.stringify(r.realtime, null, 2))}</pre>`) : ''}
        ${panel('完整回應（結構化知識）', `<details style="padding:0 12px"><summary>展開 JSON</summary><pre class="mono-block">${esc(JSON.stringify(r, null, 2))}</pre></details>`)}`;
      $$('.disambig').forEach(b => (b.onclick = () => { $('#ask-form [name=subjectIds]').value = b.dataset.id; $('#ask-form').requestSubmit(); }));
    } catch (err) {
      $('#ask-result').innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
    }
  };
};

PAGES.prompt = async () => {
  const role = new URLSearchParams(location.hash.split('?')[1] || '').get('role') === 'consumer' ? 'consumer' : 'producer';
  const res = await fetch(`/api/v1/prompt?role=${role}`);
  const md = await res.text();
  const url = `${location.origin}/api/v1/prompt${role === 'consumer' ? '?role=consumer' : ''}`;
  setActions(`<div class="segmented" role="tablist"><button class="${role === 'producer' ? 'active' : ''}" id="r-prod">生產教程</button><button class="${role === 'consumer' ? 'active' : ''}" id="r-cons">消費教程</button></div><button class="button" id="dl-md">下載 Markdown</button>`);
  content().innerHTML = `<div class="stack">${panel('拉取地址（無需金鑰）', `<div class="panel-body stack-sm"><div class="copy-row"><code>${esc(url)}</code><button class="button" id="copy-url">複製</button></div><div class="copy-row"><code>curl -s ${esc(url)}</code><button class="button" id="copy-curl">複製</button></div><p class="muted" style="font-size:12px">把這個地址交給三方智能體：先讀教程，再用你在「API 金鑰」頁發放的金鑰調用 API。教程內容會隨知識庫規模、領域代碼和有效期參數即時生成。</p></div>`)}
    ${panel('教程內容', `<div class="panel-body prose">${markdown(md)}</div>`)}</div>`;
  $('#r-prod').onclick = () => (location.hash = 'prompt');
  $('#r-cons').onclick = () => (location.hash = 'prompt?role=consumer');
  $('#copy-url').onclick = () => copy(url);
  $('#copy-curl').onclick = () => copy(`curl -s ${url}`);
  $('#dl-md').onclick = () => download(`knowledge-${role}-prompt.md`, md, 'text/markdown');
};

PAGES.keys = async () => {
  const list = await get('/admin/api/keys');
  setActions('<button class="button primary" id="add-key">發放金鑰</button>');
  const kindName = { human: '人', agent: '智能體', pipeline: '管道' };
  const roleName = { consumer: '消費者', contributor: '貢獻者', owner: '負責人' };
  content().innerHTML = `<p class="notice" style="margin-bottom:12px">角色：消費者只能讀取與問答；貢獻者可提交知識（最高 L1）；負責人（只能是人）可確認晉升、裁決衝突、判定失效。管道金鑰提交的知識按管道校驗結果直接定級。</p>${panel(`API 金鑰（${list.length}）`, table(['名稱', 'ID', '類型', '角色', '前綴', '建立', '最近使用', '狀態', '操作'], list.map(k => `<tr><td>${esc(k.name)}</td><td class="mono">${esc(k.id)}</td><td>${esc(kindName[k.kind])}</td><td>${esc(roleName[k.role])}</td><td class="mono">${esc(k.prefix)}…</td><td>${fmtTime(k.createdAt)}</td><td>${ago(k.lastUsedAt)}</td><td>${k.disabled ? pill('已停用', 'red') : pill('啟用', 'green')}</td><td><div class="cell-actions"><button class="text-btn toggle-key" data-id="${esc(k.id)}" data-disabled="${k.disabled ? '0' : '1'}">${k.disabled ? '啟用' : '停用'}</button><button class="text-btn del-key" data-id="${esc(k.id)}" style="color:var(--danger)">刪除</button></div></td></tr>`), '尚未發放金鑰'))}`;
  $('#add-key').onclick = () => modal('發放 API 金鑰', `${field('名稱', input('name', '', 'required placeholder="例如：庫存域冷啟動智能體"'))}<div class="field-pair">${field('類型', select('kind', [['agent', '智能體'], ['human', '人'], ['pipeline', '管道（自動同步）']], 'agent'))}${field('角色', select('role', [['contributor', '貢獻者：生產 + 消費'], ['consumer', '消費者：只讀與問答'], ['owner', '負責人（僅限人）']], 'contributor'))}</div>`, {
    label: '發放',
    run: async () => {
      const r = await post('/admin/api/keys', formData($('#dialog-content')));
      modal('金鑰已發放', `<p class="notice warn">金鑰只顯示這一次，請立即保存。</p><div class="copy-row" style="margin-top:10px"><code id="new-secret">${esc(r.data.secret)}</code><button class="button" id="copy-secret">複製</button></div><p class="muted" style="font-size:12px;margin-top:10px">使用方式：<code>Authorization: Bearer ${esc(r.data.prefix)}…</code>；教程地址：<code>${esc(location.origin)}/api/v1/prompt</code></p>`);
      $('#copy-secret').onclick = () => copy(r.data.secret);
      PAGES.keys();
      return true;
    }
  });
  $$('.toggle-key').forEach(b => (b.onclick = async () => { await patch(`/admin/api/keys/${b.dataset.id}`, { disabled: b.dataset.disabled === '1' }); render(); }));
  $$('.del-key').forEach(b => (b.onclick = () => modal('刪除金鑰', `<p>確定刪除 ${esc(b.dataset.id)}？使用此金鑰的智能體將無法訪問。</p>`, { label: '刪除', run: async () => { await del(`/admin/api/keys/${b.dataset.id}`); render(); } })));
};

PAGES.apidoc = async () => {
  const spec = await (await fetch('/api/v1/openapi.json')).json();
  const rows = [];
  for (const [p, methods] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(methods)) rows.push({ tag: op.tags[0], m: m.toUpperCase(), p, op });
  const tags = [...new Set(rows.map(r => r.tag))];
  setActions('<a class="button" href="/api/v1/openapi.json" target="_blank" rel="noopener">openapi.json</a>');
  content().innerHTML = `<div class="stack">${panel('基本資訊', `<div class="panel-body"><dl class="kv"><dt>根地址</dt><dd class="mono">${esc(spec.servers[0].url)}</dd><dt>認證</dt><dd><code>Authorization: Bearer &lt;API 金鑰&gt;</code>（教程、Schema、OpenAPI 公開）</dd><dt>回應</dt><dd><code>{ data, commit?, warnings? }</code>；錯誤 <code>{ error: { code, message } }</code></dd></dl></div>`)}${tags.map(t => panel(t, table(['方法', '路徑', '說明', '角色'], rows.filter(r => r.tag === t).map(r => `<tr><td>${pill(r.m, r.m === 'GET' ? '' : 'blue')}</td><td class="mono">${esc(r.p)}</td><td class="wrap">${esc(r.op.summary)}</td><td>${esc(r.op.description.replace('所需角色：', ''))}</td></tr>`)))).join('')}</div>`;
};

PAGES.repo = async () => {
  const s = await get('/admin/api/settings');
  const g = s.git;
  const src = k => (g[`${k}Source`] ? `<small>由環境變數 ${esc(g[`${k}Source`].replace('env:', ''))} 提供</small>` : '');
  const st = s.gitStatus;
  content().innerHTML = `<div class="two-col"><div class="stack">${panel('Git 倉庫', `<div class="panel-body"><form id="git-form">
    ${field('倉庫地址', input('url', g.url, 'placeholder="https://github.com/your-org/supply-chain-knowledge.git（留空為純本地倉庫）"'), '支持 https 與 ssh；知識以 YAML 檔案存放，每次寫入一個提交')}${src('url')}
    <div class="field-pair">${field('分支', input('branch', g.branch))}${field('知識目錄', input('subdir', g.subdir), '倉庫內存放知識的子目錄')}</div>
    <div class="field-pair">${field('存取權杖（https）', input('token', g.token, 'type="password" autocomplete="off" placeholder="GitHub PAT 等；只存本地，不入庫"'))}${field('權杖用戶名', input('username', g.username))}</div>
    <div class="field-pair">${field('提交者名稱', input('authorName', g.authorName))}${field('提交者郵箱', input('authorEmail', g.authorEmail))}</div>
    <div class="field-pair">${field('自動拉取間隔（秒）', input('pullIntervalSec', g.pullIntervalSec, 'type="number" min="15"'), '定期拉取他人在 Git 中直接做的修改；重啟後生效')}<label class="check" style="margin-top:22px"><input type="checkbox" name="autoPush" ${g.autoPush ? 'checked' : ''}> 寫入後自動推送</label></div>
    <div class="actions" style="margin-top:14px"><button class="button" type="button" id="git-test">測試連接</button><button class="button primary" type="submit">保存並切換</button></div></form></div>`)}</div>
    <div class="stack">${panel('同步狀態', `<div class="panel-body"><dl class="kv"><dt>遠端</dt><dd>${esc(st.remote || '未配置')}</dd><dt>分支</dt><dd>${esc(st.branch)}</dd><dt>本地目錄</dt><dd class="mono">${esc(s.repoDir)}</dd><dt>最近拉取</dt><dd>${fmtTime(st.lastPullAt)}</dd><dt>最近推送</dt><dd>${fmtTime(st.lastPushAt)}</dd><dt>錯誤</dt><dd>${esc(st.lastError || '無')}</dd></dl><div class="actions" style="margin-top:12px"><button class="button" id="git-sync">立即同步</button></div></div>`)}
    ${panel('示例資料', `<div class="panel-body"><p style="font-size:12px">載入設計文件中的「可售庫存」示例及庫存域試點主體（約 26 個主體、示意管道與 Action）。走真實流程：先提交為 L1/L2，再經 Action 校驗和負責人確認晉升。系統名、表名、接口名均為示意。</p><div class="actions" style="margin-top:10px"><button class="button" id="seed">載入示例資料</button></div></div>`)}</div></div>`;
  $('#git-test').onclick = async () => { try { const r = await post('/admin/api/settings/git/test', formData($('#git-form'))); toast(r.data.empty ? '可連接：倉庫為空，首次寫入會建立分支' : `可連接：分支 ${r.data.branches.join('、')}${r.data.branchExists ? '' : '（目標分支尚不存在，將自動建立）'}`, 6000); } catch (e) { showError(e); } };
  $('#git-form').onsubmit = async e => { e.preventDefault(); try { await put('/admin/api/settings/git', formData($('#git-form'))); toast('已切換知識倉庫'); render(); } catch (err) { showError(err); } };
  $('#git-sync').onclick = async () => { try { const r = await post('/admin/api/sync'); toast(r.data.changed ? '已拉取遠端更新並重新載入' : '已是最新'); render(); } catch (e) { showError(e); } };
  $('#seed').onclick = async () => { try { const r = await post('/admin/api/seed'); toast(`已載入示例資料（${r.data.subjects} 個主體）`); location.hash = `subject/${r.data.focus}`; } catch (e) { showError(e); } };
};

PAGES.llm = async () => {
  const s = await get('/admin/api/settings');
  const l = s.llm;
  content().innerHTML = `<div class="two-col"><div>${panel('OpenRouter', `<div class="panel-body"><form id="llm-form">${field('API Key', input('apiKey', l.apiKey, 'type="password" autocomplete="off" placeholder="sk-or-…"'), l.apiKeySource ? `由環境變數 ${l.apiKeySource.replace('env:', '')} 提供` : '只存本地 settings.json，不入知識倉庫')}${field('模型', input('model', l.model, 'placeholder="anthropic/claude-sonnet-4.5"'), 'OpenRouter 模型 ID，可隨時更換')}${field('API 地址', input('baseUrl', l.baseUrl))}<div class="field-pair">${field('Temperature', input('temperature', l.temperature, 'type="number" step="0.1" min="0" max="1"'))}${field('超時（毫秒）', input('timeoutMs', l.timeoutMs, 'type="number" min="1000"'))}</div>${field('應用名稱（X-Title）', input('appTitle', l.appTitle))}<div class="actions" style="margin-top:14px"><button class="button" type="button" id="llm-test">測試</button><button class="button primary" type="submit">保存</button></div></form></div>`)}</div>
    <div>${panel('說明', `<div class="panel-body prose"><p>消費型 API 的 <code>/ask</code> 先按規約完成術語解析、動態取值和知識檢索，再把結構化知識交給模型組織成自然語言。</p><ul><li>模型只能依據提供的知識作答，每個結論標註〔ID·層級〕。</li><li>模型返回的引用會被校驗，不在知識範圍內的 ID 會被丟棄。</li><li>未配置或調用失敗時，自動回退為規則模板組織的答案。</li></ul></div>`)}</div></div>`;
  $('#llm-form').onsubmit = async e => { e.preventDefault(); try { await put('/admin/api/settings/llm', formData($('#llm-form'))); toast('已保存'); render(); } catch (err) { showError(err); } };
  $('#llm-test').onclick = async () => { try { const r = await post('/admin/api/settings/llm/test'); toast(`可用：${r.data.model}`); } catch (e) { showError(e); } };
};

PAGES.rules = async () => {
  const s = await get('/admin/api/settings');
  const r = s.rules;
  const exp = r.expiryDays;
  const num = (name, v) => input(name, v, 'type="number" min="1" style="width:90px"');
  content().innerHTML = `<form id="rules-form" class="stack"><div class="two-col"><div class="stack">${panel('領域代碼', `<div class="panel-body">${field('每行一個：代碼 名稱', textarea('domains', r.domains.map(d => `${d.code} ${d.name}`).join('\n'), 'style="min-height:140px"'), '代碼 2–6 個大寫字母，決定主體 ID 前綴，如 S-INV-0012')}</div>`)}
    ${panel('其他參數', `<div class="panel-body">${field('高頻主體比例', input('highFrequencyRatio', r.highFrequencyRatio, 'type="number" step="0.05" min="0.01" max="1"'), 'L0 覆蓋率按被問得最多的前 N% 主體計算')}${field('定期校驗間隔（小時，0 為關閉）', input('validationIntervalHours', r.validationIntervalHours, 'type="number" min="0"'))}${field('對外訪問地址（教程中的 API 根地址）', input('publicBaseUrl', s.server.publicBaseUrl, 'placeholder="https://knowledge.example.com"'), '留空時按請求的 Host 推斷')}</div>`)}</div>
    <div>${panel('有效期初值（天）', table(['條目', '類型', '天數'], [...Object.entries(exp.assertion).map(([k, v]) => `<tr><td>斷言</td><td>${esc(k)}</td><td>${num(`assertion.${k}`, v)}</td></tr>`), ...Object.entries(exp.relation).map(([k, v]) => `<tr><td>關係</td><td>${esc(k)}</td><td>${num(`relation.${k}`, v)}</td></tr>`), ...Object.entries(exp.binding).map(([k, v]) => `<tr><td>綁定</td><td>${esc(k)}客體</td><td>${num(`binding.${k}`, v)}</td></tr>`)]))}</div></div><div class="actions"><button class="button primary" type="submit">保存規則參數</button></div></form>`;
  $('#rules-form').onsubmit = async e => {
    e.preventDefault();
    const d = formData($('#rules-form'));
    const domains = d.domains.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [code, ...name] = l.split(/\s+/); return { code: code.toUpperCase(), name: name.join(' ') }; });
    const expiryDays = { assertion: {}, relation: {}, binding: {} };
    for (const [k, v] of Object.entries(d)) { const m = /^(assertion|relation|binding)\.(.+)$/.exec(k); if (m) expiryDays[m[1]][m[2]] = Number(v); }
    try {
      await put('/api/v1/config', { domains, expiryDays, highFrequencyRatio: Number(d.highFrequencyRatio), validationIntervalHours: Number(d.validationIntervalHours) });
      await put('/admin/api/settings/server', { publicBaseUrl: d.publicBaseUrl });
      schema = await get('/api/v1/schema');
      toast('已保存（規則參數已提交到知識倉庫）');
      render();
    } catch (err) { showError(err); }
  };
};

PAGES.account = async () => {
  const s = me.isAdmin ? await get('/admin/api/settings') : null;
  content().innerHTML = `<div class="two-col"><div>${panel('目前身份', `<div class="panel-body"><dl class="kv"><dt>名稱</dt><dd>${esc(me.name)}</dd><dt>ID</dt><dd class="mono">${esc(me.id)}</dd><dt>角色</dt><dd>${me.isAdmin ? '管理員（負責人權限）' : esc(me.role)}</dd></dl><div class="actions" style="margin-top:12px"><button class="button" id="logout">登出</button></div></div>`)}</div>
    <div>${s ? panel('修改管理員密碼', `<div class="panel-body">${s.adminPasswordFromEnv ? '<p class="notice">密碼由環境變數 ADMIN_PASSWORD 提供，請在部署環境中修改。</p>' : `<form id="pw-form">${field('新密碼（至少 8 位）', input('password', '', 'type="password" autocomplete="new-password" required minlength="8"'))}<div class="actions" style="margin-top:12px"><button class="button primary" type="submit">修改</button></div></form>`}</div>`) : ''}</div></div>`;
  $('#logout').onclick = logout;
  $('#pw-form')?.addEventListener('submit', async e => { e.preventDefault(); try { await put('/admin/api/password', formData($('#pw-form'))); toast('密碼已修改'); e.target.reset(); } catch (err) { showError(err); } });
};

// ------------------------------------------------------------------ 啟動
async function render() {
  if (!me) return;
  const r = route();
  r.page = r.page.split('?')[0];
  const entry = shell(navFor(), r);
  const page = PAGES[r.page] && (r.page === entry.id || (entry.aliases || []).includes(r.page)) ? r.page : entry.id;
  content().innerHTML = '<div class="panel panel-body muted">載入中…</div>';
  try {
    await PAGES[page]({ ...r, page });
  } catch (err) {
    if (err.status === 401) return;
    content().innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
  }
}

async function logout() {
  await post('/admin/api/logout').catch(() => {});
  me = null;
  showLogin();
}

function showLogin() {
  $('#login').hidden = false;
  $('#login-mark').innerHTML = icon('node');
  $('#login-form input').focus();
}

async function boot() {
  try {
    me = await get('/admin/api/me');
  } catch {
    me = null;
  }
  if (!me) return showLogin();
  $('#login').hidden = true;
  $('#avatar').textContent = (me.name || '管').slice(0, 1);
  schema = await get('/api/v1/schema');
  get('/api/v1/status').then(s => ($('#foot-git').textContent = `知識倉庫：${s.git.remote || '本地'} · ${s.git.branch}`)).catch(() => {});
  render();
}

setUnauthorizedHandler(() => { if (me) { me = null; showLogin(); } });
$('#login-form').onsubmit = async e => {
  e.preventDefault();
  const secret = $('#login-form input').value;
  $('#login-error').hidden = true;
  try {
    await post('/admin/api/login', secret.startsWith('kk_') ? { apiKey: secret } : { password: secret });
    $('#login-form').reset();
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  }
};
$('#menu-toggle').onclick = () => { const open = $('#sidebar').classList.toggle('open'); $('#menu-toggle').setAttribute('aria-expanded', String(open)); };
$('#dialog-close').onclick = () => closeModal();
$('.skip').onclick = e => { e.preventDefault(); $('#main').setAttribute('tabindex', '-1'); $('#main').focus(); };
$('#sidenav').onclick = e => { if (e.target.closest('a')) { $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); } };
$('#avatar').onclick = () => {
  if (me?.isAdmin) { location.hash = 'account'; return; }
  modal('目前身份', `<dl class="kv"><dt>名稱</dt><dd>${esc(me?.name)}</dd><dt>ID</dt><dd class="mono">${esc(me?.id)}</dd><dt>角色</dt><dd>${esc(me?.role)}</dd></dl>`, { label: '登出', run: logout });
};
window.addEventListener('hashchange', render);
boot();

export { LEVEL_TEXT };
