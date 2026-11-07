// OpenRouter 客戶端（OpenAI 兼容的 Chat Completions 介面）。
export class LlmClient {
  constructor({ settings, fetchImpl = globalThis.fetch }) {
    this.settings = settings;
    this.fetch = fetchImpl;
  }

  get config() {
    return this.settings.section('llm');
  }

  get enabled() {
    return !!this.config.apiKey;
  }

  get model() {
    return this.config.model;
  }

  async chat({ messages, model, temperature, json = true, maxTokens = 1500 }) {
    const cfg = this.config;
    if (!cfg.apiKey) throw Object.assign(new Error('未配置 OpenRouter API Key'), { status: 503, code: 'llm_not_configured' });
    const body = { model: model || cfg.model, messages, temperature: temperature ?? Number(cfg.temperature ?? 0.1), max_tokens: maxTokens };
    if (json) body.response_format = { type: 'json_object' };
    const url = `${String(cfg.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`;
    const headers = {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json',
      'X-Title': cfg.appTitle || 'Supply Chain Knowledge MVP'
    };
    const publicBase = this.settings.value('server.publicBaseUrl');
    if (publicBase) headers['HTTP-Referer'] = publicBase;
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 45000) });
    } catch (err) {
      throw Object.assign(new Error(`OpenRouter 請求失敗：${err.message}`), { status: 502, code: 'llm_unreachable' });
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      const msg = data?.error?.message || text.slice(0, 300);
      // 部分模型不支援 response_format：去掉後重試一次。
      if (json && res.status === 400 && /response_format|json/i.test(msg)) return this.chat({ messages, model, temperature, json: false, maxTokens });
      throw Object.assign(new Error(`OpenRouter 返回 ${res.status}：${msg}`), { status: 502, code: 'llm_error' });
    }
    const content = data?.choices?.[0]?.message?.content ?? '';
    return { content: typeof content === 'string' ? content : JSON.stringify(content), model: data?.model || body.model, usage: data?.usage || null };
  }

  async chatJson(opts) {
    const r = await this.chat(opts);
    return { ...r, json: parseJsonLoose(r.content) };
  }
}

export function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 嘗試截取 */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* 繼續 */ } }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch { /* 放棄 */ } }
  return null;
}
