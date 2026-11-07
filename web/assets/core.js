// 後台共用：Portal 外殼（沿用視覺樣式包 shell.js 的結構與行為）、API 呼叫、表單與格式化工具。
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7m-3.5-3.5v7"/>',
  node: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8.3 7l7.4.8M7.2 8.2l2 7.4M16.6 10l-5 6"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  shield: '<path d="M12 3l7 3v6c0 4.2-3 7.6-7 9-4-1.4-7-4.8-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  plug: '<path d="M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-10 0zM12 17v4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'
};
export const icon = (name = 'grid') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${ICONS[name] || ICONS.grid}</svg>`;

/** 兩級 Portal：頂部第一級、左側第二級；支持 #page/參數 形式的詳情路由。 */
export function shell(config, route) {
  $('#brand').innerHTML = `<span class="brand-mark">${icon('node')}</span><span>${esc(config.title)}<small>${esc(config.subtitle)}</small></span>`;
  const groups = config.groups.filter(g => !g.hidden);
  const all = groups.flatMap(g => g.pages.map(p => ({ ...p, group: g })));
  const entry = all.find(p => p.id === route.page) || all.find(p => (p.aliases || []).includes(route.page)) || all[0];
  const group = entry.group;
  $('#topnav').innerHTML = groups.map(g => `<a href="#${g.pages[0].id}" class="${g.id === group.id ? 'active' : ''}" ${g.id === group.id ? 'aria-current="true"' : ''}>${esc(g.name)}</a>`).join('');
  $('#side-heading').innerHTML = `<small>${esc(group.en)}</small><strong>${esc(group.name)}</strong>`;
  $('#sidenav').innerHTML = group.pages.map(p => `<a href="#${p.id}" class="${p.id === entry.id ? 'active' : ''}" ${p.id === entry.id ? 'aria-current="page"' : ''}><span class="nav-icon">${icon(p.icon || group.icon)}</span><span>${esc(p.name)}</span></a>`).join('');
  setHeading(entry.name, entry.desc || '', group.name + ' › ' + entry.name);
  document.title = entry.name + ' · ' + config.title;
  $('#sidebar').classList.remove('open');
  $('#menu-toggle').setAttribute('aria-expanded', 'false');
  $('#page-actions').innerHTML = '';
  return entry;
}

export function setHeading(title, desc, crumb) {
  $('#title').textContent = title;
  $('#description').textContent = desc || '';
  if (crumb) $('#crumb').textContent = crumb;
}

let toastTimer;
export function toast(text, ms = 3200) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), ms);
}

export function modal(title, html, action) {
  $('#dialog-title').textContent = title;
  $('#dialog-content').innerHTML = html;
  const btn = $('#dialog-action');
  btn.hidden = !action;
  btn.disabled = false;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const keep = await action.run();
        if (keep !== true) $('#dialog').close();
      } catch (err) {
        showError(err, $('#dialog-content'));
      } finally {
        btn.disabled = false;
      }
    };
  }
  if (!$('#dialog').open) $('#dialog').showModal();
  const first = $('#dialog-content input, #dialog-content select, #dialog-content textarea');
  if (first) first.focus();
}
export const closeModal = () => $('#dialog').close();

export function showError(err, container) {
  const msg = err?.message || String(err);
  if (container) {
    let box = $('.form-error', container);
    if (!box) {
      box = document.createElement('div');
      box.className = 'notice warn form-error';
      container.prepend(box);
    }
    box.textContent = msg;
    box.scrollIntoView({ block: 'nearest' });
  } else toast(msg, 5000);
}

export function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已複製');
  } catch {
    toast('無法使用剪貼簿，請手動選取複製');
  }
}

// ---- API
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `請求失敗（HTTP ${status}）`);
    this.status = status;
    this.code = body?.error?.code;
    this.body = body;
  }
}

export let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(method, path, body) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (res.status === 401 && !path.endsWith('/login')) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, json);
  if (json.warnings?.length) toast('提示：' + json.warnings.join('；'), 6000);
  return json;
}
export const get = path => api('GET', path).then(r => r.data ?? r);
export const post = (path, body = {}) => api('POST', path, body);
export const put = (path, body = {}) => api('PUT', path, body);
export const patch = (path, body = {}) => api('PATCH', path, body);
export const del = path => api('DELETE', path);

// ---- 格式化
export const LEVEL_TEXT = { L0: 'L0 可靠', L1: 'L1 參考', L2: 'L2 探索', E1: 'E1 失效' };
const LEVEL_CLASS = { L0: 'green', L1: 'blue', L2: 'amber', E1: 'red' };
export const level = l => (l ? `<span class="badge ${LEVEL_CLASS[l] || ''} lvl-${esc(l)}" title="${esc(LEVEL_TEXT[l] || l)}">${esc(LEVEL_TEXT[l] || l)}</span>` : '<span class="muted">—</span>');
export const pill = (s, c = '') => `<span class="badge ${c}">${esc(s)}</span>`;
export const tag = s => `<span class="tag">${esc(s)}</span>`;
export const idLink = (id, label) => {
  if (!id) return '';
  const href = id.startsWith('S-') ? `#subject/${id}` : id.startsWith('O-') ? `#object/${id}` : id.startsWith('ACT-') ? `#actions` : id.startsWith('P-') ? '#pipelines' : `#item/${id}`;
  return `<a href="${href}" class="tag">${esc(label || id)}</a>`;
};
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
}
export const pct = v => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

export function panel(title, body, extra = '', cls = '') {
  return `<section class="panel ${cls}"><div class="panel-header"><h2>${title}</h2><div class="actions">${extra}</div></div>${body}</section>`;
}

export function table(headers, rows, empty = '沒有相符項目') {
  return `<div class="table-scroll"><table><thead><tr>${headers.map(h => `<th${h.startsWith('#') ? ' class="numeric"' : ''}>${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="empty-cell">${esc(empty)}</td></tr>`}</tbody></table></div>`;
}

export function formData(root) {
  const out = {};
  for (const el of $$('[name]', root)) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.multiple) out[el.name] = [...el.selectedOptions].map(o => o.value);
    else out[el.name] = el.value;
  }
  return out;
}

export const field = (label, inner, hint = '') => `<label class="field">${esc(label)}${inner}${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
export const input = (name, value = '', attrs = '') => `<input name="${name}" value="${esc(value)}" ${attrs}>`;
export const select = (name, options, value = '', attrs = '') => `<select name="${name}" ${attrs}>${options.map(o => {
  const [v, l] = Array.isArray(o) ? o : [o, o];
  return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`;
}).join('')}</select>`;
export const textarea = (name, value = '', attrs = '') => `<textarea name="${name}" ${attrs}>${esc(value)}</textarea>`;

/** 極簡 Markdown 渲染（標題、段落、列表、表格、程式碼塊、行內程式碼、粗體）。 */
export function markdown(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let i = 0;
  const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { const n = Math.min(3, h[1].length + 1); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push(`<div class="table-scroll"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td class="wrap">${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(x => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\||```|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}
