// Git 持久化：知識以 YAML 檔案存放在使用者指定的 Git 倉庫中，每次寫入即一次提交。
// 憑證只在單次命令中以 http.extraHeader 傳入，不寫入 .git/config。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function run(args, { cwd, env, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        err.message = `git ${args.filter(a => !a.startsWith('http.extraHeader')).join(' ')} 失敗：${(stderr || err.message).trim()}`;
        reject(err);
      } else resolve(stdout);
    });
  });
}

function redact(text, token) {
  if (!text) return text;
  let t = String(text);
  if (token) t = t.split(token).join('***');
  return t.replace(/(https?:\/\/)[^@/\s]+@/g, '$1***@');
}

export class GitRepo {
  /**
   * @param {object} opts
   * @param {string} opts.dir       本地工作目錄
   * @param {string} [opts.url]     遠端倉庫地址（https 或 ssh）；留空則為純本地倉庫
   * @param {string} [opts.branch]
   * @param {string} [opts.token]   https 存取權杖（GitHub PAT 等）
   * @param {string} [opts.username] Basic 認證用戶名，預設 x-access-token
   * @param {string} [opts.authorName]
   * @param {string} [opts.authorEmail]
   */
  constructor(opts) {
    this.dir = opts.dir;
    this.url = (opts.url || '').trim();
    this.branch = opts.branch || 'main';
    this.token = opts.token || '';
    this.username = opts.username || 'x-access-token';
    this.authorName = opts.authorName || 'Knowledge Bot';
    this.authorEmail = opts.authorEmail || 'knowledge-bot@localhost';
    this.status = { remote: this.url ? redact(this.url) : null, branch: this.branch, lastPullAt: null, lastPushAt: null, lastError: null, ahead: 0, initialized: false };
  }

  authArgs() {
    if (!this.token || !/^https?:\/\//.test(this.url)) return [];
    const basic = Buffer.from(`${this.username}:${this.token}`).toString('base64');
    return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
  }

  git(args, opts = {}) {
    return run(args, { cwd: this.dir, ...opts }).catch(err => {
      err.message = redact(err.message, this.token);
      throw err;
    });
  }

  async exists() {
    try {
      await fs.access(path.join(this.dir, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    if (!(await this.exists())) {
      if (this.url) {
        await fs.rm(this.dir, { recursive: true, force: true });
        await fs.mkdir(path.dirname(this.dir), { recursive: true });
        try {
          await run([...this.authArgs(), 'clone', '--branch', this.branch, this.url, this.dir]);
        } catch (err) {
          // 空倉庫或分支不存在：先克隆預設分支（或空倉庫），再切出目標分支。
          await fs.rm(this.dir, { recursive: true, force: true });
          try {
            await run([...this.authArgs(), 'clone', this.url, this.dir]);
          } catch (err2) {
            err2.message = redact(err2.message, this.token);
            throw err2;
          }
          await this.git(['checkout', '-B', this.branch]);
        }
      } else {
        await this.git(['init', '-q', '-b', this.branch]);
      }
    }
    await this.git(['config', 'user.name', this.authorName]);
    await this.git(['config', 'user.email', this.authorEmail]);
    await this.git(['config', 'core.quotepath', 'false']);
    if (this.url) {
      const current = (await this.git(['remote']).catch(() => '')).split('\n').map(s => s.trim());
      if (current.includes('origin')) await this.git(['remote', 'set-url', 'origin', this.url]);
      else await this.git(['remote', 'add', 'origin', this.url]);
    }
    this.status.initialized = true;
    return this;
  }

  async hasCommits() {
    try {
      await this.git(['rev-parse', '--verify', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  async remoteHasBranch() {
    if (!this.url) return false;
    try {
      const out = await run([...this.authArgs(), 'ls-remote', '--heads', 'origin', this.branch], { cwd: this.dir });
      return out.trim().length > 0;
    } catch (err) {
      err.message = redact(err.message, this.token);
      throw err;
    }
  }

  /** 從遠端拉取並以 rebase 合併本地提交；返回是否有變化。 */
  async pull() {
    if (!this.url) return false;
    const before = (await this.hasCommits()) ? (await this.git(['rev-parse', 'HEAD'])).trim() : null;
    try {
      if (!(await this.remoteHasBranch())) {
        this.status.lastPullAt = new Date().toISOString();
        return false;
      }
      await this.git([...this.authArgs(), 'fetch', 'origin', this.branch]);
      if (!before) {
        await this.git(['reset', '--hard', `origin/${this.branch}`]);
      } else {
        try {
          await this.git(['rebase', `origin/${this.branch}`]);
        } catch (err) {
          await this.git(['rebase', '--abort']).catch(() => {});
          throw new Error(`與遠端分支合併衝突，已中止 rebase，請在倉庫中手動解決：${err.message}`);
        }
      }
      this.status.lastPullAt = new Date().toISOString();
      this.status.lastError = null;
    } catch (err) {
      this.status.lastError = redact(err.message, this.token);
      throw err;
    }
    const after = (await this.git(['rev-parse', 'HEAD'])).trim();
    return before !== after;
  }

  async push() {
    if (!this.url) return false;
    const attempt = () => this.git([...this.authArgs(), 'push', '-u', 'origin', `HEAD:refs/heads/${this.branch}`]);
    try {
      try {
        await attempt();
      } catch (err) {
        if (/rejected|non-fast-forward|fetch first/i.test(err.message)) {
          await this.pull();
          await attempt();
        } else throw err;
      }
      this.status.lastPushAt = new Date().toISOString();
      this.status.lastError = null;
      this.status.ahead = 0;
      return true;
    } catch (err) {
      this.status.lastError = redact(err.message, this.token);
      this.status.ahead += 1;
      throw err;
    }
  }

  /** 暫存指定路徑並提交；沒有變化時返回 null。 */
  async commit(message, { authorName, authorEmail, paths = ['.'] } = {}) {
    await this.git(['add', '-A', '--', ...paths]);
    const staged = await this.git(['diff', '--cached', '--name-only']);
    if (!staged.trim()) return null;
    const args = ['commit', '-q', '-m', message];
    if (authorName) args.push('--author', `${authorName} <${authorEmail || 'unknown@localhost'}>`);
    await this.git(args);
    return (await this.git(['rev-parse', '--short', 'HEAD'])).trim();
  }

  async log({ limit = 30, file } = {}) {
    if (!(await this.hasCommits())) return [];
    const sep = '\x1f';
    const args = ['log', `-n${limit}`, `--pretty=format:%h${sep}%an${sep}%ae${sep}%aI${sep}%s`];
    if (file) args.push('--follow', '--', file);
    const out = await this.git(args);
    return out.split('\n').filter(Boolean).map(line => {
      const [hash, author, email, date, subject] = line.split(sep);
      return { hash, author, email, date, subject };
    });
  }

  async head() {
    if (!(await this.hasCommits())) return null;
    return (await this.git(['rev-parse', '--short', 'HEAD'])).trim();
  }

  async show(hash, file) {
    return this.git(['show', `${hash}:${file}`]);
  }

  /** 測試遠端連通性（不改變本地狀態）。 */
  static async test({ url, token, username = 'x-access-token', branch = 'main' }) {
    const tmp = new GitRepo({ dir: process.cwd(), url, token, username, branch });
    const out = await run([...tmp.authArgs(), 'ls-remote', url], { cwd: process.cwd(), timeout: 30000 }).catch(err => {
      throw new Error(redact(err.message, token));
    });
    const heads = out.split('\n').filter(l => l.includes('refs/heads/')).map(l => l.split('refs/heads/')[1]);
    return { reachable: true, branches: heads, branchExists: heads.includes(branch), empty: heads.length === 0 };
  }
}
