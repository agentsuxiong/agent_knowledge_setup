// 端到端：教程 API、權限、批量生產、消費型問答（設計文件中的 6 個示例）、校驗 Action、OpenRouter、Git 遠端同步。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, tmpDir } from './helpers.js';

let t;
before(async () => {
  t = await startServer();
  const seed = await t.admin('POST', '/admin/api/seed');
  assert.equal(seed.status, 201, JSON.stringify(seed.body));
});
after(() => t.close());

test('教程 prompt API 公開可取，包含寫入規則與端點', async () => {
  const r = await t.call('GET', '/api/v1/prompt');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type').split(';')[0], 'text/markdown');
  for (const s of ['智能體知識生產教程', '寫入上限', '/batch', '你不能寫入 L0', '擁有', '未收錄']) assert.ok(r.body.includes(s), `缺少：${s}`);
  const c = await t.call('GET', '/api/v1/prompt?role=consumer&format=json');
  assert.equal(c.body.data.role, 'consumer');
  assert.match(c.body.data.prompt, /智能體使用規約/);
  const schema = await t.call('GET', '/api/v1/schema');
  assert.equal(Object.keys(schema.body.data.relationTypes).length, 10);
  assert.equal(Object.keys(schema.body.data.subjectTypes).length, 6);
  const oa = await t.call('GET', '/api/v1/openapi.json');
  assert.equal(oa.body.openapi, '3.1.0');
  assert.ok(oa.body.paths['/ask'].post);
});

test('權限：無金鑰 401；消費者不能生產；智能體不能確認晉升', async () => {
  assert.equal((await t.call('GET', '/api/v1/subjects')).status, 401);
  assert.equal((await t.call('GET', '/api/v1/subjects', undefined, { authorization: 'Bearer kk_wrong' })).status, 401);
  const consumer = await t.keyFor('agent', 'consumer');
  assert.equal((await consumer('GET', '/api/v1/subjects')).status, 200);
  const denied = await consumer('POST', '/api/v1/subjects', { name: 'X', type: '系統', domain: 'INV' });
  assert.equal(denied.status, 403);
  const agent = await t.keyFor('agent', 'contributor');
  const conf = await agent('POST', '/api/v1/items/A-0003/confirm', {});
  assert.equal(conf.status, 403);
  const ownerAgent = await t.admin('POST', '/admin/api/keys', { name: 'x', kind: 'agent', role: 'owner' });
  assert.equal(ownerAgent.status, 400, '智能體不能被授予負責人角色');
});

test('生產型 API：批量提交（ref 引用、單次提交、L0 請求被降級並提示）', async () => {
  const agent = await t.keyFor('agent', 'contributor', '冷啟動智能體');
  const r = await agent('POST', '/api/v1/batch', {
    message: '冷啟動：調撥',
    items: [
      { op: 'object.create', ref: 'doc', data: { name: '《調撥流程 SOP》', category: '制度', kind: 'SOP', locator: 'wiki://transfer/sop' } },
      { op: 'subject.create', ref: 'svc', data: { name: '調撥服務', type: '系統', domain: 'INV', definition: '創建與執行調撥單的服務' } },
      { op: 'binding.create', data: { subjectId: '$ref:svc', objectId: '$ref:doc' } },
      { op: 'assertion.create', data: { subjectId: '$ref:svc', type: '約束', content: '同一 SKU 同時只能有一張進行中的調撥單', level: 'L0', evidence: { objectIds: ['$ref:doc'] } } },
      { op: 'relation.create', data: { from: '$ref:svc', type: '依賴', to: 'S-INV-0001' } }
    ]
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const res = r.body.data.results;
  assert.equal(res.length, 5);
  assert.equal(res[3].level, 'L1');
  assert.equal(res[4].level, 'L2');
  assert.ok(r.body.warnings.some(w => w.includes('不能直接寫入 L0')));
  assert.match(r.body.commit, /^[0-9a-f]{7,}$/);
  const log = await t.admin('GET', '/admin/api/log?limit=1');
  assert.equal(log.body.data[0].author, '冷啟動智能體');
  assert.match(log.body.data[0].subject, /\[批量\] 冷啟動：調撥（5 條）/);
});

test('生產型 API：批量中任一條違規則整批回滾並返回序號', async () => {
  const agent = await t.keyFor('agent', 'contributor');
  const before = (await agent('GET', '/api/v1/subjects')).body.data.length;
  const r = await agent('POST', '/api/v1/batch', {
    items: [
      { op: 'subject.create', ref: 'a', data: { name: '回滾測試主體', type: '系統', domain: 'INV' } },
      { op: 'relation.create', data: { from: '$ref:a', type: '計算自', to: 'S-INV-0012' } }
    ]
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.index, 1);
  assert.equal(r.body.error.code, 'relation_direction');
  assert.equal((await agent('GET', '/api/v1/subjects')).body.data.length, before);
});

test('消費型 API：設計文件「智能體如何回答」6 個示例（規則模板組織）', async () => {
  const consumer = await t.keyFor('agent', 'consumer', '問答智能體');
  const ask = async question => (await consumer('POST', '/api/v1/ask', { question, compose: 'template' })).body.data;

  const def = await ask('可售庫存怎麼算？');
  assert.equal(def.status, 'answered');
  assert.ok(def.citations.some(c => c.id === 'A-0001' && c.level === 'L0'));
  assert.match(def.answer, /A-0001·L0/);
  assert.equal(def.knowledge[0].subject.id, 'S-INV-0012');

  const hist = await ask('可售庫存以前是不是不扣安全庫存？');
  assert.equal(hist.status, 'answered');
  assert.match(hist.answer, /已失效/);
  assert.ok(hist.citations.some(c => c.id === 'A-0004' && c.level === 'E1'));
  assert.ok(hist.citations.some(c => c.id === 'A-0001' && c.level === 'L0'), '給出替代者');

  const dyn = await ask('SKU-123 在上海一號倉還有多少可售？');
  assert.equal(dyn.status, 'answered');
  assert.equal(dyn.realtime[0].actionId, 'ACT-0004');
  assert.deepEqual(dyn.realtime[0].inputs, { sku: 'SKU-123', warehouse: 'SH01' });
  assert.equal(typeof dyn.realtime[0].value, 'number');
  assert.match(dyn.answer, /實時取值/);

  const neg = await ask('可售庫存會出現負數嗎？');
  assert.equal(neg.status, 'answered');
  assert.ok(neg.citations.some(c => c.id === 'A-0003' && c.level === 'L1'));
  assert.match(neg.answer, /未經驗證/);

  const amb = await ask('「可用庫存」指什麼？');
  assert.equal(amb.status, 'ambiguous');
  assert.deepEqual(amb.next.candidates.map(c => c.name).sort(), ['可售庫存', '實物可用庫存'].sort());

  const gap = await ask('可售庫存多久同步到搜索系統？');
  assert.equal(gap.status, 'uncovered');
  assert.match(gap.answer, /知識庫未收錄/);
  assert.ok(gap.gap.id.startsWith('G-'));

  const missingParams = await ask('可售庫存現在還有多少？');
  assert.equal(missingParams.status, 'need_inputs');

  const disamb = await consumer('POST', '/api/v1/ask', { question: '「可用庫存」指什麼？', subjectIds: ['S-INV-0013'], compose: 'template' });
  assert.equal(disamb.body.data.status, 'answered');

  const gaps = await t.admin('GET', '/api/v1/gaps');
  assert.ok(gaps.body.data.some(g => g.question.includes('搜索系統')));
  const metrics = await t.admin('GET', '/api/v1/metrics');
  assert.ok(metrics.body.data.uncoveredQueries.value >= 1);
});

test('結構化知識：知識卡、上下文、圖譜、術語解析、取值 Action', async () => {
  const consumer = await t.keyFor('agent', 'consumer');
  const card = (await consumer('GET', '/api/v1/subjects/S-INV-0012')).body.data;
  assert.equal(card.subject.level, 'L0');
  assert.deepEqual(card.assertions.map(a => a.level), ['L0', 'L0', 'L1', 'E1', 'L1']);
  assert.ok(card.aliases.some(a => a.name === '可用庫存' && a.ambiguous));
  assert.ok(card.actions.some(a => a.kind === '取值'));
  const ctx = (await consumer('GET', '/api/v1/subjects/S-INV-0012/context')).body.data;
  assert.ok(ctx.neighbors.some(n => n.name === '庫存中心'));
  const g = (await consumer('GET', '/api/v1/graph?focus=S-INV-0012&depth=1')).body.data;
  assert.ok(g.nodes.length > 3 && g.edges.length > 3);
  const res = (await consumer('GET', '/api/v1/resolve?text=ATP')).body.data;
  assert.equal(res.canonical[0].id, 'S-INV-0012');
  const v = await consumer('POST', '/api/v1/actions/ACT-0004/invoke', { inputs: { sku: 'SKU-9', warehouse: 'BJ01' } });
  assert.equal(v.status, 200);
  assert.equal(v.body.data.note, '實時取值，未使用任何存儲值');
  const bad = await consumer('POST', '/api/v1/actions/ACT-0004/invoke', { inputs: { sku: 'abc', warehouse: 'BJ01' } });
  assert.equal(bad.status, 400);
});

test('客體變更觸發：校驗 Action 發現配置值變化 → L0 降為 L1；客體不存在 → 下線級聯', async () => {
  const pipes = (await t.admin('GET', '/api/v1/pipelines')).body.data;
  const cfg = pipes.find(p => p.name.startsWith('配置中心'));
  const { id, updatedAt, ...rest } = cfg;
  rest.routes = [{ method: 'GET', path: '/config/reserve.ttl', status: 200, body: { key: 'reserve.ttl', value: '15m' } }];
  assert.equal((await t.admin('PUT', `/api/v1/pipelines/${id}`, rest)).status, 200);
  const agent = await t.keyFor('agent', 'contributor');
  const r = await agent('POST', '/api/v1/validate/A-0002', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.outcome, 'mismatch');
  const item = (await agent('GET', '/api/v1/items/A-0002')).body.data;
  assert.equal(item.validity.level, 'L1');
  assert.equal(item.validity.pending.reason, 'mismatch');
  const queue = (await agent('GET', '/api/v1/queue')).body.data;
  assert.equal(queue[0].id, 'A-0002', '高出錯代價且被使用的條目排在最前');

  const meta = pipes.find(p => p.name.startsWith('業務數據庫'));
  const { id: mid, updatedAt: _u, ...mrest } = meta;
  mrest.routes = [];
  await t.admin('PUT', `/api/v1/pipelines/${mid}`, mrest);
  const miss = await agent('POST', '/api/v1/validate/B-0002', {});
  assert.equal(miss.body.data.outcome, 'missing');
  const obj = (await agent('GET', '/api/v1/objects/O-0002')).body.data;
  assert.equal(obj.status, '下線');
  assert.equal((await agent('GET', '/api/v1/items/B-0002')).body.data.validity.level, 'E1');
});

test('OpenRouter 組織自然語言：引用經過校驗；未收錄時記錄缺口', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    if (String(url).startsWith('https://openrouter.test/')) {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body, headers: init.headers });
      const user = body.messages.at(-1).content;
      let content;
      if (user.includes('搜索系統')) content = JSON.stringify({ covered: false, answer: '知識庫未收錄：沒有可售庫存同步到搜索系統的時效。', citations: [], missingInfo: '同步時效' });
      else content = JSON.stringify({ covered: true, answer: '可售庫存 = 實物庫存 − 已預佔 − 凍結 − 安全庫存〔A-0001·L0〕', citations: [{ id: 'A-0001', level: 'L0' }, { id: 'A-9999', level: 'L0' }], missingInfo: null });
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content } }], usage: { total_tokens: 42 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return fetch(url, init);
  };
  const s = await startServer({ fetchImpl: fakeFetch, env: { OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_BASE_URL: 'https://openrouter.test/api/v1', OPENROUTER_MODEL: 'test/model' } });
  try {
    await s.admin('POST', '/admin/api/seed');
    const consumer = await s.keyFor('agent', 'consumer');
    const r = (await consumer('POST', '/api/v1/ask', { question: '可售庫存怎麼算？' })).body.data;
    assert.equal(r.composer.type, 'openrouter');
    assert.equal(r.composer.model, 'test/model');
    assert.deepEqual(r.citations.map(c => c.id), ['A-0001'], '不在知識範圍內的引用被丟棄');
    const last = calls.at(-1);
    assert.equal(last.headers.authorization, 'Bearer sk-or-test');
    assert.match(last.body.messages[0].content, /絕不用行業通用知識/);
    const u = (await consumer('POST', '/api/v1/ask', { question: '可售庫存多久同步到搜索系統？' })).body.data;
    assert.equal(u.status, 'uncovered');
    assert.ok(u.gap);
    const settings = await s.admin('GET', '/admin/api/settings');
    assert.equal(settings.body.data.llm.apiKeySource, 'env:OPENROUTER_API_KEY');
    assert.ok(!JSON.stringify(settings.body.data).includes('sk-or-test'), '機密不回傳');
  } finally {
    await s.close();
  }
});

test('Git 遠端：寫入推送到使用者指定倉庫；他人在 Git 中的修改可同步回來', async () => {
  const root = await tmpDir();
  const bare = path.join(root, 'knowledge.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const s = await startServer({ env: { KNOWLEDGE_GIT_URL: `file://${bare}`, KNOWLEDGE_GIT_BRANCH: 'main' } });
  try {
    const agent = await s.keyFor('agent', 'contributor', '遠端測試');
    const r = await agent('POST', '/api/v1/subjects', { name: '運輸管理系統', type: '系統', domain: 'TMS', definition: '幹線與末端運輸調度' });
    assert.equal(r.status, 201);
    await s.srv.ctx.store.flushPush();
    const work = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', bare, work]);
    const file = path.join(work, 'knowledge', 'subjects', `${r.body.data.id}.yaml`);
    assert.match(await fs.readFile(file, 'utf8'), /運輸管理系統/);
    // 模擬人直接在 Git 中修改定義並推送
    const edited = (await fs.readFile(file, 'utf8')).replace('幹線與末端運輸調度', '幹線運輸調度（不含末端配送）');
    await fs.writeFile(file, edited);
    execFileSync('git', ['-C', work, '-c', 'user.name=Reviewer', '-c', 'user.email=r@example.com', 'commit', '-qam', '人工修正定義']);
    execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'HEAD:main']);
    const sync = await s.admin('POST', '/admin/api/sync');
    assert.equal(sync.body.data.changed, true);
    const card = (await agent('GET', `/api/v1/subjects/${r.body.data.id}`)).body.data;
    assert.equal(card.subject.definition, '幹線運輸調度（不含末端配送）');
  } finally {
    await s.close();
  }
});

test('管理後台：靜態頁面與登入保護', async () => {
  const page = await t.call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /assets\/portal\.css/);
  assert.equal((await t.call('GET', '/admin/api/me')).status, 401);
  assert.equal((await t.call('POST', '/admin/api/login', { password: 'nope' })).status, 401);
  const me = await t.admin('GET', '/admin/api/me');
  assert.equal(me.body.data.isAdmin, true);
  const agentKey = await t.admin('POST', '/admin/api/keys', { name: 'bot', kind: 'agent', role: 'contributor' });
  const human = await t.admin('POST', '/admin/api/keys', { name: '庫存域架構師', kind: 'human', role: 'owner' });
  assert.equal(human.status, 201, JSON.stringify(human.body));
  const login = await t.call('POST', '/admin/api/login', { apiKey: human.body.data.secret });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.role, 'owner');
  assert.equal((await t.call('POST', '/admin/api/login', { apiKey: agentKey.body.data.secret })).status, 403, '後台只允許人登入');
});
