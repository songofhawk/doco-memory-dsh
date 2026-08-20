// @ts-check
/** 工具共享工具：参数校验、渲染块、宽松输出 schema。 */

/** 宽松输出 schema：允许任意字段（对齐 doco-dsh OPEN_OBJECT）。 */
export const OPEN_OBJECT = Object.freeze({ type: 'object', additionalProperties: true, properties: {} });

/**
 * 渲染文本块（dsh output.render 返回值）。
 * @param {string} text
 * @returns {Array<{ type: 'text'; text: string }>}
 */
export function textBlock(text) {
  return [{ type: 'text', text }];
}

/**
 * @param {unknown} v
 * @param {string} fallback
 */
export function toString(v, fallback) {
  return v == null || v === '' ? fallback : String(v);
}

/**
 * @param {unknown} v
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
export function toNumInRange(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 归一化 knowledge_base_id（字符串/数字 → string|null）。
 * @param {unknown} v
 * @returns {string | null}
 */
export function normalizeKbId(v) {
  if (v == null || v === '') return null;
  return String(v);
}