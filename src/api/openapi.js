// 精簡 OpenAPI 3.1 描述，方便三方智能體框架自動生成工具定義。
const E = (method, path, summary, role, { body, query, tag } = {}) => ({ method, path, summary, role, body, query, tag });

const ENDPOINTS = [
  E('get', '/prompt', '拉取智能體教程（Markdown）；?role=producer|consumer&format=json', 'public', { tag: '教程', query: ['role', 'format'] }),
  E('get', '/schema', '機器可讀的類型、關係方向、層級與寫入上限', 'public', { tag: '教程' }),
  E('post', '/ask', '問答：返回自然語言答案、引用（含層級）與結構化知識卡', 'consumer', { tag: '消費', body: { question: 'string', subjectIds: 'string[]', inputs: 'object', compose: 'auto|llm|template', model: 'string', includeKnowledge: 'boolean' } }),
  E('get', '/resolve', '術語解析：別名 → 規範主體', 'consumer', { tag: '消費', query: ['text'] }),
  E('get', '/subjects', '搜索主體', 'consumer', { tag: '消費', query: ['q', 'type', 'domain', 'level'] }),
  E('get', '/subjects/{id}', '主體知識卡', 'consumer', { tag: '消費' }),
  E('get', '/subjects/{id}/context', '知識卡 + 一跳鄰居', 'consumer', { tag: '消費' }),
  E('get', '/subjects/{id}/history', '主體檔案的 Git 版本歷史', 'consumer', { tag: '消費' }),
  E('get', '/graph', '圖譜子圖', 'consumer', { tag: '消費', query: ['focus', 'depth', 'domain', 'types', 'relationTypes', 'levels', 'aliases', 'e1'] }),
  E('get', '/objects', '客體列表', 'consumer', { tag: '消費', query: ['category', 'status', 'q'] }),
  E('get', '/assertions', '斷言列表', 'consumer', { tag: '消費', query: ['level', 'type', 'subjectId', 'q', 'pending'] }),
  E('get', '/relations', '關係列表', 'consumer', { tag: '消費', query: ['type', 'level', 'subjectId'] }),
  E('get', '/items/{id}', '帶有效性的條目（B-/A-/R-）', 'consumer', { tag: '消費' }),
  E('post', '/actions/{id}/invoke', '調用取值 Action 獲取實時動態值', 'consumer', { tag: '消費', body: { inputs: 'object' } }),
  E('post', '/feedback', '反饋知識有誤（觸發降級與重驗）', 'consumer', { tag: '消費', body: { targetId: 'string', comment: 'string', question: 'string' } }),
  E('post', '/subjects', '新建主體', 'contributor', { tag: '生產', body: { name: 'string', type: '系統|業務對象|流程|規則|指標|別名', domain: 'string', definition: 'string', owner: 'string', errorCost: 'integer 1-5', aliasOf: 'string[]', tags: 'string[]' } }),
  E('patch', '/subjects/{id}', '修改主體', 'contributor', { tag: '生產', body: { name: 'string', definition: 'string', owner: 'string', errorCost: 'integer', expiryDays: 'integer' } }),
  E('post', '/objects', '登記客體', 'contributor', { tag: '生產', body: { name: 'string', category: '數字|制度|物理', kind: 'string', locator: 'string', description: 'string', actionIds: 'string[]' } }),
  E('patch', '/objects/{id}', '修改客體（status=下線 觸發級聯）', 'contributor', { tag: '生產', body: { status: '在用|下線', reason: 'string' } }),
  E('post', '/subjects/{id}/bindings', '綁定客體', 'contributor', { tag: '生產', body: { objectId: 'string', note: 'string', level: 'L1|L2|E1' } }),
  E('post', '/subjects/{id}/assertions', '新增斷言', 'contributor', { tag: '生產', body: { type: '定義|屬性|規則|約束', content: 'string', structured: '{key,value}', evidence: '{objectIds,sourceRef}', level: 'L1|L2|E1', invalidReason: 'string', replacedBy: 'string' } }),
  E('patch', '/assertions/{id}', '修改斷言', 'contributor', { tag: '生產', body: { content: 'string', structured: '{key,value}' } }),
  E('post', '/relations', '新增關係', 'contributor', { tag: '生產', body: { from: 'string', type: 'string', to: 'string', evidence: '{objectIds,sourceRef}', level: 'L1|L2|E1' } }),
  E('post', '/batch', '批量提交（單個 Git 提交，失敗整批回滾）', 'contributor', { tag: '生產', body: { message: 'string', items: '[{op, ref?, data}]' } }),
  E('post', '/items/{id}/evidence', '補充證據 L2 → L1', 'contributor', { tag: '生產', body: { objectIds: 'string[]', sourceRef: 'string', actionId: 'string' } }),
  E('post', '/validate/{id}', '執行校驗 Action 並寫回有效性', 'contributor', { tag: '生產', body: { actionId: 'string' } }),
  E('post', '/conflicts', '登記衝突（雙方降為 L1）', 'contributor', { tag: '治理', body: { a: 'string', b: 'string', note: 'string' } }),
  E('get', '/conflicts', '衝突列表', 'contributor', { tag: '治理' }),
  E('get', '/feedback', '反饋列表', 'contributor', { tag: '治理' }),
  E('get', '/gaps', '知識缺口（未收錄查詢）', 'contributor', { tag: '治理' }),
  E('get', '/queue', '重驗隊列（按 使用頻率 × 出錯代價 排序）', 'contributor', { tag: '治理' }),
  E('get', '/metrics', '健康指標', 'contributor', { tag: '治理', query: ['days'] }),
  E('post', '/items/{id}/confirm', '負責人確認 L1 → L0（僅限人）', 'owner', { tag: '負責人', body: { note: 'string', expiryDays: 'integer' } }),
  E('post', '/items/{id}/invalidate', '判定失效 → E1', 'owner', { tag: '負責人', body: { reason: 'string', replacedBy: 'string' } }),
  E('post', '/conflicts/{id}/resolve', '裁決衝突', 'owner', { tag: '負責人', body: { winner: 'string', reason: 'string' } }),
  E('post', '/validate-all', '對全部可校驗知識執行校驗', 'owner', { tag: '負責人', body: { onlyPending: 'boolean' } }),
  E('post', '/pipelines', '新增管道', 'owner', { tag: '動力層' }),
  E('post', '/actions', '新增 Action', 'owner', { tag: '動力層' })
];

function schemaFor(spec) {
  const props = {};
  for (const [k, v] of Object.entries(spec || {})) {
    if (v.endsWith('[]')) props[k] = { type: 'array', items: { type: 'string' }, description: v };
    else if (v === 'object' || v.startsWith('{') || v.startsWith('[')) props[k] = { type: v.startsWith('[') ? 'array' : 'object', description: v };
    else if (v.startsWith('integer')) props[k] = { type: 'integer', description: v };
    else if (v === 'boolean') props[k] = { type: 'boolean' };
    else props[k] = { type: 'string', description: v === 'string' ? undefined : v };
  }
  return { type: 'object', properties: props };
}

export function buildOpenApi(baseUrl) {
  const paths = {};
  for (const e of ENDPOINTS) {
    const params = [...(e.path.match(/\{(\w+)\}/g) || [])].map(p => ({ name: p.slice(1, -1), in: 'path', required: true, schema: { type: 'string' } }));
    for (const q of e.query || []) params.push({ name: q, in: 'query', required: false, schema: { type: 'string' } });
    const op = {
      summary: e.summary,
      tags: [e.tag],
      operationId: `${e.method}_${e.path.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      description: `所需角色：${e.role}`,
      parameters: params.length ? params : undefined,
      requestBody: e.body ? { required: true, content: { 'application/json': { schema: schemaFor(e.body) } } } : undefined,
      responses: { 200: { description: '成功：{ data, commit?, warnings? }' }, 400: { description: '輸入錯誤' }, 401: { description: '未認證' }, 403: { description: '權限不足' }, 422: { description: '違反知識規則' } },
      security: e.role === 'public' ? [] : undefined
    };
    (paths[e.path] ||= {})[e.method] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: '供應鏈技術知識體系 API', version: '0.1.0', description: '生產型 API 供三方智能體生產與管理知識；消費型 API 返回結構化知識與自然語言答案。先 GET /prompt 閱讀教程。' },
    servers: [{ url: `${baseUrl.replace(/\/+$/, '')}/api/v1` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: '後台「接入 › API 金鑰」創建' } } },
    security: [{ bearer: [] }],
    paths
  };
}
