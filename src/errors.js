// @ts-check
/**
 * doco-memory-dsh 错误契约。
 * 形态对齐 doco-dsh:工具失败返回结构化错误值（不抛出），
 * 装配期错误抛 DocoPluginError（含稳定错误码）。
 *
 * 说明：本插件从 doco 服务(doco-dsh)拿到的是「能力面」，错误映射逻辑为独立实现，
 * 语义与 doco-dsh mapApiError 一致（同一后端契约），不复制其源码。
 */

export class DocoPluginError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DocoPluginError';
    this.code = code;
    this.details = details ?? {};
  }
}

/**
 * @typedef {{ kind: 'doco_error'; code: string; message: string; next_step: string }} ErrorValue
 */

/**
 * 构造结构化错误值。
 * @param {string} code
 * @param {string} message
 * @param {string} [nextStep]
 * @returns {ErrorValue}
 */
export function errorValue(code, message, nextStep = '') {
  return { kind: 'doco_error', code, message, next_step: nextStep };
}

/**
 * 后端错误 → 插件错误码（对齐 Doco Open API 契约）。
 * @param {unknown} error
 * @returns {{ code: string; message: string; next_step: string; http_status: number|null; retryable: boolean }}
 */
export function mapApiError(error) {
  const status = typeof error?.status === 'number' ? error.status : null;
  const code = typeof error?.code === 'string' ? error.code : '';
  const rawMessage = typeof error?.message === 'string' ? error.message : String(error ?? '');

  if (status === 429 || code === 'rate_limited') {
    return { code: 'doco_rate_limited', message: 'Doco API 限流（请稍后重试）', next_step: '稍后重试。', http_status: 429, retryable: true };
  }
  if (status === 401 || code === 'invalid_api_token') {
    return { code: 'doco_auth_required', message: 'Doco 令牌无效或已过期。', next_step: '重新 /doco connect 完成设备授权。', http_status: 401, retryable: false };
  }
  if (status === 403 || code === 'insufficient_scope') {
    return { code: 'doco_insufficient_scope', message: '当前令牌权限不足。', next_step: '用 /doco connect --access read_write 重新授权，或提升 Token scope。', http_status: 403, retryable: false };
  }
  if (status === 404 || code === 'not_found') {
    return { code: 'doco_not_found', message: '目标文档或知识库不存在。', next_step: '确认 id 有效或用 doco_search 定位。', http_status: 404, retryable: false };
  }
  if (code === 'read_cursor_stale') {
    return { code: 'doco_read_cursor_stale', message: '游标/版本已过期。', next_step: '去掉 cursor 重读最新内容。', http_status: status, retryable: false };
  }
  if (status === 409 || status === 412 || code === 'version_conflict') {
    return { code: 'doco_version_conflict', message: '目标已在他处被修改，写入被乐观锁拒绝。', next_step: '重读最新内容后再写。', http_status: status, retryable: false };
  }
  if (status === 0 || code === 'network_error' || code === 'timeout' || (status == null && /fetch|ECONN|ETIMEDOUT|network|ENOTFOUND|socket/i.test(rawMessage))) {
    return { code: 'doco_network', message: code === 'timeout' ? '连接 Doco API 超时。' : '无法连接到 Doco API。', next_step: '检查网络与 DOCO_API_BASE_URL 后重试。', http_status: status === 0 ? null : status, retryable: true };
  }
  return { code: 'doco_internal', message: 'Doco API 返回未预期错误：' + rawMessage, next_step: '稍后重试或联系管理员。', http_status: status, retryable: false };
}

/**
 * 异常 → ErrorValue。
 * @param {unknown} error
 * @returns {ErrorValue}
 */
export function toErrorValue(error) {
  const mapped = mapApiError(error);
  return errorValue(mapped.code, mapped.message, mapped.next_step);
}