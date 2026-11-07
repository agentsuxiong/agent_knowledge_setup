// 知識圖譜可視化：無外部依賴的力導向佈局（SVG），支持拖曳節點、平移、縮放、點選。
import { esc } from './core.js';

export const TYPE_COLORS = { 系統: '#147fe6', 業務對象: '#248569', 流程: '#7a5af5', 規則: '#b8661f', 指標: '#0b8fa3', 別名: '#8a99ad' };
const EDGE_STYLE = {
  L0: { stroke: '#5b6f88', width: 1.7, dash: '' },
  L1: { stroke: '#8fa6c0', width: 1.3, dash: '' },
  L2: { stroke: '#b8c6d6', width: 1.2, dash: '5 4' },
  E1: { stroke: '#d48c89', width: 1.1, dash: '2 4' }
};

function layout(nodes, edges, width, height, focus) {
  // Fruchterman–Reingold，最後整體縮放平移以完整放入畫布。
  const n = nodes.length;
  const idx = new Map(nodes.map((d, i) => [d.id, i]));
  const cx = width / 2;
  const cy = height / 2;
  const pos = nodes.map((d, i) => {
    const a = (i / Math.max(1, n)) * Math.PI * 2 + (i % 3) * 0.3;
    const r = Math.min(width, height) * (0.18 + ((i * 37) % 10) / 40);
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
  const fi = focus && idx.has(focus) ? idx.get(focus) : -1;
  if (fi >= 0) Object.assign(pos[fi], { x: cx, y: cy });
  const links = edges.map(e => [idx.get(e.from), idx.get(e.to)]).filter(([a, b]) => a !== undefined && b !== undefined && a !== b);
  const k = Math.sqrt((width * height) / Math.max(1, n)) * 0.7;
  const cutoff = k * 2.6;
  let t = Math.min(width, height) / 8;
  for (let iter = 0; iter < 300; iter++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d < 0.01) { dx = 0.01 * (i - j || 1); dy = 0.01; d = 0.015; }
        if (d > cutoff) continue;
        const f = (k * k) / d;
        disp[i].x += (dx / d) * f; disp[i].y += (dy / d) * f;
        disp[j].x -= (dx / d) * f; disp[j].y -= (dy / d) * f;
      }
    }
    for (const [a, b] of links) {
      const dx = pos[a].x - pos[b].x;
      const dy = pos[a].y - pos[b].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d * d) / k;
      disp[a].x -= (dx / d) * f; disp[a].y -= (dy / d) * f;
      disp[b].x += (dx / d) * f; disp[b].y += (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      disp[i].x += (cx - pos[i].x) * 0.06;
      disp[i].y += (cy - pos[i].y) * 0.06;
      if (i === fi) continue;
      const len = Math.sqrt(disp[i].x ** 2 + disp[i].y ** 2) || 1;
      pos[i].x += (disp[i].x / len) * Math.min(len, t);
      pos[i].y += (disp[i].y / len) * Math.min(len, t);
    }
    t = Math.max(0.5, t * 0.975);
  }
  const pad = 46;
  const xs = pos.map(p => p.x);
  const ys = pos.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY), 1.4);
  const ox = (width - (maxX - minX) * scale) / 2;
  const oy = (height - (maxY - minY) * scale) / 2;
  return pos.map(p => ({ x: ox + (p.x - minX) * scale, y: oy + (p.y - minY) * scale }));
}

export function renderGraph(container, data, { onSelect, focus, height = 560, selected } = {}) {
  const width = Math.max(320, container.clientWidth || 900);
  const nodes = data.nodes;
  const edges = data.edges;
  if (!nodes.length) {
    container.innerHTML = '<div class="empty"><h2>沒有可顯示的主體</h2><p>調整篩選條件，或先在知識庫中新增主體與關係。</p></div>';
    return;
  }
  const pos = layout(nodes, edges, width, height, focus);
  const byId = new Map(nodes.map((d, i) => [d.id, { d, p: pos[i] }]));
  const radius = d => 7 + Math.min(8, Math.log2((d.usage || 0) + 1) * 1.6) + (d.id === focus ? 3 : 0);
  const markers = Object.entries(EDGE_STYLE).map(([l, s]) => `<marker id="arrow-${l}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${s.stroke}"/></marker>`).join('');
  container.innerHTML = `<svg class="graph-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="知識圖譜：${nodes.length} 個主體、${edges.length} 條關係"><defs>${markers}</defs><g class="viewport"><g class="edges"></g><g class="nodes"></g></g></svg>`;
  const svg = container.querySelector('svg');
  const vp = svg.querySelector('.viewport');
  const gEdges = svg.querySelector('.edges');
  const gNodes = svg.querySelector('.nodes');

  function edgeGeom(e) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const dx = b.p.x - a.p.x;
    const dy = b.p.y - a.p.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const ra = radius(a.d) + 2;
    const rb = radius(b.d) + 4;
    return { x1: a.p.x + (dx / d) * ra, y1: a.p.y + (dy / d) * ra, x2: b.p.x - (dx / d) * rb, y2: b.p.y - (dy / d) * rb, mx: (a.p.x + b.p.x) / 2, my: (a.p.y + b.p.y) / 2 };
  }
  function drawEdges() {
    gEdges.innerHTML = edges.map(e => {
      const s = EDGE_STYLE[e.level] || EDGE_STYLE.L2;
      const g = edgeGeom(e);
      return `<g class="edge" data-id="${esc(e.id)}"><line x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" stroke="${s.stroke}" stroke-width="${s.width}" stroke-dasharray="${s.dash}" marker-end="url(#arrow-${e.level})"><title>${esc(e.id)} ${esc(e.type)} · ${esc(e.level)}</title></line><text x="${g.mx}" y="${g.my - 3}" class="edge-label">${esc(e.type)}</text></g>`;
    }).join('');
  }
  function drawNodes() {
    gNodes.innerHTML = nodes.map(d => {
      const { p } = byId.get(d.id);
      const r = radius(d);
      const stroke = d.level === 'L0' ? '#1f2d42' : '#ffffff';
      const sw = d.level === 'L0' ? 2.4 : 1.6;
      const dash = d.level === 'L2' ? 'stroke-dasharray="3 2"' : '';
      const ring = d.level === 'L2' ? `<circle r="${r + 2.5}" fill="none" stroke="#9aa9bb" stroke-width="1.2" stroke-dasharray="3 2"/>` : '';
      return `<g class="node${d.id === selected ? ' selected' : ''}${d.id === focus ? ' focus' : ''}" data-id="${esc(d.id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(d.name)}（${esc(d.type)}${d.level ? '，' + d.level : ''}）">${ring}<circle r="${r}" fill="${TYPE_COLORS[d.type] || '#8a99ad'}" stroke="${stroke}" stroke-width="${sw}" ${dash}/><text y="${r + 13}" class="node-label">${esc(d.name)}</text><title>${esc(d.id)} ${esc(d.name)} · ${esc(d.type)}${d.level ? ' · ' + d.level : ''}</title></g>`;
    }).join('');
  }
  drawEdges();
  drawNodes();

  // 平移與縮放
  let view = { x: 0, y: 0, k: 1 };
  const apply = () => vp.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  const toLocal = evt => {
    const rect = svg.getBoundingClientRect();
    const sx = width / rect.width;
    return { x: ((evt.clientX - rect.left) * sx - view.x) / view.k, y: ((evt.clientY - rect.top) * sx - view.y) / view.k, sx };
  };
  svg.addEventListener('wheel', evt => {
    evt.preventDefault();
    const rect = svg.getBoundingClientRect();
    const sx = width / rect.width;
    const mx = (evt.clientX - rect.left) * sx;
    const my = (evt.clientY - rect.top) * sx;
    const k2 = Math.min(3, Math.max(0.35, view.k * (evt.deltaY < 0 ? 1.12 : 0.89)));
    view = { x: mx - ((mx - view.x) / view.k) * k2, y: my - ((my - view.y) / view.k) * k2, k: k2 };
    apply();
  }, { passive: false });

  let drag = null;
  svg.addEventListener('pointerdown', evt => {
    const nodeEl = evt.target.closest('.node');
    const start = toLocal(evt);
    drag = nodeEl ? { type: 'node', id: nodeEl.dataset.id, moved: false, start } : { type: 'pan', ox: view.x, oy: view.y, cx: evt.clientX, cy: evt.clientY, sx: start.sx };
    svg.setPointerCapture(evt.pointerId);
  });
  svg.addEventListener('pointermove', evt => {
    if (!drag) return;
    if (drag.type === 'pan') {
      view.x = drag.ox + (evt.clientX - drag.cx) * drag.sx;
      view.y = drag.oy + (evt.clientY - drag.cy) * drag.sx;
      apply();
    } else {
      const l = toLocal(evt);
      if (Math.abs(l.x - drag.start.x) + Math.abs(l.y - drag.start.y) > 3) drag.moved = true;
      if (!drag.moved) return;
      const n = byId.get(drag.id);
      n.p.x = l.x; n.p.y = l.y;
      gNodes.querySelector(`[data-id="${CSS.escape(drag.id)}"]`).setAttribute('transform', `translate(${l.x},${l.y})`);
      drawEdges();
    }
  });
  svg.addEventListener('pointerup', () => {
    if (drag?.type === 'node' && !drag.moved && onSelect) select(drag.id);
    drag = null;
  });
  svg.addEventListener('keydown', evt => {
    const nodeEl = evt.target.closest?.('.node');
    if (nodeEl && (evt.key === 'Enter' || evt.key === ' ')) { evt.preventDefault(); select(nodeEl.dataset.id); }
  });
  function select(id) {
    gNodes.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'));
    gNodes.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('selected');
    onSelect?.(byId.get(id).d);
  }
  return { reset: () => { view = { x: 0, y: 0, k: 1 }; apply(); } };
}

export function legend() {
  const types = Object.entries(TYPE_COLORS).map(([t, c]) => `<span class="legend-item"><i style="background:${c}"></i>${esc(t)}</span>`).join('');
  const levels = Object.entries(EDGE_STYLE).map(([l, s]) => `<span class="legend-item"><svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="${s.stroke}" stroke-width="2" stroke-dasharray="${s.dash}"/></svg>${esc(l)}</span>`).join('');
  return `<div class="legend"><span class="legend-title">主體類型</span>${types}<span class="legend-sep"></span><span class="legend-title">關係層級</span>${levels}<span class="legend-sep"></span><span class="legend-item"><i class="ring-l0"></i>主體 L0（深色描邊）</span><span class="legend-item"><i class="ring-l2"></i>主體 L2（虛線）</span></div>`;
}
