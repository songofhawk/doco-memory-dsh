// @ts-check
/**
 * 写入门禁（对齐 doco-dsh policy.js 三层防御）：
 *   1. ctx.tools.guard —— allowWrites 未开时，commit 类调用单调拒绝；
 *   2. ctx.on('tools/pre-execute') —— 校验 documents:write scope 后 ask 用户确认；
 *   3. 工具 execute 内防御性校验（remember/init 已内置）。
 *
 * 写工具集合：doco_memory_init（commit 语义=实际执行 provision）、doco_memory_remember（commit）。
 */

/** 记忆插件的写工具名（commit 触发审批）。 */
export function memoryWriteTools(toolPrefix = 'doco_') {
  return [`${toolPrefix}memory_init`, `${toolPrefix}memory_remember`];
}

/**
 * 是否为需要审批的 commit 调用。
 * @param {{ name?: string; arguments?: unknown } | null | undefined} exec
 * @param {string} toolPrefix
 */
export function isCommitCall(exec, toolPrefix) {
  if (!exec || typeof exec !== 'object') return false;
  const writes = memoryWriteTools(toolPrefix);
  // init 全部执行都算 commit（无 preview 语义的独立动作）；remember 仅 mode=commit
  if (exec.name === `${toolPrefix}memory_init`) return true;
  if (exec.name === `${toolPrefix}memory_remember`) {
    const args = exec.arguments;
    return Boolean(args && typeof args === 'object' && args.mode === 'commit');
  }
  return false;
}

/**
 * 同步 guard：allowWrites 未开启时拒绝 commit。
 * @param {{ name?: string; arguments?: unknown }} exec
 * @param {{ config: { allowWrites?: boolean } }} state
 * @param {string} toolPrefix
 */
export function writeGuard(exec, state, toolPrefix) {
  if (!isCommitCall(exec, toolPrefix)) return undefined;
  if (state.config?.allowWrites !== true) {
    return 'doco_write_not_confirmed：记忆写入未被允许（默认只读）。请在 dsh 审批中确认，或配置 DOCO_MEMORY_ALLOW_WRITES=true。';
  }
  return undefined;
}

/**
 * pre-execute 决策：scope 校验 + 用户确认。
 * @param {{ name?: string; arguments?: unknown }} exec
 * @param {() => Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }>} next
 * @param {ReturnType<import('../service.js').createMemoryState>} state
 * @param {string} toolPrefix
 */
export async function preExecuteDecision(exec, next, state, toolPrefix) {
  if (!isCommitCall(exec, toolPrefix)) return next();

  if (state.config?.allowWrites !== true) {
    return { kind: 'deny', reason: 'doco_write_not_confirmed：记忆写入未获确认（默认只读）。' };
  }

  let scopes = [];
  try {
    const identity = await state.doco.ensureIdentity();
    scopes = Array.isArray(identity?.scopes) ? identity.scopes : [];
  } catch { /* 放行到 execute 防御性校验 */ }

  if (!state.doco.hasScope(scopes, 'documents:write')) {
    return { kind: 'deny', reason: 'doco_write_scope_required：当前 Token 无 documents:write 权限。请重新 /doco connect --access read_write。' };
  }

  const args = exec.arguments || {};
  const what = exec.name === `${toolPrefix}memory_init`
    ? `初始化记忆库（${String(args?.mode ?? 'auto')}）`
    : `沉淀记忆：${String(args?.content ?? '').slice(0, 40)}${String(args?.content ?? '').length > 40 ? '…' : ''}`;
  return { kind: 'ask', reason: `确认记忆写入：${what}？` };
}

/**
 * 装配 guard 与 pre-execute，返回 disposers。
 * @param {{ tools: { guard(g: (...a: unknown[]) => string | undefined): () => void }; on(ev: string, cb: (...a: any[]) => unknown): () => void }} ctx
 * @param {ReturnType<import('../service.js').createMemoryState>} state
 * @param {string} toolPrefix
 * @returns {(() => void)[]}
 */
export function applyMemoryPolicy(ctx, state, toolPrefix) {
  const disposers = [];
  disposers.push(ctx.tools.guard((exec) => writeGuard(exec, state, toolPrefix)));
  disposers.push(ctx.on('tools/pre-execute', (exec, next) => preExecuteDecision(exec, next, state, toolPrefix)));
  return disposers;
}