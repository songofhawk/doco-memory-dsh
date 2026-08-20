// @ts-check
/**
 * doco_memory_remember：沉淀一条记忆（Doco Memory Layout spec v1 §6、§8）。
 * 流程：写前查重（recall）→ 命中建议更新既有块 / 未命中按 type+scope 落位 → preview → commit。
 * 支持 promote 参数（project→global 升级，spec §10 触发 A）。
 * 条目文本带元信息前缀：[日期 | 项目 | 来源]。
 */
import { loadManifest } from '../manifest.js';
import { recordCite } from '../usage.js';
import { errorValue, toErrorValue } from '../errors.js';
import { normalizeKbId, textBlock, toString } from './shared.js';

const TYPES = ['profile', 'facts', 'episodes', 'runbooks'];
const SCOPES = ['global', 'project'];

/**
 * 构造条目节点（Tiptap paragraph，带元信息前缀）。
 * @param {{ content: string; date: string; scope: string; source: string }} p
 */
export function buildEntryNode(p) {
  const prefix = `[${p.date} | ${p.scope} | ${p.source}] `;
  return { type: 'paragraph', content: [{ type: 'text', text: prefix + p.content }] };
}

/**
 * @param {{ state: ReturnType<import('../service.js').createMemoryState>; name: string }} deps
 */
export function createDocoMemoryRemember({ state, name }) {
  return {
    name,
    description:
      '把 Agent 会话中的结论/决策/教训沉淀为一条记忆（spec v1 §6/§8）。' +
      ' 写前自动查重：命中既有块则建议修订（policy.edit 开启时更新，否则在审阅队列提示）；' +
      ' 未命中则按 type+scope 落到对应位置。promote 参数把 project 记忆升级为 global（触发 A）。' +
      ' 所有写入需 documents:write + 用户确认；只新增/修订，绝不删除或整篇覆盖。',
    parameters: {
      content: { type: 'string', required: true, description: '记忆内容（结论式一句话，不含密钥/口令/私密原文）。' },
      type: { type: 'string', enum: TYPES, description: '默认 episodes。' },
      scope: { type: 'string', enum: SCOPES, description: '默认 project（当前项目）；global 为全项目共享。' },
      project: { type: 'string', description: '可选：目标项目 key（scope=project 时）。缺省自动解析当前工作区。' },
      source: { type: 'string', description: '可选：来源标识（会话 id、讨论链接），写入条目元信息。' },
      promote: { type: 'boolean', description: '可选：把本条目同时作为 global fact 沉淀（spec §10 触发 A，需查重）。' },
      mode: { type: 'string', enum: ['preview', 'commit'], description: '默认 preview：只返回计划不写入。' },
    },
    async execute(args) {
      const content = String(args?.content ?? '').trim();
      if (!content || content.length > 4000) {
        return errorValue('doco_memory_invalid_content', '记忆内容需为 1–4000 字符。', '精简为结论式一句话。');
      }
      const type = TYPES.includes(args?.type) ? String(args.type) : 'episodes';
      const scopeRaw = SCOPES.includes(args?.scope) ? String(args.scope) : 'project';
      const mode = args?.mode === 'commit' ? 'commit' : 'preview';
      const source = toString(args?.source, '');
      const promote = args?.promote === true;

      // 定位记忆库 + manifest
      let kbId = state.memory?.kb_id || normalizeKbId(state.config.defaultKb) || normalizeKbId(state.doco.getConfig().defaultKb);
      let manifest = state.memory?.manifest ?? null;
      if (!manifest && kbId) {
        const loaded = await loadManifest(state.doco, kbId, { manifestDocId: state.memory?.manifest_doc_id ?? null });
        if (!loaded.ok) return state.doco.toErrorValue(loaded.error);
        manifest = loaded.manifest;
        state.memory = { kb_id: kbId, manifest, manifest_doc_id: loaded.doc_id };
      }
      if (!manifest || !kbId) {
        return errorValue('doco_memory_not_initialized', '尚未初始化记忆库。', '先执行 doco_memory_init。');
      }

      // 项目解析
      let projectKey = null;
      if (scopeRaw === 'global') projectKey = 'global';
      else if (args?.project) projectKey = String(args.project);
      else projectKey = 'global'; // 未解析出项目时 fallback global（避免写到无处）

      // ---- 写前查重（spec §8.1）----
      let dupes = [];
      try {
        const dupResp = await state.doco.getClient().searchV2({
          q: content.slice(0, 120),
          knowledge_base_id: kbId,
          limit: 5,
          mode: 'topk',
        });
        dupes = (dupResp?.data?.results ?? []).filter((h) => h?.document_id && h?.block_id);
      } catch { /* 查重失败不阻塞：仍按未命中处理，宁多勿漏 */ }

      // ---- preview 计划（绝不写入）----
      const date = new Date().toISOString().slice(0, 10);
      const plan = {
        content,
        type,
        scope: projectKey,
        source,
        target: describeTarget(manifest, type, projectKey),
        dedup: dupes.length > 0
          ? { hits: dupes.map((d) => ({ document_id: d.document_id, block_id: d.block_id, title: d.title, context: d.context?.match ?? null })), action: 'update_existing_or_queue' }
          : { hits: [], action: 'create_new' },
        promote: promote ? { to: manifest.layout.facts.global_folder, action: 'add_global_fact' } : false,
      };
      if (mode === 'preview') {
        return { kind: 'doco_memory_remember', mode: 'preview', planned: plan, writes_nothing: true, note: '预览通过。commit 会经用户确认后写入。' };
      }

      // ---- commit 门禁（防御性；正常应已由 policy 拦截/审批）----
      if (!state.config.allowWrites) {
        return errorValue('doco_write_not_confirmed', '写入未获确认（allowWrites 未开启）。', '在 dsh 审批中确认写入，或配置 DOCO_MEMORY_ALLOW_WRITES=true。');
      }
      const identity = await state.doco.ensureIdentity();
      if (!state.doco.hasScope(identity.scopes, 'documents:write')) {
        return errorValue('doco_write_scope_required', '当前 Token 无 documents:write 权限。', '重新 /doco connect --access read_write。');
      }

      try {
        // 目标文档：episodes → 对应 living doc；facts → facts/global 或项目文件夹（创建文档）；profile/runbooks → profile/runbooks。
        const targetDocId = resolveTargetDocId(manifest, type, projectKey);
        const node = buildEntryNode({ content, date, scope: projectKey, source });

        const resp = await state.doco.getClient().insertBlocks(targetDocId, {
          position: { document_end: true },
          nodes: [node],
        });
        const version = resp?.etag ?? resp?.data?.version ?? null;

        // 升级（promote）：在 facts/global living doc 追加一条带来源链接的事实
        let promoted = null;
        if (promote) {
          const globalFactsDoc = state.memory.manifest.layout.facts.global_doc ?? state.memory.manifest.layout.facts.global_folder;
          const factNode = buildEntryNode({ content, date, scope: 'global', source: source || `promoted from ${targetDocId}` });
          const factResp = await state.doco.getClient().insertBlocks(
            globalFactsDoc,
            { position: { document_end: true }, nodes: [factNode] },
          );
          promoted = { target: globalFactsDoc, version: factResp?.etag ?? null };
        }

        // 记录引用（本条内容若含对既有块的引用则计入台账）
        if (dupes.length > 0 && args?.promote !== true) {
          for (const d of dupes) if (d.block_id) recordCite(state, d.block_id);
        }

        return {
          kind: 'doco_memory_remember',
          mode: 'commit',
          content,
          type,
          scope: projectKey,
          target_doc: targetDocId,
          version,
          dedup_action: dupes.length > 0 ? 'update_existing_or_queue' : 'create_new',
          promote: promoted,
          created: true,
        };
      } catch (error) {
        return toErrorValue(error);
      }
    },
    render(_args, value) {
      if (value.kind === 'doco_error') return textBlock(`Doco 错误（${value.code}）：${value.message}\n下一步：${value.next_step || ''}`);
      if (value.mode === 'preview') {
        const p = value.planned;
        return textBlock(
          `记忆沉淀预览（未写入）\n类型：${p.type} · 范围：${p.scope}\n内容：${p.content}\n` +
          `目标：${p.target}\n查重：${p.dedup.hits.length > 0 ? `命中 ${p.dedup.hits.length} 条 → ${p.dedup.action}` : '无命中 → 新建'}\n` +
          `升级：${p.promote ? '是（global facts）' : '否'}\n${value.note}`,
        );
      }
      return textBlock(
        `记忆已沉淀（${value.type} @ ${value.scope}）\n目标：${value.target_doc}\n查重动作：${value.dedup_action}${value.promote ? '\n已升级 global facts' : ''}\nversion：${value.version ?? '?'}`,
      );
    },
  };
}

/** @param {import('../types.js').Manifest} manifest @param {string} type @param {string} projectKey */
function describeTarget(manifest, type, projectKey) {
  if (type === 'episodes') return projectKey === 'global' ? manifest.layout.episodes.global_doc : `episodes/<${projectKey}>`;
  if (type === 'facts') return manifest.layout.facts.global_doc ?? 'facts/global';
  if (type === 'profile') return manifest.layout.profile.doc;
  if (type === 'runbooks') return manifest.layout.runbooks.doc ?? 'runbooks';
  return '(未知)';
}

/** @param {import('../types.js').Manifest} manifest @param {string} type @param {string} projectKey */
function resolveTargetDocId(manifest, type, projectKey) {
  if (type === 'episodes') {
    if (projectKey !== 'global') {
      const proj = (manifest.projects || []).find((p) => p.key === projectKey);
      if (proj?.episodes_doc) return proj.episodes_doc;
    }
    return manifest.layout.episodes.global_doc;
  }
  if (type === 'profile') return manifest.layout.profile.doc;
  if (type === 'facts') return manifest.layout.facts.global_doc ?? manifest.layout.facts.global_folder;
  if (type === 'runbooks') return manifest.layout.runbooks.doc ?? manifest.layout.runbooks.folder_id;
  return manifest.layout.episodes.global_doc;
}