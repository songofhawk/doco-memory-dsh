// @ts-check
/**
 * doco-memory-dsh 服务装配。
 *
 * 依赖契约（设计文档 §9 + cordis 语义）：
 * - 以 `inject: ['doco']` 消费 doco-dsh 提供的 doco 服务；
 * - 依赖缺失（doco-dsh 未挂载或版本过旧）→ 装配期抛 `doco_memory_requires_base`，
 *   绝不静默降级为「无证据回答」。
 */
import { DocoPluginError } from './errors.js';
import { resolveMemoryConfig } from './config.js';

/** @typedef {import('./types.js').DocoService} DocoService */

/**
 * 校验 doco 服务面完整且版本兼容。
 * @param {unknown} svc
 * @returns {svc is DocoService}
 */
export function isDocoService(svc) {
  if (!svc || typeof svc !== 'object') return false;
  const s = /** @type {Record<string, unknown>} */ (svc);
  return (
    typeof s.getConfig === 'function'
    && typeof s.getClient === 'function'
    && typeof s.ensureIdentity === 'function'
    && typeof s.hasScope === 'function'
    && typeof s.toErrorValue === 'function'
    && typeof s.errorValue === 'function'
  );
}

/**
 * 装配记忆插件运行时状态。
 * @param {DocoService} doco
 * @param {ReturnType<typeof resolveMemoryConfig>} config
 */
export function createMemoryState(doco, config) {
  return {
    doco,
    config,
    /** init 成功后缓存的 manifest doc_id + kb_id（可选，加速；以 manifest 为权威） */
    memory: null,
    /** 会话内引用台账缓冲：block_id → 计数（会话结束 flush） */
    citeBuffer: new Map(),
  };
}

/**
 * apply 入口辅助：从宿主注入拿 doco 服务，缺失/不兼容抛稳定错误码。
 * @param {Record<string, unknown>} ctx 实际是 cordis Context；此处按鸭子类型访问 doco
 * @param {Record<string, unknown>} [options]
 */
export function requireDocoService(ctx, options = {}) {
  const svc = ctx?.doco;
  if (!isDocoService(svc)) {
    throw new DocoPluginError(
      'doco_memory_requires_base',
      'doco-memory-dsh 需要 doco-dsh（≥0.2.0）提供的 doco 服务，但当前不可用。请先挂载 doco-dsh，或升级其版本。',
      { required: 'doco-dsh >= 0.2.0' },
    );
  }
  return { doco: svc, config: resolveMemoryConfig(options ?? {}) };
}