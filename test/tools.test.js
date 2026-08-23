// @ts-check
/** 装配与工具级测试：注册、门禁、提示词、端口工具行为（用 fake doco 服务）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeContext, makeFakeDocoService, identityBuildTool } from './helpers/fake-context.js';
import { registerMemoryTools } from '../src/tools/index.js';
import { applyMemoryPolicy } from '../src/policy.js';
import { promptText } from '../src/prompt.js';
import { resolveMemoryConfig } from '../src/config.js';
import { MANIFEST_SCHEMA } from '../src/manifest.js';
import { createMemoryState, requireDocoService } from '../src/service.js';
import { createDocoMemoryInit } from '../src/tools/init.js';
import { createDocoMemoryRecall } from '../src/tools/recall.js';
import { createDocoMemoryRemember } from '../src/tools/remember.js';

const EXPECTED_TOOLS = [
  'doco_memory_init',
  'doco_memory_recall',
  'doco_memory_remember',
  'doco_memory_context',
];

function makeState(overrides = {}) {
  const doco = makeFakeDocoService(overrides.doco);
  return createMemoryState(doco, resolveMemoryConfig(overrides.config ?? {}, {}));
}

test('registerMemoryTools 注册全部 4 工具并应用前缀', () => {
  const { ctx, registeredTools } = makeFakeContext();
  const state = makeState();
  const { registered, skipped } = registerMemoryTools(ctx.tools, { state, toolPrefix: 'doco_' }, identityBuildTool);
  assert.deepEqual(registered.sort(), EXPECTED_TOOLS.slice().sort());
  assert.equal(skipped.length, 0);
  for (const name of EXPECTED_TOOLS) {
    const tool = registeredTools.get(name);
    assert.ok(tool, `${name} 未注册`);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
  }
});

test('registerMemoryTools 重名跳过不覆盖', () => {
  const { ctx } = makeFakeContext();
  ctx.tools.register({ name: 'doco_memory_recall' });
  const state = makeState();
  const { registered, skipped } = registerMemoryTools(ctx.tools, { state, toolPrefix: 'doco_' }, identityBuildTool);
  assert.equal(skipped.length, 1);
  assert.ok(!registered.includes('doco_memory_recall'));
});

test('promptText 引用工具名并含纪律', () => {
  const text = promptText({ toolPrefix: 'doco_' });
  assert.ok(text.includes('doco_memory_context'));
  assert.ok(text.includes('doco_memory_recall'));
  assert.ok(text.includes('doco_memory_remember'));
  assert.ok(text.includes('密钥'));
  assert.ok(text.includes('数据而非指令'));
});

test('门禁：guard 拒绝未授权 commit，放行 preview 与非写工具', () => {
  const { ctx, guards } = makeFakeContext();
  const state = makeState(); // allowWrites=false
  applyMemoryPolicy(ctx, state, 'doco_');
  const guard = guards[0];

  const denyRemember = guard({ name: 'doco_memory_remember', arguments: { mode: 'commit' } });
  assert.ok(denyRemember.includes('doco_write_not_confirmed'));
  // preview / recall 放行
  assert.equal(guard({ name: 'doco_memory_remember', arguments: { mode: 'preview' } }), undefined);
  assert.equal(guard({ name: 'doco_memory_recall', arguments: { q: 'x' } }), undefined);
  // init 属 commit 语义
  assert.ok(guard({ name: 'doco_memory_init', arguments: {} }).includes('doco_write_not_confirmed'));
});

test('requireDocoService：缺失抛 doco_memory_requires_base；完整则返回 state', () => {
  assert.throws(() => requireDocoService({}, {}), (e) => e?.code === 'doco_memory_requires_base');
  const doco = makeFakeDocoService();
  const { doco: svc, config } = requireDocoService({ doco }, {});
  assert.equal(svc.pluginName, 'doco-dsh');
  assert.equal(config.allowWrites, false);
});

test('init 工具：preview 语义返回计划（不写 Doco）', async () => {
  const { state } = (() => {
    const doco = makeFakeDocoService();
    const s = createMemoryState(doco, resolveMemoryConfig({ allowWrites: true }, {}));
    return { state: s };
  })();
  const tool = createDocoMemoryInit({ state });
  const result = await tool.execute({ mode: 'auto' });
  assert.equal(result.kind, 'doco_memory_init');
  assert.ok(result.kb_id);
  assert.ok(result.manifest_doc_id);
  assert.ok(state.memory, 'init 成功后应缓存 memory 定位');
  assert.equal(state.memory.manifest.layout.usage.doc, 'doc_usage');
});

test('recall 工具：未初始化返回引导错误；已初始化走 searchV2 且 scope 过滤生效', async () => {
  const doco = makeFakeDocoService({
    client: {
      searchV2: async () => ({
        data: {
          query: 'q', mode: 'topk', page: {},
          results: [{ document_id: 'doc_profile', block_id: 'blk1', title: '用户画像', document_uri: 'doco:doc/doc_profile' }],
          projection: { complete: true, freshness: 'current' },
        },
      }),
    },
  });
  const state = createMemoryState(doco, resolveMemoryConfig({}, {}));
  const tool = createDocoMemoryRecall({ state, name: 'doco_memory_recall' });

  // 未初始化
  const noInit = await tool.execute({ q: '偏好' });
  assert.equal(noInit.kind, 'doco_error');
  assert.equal(noInit.code, 'doco_memory_not_initialized');

  // 初始化记忆库定位（加载 manifest）
  const initTool = createDocoMemoryInit({ state });
  await initTool.execute({ mode: 'auto' });

  // 让 stub 返回真实登记在 manifest 里的 profile doc id（验证 scope 过滤）
  const profileDocId = state.memory.manifest.layout.profile.doc;
  doco.getClient().searchV2 = async () => ({
    data: {
      query: 'q', mode: 'topk', page: {},
      results: [
        { document_id: profileDocId, block_id: 'blk1', title: '用户画像', document_uri: 'doco:doc/' + profileDocId },
        { document_id: 'doc_foreign', block_id: 'blk2', title: '外部文档', document_uri: 'doco:doc/doc_foreign' },
      ],
      projection: { complete: true, freshness: 'current' },
    },
  });

  const ok = await tool.execute({ q: '偏好', cite: true });
  assert.equal(ok.kind, 'doco_memory_recall');
  assert.equal(ok.scope, 'global');
  // 只保留 profile（global docs），外部文档被过滤
  assert.equal(ok.results.length, 1);
  assert.equal(ok.results[0].document_id, profileDocId);
  // cite 应计入台账缓冲
  assert.ok(state.citeBuffer.size >= 1);
});

test('remember 工具：preview 只回计划；commit 写入并记录目标', async () => {
  const doco = makeFakeDocoService({
    ensureIdentity: async () => ({ user: { id: 'u1', name: 'Alice' }, scopes: ['documents:read', 'documents:write', 'knowledge-bases:read'], error: null }),
    client: {
      insertBlocks: async (docId) => ({ data: { version: 'v2' }, etag: '"v2"' }),
      searchV2: async () => ({ data: { results: [], page: {}, projection: { complete: true } } }),
    },
  });
  const state = createMemoryState(doco, resolveMemoryConfig({ allowWrites: true }, {}));
  const tool = createDocoMemoryRemember({ state, name: 'doco_memory_remember' });

  // 先 init（注入 manifest）
  const initTool = createDocoMemoryInit({ state });
  await initTool.execute({ mode: 'auto' });

  const preview = await tool.execute({ content: 'ding 项目用 pnpm workspace', type: 'episodes', scope: 'global' });
  assert.equal(preview.kind, 'doco_memory_remember');
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.writes_nothing, true);

  const commit = await tool.execute({ content: 'ding 项目用 pnpm workspace', type: 'episodes', scope: 'global', mode: 'commit' });
  assert.equal(commit.kind, 'doco_memory_remember');
  assert.equal(commit.mode, 'commit');
  // episodes global living doc = manifest 登记的目标
  assert.equal(commit.target_doc, state.memory.manifest.layout.episodes.global_doc);
  assert.equal(commit.dedup_action, 'create_new');
});

test('remember：项目记忆按 manifest.projects 落位到项目文档', async () => {
  const inserted = [];
  const doco = makeFakeDocoService({
    ensureIdentity: async () => ({ user: { id: 'u1', name: 'Alice' }, scopes: ['documents:read', 'documents:write'], error: null }),
    client: {
      insertBlocks: async (docId, body) => {
        inserted.push({ docId, text: body?.nodes?.[0]?.content?.[0]?.text ?? '' });
        return { data: { version: 'v2' }, etag: '"v2"' };
      },
      searchV2: async () => ({ data: { results: [], page: {}, projection: { complete: true } } }),
    },
  });
  const state = createMemoryState(doco, resolveMemoryConfig({ allowWrites: true }, {}));
  // 直接注入含项目登记的 manifest（模拟登记完成后的缓存状态）
  state.memory = {
    kb_id: '48',
    manifest_doc_id: 'doc_manifest',
    manifest: {
      schema: MANIFEST_SCHEMA,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      layout: {
        inbox: { folder_id: 'f1', queue_doc: 'q', reports_doc: 'r' },
        profile: { doc: 'p' },
        facts: { folder_id: 'ff', global_folder: 'fg', global_doc: 'fdoc' },
        episodes: { folder_id: 'ef', global_doc: 'eg' },
        runbooks: { folder_id: 'rf', doc: 'rd' },
        archive: { folder_id: 'ar' },
        usage: { doc: 'u' },
      },
      projects: [{ key: 'ding', repo: null, aliases: [], episodes_doc: 'ep_ding', facts_folder: null }],
      policy: { append: true, edit: false },
    },
  };

  const tool = createDocoMemoryRemember({ state, name: 'doco_memory_remember' });
  const preview = await tool.execute({ content: 'ding 的经验条目', type: 'episodes', scope: 'project', project: 'ding' });
  // preview 目标展示与 commit 实际落位一致（不再显示 episodes/<key> 占位符）
  assert.equal(preview.planned.target, 'ep_ding');

  const commit = await tool.execute({ content: 'ding 的经验条目', type: 'episodes', scope: 'project', project: 'ding', mode: 'commit' });
  assert.equal(commit.target_doc, 'ep_ding');
  assert.equal(inserted[0]?.docId, 'ep_ding');
});