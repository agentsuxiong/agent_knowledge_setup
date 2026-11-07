// 本地設定（含機密）：存放在 DATA_DIR/settings.json，不進入知識倉庫。
// 環境變數優先於設定檔，後台中顯示為「由環境變數提供」。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ENV_MAP = {
  'git.url': 'KNOWLEDGE_GIT_URL',
  'git.branch': 'KNOWLEDGE_GIT_BRANCH',
  'git.token': 'KNOWLEDGE_GIT_TOKEN',
  'git.username': 'KNOWLEDGE_GIT_USERNAME',
  'git.subdir': 'KNOWLEDGE_GIT_SUBDIR',
  'llm.apiKey': 'OPENROUTER_API_KEY',
  'llm.model': 'OPENROUTER_MODEL',
  'llm.baseUrl': 'OPENROUTER_BASE_URL',
  'server.publicBaseUrl': 'PUBLIC_BASE_URL'
};

const SECRET_KEYS = new Set(['git.token', 'llm.apiKey']);

export const DEFAULT_SETTINGS = {
  server: { publicBaseUrl: '' },
  git: {
    url: '',
    branch: 'main',
    token: '',
    username: 'x-access-token',
    subdir: 'knowledge',
    authorName: 'Knowledge Bot',
    authorEmail: 'knowledge-bot@localhost',
    autoPush: true,
    pullIntervalSec: 60
  },
  llm: {
    provider: 'openrouter',
    apiKey: '',
    model: 'anthropic/claude-sonnet-4.5',
    baseUrl: 'https://openrouter.ai/api/v1',
    temperature: 0.1,
    timeoutMs: 45000,
    appTitle: 'Supply Chain Knowledge MVP'
  },
  admin: { passwordHash: '', salt: '' },
  apiKeys: []
};

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function set(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

function deepMerge(base, extra) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const h = crypto.scryptSync(String(password), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === h.length && crypto.timingSafeEqual(h, expected);
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export class Settings {
  constructor(dataDir, env = process.env) {
    this.dataDir = dataDir;
    this.env = env;
    this.file = path.join(dataDir, 'settings.json');
    fs.mkdirSync(dataDir, { recursive: true });
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      stored = {};
    }
    this.data = deepMerge(DEFAULT_SETTINGS, stored);
    this.ensureAdmin();
  }

  ensureAdmin() {
    if (this.env.ADMIN_PASSWORD) return;
    if (this.data.admin.passwordHash) return;
    const password = crypto.randomBytes(9).toString('base64url');
    const { hash, salt } = hashPassword(password);
    this.data.admin = { passwordHash: hash, salt };
    this.save();
    const file = path.join(this.dataDir, 'initial-admin-password.txt');
    fs.writeFileSync(file, password + '\n', { mode: 0o600 });
    this.generatedAdminPassword = password;
    console.log(`[knowledge] 已生成初始管理員密碼，見 ${file}（建議以 ADMIN_PASSWORD 環境變數設定）`);
  }

  checkAdminPassword(password) {
    if (this.env.ADMIN_PASSWORD) {
      const a = Buffer.from(sha256(password));
      const b = Buffer.from(sha256(this.env.ADMIN_PASSWORD));
      return crypto.timingSafeEqual(a, b);
    }
    return verifyPassword(password, this.data.admin.passwordHash, this.data.admin.salt);
  }

  setAdminPassword(password) {
    if (this.env.ADMIN_PASSWORD) throw Object.assign(new Error('管理員密碼由環境變數 ADMIN_PASSWORD 提供，無法在後台修改'), { status: 409 });
    if (!password || String(password).length < 8) throw Object.assign(new Error('密碼至少 8 個字元'), { status: 400 });
    const { hash, salt } = hashPassword(password);
    this.data.admin = { passwordHash: hash, salt };
    this.save();
  }

  /** 取得生效值（環境變數優先）。 */
  value(dotted) {
    const envName = ENV_MAP[dotted];
    if (envName && this.env[envName]) return this.env[envName];
    return get(this.data, dotted);
  }

  source(dotted) {
    const envName = ENV_MAP[dotted];
    return envName && this.env[envName] ? `env:${envName}` : 'settings';
  }

  section(name) {
    const out = {};
    for (const key of Object.keys(DEFAULT_SETTINGS[name] || {})) out[key] = this.value(`${name}.${key}`);
    return out;
  }

  /** 對外展示（機密遮罩）。 */
  publicSection(name) {
    const out = {};
    for (const key of Object.keys(DEFAULT_SETTINGS[name] || {})) {
      const dotted = `${name}.${key}`;
      const v = this.value(dotted);
      out[key] = SECRET_KEYS.has(dotted) ? (v ? `已設定（…${String(v).slice(-4)}）` : '') : v;
      if (this.source(dotted) !== 'settings') out[`${key}Source`] = this.source(dotted);
    }
    return out;
  }

  update(name, patch) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in (DEFAULT_SETTINGS[name] || {}))) continue;
      const dotted = `${name}.${key}`;
      if (SECRET_KEYS.has(dotted) && (value === undefined || value === null || String(value).startsWith('已設定'))) continue;
      const def = DEFAULT_SETTINGS[name][key];
      let v = value;
      if (typeof def === 'number') v = Number(value);
      if (typeof def === 'boolean') v = value === true || value === 'true' || value === 'on';
      set(this.data, dotted, v);
    }
    this.save();
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ---- API 金鑰 ----
  createApiKey({ name, kind, role }) {
    if (!['human', 'agent', 'pipeline'].includes(kind)) throw Object.assign(new Error('kind 必須為 human / agent / pipeline'), { status: 400 });
    if (!['consumer', 'contributor', 'owner'].includes(role)) throw Object.assign(new Error('role 必須為 consumer / contributor / owner'), { status: 400 });
    if (role === 'owner' && kind !== 'human') throw Object.assign(new Error('負責人（owner）只能是人；智能體不能晉升知識'), { status: 400 });
    if (!name || !String(name).trim()) throw Object.assign(new Error('請填寫名稱'), { status: 400 });
    const secret = 'kk_' + crypto.randomBytes(24).toString('base64url');
    const id = (kind === 'agent' ? 'agent-' : kind === 'pipeline' ? 'pipe-' : 'user-') + crypto.randomBytes(4).toString('hex');
    const record = { id, name: String(name).trim(), kind, role, hash: sha256(secret), prefix: secret.slice(0, 9), createdAt: new Date().toISOString(), lastUsedAt: null, disabled: false };
    this.data.apiKeys.push(record);
    this.save();
    return { ...this.publicKey(record), secret };
  }

  publicKey(k) {
    const { hash, ...rest } = k;
    return rest;
  }

  listApiKeys() {
    return this.data.apiKeys.map(k => this.publicKey(k));
  }

  findApiKey(secret) {
    if (!secret) return null;
    const h = sha256(secret);
    return this.data.apiKeys.find(k => !k.disabled && k.hash === h) || null;
  }

  touchApiKey(id) {
    const k = this.data.apiKeys.find(x => x.id === id);
    if (!k) return;
    const now = Date.now();
    if (!k.lastUsedAt || now - Date.parse(k.lastUsedAt) > 60000) {
      k.lastUsedAt = new Date(now).toISOString();
      this.save();
    }
  }

  setApiKeyDisabled(id, disabled) {
    const k = this.data.apiKeys.find(x => x.id === id);
    if (!k) throw Object.assign(new Error('找不到該金鑰'), { status: 404 });
    k.disabled = !!disabled;
    this.save();
    return this.publicKey(k);
  }

  deleteApiKey(id) {
    const before = this.data.apiKeys.length;
    this.data.apiKeys = this.data.apiKeys.filter(k => k.id !== id);
    if (before === this.data.apiKeys.length) throw Object.assign(new Error('找不到該金鑰'), { status: 404 });
    this.save();
  }
}
