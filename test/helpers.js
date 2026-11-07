import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { GitRepo } from '../src/git/repo.js';
import { KnowledgeStore } from '../src/store/store.js';

export const quiet = { log() {}, warn() {}, error() {} };

export async function tmpDir(prefix = 'kb-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export const ADMIN = { id: 'admin', name: '管理員', kind: 'human', role: 'owner', isAdmin: true };
export const AGENT = { id: 'agent-1', name: '測試智能體', kind: 'agent', role: 'contributor', isAdmin: false };
export const OWNER = { id: 'user-owner', name: '庫存域架構師', kind: 'human', role: 'owner', isAdmin: false };
export const PIPE = { id: 'pipe-1', name: '表血緣管道', kind: 'pipeline', role: 'contributor', isAdmin: false };

export async function makeStore() {
  const dir = await tmpDir();
  const repo = new GitRepo({ dir: path.join(dir, 'repo') });
  const store = new KnowledgeStore({ repo, autoPush: false, logger: quiet });
  await store.init();
  return { store, dir };
}

/** 啟動完整服務並返回帶身份的 HTTP 客戶端。 */
export async function startServer({ env = {}, fetchImpl, dataDir } = {}) {
  dataDir ||= await tmpDir();
  const srv = await createServer({ dataDir, env: { ADMIN_PASSWORD: 'test-admin-pass', ...env }, schedulers: false, logger: quiet, fetchImpl });
  const server = await srv.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  const admin = (method, p, body) => call(method, p, body, { cookie });
  await call('POST', '/admin/api/login', { password: 'test-admin-pass' });
  const keyFor = async (kind, role, name = `${kind}-${role}`) => {
    const r = await admin('POST', '/admin/api/keys', { name, kind, role });
    const secret = r.body.data.secret;
    return (method, p, body) => call(method, p, body, { authorization: `Bearer ${secret}` });
  };
  return { srv, base, call, admin, keyFor, dataDir, close: () => srv.close() };
}
