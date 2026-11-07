// 知識模型規則：寫入上限、層級遷移、別名規則、關係方向、客體下線級聯、到期、衝突、反饋、Git 持久化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeStore, ADMIN, AGENT, OWNER, PIPE } from './helpers.js';
import { capSubmittedLevel, normalizeValidity } from '../src/store/validity.js';

async function basics(store) {
  const { result } = await store.tx(ADMIN, '準備', t => {
    const doc = store.createObject(t, { name: '口徑文檔', category: '制度', kind: '口徑定義', locator: 'wiki://doc' }, AGENT);
    const center = store.createSubject(t, { name: '庫存中心', type: '系統', domain: 'INV', definition: '庫存權威系統' }, AGENT);
    const atp = store.createSubject(t, { name: '可售庫存', type: '指標', domain: 'INV', definition: '可下單佔用的庫存' }, AGENT);
    const phys = store.createSubject(t, { name: '實物可用庫存', type: '指標', domain: 'INV', definition: '倉內可揀貨數量' }, AGENT);
    return { doc: doc.id, center: center.id, atp: atp.id, phys: phys.id };
  });
  return result;
}

test('寫入上限：人或智能體不能直接寫入 L0；有證據最高 L1，無證據 L2；管道按校驗結果定級', () => {
  const withEv = normalizeValidity({ evidence: { objectIds: ['O-0001'] } });
  const noEv = normalizeValidity({});
  assert.equal(capSubmittedLevel({ requested: 'L0', principal: AGENT, validity: withEv }).level, 'L1');
  assert.match(capSubmittedLevel({ requested: 'L0', principal: AGENT, validity: withEv }).warnings[0], /不能直接寫入 L0/);
  assert.equal(capSubmittedLevel({ requested: 'L0', principal: ADMIN, validity: noEv }).level, 'L2');
  assert.equal(capSubmittedLevel({ requested: 'L1', principal: AGENT, validity: noEv }).level, 'L2');
  assert.equal(capSubmittedLevel({ principal: AGENT, validity: withEv }).level, 'L1');
  assert.equal(capSubmittedLevel({ requested: 'L0', principal: PIPE, validity: noEv }).level, 'L0');
  assert.throws(() => capSubmittedLevel({ requested: 'E1', principal: AGENT, validity: noEv }), /invalidReason/);
});

test('主體 ID 按領域編號；同名衝突返回 409', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  assert.equal(ids.center, 'S-INV-0001');
  assert.equal(ids.atp, 'S-INV-0002');
  await assert.rejects(store.tx(AGENT, 'dup', t => store.createSubject(t, { name: '可售庫存', type: '指標', domain: 'INV' }, AGENT)), err => err.status === 409 && err.code === 'duplicate_name');
});

test('別名規則：只通過別名關係指向規範主體、不掛斷言、多義需消歧', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  await store.tx(AGENT, 'alias', t => {
    store.createSubject(t, { name: 'ATP', type: '別名', domain: 'INV', aliasOf: [ids.atp] }, AGENT);
    store.createSubject(t, { name: '可用庫存', type: '別名', domain: 'INV', aliasOf: [ids.atp, ids.phys] }, AGENT);
  });
  const alias = [...store.subjects.values()].find(s => s.name === 'ATP');
  await assert.rejects(store.tx(AGENT, 'x', t => store.createAssertion(t, alias.id, { type: '定義', content: 'x' }, AGENT)), /別名主體自身不掛/);
  await assert.rejects(store.tx(AGENT, 'x', t => store.createRelation(t, { from: alias.id, type: '依賴', to: ids.center }, AGENT)), err => err.code === 'alias_rule' || err.code === 'relation_direction');
  const r1 = store.resolveTerms('ATP 怎麼算');
  assert.deepEqual(r1.canonical, [ids.atp]);
  const r2 = store.resolveTerms('可用庫存指什麼');
  assert.equal(r2.ambiguous.length, 1);
  assert.equal(r2.ambiguous[0].candidates.length, 2);
  // 最長匹配：「實物可用庫存」不應被「可用庫存」別名截走
  const r3 = store.resolveTerms('實物可用庫存是什麼');
  assert.deepEqual(r3.canonical, [ids.phys]);
  assert.equal(r3.ambiguous.length, 0);
});

test('關係類型閉集與方向約束', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  await assert.rejects(store.tx(AGENT, 'x', t => store.createRelation(t, { from: ids.atp, type: '擁有', to: ids.center }, AGENT)), err => err.code === 'relation_direction');
  await assert.rejects(store.tx(AGENT, 'x', t => store.createRelation(t, { from: ids.center, type: '調用', to: ids.atp }, AGENT)), err => err.code === 'invalid_relation_type');
  const { result } = await store.tx(AGENT, 'ok', t => store.createRelation(t, { from: ids.center, type: '擁有', to: ids.atp, evidence: { objectIds: [ids.doc] } }, AGENT));
  assert.equal(result.validity.level, 'L1');
});

test('層級遷移：L2 → L1 補證據；L1 → L0 只能由人類負責人確認；智能體不能晉升', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  const { result: a } = await store.tx(AGENT, 'a', t => store.createAssertion(t, ids.atp, { type: '約束', content: '計算結果為負時，對外按 0 展示', level: 'L0' }, AGENT));
  assert.equal(a.validity.level, 'L2');
  await assert.rejects(store.tx(OWNER, 'c', t => store.confirm(t, a.id, {}, OWNER)), /L2 不能直接晉升 L0/);
  await store.tx(AGENT, 'e', t => store.addEvidence(t, a.id, { objectIds: [ids.doc] }, AGENT));
  assert.equal(store.getItem(a.id).item.validity.level, 'L1');
  await assert.rejects(store.tx(AGENT, 'c', t => store.confirm(t, a.id, {}, AGENT)), err => err.code === 'agent_cannot_promote');
  await store.tx(OWNER, 'c', t => store.confirm(t, a.id, { note: '已核實' }, OWNER));
  const v = store.getItem(a.id).item.validity;
  assert.equal(v.level, 'L0');
  assert.equal(v.method, 'manual');
  assert.equal(v.verifiedBy, OWNER.id);
  assert.ok(Date.parse(v.expiresAt) > Date.now() + 29 * 86400000, '約束類預設 30 天有效期');
  assert.deepEqual(v.history.map(h => h.to), ['L2', 'L1', 'L0']);
});

test('主體綜合層級 = 有效綁定中的最高層級，沒有有效綁定時為 L2', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  assert.equal(store.subjectLevel(store.getSubject(ids.atp)), 'L2');
  const { result: b } = await store.tx(AGENT, 'b', t => store.createBinding(t, ids.atp, { objectId: ids.doc }, AGENT));
  assert.equal(store.subjectLevel(store.getSubject(ids.atp)), 'L1');
  await store.tx(OWNER, 'c', t => store.confirm(t, b.id, {}, OWNER));
  assert.equal(store.subjectLevel(store.getSubject(ids.atp)), 'L0');
});

test('客體下線：綁定轉 E1，以它為證據的斷言與關係降為 L1 並排入重驗', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  const { result } = await store.tx(AGENT, 'x', t => {
    const b = store.createBinding(t, ids.atp, { objectId: ids.doc }, AGENT);
    const a = store.createAssertion(t, ids.atp, { type: '定義', content: '可售庫存 = 實物 − 預佔', evidence: { objectIds: [ids.doc] } }, AGENT);
    const r = store.createRelation(t, { from: ids.center, type: '擁有', to: ids.atp, evidence: { objectIds: [ids.doc] } }, AGENT);
    return { b: b.id, a: a.id, r: r.id };
  });
  await store.tx(OWNER, 'c', t => { store.confirm(t, result.b, {}, OWNER); store.confirm(t, result.a, {}, OWNER); });
  await store.tx(AGENT, 'off', t => store.updateObject(t, ids.doc, { status: '下線', reason: '文檔作廢' }, AGENT));
  assert.equal(store.getItem(result.b).item.validity.level, 'E1');
  assert.equal(store.getItem(result.a).item.validity.level, 'L1');
  assert.equal(store.getItem(result.a).item.validity.pending.reason, 'object_offline');
  assert.equal(store.getItem(result.r).item.validity.pending.reason, 'object_offline');
  assert.equal(store.subjectLevel(store.getSubject(ids.atp)), 'L2');
  assert.ok(store.revalidationQueue().some(q => q.id === result.a));
});

test('時間觸發：L0 到期自動降為 L1 並排入重驗', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  const { result: a } = await store.tx(AGENT, 'a', t => store.createAssertion(t, ids.atp, { type: '規則', content: '預佔 30 分鐘釋放', evidence: { objectIds: [ids.doc] } }, AGENT));
  await store.tx(OWNER, 'c', t => store.confirm(t, a.id, { expiryDays: 1 }, OWNER));
  const { result: expired } = await store.tx(ADMIN, 'sweep', t => store.expirySweep(t, Date.now() + 2 * 86400000));
  assert.deepEqual(expired, [a.id]);
  const v = store.getItem(a.id).item.validity;
  assert.equal(v.level, 'L1');
  assert.equal(v.pending.reason, 'expired');
});

test('衝突：雙方降為 L1；裁決後勝方 L0、敗方 E1 並指向替代者', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  const { result } = await store.tx(AGENT, 'x', t => ({
    a: store.createAssertion(t, ids.atp, { type: '定義', content: '扣安全庫存', evidence: { objectIds: [ids.doc] } }, AGENT).id,
    b: store.createAssertion(t, ids.atp, { type: '定義', content: '不扣安全庫存', evidence: { objectIds: [ids.doc] } }, AGENT).id
  }));
  await store.tx(OWNER, 'c', t => store.confirm(t, result.a, {}, OWNER));
  const { result: c } = await store.tx(AGENT, 'conf', t => store.reportConflict(t, { a: result.a, b: result.b, note: '口徑矛盾' }, AGENT));
  assert.equal(store.getItem(result.a).item.validity.level, 'L1');
  await assert.rejects(store.tx(AGENT, 'r', t => store.resolveConflict(t, c.id, { winner: result.a }, AGENT)), err => err.code === 'agent_cannot_promote');
  await store.tx(OWNER, 'r', t => store.resolveConflict(t, c.id, { winner: result.a, reason: '口徑 v3' }, OWNER));
  assert.equal(store.getItem(result.a).item.validity.level, 'L0');
  const loser = store.getItem(result.b).item.validity;
  assert.equal(loser.level, 'E1');
  assert.equal(loser.replacedBy, result.a);
  assert.equal(store.conflicts.get(c.id).status, 'resolved');
});

test('使用反饋：L0 降為 L1 並計入 L0 錯誤反饋數', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  const { result: a } = await store.tx(AGENT, 'a', t => store.createAssertion(t, ids.atp, { type: '屬性', content: '準實時刷新', evidence: { objectIds: [ids.doc] } }, AGENT));
  await store.tx(OWNER, 'c', t => store.confirm(t, a.id, {}, OWNER));
  await store.tx(AGENT, 'f', t => store.submitFeedback(t, { targetId: a.id, comment: '現在改成每 5 分鐘批量刷新' }, AGENT));
  assert.equal(store.getItem(a.id).item.validity.level, 'L1');
  assert.equal(store.health().l0ErrorFeedback.value, 1);
});

test('每個業務對象或指標只有一條 L0「擁有」關係', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  const { result } = await store.tx(AGENT, 'x', t => {
    const other = store.createSubject(t, { name: '商品中心', type: '系統', domain: 'INV' }, AGENT);
    return {
      r1: store.createRelation(t, { from: ids.center, type: '擁有', to: ids.atp, evidence: { objectIds: [ids.doc] } }, AGENT).id,
      r2: store.createRelation(t, { from: other.id, type: '擁有', to: ids.atp, evidence: { objectIds: [ids.doc] } }, AGENT).id
    };
  });
  await store.tx(OWNER, 'c1', t => store.confirm(t, result.r1, {}, OWNER));
  await assert.rejects(store.tx(OWNER, 'c2', t => store.confirm(t, result.r2, {}, OWNER)), err => err.code === 'single_owner');
});

test('Git 持久化：每次寫入一個提交，作者為提交者；重新載入後數據一致；失敗事務回滾', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  const log = await store.repo.log({ limit: 5 });
  assert.equal(log[0].author, ADMIN.name);
  assert.equal(log[0].subject, '準備');
  const file = path.join(store.root, 'subjects', `${ids.atp}.yaml`);
  const yaml = await fs.readFile(file, 'utf8');
  assert.match(yaml, /name: 可售庫存/);
  await assert.rejects(store.tx(AGENT, 'bad', t => {
    store.createSubject(t, { name: '臨時主體', type: '系統', domain: 'INV' }, AGENT);
    store.createRelation(t, { from: ids.atp, type: '擁有', to: ids.center }, AGENT);
  }));
  assert.ok(![...store.subjects.values()].some(s => s.name === '臨時主體'), '失敗事務不留下記憶體修改');
  const before = store.listSubjects().length;
  await store.load();
  assert.equal(store.listSubjects().length, before);
  assert.equal((await store.repo.log({ limit: 50 })).filter(l => l.subject === 'bad').length, 0);
});

test('防止繞過：客體存在不能把斷言校驗成 L0；客體定位變更使相關知識降為 L1', async () => {
  const { store } = await makeStore();
  const ids = await basics(store);
  const { result } = await store.tx(ADMIN, 'dyn', t => {
    const p = store.upsertPipeline(t, { name: 'mock', type: 'mock', routes: [] }, ADMIN);
    const exists = store.upsertAction(t, { name: '存在', kind: '校驗', pipelineId: p.id, request: { path: '/x/{object.locator}' }, check: { mode: 'exists' } }, ADMIN);
    const equals = store.upsertAction(t, { name: '比對', kind: '校驗', pipelineId: p.id, request: { path: '/c/{object.locator}' }, output: { path: 'value' }, check: { mode: 'equals' } }, ADMIN);
    const relCheck = store.upsertAction(t, { name: '調用鏈', kind: '校驗', pipelineId: p.id, request: { path: '/trace/{item.from}/{item.to}' }, check: { mode: 'exists' } }, ADMIN);
    store.updateObject(t, ids.doc, { actionIds: [exists.id, equals.id, relCheck.id] }, ADMIN);
    const b = store.createBinding(t, ids.atp, { objectId: ids.doc }, AGENT);
    const plain = store.createAssertion(t, ids.atp, { type: '定義', content: '隨便寫的定義', evidence: { objectIds: [ids.doc] } }, AGENT);
    const structured = store.createAssertion(t, ids.atp, { type: '規則', content: '預佔 30 分鐘釋放', structured: { key: 'reserve.ttl', value: '30m' }, evidence: { objectIds: [ids.doc] } }, AGENT);
    const r = store.createRelation(t, { from: ids.center, type: '擁有', to: ids.atp, evidence: { objectIds: [ids.doc] } }, AGENT);
    return { exists: exists.id, equals: equals.id, relCheck: relCheck.id, b: b.id, plain: plain.id, structured: structured.id, r: r.id };
  });
  assert.equal(store.findValidateAction(store.getItem(result.b)).action.id, result.exists);
  assert.equal(store.findValidateAction(store.getItem(result.plain)), null, '無結構化值的斷言沒有可用校驗');
  assert.equal(store.findValidateAction(store.getItem(result.structured)).action.id, result.equals);
  assert.equal(store.findValidateAction(store.getItem(result.r)).action.id, result.relCheck);
  await store.tx(OWNER, 'c', t => store.confirm(t, result.b, {}, OWNER));
  await store.tx(AGENT, 'move', t => store.updateObject(t, ids.doc, { locator: 'wiki://other' }, AGENT));
  const v = store.getItem(result.b).item.validity;
  assert.equal(v.level, 'L1');
  assert.equal(v.pending.reason, 'object_changed');
});
