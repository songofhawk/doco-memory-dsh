// @ts-check
/**
 * doco-memory-dsh 插件入口。
 * 依赖 doco-dsh 的 `doco` 服务（inject: ['doco']）。依赖缺失/版本不兼容 →
 * 装配期抛 `doco_memory_requires_base`，不静默降级。
 */
import { DocoPluginError } from './errors.js';
import { createMemoryState, requireDocoService } from './service.js';
import { registerMemoryTools } from './tools/index.js';
import { applyMemoryPolicy } from './policy.js';
import { promptText, PROMPT_SECTION_NAME } from './prompt.js';
import { flushUsage } from './usage.js';

export const name = 'doco-memory-dsh';
export const inject = ['doco', 'tools', 'systemPrompt'];
export const pluginVersion = '0.1.0';

let defineTool;
let incompatibility = null;
try {
  const dshTools = await import('@deepseek-ai/dsh-tools');
  defineTool = dshTools?.defineTool;
} catch (error) {
  incompatibility = error;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [options]
 */
export function apply(ctx, options = {}) {
  if (typeof defineTool !== 'function') {
    const cause = incompatibility?.message ? `（${incompatibility.message}）` : '';
    throw new DocoPluginError(
      'doco_memory_incompatible',
      `doco-memory-dsh 需要的 @deepseek-ai/dsh-tools 不可用或版本不兼容${cause}。`,
      { required: '@deepseek-ai/dsh-tools >= 0.1.0-rc.7' },
    );
  }

  const { doco, config } = requireDocoService(ctx, options ?? {});
  const state = createMemoryState(doco, config);
  const toolPrefix = doco.toolPrefix ?? 'doco_';
  const log = (m) => { try { ctx.logger?.warn?.(m); } catch { /* 诊断日志失败不阻塞 */ } };

  ctx.effect(function* () {
    // 1. 工具
    const { disposers, skipped } = registerMemoryTools(ctx.tools, { state, toolPrefix }, defineTool, { log });
    for (const skip of skipped) log(`doco-memory-dsh: 未注册 ${skip.name}（已存在同名工具）`);
    for (const dispose of disposers) yield dispose;

    // 2. 写入门禁（guard + pre-execute ask）
    for (const dispose of applyMemoryPolicy(ctx, state, toolPrefix)) yield dispose;

    // 3. 系统提示词档案段（仅规则，无内容）
    yield ctx.systemPrompt.section({ name: PROMPT_SECTION_NAME, order: 420, text: promptText({ toolPrefix }) });

    // 4. 会话结束 flush 引用台账（best-effort；不阻塞退出）
    const flushDisposer = ctx.on('session/end', () => {
      flushUsage(state).catch(() => { /* best-effort */ });
    });
    yield flushDisposer;
  }, 'doco-memory-dsh lifecycle');
}

export { createMemoryState, requireDocoService, registerMemoryTools, applyMemoryPolicy, promptText, flushUsage };