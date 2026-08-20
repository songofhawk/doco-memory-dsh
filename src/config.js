// @ts-check
/**
 * doco-memory-dsh 配置。优先级（高→低）：dsh 启动参数 options > 环境变量 > 默认。
 * 复用 doco 服务（doco-dsh）的配置面，这里只定义记忆插件自己的开关。
 */
import { DocoPluginError } from './errors.js';

/** 插件级环境变量名。 */
export const ENV_KEYS = Object.freeze({
  defaultKb: 'DOCO_MEMORY_KB',
  kbName: 'DOCO_MEMORY_KB_NAME',
  recallLimit: 'DOCO_MEMORY_RECALL_LIMIT',
  contextBudget: 'DOCO_MEMORY_CONTEXT_BUDGET',
  allowWrites: 'DOCO_MEMORY_ALLOW_WRITES',
});

/**
 * @typedef {{
 *   defaultKb: string | null;
 *   kbName: string;
 *   recallLimit: number;
 *   contextBudget: number;
 *   allowWrites: boolean;
 * }} MemoryConfig
 */

/**
 * @param {unknown} v
 * @param {boolean} fallback
 */
function toBool(v, fallback) {
  if (v == null || v === '') return fallback;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

/**
 * @param {unknown} v
 * @param {string} fallback
 */
function toString(v, fallback) {
  if (v == null || v === '') return fallback;
  return String(v);
}

/**
 * @param {unknown} v
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function toNumInRange(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 解析记忆插件配置。
 * @param {Record<string, unknown>} [options] dsh profile / 启动参数
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {MemoryConfig}
 */
export function resolveMemoryConfig(options = {}, env = process.env) {
  const defaultKb = firstDefined(options.defaultKb, env[ENV_KEYS.defaultKb]);
  const kbName = firstDefined(options.kbName, env[ENV_KEYS.kbName]);
  if (typeof kbName === 'string' && kbName.length > 200) {
    throw new DocoPluginError('doco_memory_invalid_kb_name', '记忆库名称不能超过 200 字符。', { config: ENV_KEYS.kbName });
  }
  return Object.freeze({
    defaultKb: defaultKb ? String(defaultKb) : null,
    kbName: toString(kbName, 'Agent Memory'),
    recallLimit: toNumInRange(firstDefined(options.recallLimit, env[ENV_KEYS.recallLimit]), 12, 1, 50),
    contextBudget: toNumInRange(firstDefined(options.contextBudget, env[ENV_KEYS.contextBudget]), 2000, 64, 50000),
    allowWrites: toBool(firstDefined(options.allowWrites, env[ENV_KEYS.allowWrites]), false),
  });
}

/** @param {...(string|number|boolean|undefined)} values */
function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

export { ENV_KEYS as default };