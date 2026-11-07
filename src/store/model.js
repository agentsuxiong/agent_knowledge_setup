// 知識模型常量：6 個概念、6 種主體類型、10 種關係類型、2 種 Action、4 個層級。
// 對應設計文件《供應鏈技術知識體系 MVP 建模設計 v0.1》。

export const LEVELS = ['L0', 'L1', 'L2', 'E1'];

// 數值越大越可靠；E1 不參與排序（不計入有效知識）。
export const LEVEL_RANK = { L0: 3, L1: 2, L2: 1, E1: 0 };

export const LEVEL_INFO = {
  L0: { name: '可靠', condition: '有客體證據，已驗證，在有效期內', usage: '直接作為依據' },
  L1: { name: '參考', condition: '有客體證據或明確來源，但未驗證或驗證已過期', usage: '可以使用，但必須標註未驗證' },
  L2: { name: '探索', condition: '無客體證據，屬於推測、假設或經驗', usage: '只用於拓展思路，不作結論' },
  E1: { name: '失效', condition: '已被證偽、已過時，或客體已下線', usage: '不得作為依據，用於避坑和說明替代者' }
};

export const SUBJECT_TYPES = {
  系統: { en: 'system', desc: '服務、平台、子系統', example: '庫存中心、WMS、分倉服務' },
  業務對象: { en: 'business_object', desc: '在系統中流轉的業務實體', example: 'SKU、銷售訂單、調撥單、庫存' },
  流程: { en: 'process', desc: '跨系統的業務過程，或其中一步', example: '訂單履約、入庫上架、出庫揀貨' },
  規則: { en: 'rule', desc: '系統執行的業務規則或策略', example: '分倉規則、庫存預佔規則' },
  指標: { en: 'metric', desc: '有計算口徑的度量', example: '可售庫存、履約時效、缺貨率' },
  別名: { en: 'alias', desc: '某個主體的其他叫法', example: 'ATP、可用庫存' }
};

export const OBJECT_CATEGORIES = {
  數字: { desc: '數據表與字段、API、消息主題、配置項、代碼模塊、監控指標', kinds: ['表字段', '數據表', 'API', '消息主題', '配置項', '代碼模塊', '監控指標'] },
  制度: { desc: '設計文檔、SOP、口徑定義文檔、SLA、評審記錄', kinds: ['設計文檔', 'SOP', '口徑定義', 'SLA', '評審記錄'] },
  物理: { desc: '倉庫、庫區、庫位、設備（MVP 只登記，不接管道）', kinds: ['倉庫', '庫區', '庫位', '設備'] }
};

export const OBJECT_STATUS = ['在用', '下線'];

export const ASSERTION_TYPES = {
  定義: '是什麼、怎麼算',
  屬性: '具體取值或特徵',
  規則: '條件與結果',
  約束: '不能做什麼，邊界情況'
};

const NON_ALIAS = ['系統', '業務對象', '流程', '規則', '指標'];

// 10 種關係類型（閉集）。from/to 為允許的主體類型。
export const RELATION_TYPES = {
  別名: { direction: '別名主體 → 規範主體', from: ['別名'], to: NON_ALIAS, example: 'ATP → 可售庫存' },
  是一種: { direction: '子類 → 父類', from: NON_ALIAS, to: NON_ALIAS, example: '調撥單 → 庫存單據' },
  組成: { direction: '部分 → 整體', from: NON_ALIAS, to: NON_ALIAS, example: '揀貨 → 出庫流程' },
  後續: { direction: '前一步 → 後一步', from: NON_ALIAS, to: NON_ALIAS, example: '分倉 → 出庫' },
  擁有: { direction: '系統 → 業務對象或指標（權威數據源）', from: ['系統'], to: ['業務對象', '指標'], example: '庫存中心 → 可售庫存' },
  依賴: { direction: '系統 → 系統', from: ['系統'], to: ['系統'], example: '分倉服務 → 庫存中心' },
  產出: { direction: '系統或流程 → 業務對象', from: ['系統', '流程'], to: ['業務對象'], example: '訂單中心 → 銷售訂單' },
  消費: { direction: '系統或流程 → 業務對象', from: ['系統', '流程'], to: ['業務對象'], example: 'WMS → 出庫指令' },
  約束: { direction: '規則 → 業務對象或流程', from: ['規則'], to: ['業務對象', '流程', '指標'], example: '庫存預佔規則 → 可售庫存' },
  計算自: { direction: '指標 → 業務對象或指標', from: ['指標'], to: ['業務對象', '指標'], example: '可售庫存 → 實物庫存' }
};

export const ACTION_KINDS = {
  校驗: '檢查客體是否存在、內容是否與斷言一致，結果寫回有效性',
  取值: '實時讀取客體的當前值，供智能體回答'
};

export const PIPELINE_TYPES = {
  http: '通用 HTTP 管道（API 網關、配置中心、文檔庫等提供 HTTP 介面的數據源）',
  mock: '示意管道：按路由規則返回模板化結果，用於演示與聯調'
};

// 有效期建議初值（天）：配置與規則類 30 天，系統依賴與數據流關係 90 天，定義與口徑類 180 天。
export const DEFAULT_EXPIRY_DAYS = {
  assertion: { 定義: 180, 屬性: 30, 規則: 30, 約束: 30 },
  relation: { 別名: 180, 是一種: 180, 組成: 180, 計算自: 180, 後續: 90, 擁有: 90, 依賴: 90, 產出: 90, 消費: 90 },
  binding: { 制度: 180, 數字: 90, 物理: 180 }
};

export const DEFAULT_DOMAINS = [
  { code: 'INV', name: '庫存' },
  { code: 'ORD', name: '訂單' },
  { code: 'WMS', name: '倉儲' },
  { code: 'TMS', name: '運輸' },
  { code: 'PLN', name: '計劃補貨' }
];

export const PENDING_REASONS = {
  expired: '有效期到期',
  mismatch: '校驗不符',
  conflict: '知識衝突',
  feedback: '使用反饋指出錯誤',
  object_offline: '證據客體已下線',
  object_changed: '客體已變化'
};

export const ID_PREFIX = {
  subject: 'S',
  object: 'O',
  binding: 'B',
  assertion: 'A',
  relation: 'R',
  action: 'ACT',
  pipeline: 'P',
  conflict: 'C',
  feedback: 'F',
  gap: 'G'
};

export function kindOfId(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('ACT-')) return 'action';
  const p = id.split('-')[0];
  return { S: 'subject', O: 'object', B: 'binding', A: 'assertion', R: 'relation', P: 'pipeline', C: 'conflict', F: 'feedback', G: 'gap' }[p] || null;
}

export function levelGte(a, b) {
  return (LEVEL_RANK[a] ?? -1) >= (LEVEL_RANK[b] ?? -1);
}

export function maxLevel(levels) {
  let best = null;
  for (const l of levels) {
    if (l === 'E1') continue;
    if (!best || LEVEL_RANK[l] > LEVEL_RANK[best]) best = l;
  }
  return best;
}
