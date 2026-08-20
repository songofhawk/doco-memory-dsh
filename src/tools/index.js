// @ts-check
/**
 * 工具注册装配（对齐 doco-dsh 的 tools/index.js 形态）。
 * 用 buildTool（真实 dsh 的 defineTool 或测试注入的 identity）包装各工具工厂，
 * 统一补 output.schema=OPEN_OBJECT 与 (args, value) render，重名时跳过不覆盖。
 */
import { createDocoMemoryInit } from './init.js';
import { createDocoMemoryRecall } from './recall.js';
import { createDocoMemoryRemember } from './remember.js';
import { createDocoMemoryContext } from './context.js';
import { OPEN_OBJECT } from './shared.js';

const DUPLICATE_RE = /is already registered/i;

/**
 * @param {{
 *   register(def: unknown): () => void;
 *   get?(name: string): unknown;
 * }} ctxTools
 * @param {{ state: ReturnType<import('../service.js').createMemoryState>; toolPrefix?: string }} deps
 * @param {(def: Record<string, unknown>) => unknown} buildTool
 * @param {{ log?(message: string): void }} [hooks]
 * @returns {{ registered: string[]; skipped: { name: string; reason: string }[]; disposers: (() => void)[] }}
 */
export function registerMemoryTools(ctxTools, deps, buildTool, hooks = {}) {
  const state = deps.state;
  const name = (base) => `${deps.toolPrefix ?? 'doco_'}${base}`;

  const factories = [
    createDocoMemoryInit,
    createDocoMemoryRecall,
    createDocoMemoryRemember,
    createDocoMemoryContext,
  ];

  const registered = [];
  const skipped = [];
  const disposers = [];

  for (const factory of factories) {
    const base = factoryBaseName(factory);
    const def = factory({ state, name: name(base) });
    const tool = buildTool({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: { schema: OPEN_OBJECT, render: def.render },
      execute: def.execute,
    });
    try {
      disposers.push(ctxTools.register(tool));
      registered.push(def.name);
    } catch (error) {
      if (DUPLICATE_RE.test(String(error?.message ?? ''))) {
        skipped.push({ name: def.name, reason: String(error.message) });
        if (hooks.log) hooks.log(`doco-memory-dsh: 跳过重复工具 ${def.name}`);
      } else {
        throw error;
      }
    }
  }

  return { registered, skipped, disposers };
}

/** 从工厂函数推基名（createDocoMemoryInit → memory_init）。 */
function factoryBaseName(factory) {
  const raw = factory.name.replace(/^createDocoMemory/, '');
  return 'memory_' + raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export { createDocoMemoryInit, createDocoMemoryRecall, createDocoMemoryRemember, createDocoMemoryContext };
export { OPEN_OBJECT };