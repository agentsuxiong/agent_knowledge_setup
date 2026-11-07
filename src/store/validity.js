// 有效性（Validity）：附在綁定、斷言、關係三處，共用同一套字段與層級規則。
import { LEVELS, LEVEL_RANK, PENDING_REASONS } from './model.js';

export class RuleError extends Error {
  constructor(message, status = 422, code = 'rule_violation') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const HISTORY_LIMIT = 30;

export function emptyValidity() {
  return {
    level: 'L2',
    evidence: { objectIds: [], actionId: null, sourceRef: null },
    method: null,
    verifiedBy: null,
    verifiedAt: null,
    expiresAt: null,
    source: null,
    invalidReason: null,
    replacedBy: null,
    pending: null,
    history: []
  };
}

export function normalizeValidity(v) {
  const base = emptyValidity();
  const out = { ...base, ...(v || {}) };
  out.evidence = { ...base.evidence, ...(v?.evidence || {}) };
  out.evidence.objectIds = Array.isArray(out.evidence.objectIds) ? out.evidence.objectIds.filter(Boolean) : [];
  if (!LEVELS.includes(out.level)) out.level = 'L2';
  out.history = Array.isArray(out.history) ? out.history : [];
  return out;
}

export function hasEvidence(validity) {
  const e = validity?.evidence || {};
  return (Array.isArray(e.objectIds) && e.objectIds.length > 0) || !!(e.sourceRef && String(e.sourceRef).trim());
}

export function sourceOf(principal) {
  if (!principal) return { kind: 'system', id: 'system', name: '系統' };
  return { kind: principal.kind, id: principal.id, name: principal.name };
}

/**
 * 寫入上限：
 *  - 人或智能體提交：附客體證據最高 L1，無證據只能 L2；不能直接寫入 L0。
 *  - 已註冊管道自動同步：按管道校驗結果直接定級。
 *  - E1（記錄已失效知識）方向安全，允許提交，但必須寫明失效原因。
 */
export function capSubmittedLevel({ requested, principal, validity }) {
  const warnings = [];
  const evidence = hasEvidence(validity);
  const ceiling = evidence ? 'L1' : 'L2';
  if (requested && !LEVELS.includes(requested)) throw new RuleError(`層級必須為 ${LEVELS.join(' / ')}`, 400, 'invalid_level');

  if (principal?.kind === 'pipeline') {
    if (!requested) return { level: ceiling, warnings, method: null };
    if (requested === 'E1' && !validity.invalidReason) throw new RuleError('寫入 E1 必須提供 invalidReason（失效原因）', 400, 'missing_invalid_reason');
    return { level: requested, warnings, method: requested === 'L0' ? 'pipeline' : null };
  }

  if (requested === 'E1') {
    if (!validity.invalidReason) throw new RuleError('寫入 E1 必須提供 invalidReason（失效原因）', 400, 'missing_invalid_reason');
    return { level: 'E1', warnings, method: null };
  }
  if (!requested) return { level: ceiling, warnings, method: null };
  if (requested === 'L0') {
    warnings.push(`人或智能體不能直接寫入 L0，已按寫入上限定為 ${ceiling}。L0 只能通過 Action 校驗或負責人確認晉升。`);
    return { level: ceiling, warnings, method: null };
  }
  if (requested === 'L1' && !evidence) {
    warnings.push('沒有客體證據或明確來源，只能寫入 L2。補充證據後可升為 L1。');
    return { level: 'L2', warnings, method: null };
  }
  return { level: requested, warnings, method: null };
}

export function transition(validity, to, { reason, by, note, at = new Date().toISOString() } = {}) {
  const from = validity.level;
  if (!LEVELS.includes(to)) throw new RuleError(`未知層級 ${to}`, 400);
  validity.level = to;
  validity.history = [...(validity.history || []), { at, from, to, reason: reason || null, by: by || null, ...(note ? { note } : {}) }].slice(-HISTORY_LIMIT);
  return { from, to };
}

export function setPending(validity, reason, note, at = new Date().toISOString()) {
  if (!PENDING_REASONS[reason]) throw new RuleError(`未知的重驗原因 ${reason}`, 400);
  validity.pending = { reason, label: PENDING_REASONS[reason], at, ...(note ? { note } : {}) };
}

export function clearPending(validity) {
  validity.pending = null;
}

/** 降級到 L1（到期、校驗不符、衝突、反饋錯誤、證據客體下線）並排入重驗。 */
export function demoteToL1(validity, reason, { by, note, at } = {}) {
  let changed = false;
  if (validity.level === 'L0') {
    transition(validity, 'L1', { reason: `降級：${PENDING_REASONS[reason] || reason}`, by, note, at });
    changed = true;
  }
  if (validity.level !== 'E1') {
    setPending(validity, reason, note, at);
    changed = true;
  }
  return changed;
}

export function promoteToL0(validity, { method, by, expiresAt, note, actionId, at = new Date().toISOString() }) {
  if (validity.level === 'E1') throw new RuleError('E1（失效）知識不能晉升；請提交新的知識並指向替代關係', 409, 'invalid_transition');
  if (validity.level === 'L2' && method === 'manual') throw new RuleError('L2 不能直接晉升 L0：先補充客體證據（L2 → L1），再校驗或確認（L1 → L0）', 409, 'invalid_transition');
  if (!hasEvidence(validity) && method === 'manual') throw new RuleError('晉升 L0 需要客體證據', 409, 'missing_evidence');
  if (validity.level !== 'L0') transition(validity, 'L0', { reason: method === 'auto' ? `Action 校驗通過${actionId ? `（${actionId}）` : ''}` : '負責人確認', by, note, at });
  else validity.history = [...validity.history, { at, from: 'L0', to: 'L0', reason: '重新驗證，延長有效期', by }].slice(-HISTORY_LIMIT);
  validity.method = method;
  validity.verifiedBy = by;
  validity.verifiedAt = at;
  validity.expiresAt = expiresAt;
  if (actionId) validity.evidence.actionId = actionId;
  validity.invalidReason = null;
  clearPending(validity);
}

export function invalidate(validity, { reason, replacedBy, by, at = new Date().toISOString() }) {
  if (!reason) throw new RuleError('轉為 E1 必須寫明失效原因', 400, 'missing_invalid_reason');
  if (validity.level !== 'E1') transition(validity, 'E1', { reason: `失效：${reason}`, by, at });
  validity.invalidReason = reason;
  validity.replacedBy = replacedBy || validity.replacedBy || null;
  validity.expiresAt = null;
  clearPending(validity);
}

export function addDays(iso, days) {
  return new Date(Date.parse(iso) + days * 86400000).toISOString();
}

export function isExpired(validity, now = Date.now()) {
  return validity.level === 'L0' && validity.expiresAt && Date.parse(validity.expiresAt) < now;
}

export function rankOf(level) {
  return LEVEL_RANK[level] ?? -1;
}
