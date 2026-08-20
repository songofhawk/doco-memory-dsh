// @ts-check
/** 模块级单测：manifest / usage / config / provisioning 纯函数。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_SCHEMA, META_FOLDER_NAME, MANIFEST_TITLE,
  extractJsonCodeBlock, parseManifest, manifestToMarkdown,
} from '../src/manifest.js';
import {
  USAGE_SCHEMA, parseUsageDoc, recordCite, loadUsage,
} from '../src/usage.js';
import { resolveMemoryConfig } from '../src/config.js';
import { buildEntryNode } from '../src/tools/remember.js';
import { makeFakeDocoService, makeFakeContext } from './helpers/fake-context.js';
import { createMemoryState } from '../src/service.js';
import { apply } from '../src/index.js';

test('extractJsonCodeBlock 只取第一个 json code block', () => {
  const md = '说明\n```json\n{"schema":"doco-memory/1"}\n```\n更多';
  assert.equal(JSON.parse(extractJsonCodeBlock(md)).schema, 'doco-memory/1');
  assert.equal(extractJsonCodeBlock('no code block'), null);
});

test('parseManifest 校验主版本、容忍未知字段', () => {
  const ok = parseManifest({ schema: MANIFEST_SCHEMA, layout: {}, projects: [], policy: {} });
  assert.equal(ok.ok, true);
  const badMajor = parseManifest({ schema: 'doco-memory/2', layout: {}, projects: [], policy: {} });
  assert.equal(badMajor.ok, false);
  const noSchema = parseManifest({ layout: {} });
  assert.equal(noSchema.ok, false);
});

test('manifestToMarkdown 可往返', () => {
  const manifest = {
    schema: MANIFEST_SCHEMA, created_at: 'x', updated_at: 'x',
    layout: { inbox: { folder_id: '1', queue_doc: 'd1', reports_doc: 'd2' }, profile: { doc: 'd3' }, facts: { folder_id: '2', global_folder: '3' }, episodes: { folder_id: '4', global_doc: 'd5' }, runbooks: { folder_id: '5' }, archive: { folder_id: '6' }, usage: { doc: 'd7' } },
    projects: [], policy: { append: true, edit: false },
  };
  const md = manifestToMarkdown(manifest);
  const parsed = parseManifest(JSON.parse(extractJsonCodeBlock(md)));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.layout.inbox.queue_doc, 'd1');
});

test('usage：parse / record / load 合并缓冲', async () => {
  const doco = makeFakeDocoService();
  const state = createMemoryState(doco, resolveMemoryConfig({}, {}));
  recordCite(state, 'blk_1');
  recordCite(state, 'blk_1');
  recordCite(state, 'blk_2');

  const loaded = await loadUsage(state, 'doc_usage');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.doc.cites.blk_1.count, 2);
  assert.equal(loaded.doc.cites.blk_2.count, 1);
  assert.equal(loaded.doc.schema, USAGE_SCHEMA);
});

test('buildEntryNode 带元信息前缀', () => {
  const node = buildEntryNode({ content: 'ding', date: '2026-08-20', scope: 'global', source: 's1' });
  assert.equal(node.type, 'paragraph');
  assert.ok(node.content[0].text.startsWith('[2026-08-20 | global | s1]'));
});

test('config：默认值与 env 优先级', () => {
  const cfg = resolveMemoryConfig({}, { DOCO_MEMORY_KB: 'kb9', DOCO_MEMORY_KB_NAME: '我的记忆' });
  assert.equal(cfg.defaultKb, 'kb9');
  assert.equal(cfg.kbName, '我的记忆');
  const def = resolveMemoryConfig({}, {});
  assert.equal(def.kbName, 'Agent Memory');
  assert.equal(def.allowWrites, false);
  assert.equal(def.recallLimit, 12);
});

test('helpers：fake context 支持 provide 与 session/end', () => {
  const { ctx, providedServices, sessionEndHandlers } = makeFakeContext();
  const dispose = ctx.provide('x', 1);
  assert.equal(providedServices.get('x'), 1);
  dispose();
  assert.ok(!providedServices.has('x'));
  ctx.on('session/end', () => {});
  assert.equal(sessionEndHandlers.length, 1);
});

test('入口常量与依赖校验达意', () => {
  assert.equal(META_FOLDER_NAME, '_meta');
  assert.equal(MANIFEST_TITLE, 'manifest');
  // apply 需要 doco 服务：fake ctx 无 doco 时应抛稳定错误码
  const { ctx } = makeFakeContext();
  assert.throws(() => apply(ctx, {}), (e) => e?.code === 'doco_memory_requires_base' || e?.code === 'doco_memory_incompatible');
});