// 庫存域示例資料：設計文件「示例：可售庫存」的完整演示。系統名、表名、接口名與數值均為示意。
// 走真實流程：先以人身份提交（寫入上限 L1/L2），再由 Action 校驗（→ L0 自動）與負責人確認（→ L0 人工）晉升。
import { RuleError } from '../store/validity.js';

const SUBJECTS = [
  ['inv-center', '庫存中心', '系統', 'INV', '管理全渠道庫存數量與預佔的權威系統；不負責倉內作業'],
  ['alloc-svc', '分倉服務', '系統', 'INV', '為訂單選擇發貨倉的服務；不直接修改庫存'],
  ['sku', 'SKU', '業務對象', 'INV', '最小庫存管理單元，一個 SKU 對應一個可售規格'],
  ['stock', '庫存', '業務對象', 'INV', '某 SKU 在某倉庫的庫存記錄'],
  ['transfer', '調撥單', '業務對象', 'INV', '在倉庫之間移動庫存的單據'],
  ['stock-doc', '庫存單據', '業務對象', 'INV', '所有引起庫存變化的單據的統稱'],
  ['physical', '實物庫存', '指標', 'INV', '倉庫中實際存在的庫存數量，含已預佔和凍結部分'],
  ['reserved', '已預佔庫存', '指標', 'INV', '已被訂單佔用、尚未出庫的庫存數量'],
  ['frozen', '凍結庫存', '指標', 'INV', '因質檢、盤點等原因暫不可用的庫存數量'],
  ['safety', '安全庫存', '指標', 'INV', '為應對波動保留、不對外售賣的庫存數量'],
  ['reserve-rule', '庫存預佔規則', '規則', 'INV', '下單時佔用可售庫存、超時釋放的規則'],
  ['atp', '可售庫存', '指標', 'INV', '當前可被下單佔用的庫存數量，不含已預佔和凍結部分'],
  ['phys-avail', '實物可用庫存', '指標', 'INV', '倉內可立即揀貨的實物數量，不含凍結部分；不扣減訂單預佔'],
  ['alloc-rule', '分倉規則', '規則', 'INV', '決定訂單由哪個倉庫發貨的策略'],
  ['oos-rate', '缺貨率', '指標', 'INV', '可售庫存為 0 的 SKU 佔在售 SKU 的比例'],
  ['order-center', '訂單中心', '系統', 'ORD', '接收並管理銷售訂單生命週期的系統'],
  ['sales-order', '銷售訂單', '業務對象', 'ORD', '客戶下單後生成的訂單'],
  ['fulfil', '訂單履約', '流程', 'ORD', '從訂單確認到妥投的跨系統過程'],
  ['alloc', '分倉', '流程', 'ORD', '為訂單選定發貨倉的步驟'],
  ['wms', 'WMS', '系統', 'WMS', '倉庫管理系統，負責倉內作業'],
  ['outbound', '出庫流程', '流程', 'WMS', '從接收出庫指令到貨物離倉的倉內流程'],
  ['pick', '揀貨', '流程', 'WMS', '按出庫指令從庫位取出貨品的步驟'],
  ['outbound-cmd', '出庫指令', '業務對象', 'WMS', '下發給倉庫的出庫作業指令'],
  ['putaway', '入庫上架', '流程', 'WMS', '貨品到倉後驗收並放入庫位的步驟']
];

export async function seedInventory(ctx, principal) {
  const store = ctx.store;
  if ([...store.subjects.values()].some(s => s.name === '可售庫存')) throw new RuleError('示例資料已存在（主體「可售庫存」已登記）', 409, 'already_seeded');
  const ids = {};

  // 1. 動力層：管道與 Action（示意管道，不連真實系統）
  const { result: dyn } = await store.tx(principal, '[示例] 動力層：示意管道與 Action', t => {
    const gw = store.upsertPipeline(t, {
      name: 'API 網關（示意）', type: 'mock', description: '示意管道：模擬庫存查詢接口。接入真實 API 網關時改為 http 類型並配置 baseUrl。',
      routes: [{ method: 'GET', path: '/inventory/v1/availability', status: 200, body: { sku: '{query.sku}', warehouse: '{query.warehouse}', available_qty: '{rand:0:500}', unit: '件', source: 'mock' } }]
    }, principal);
    const meta = store.upsertPipeline(t, {
      name: '業務數據庫元數據（示意）', type: 'mock', description: '示意管道：模擬讀取表結構，校驗字段是否存在。',
      routes: [{ method: 'GET', path: '/schema/inventory.sku_stock.available_qty', status: 200, body: { exists: true, type: 'decimal(18,2)' } }]
    }, principal);
    const cfg = store.upsertPipeline(t, {
      name: '配置中心（示意）', type: 'mock', description: '示意管道：模擬讀取配置項當前值。',
      routes: [{ method: 'GET', path: '/config/reserve.ttl', status: 200, body: { key: 'reserve.ttl', value: '30m' } }]
    }, principal);
    const vField = store.upsertAction(t, { name: '校驗表字段存在', kind: '校驗', pipelineId: meta.id, objectKinds: ['表字段'], request: { method: 'GET', path: '/schema/{object.locator}' }, check: { mode: 'exists' }, description: '讀取表結構，確認字段仍存在' }, principal);
    const vApi = store.upsertAction(t, { name: '校驗接口可調用', kind: '校驗', pipelineId: gw.id, objectKinds: ['API'], request: { method: 'GET', path: '{object.locator}', query: { sku: 'SKU-PROBE', warehouse: 'PROBE' } }, check: { mode: 'exists' }, description: '探測接口可正常返回' }, principal);
    const vCfg = store.upsertAction(t, { name: '校驗配置項取值', kind: '校驗', pipelineId: cfg.id, objectKinds: ['配置項'], request: { method: 'GET', path: '/config/{object.locator}' }, output: { path: 'value' }, check: { mode: 'equals' }, description: '讀取配置項，確認與斷言的結構化值一致' }, principal);
    const fAtp = store.upsertAction(t, {
      name: '查詢可售庫存（SKU，倉庫）', kind: '取值', pipelineId: gw.id, objectKinds: ['API'],
      request: { method: 'GET', path: '/inventory/v1/availability', query: { sku: '{input.sku}', warehouse: '{input.warehouse}' } },
      inputs: [{ name: 'sku', label: 'SKU', required: true, pattern: 'SKU-\\d+' }, { name: 'warehouse', label: '倉庫', required: true, fromObjects: '物理' }],
      output: { path: 'available_qty', unit: '件', label: '可售庫存' }, permission: 'consumer', description: '經 API 網關實時查詢某 SKU 在某倉的可售庫存'
    }, principal);
    return { vField: vField.id, vApi: vApi.id, vCfg: vCfg.id, fAtp: fAtp.id };
  });

  // 2. 客體、主體、綁定、斷言、關係（以人身份提交：有證據 L1，無證據 L2）
  const { result: made } = await store.tx(principal, '[示例] 庫存域：主體、客體、斷言與關係', t => {
    const o = {};
    o.doc = store.createObject(t, { name: '《庫存口徑定義 v3》', category: '制度', kind: '口徑定義', locator: 'wiki://inventory/metrics/v3', description: '庫存相關指標的統一口徑' }, principal).id;
    o.field = store.createObject(t, { name: '表字段 inventory.sku_stock.available_qty', category: '數字', kind: '表字段', locator: 'inventory.sku_stock.available_qty', actionIds: [dyn.vField] }, principal).id;
    o.api = store.createObject(t, { name: '接口 GET /inventory/v1/availability', category: '數字', kind: 'API', locator: '/inventory/v1/availability', actionIds: [dyn.vApi, dyn.fAtp] }, principal).id;
    o.ttl = store.createObject(t, { name: '配置項 reserve.ttl', category: '數字', kind: '配置項', locator: 'reserve.ttl', actionIds: [dyn.vCfg] }, principal).id;
    o.sh01 = store.createObject(t, { name: '上海一號倉', category: '物理', kind: '倉庫', locator: 'SH01' }, principal).id;
    o.bj01 = store.createObject(t, { name: '北京一號倉', category: '物理', kind: '倉庫', locator: 'BJ01' }, principal).id;
    o.repo = store.createObject(t, { name: '代碼模塊 inventory-center', category: '數字', kind: '代碼模塊', locator: 'git://inventory/inventory-center' }, principal).id;
    o.trace = store.createObject(t, { name: '調用鏈追蹤：allocation → inventory', category: '數字', kind: '監控指標', locator: 'apm://trace/allocation-service/inventory-center' }, principal).id;

    for (const [key, name, type, domain, definition] of SUBJECTS) ids[key] = store.createSubject(t, { name, type, domain, definition, owner: domain === 'INV' ? '庫存域架構師' : domain === 'ORD' ? '訂單域架構師' : '倉儲域架構師', errorCost: key === 'atp' ? 5 : 3 }, principal).id;
    ids.aliasAtp = store.createSubject(t, { name: 'ATP', type: '別名', domain: 'INV', aliasOf: [ids.atp], evidence: { objectIds: [o.doc] } }, principal).id;
    ids.aliasAvail = store.createSubject(t, { name: '可用庫存', type: '別名', domain: 'INV', aliasOf: [ids.atp, ids['phys-avail']], evidence: { objectIds: [o.doc] } }, principal).id;

    const b = {};
    b.doc = store.createBinding(t, ids.atp, { objectId: o.doc }, principal).id;
    b.field = store.createBinding(t, ids.atp, { objectId: o.field }, principal).id;
    b.api = store.createBinding(t, ids.atp, { objectId: o.api }, principal).id;
    store.createBinding(t, ids['inv-center'], { objectId: o.repo }, principal);
    store.createBinding(t, ids.physical, { objectId: o.doc }, principal);
    store.createBinding(t, ids['reserve-rule'], { objectId: o.ttl }, principal);

    const a = {};
    a.def = store.createAssertion(t, ids.atp, { type: '定義', content: '可售庫存 = 實物庫存 − 已預佔 − 凍結 − 安全庫存', evidence: { objectIds: [o.doc] } }, principal).id;
    a.ttl = store.createAssertion(t, ids.atp, { type: '規則', content: '預佔 30 分鐘未支付，自動釋放', structured: { key: 'reserve.ttl', value: '30m' }, evidence: { objectIds: [o.ttl] } }, principal).id;
    a.neg = store.createAssertion(t, ids.atp, { type: '約束', content: '計算結果為負時，對外按 0 展示', evidence: { sourceRef: 'wiki://inventory/edge-cases#negative' } }, principal).id;
    a.old = store.createAssertion(t, ids.atp, { type: '定義', content: '可售庫存 = 實物庫存 − 已預佔 − 凍結，不扣安全庫存', level: 'E1', invalidReason: '《庫存口徑定義 v3》起扣減安全庫存，舊口徑作廢', replacedBy: a.def, evidence: { objectIds: [o.doc] } }, principal).id;
    a.refresh = store.createAssertion(t, ids.atp, { type: '屬性', content: '刷新方式：事件驅動，準實時', evidence: { objectIds: [o.api] } }, principal).id;
    store.createAssertion(t, ids['reserve-rule'], { type: '規則', content: '下單時按 SKU + 倉庫預佔可售庫存', evidence: { objectIds: [o.ttl] } }, principal);
    store.createAssertion(t, ids.physical, { type: '定義', content: '實物庫存 = 倉庫中實際存在的庫存數量，含已預佔和凍結部分', evidence: { objectIds: [o.doc] } }, principal);
    store.createAssertion(t, ids.safety, { type: '約束', content: '安全庫存不參與對外售賣', evidence: { objectIds: [o.doc] } }, principal);
    store.createAssertion(t, ids['alloc-rule'], { type: '規則', content: '優先選擇距離收貨地址最近且可售庫存充足的倉庫' }, principal);

    const rel = (from, type, to, evidence) => store.createRelation(t, { from: ids[from], type, to: ids[to], evidence }, principal).id;
    const r = {};
    r.own = rel('inv-center', '擁有', 'atp', { objectIds: [o.api] });
    r.calc = rel('atp', '計算自', 'physical', { objectIds: [o.doc] });
    r.constrain = rel('reserve-rule', '約束', 'atp', { objectIds: [o.ttl] });
    rel('alloc-svc', '依賴', 'inv-center', { objectIds: [o.trace] });
    rel('inv-center', '擁有', 'physical', { objectIds: [o.repo] });
    rel('atp', '計算自', 'reserved', { objectIds: [o.doc] });
    rel('atp', '計算自', 'frozen', { objectIds: [o.doc] });
    rel('atp', '計算自', 'safety', { objectIds: [o.doc] });
    rel('transfer', '是一種', 'stock-doc', { sourceRef: 'wiki://inventory/documents' });
    rel('pick', '組成', 'outbound', { sourceRef: 'wiki://wms/outbound-sop' });
    rel('alloc', '後續', 'outbound', { sourceRef: 'wiki://ord/fulfilment' });
    rel('alloc', '組成', 'fulfil', { sourceRef: 'wiki://ord/fulfilment' });
    rel('order-center', '產出', 'sales-order', { sourceRef: 'wiki://ord/order-center' });
    rel('wms', '消費', 'outbound-cmd', { sourceRef: 'wiki://wms/outbound-sop' });
    rel('fulfil', '消費', 'sales-order', undefined);
    rel('alloc-rule', '約束', 'fulfil', undefined);
    rel('oos-rate', '計算自', 'atp', undefined);
    rel('alloc-svc', '依賴', 'order-center', undefined);
    return { o, b, a, r };
  });

  // 3. Action 校驗（→ L0 自動）
  for (const id of [made.b.field, made.b.api, made.a.ttl]) await ctx.actions.validateItem(id, principal);

  // 4. 負責人確認（→ L0 人工）
  await store.tx(principal, '[示例] 負責人確認高頻、高風險知識', t => {
    for (const id of [made.b.doc, made.a.def, made.r.own, made.r.calc, made.r.constrain]) store.confirm(t, id, { note: '示例資料：負責人確認' }, principal);
    for (const rid of [...store.relations.values()].filter(x => x.type === '別名').map(x => x.id)) store.confirm(t, rid, { note: '示例資料：別名確認' }, principal);
  });

  return { subjects: Object.keys(ids).length, focus: ids.atp, ids };
}
