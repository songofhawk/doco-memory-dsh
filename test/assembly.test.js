// @ts-check
/**
 * 装配冒烟：真实 cordis Context 上同挂 doco-dsh + doco-memory-dsh，
 * 验证 `inject: ['doco']` 的依赖解析、doco 服务提供、工具注册与门禁挂载真实可用。
 *
 * 注意：doco-dsh apply 需要 dsh-tools 的 defineTool 与 dsh 宿主（tools/systemPrompt 服务），
 * 此处用最小桩模拟宿主面（对齐 doco-dsh 自身 integration 测试），验证重点是
 * cordis inject 依赖调度（doco 服务在 doco-dsh 装配后可用 → memory 插件才会启动）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
// file: 链接的 doco-dsh（devDependency）——相对路径导入绕过 exports 子路径限制
import * as docoDsh from '../node_modules/doco-dsh/src/index.js';
import * as docoMemory from '../src/index.js';
import { isDocoService } from '../src/service.js';

/** 最小宿主桩：tools / commands / systemPrompt 三个服务面。 */
function makeHostContext() {
  const ctx = new Context();
  ctx.plugin({
    name: 'dsh-host-min',
    inject: [],
    apply(ctx) {
      const registered = new Map();
      ctx.provide('tools', {
        register(tool) {
          if (registered.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
          registered.set(tool.name, tool);
          return () => registered.delete(tool.name);
        },
        get(name) { return registered.get(name); },
        guard() { return () => {}; },
      });
      ctx.provide('systemPrompt', {
        section() { return () => {}; },
      });
      ctx.provide('commands', {
        register() { return () => {}; },
      });
      return registered;
    },
  });
  return ctx;
}

test('真实 cordis：doco 服务随 doco-dsh 装配可用，memory 插件依赖解析并注册 4 工具', async () => {
  const ctx = makeHostContext();
  // 挂 doco-dsh（provide 'doco'）
  ctx.plugin(docoDsh, {});
  // 挂 memory 插件（inject: ['doco'] → 等 doco 服务就绪）
  ctx.plugin(docoMemory, {});

  // cordis 4：注册即启动（effect 同步消费），无需 start()。
  // 事件循环驱动的异步（fiber 内 await）用 setTimeout 让出微任务。
  await new Promise((resolve) => setTimeout(resolve, 20));

  // doco 服务真实可用
  const svc = ctx.doco;
  assert.ok(isDocoService(svc), 'doco 服务应可被 memory 插件消费');

  // 内存工具（真实 defineTool 注册）
  const toolNames = ['doco_memory_init', 'doco_memory_recall', 'doco_memory_remember', 'doco_memory_context'];
  for (const name of toolNames) {
    const tool = ctx.tools.get(name);
    assert.ok(tool, `${name} 应已注册`);
    assert.equal(typeof tool.execute, 'function');
  }
});

test('真实 cordis：缺 doco-dsh 时 memory 插件保持待命（工具未注册，不静默降级）', async () => {
  const ctx = makeHostContext();
  // 不挂 doco-dsh：memory 插件的 inject:['doco'] 依赖缺失，
  // cordis 让插件保持挂起（等待 doco 服务），而非立即执行 apply。
  let threw = null;
  try {
    ctx.plugin(docoMemory, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
  } catch (error) {
    threw = error;
  }
  // 两种合法行为：抛稳定错误码（若立即执行），或保持待命不注册工具（cordis 依赖调度）。
  if (threw) {
    const message = String(threw?.message ?? '');
    const ok = threw?.code === 'doco_memory_requires_base' || message.includes('doco_memory_requires_base') || /doco/.test(message);
    assert.ok(ok, `错误应带 doco_memory 信号，got: ${message}`);
  } else {
    // 待命：工具未注册（requiring doco 服务，不静默提供降级能力）
    assert.equal(ctx.tools.get('doco_memory_init'), undefined, '依赖未满足时不应注册写记忆工具');
    assert.equal(ctx.tools.get('doco_memory_recall'), undefined, '依赖未满足时不应注册读记忆工具');
  }
});