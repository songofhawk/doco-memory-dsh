// @ts-check
/**
 * 真实 dsh 冒烟：用安装好的 @deepseek-ai/dsh-tools 的 defineTool /
 * valueSchemaSpecToJsonSchema / validateArgs 校验本插件的 schema DSL，
 * 对齐 doco-dsh 的 dsh-smoke 测试（不猜 dsh API，直接对真实运行时）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineTool, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import { registerMemoryTools, OPEN_OBJECT } from '../src/tools/index.js';
import { makeFakeContext, makeFakeDocoService } from './helpers/fake-context.js';
import { createMemoryState } from '../src/service.js';
import { resolveMemoryConfig } from '../src/config.js';

function makeState() {
  return createMemoryState(makeFakeDocoService(), resolveMemoryConfig({}, {}));
}

test('真实 defineTool 接受并编译全部 4 个记忆工具', () => {
  const { ctx } = makeFakeContext();
  const state = makeState();
  const { registered, skipped } = registerMemoryTools(ctx.tools, { state, toolPrefix: 'doco_' }, defineTool);
  assert.equal(registered.length, 4);
  assert.equal(skipped.length, 0);

  for (const name of registered) {
    const tool = ctx.tools.get(name);
    assert.equal(tool.name, name);
    assert.equal(tool.parameters?.type, 'object');
    assert.equal(tool.output?.schema?.type, 'object');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output?.render, 'function');
  }
});

test('真实 defineTool 的 execute 按 schema 校验：合法参数通过、缺必填抛 ToolArgsError', async () => {
  const { ctx } = makeFakeContext();
  const state = makeState();
  registerMemoryTools(ctx.tools, { state, toolPrefix: 'doco_' }, defineTool);

  const recall = ctx.tools.get('doco_memory_recall');
  // 合法参数（q 必填）→ 正常执行路径（缺 kb → 返回引导错误而非类型错误）
  const ok = await recall.execute({ q: '偏好' });
  assert.ok(ok.kind === 'doco_memory_recall' || ok.kind === 'doco_error');

  // 缺 q → defineTool 按 DSL 必填约束抛 ToolArgsError
  await assert.rejects(
    () => ctx.tools.get('doco_memory_recall').execute({}),
    (e) => e?.name === 'ToolArgsError',
  );

  // remember 缺 content 同理
  await assert.rejects(
    () => ctx.tools.get('doco_memory_remember').execute({ type: 'episodes' }),
    (e) => e?.name === 'ToolArgsError',
  );
});

test('OPEN_OBJECT 编译为开放对象且 defineTool 的 output 可渲染', () => {
  const compiled = valueSchemaSpecToJsonSchema(OPEN_OBJECT);
  assert.equal(compiled.type, 'object');
  assert.equal(compiled.additionalProperties, true);

  const { ctx } = makeFakeContext();
  const state = makeState();
  registerMemoryTools(ctx.tools, { state, toolPrefix: 'doco_' }, defineTool);
  const init = ctx.tools.get('doco_memory_init');
  // render 以 (args, value) 两参调用（dsh 0.1.4 回归修复点）
  const rendered = init.output.render({}, { kind: 'doco_error', code: 'x', message: 'm', next_step: 'n' });
  assert.ok(Array.isArray(rendered) && rendered[0]?.type === 'text');
});