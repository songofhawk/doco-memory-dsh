// @ts-check
/**
 * doco_memory_recall：记忆库内检索，自动限定当前 project + global scope，带引用返回。
 * 会话内命中（被实际用于回答）由上层调用 recordCite 计入 usage 台账。
 */
import { ensureProjectsFresh, loadManifest } from '../manifest.js';
import { recordCite } from '../usage.js';
import { normalizeKbId, textBlock, toNumInRange } from './shared.js';

/**
 * 解析当前项目（spec §4.3）：先 git remote 后路径别名；未命中返回 null。
 * 简化实现：用 manifest.projects 的 repo/aliases 匹配；匹配不到返回 null（→ 只搜 global）。
 * @param {import('../types.js').Manifest} manifest
 * @param {{ repo?: string|null; path?: string|null }} context
 */
export function resolveProject(manifest, context = {}) {
  const projects = Array.isArray(manifest.projects) ? manifest.projects : [];
  if (projects.length === 0) return null;
  const norm = (s) => String(s ?? '').replace(/^https?:\/\//, '').replace(/\.git$/, '').toLowerCase();
  if (context.repo) {
    const want = norm(context.repo);
    const hit = projects.find((p) => p.repo && norm(p.repo) === want) || projects.find((p) => (p.aliases || []).some((a) => norm(a) === want));
    if (hit) return hit;
  }
  if (context.path) {
    const want = String(context.path).toLowerCase();
    const hit = projects.find((p) => (p.aliases || []).some((a) => String(a).toLowerCase() === want || String(a).toLowerCase().includes(want)));
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {{ state: ReturnType<import('../service.js').createMemoryState>; name: string }} deps
 */
export function createDocoMemoryRecall({ state, name }) {
  return {
    name,
    description:
      '在记忆库内检索 Agent 记忆（profile/facts/episodes/runbooks），自动限定 global + 当前项目范围。' +
      ' 返回带引用（document_uri/web_url）的命中；投影不完整（complete=false）或索引过期（stale）时明确标注，' +
      ' 不得据不完整结果断言「记忆中没有」。',
    parameters: {
      q: { type: 'string', required: true, description: '回忆内容的关键词或语义描述，1–200 字符。' },
      project: { type: 'string', description: '可选：项目 key；缺省自动解析当前工作区。传 global 只搜全局记忆。' },
      limit: { type: 'integer', description: '返回条数，1–50，默认 12。' },
      cite: { type: 'boolean', description: '可选：本次命中是否计入引用台账（回答中实际引用时传 true）。' },
    },
    async execute(args) {
      const q = String(args?.q ?? '').trim();
      if (!q || q.length > 200) {
        return state.doco.errorValue('doco_memory_invalid_query', 'recall 需要 1–200 字符的查询词。', '给出更精确的记忆检索词。');
      }
      const limit = toNumInRange(args?.limit, state.config.recallLimit, 1, 50);

      // 定位记忆库
      let kbId = state.memory?.kb_id || normalizeKbId(state.config.defaultKb) || normalizeKbId(state.doco.getConfig().defaultKb);
      let manifest = state.memory?.manifest ?? null;
      if (!manifest && kbId) {
        const loaded = await loadManifest(state.doco, kbId, { manifestDocId: state.memory?.manifest_doc_id ?? null });
        if (!loaded.ok) {
          return state.doco.errorValue('doco_memory_not_initialized', '记忆库未初始化或 manifest 不可用：' + loaded.error.message, '先执行 doco_memory_init。');
        }
        manifest = loaded.manifest;
        kbId = kbId;
        state.memory = { kb_id: kbId, manifest, manifest_doc_id: loaded.doc_id };
      }
      if (!manifest || !kbId) {
        return state.doco.errorValue('doco_memory_not_initialized', '尚未初始化记忆库。', '先执行 doco_memory_init。');
      }

      // 项目解析前尽力刷新缓存（工作区自动匹配依赖最新 projects 登记）
      await ensureProjectsFresh(state, kbId);
      manifest = state.memory?.manifest ?? manifest;

      // 项目解析
      let projectKey = null;
      if (String(args?.project ?? '').toLowerCase() === 'global') {
        projectKey = 'global';
      } else if (args?.project) {
        projectKey = String(args.project);
      } else {
        const hit = resolveProject(manifest, { repo: state.context?.repo ?? null, path: state.context?.workspacePath ?? null });
        projectKey = hit?.key ?? 'global';
      }

      try {
        const resp = await state.doco.getClient().searchV2({
          q,
          knowledge_base_id: kbId,
          limit,
          mode: 'topk',
        });
        const data = resp?.data ?? {};
        const projection = data.projection ?? {};
        const results = Array.isArray(data.results) ? data.results : [];

        // scope 过滤：global 始终包含；project 命中只保留匹配项目的条目（按文档是否属于该项目 episodes/facts）
        const projectDocIds = new Set();
        if (projectKey !== 'global' && manifest) {
          const proj = (manifest.projects || []).find((p) => p.key === projectKey);
          if (proj?.episodes_doc) projectDocIds.add(proj.episodes_doc);
          if (proj?.facts_folder) projectDocIds.add(proj.facts_folder);
        }
        const globalDocIds = new Set([manifest.layout.profile.doc, manifest.layout.episodes.global_doc, manifest.layout.facts.global_folder]);

        const hits = results.filter((hit) => {
          if (projectKey === 'global') return globalDocIds.has(hit.document_id);
          return globalDocIds.has(hit.document_id) || projectDocIds.has(hit.document_id);
        }).map((hit) => ({
          document_id: hit.document_id,
          document_uri: hit.document_uri ?? null,
          web_url: hit.web_url ?? null,
          title: hit.title ?? null,
          heading_path: Array.isArray(hit.heading_path) ? hit.heading_path : [],
          block_id: hit.block_id ?? null,
          matched_in: hit.matched_in ?? null,
          context: hit.context ?? null,
          score: hit.score ?? null,
          source_version: hit.source_version ?? null,
          freshness: hit.freshness ?? null,
        }));

        // 引用台账（可选）：回答中实际引用这些命中时计一次
        if (args?.cite && hits.length > 0) {
          for (const hit of hits) {
            if (hit.block_id) recordCite(state, hit.block_id);
          }
        }

        const complete = projection.complete !== false;
        return {
          kind: 'doco_memory_recall',
          query: q,
          scope: projectKey,
          results: hits,
          projection: {
            complete,
            freshness: projection.freshness ?? 'current',
            stale_document_count: projection.stale_document_count ?? 0,
          },
          completeness: complete ? null : { code: 'doco_search_incomplete', note: '投影不完整：仅部分结果，可能遗漏记忆内容。用更精确的关键词重试。' },
        };
      } catch (error) {
        return state.doco.toErrorValue(error);
      }
    },
    render(_args, value) {
      if (value.kind === 'doco_error') return textBlock(`Doco 错误（${value.code}）：${value.message}\n下一步：${value.next_step || ''}`);
      const head = [`回忆「${value.query}」（scope=${value.scope}，${value.results.length} 条命中，complete=${value.projection.complete}）`];
      if (value.projection.stale_document_count > 0) head.push(`⚠ ${value.projection.stale_document_count} 篇文档索引待重建。`);
      if (value.completeness) head.push(`⚠ ${value.completeness.note}`);
      if (value.results.length === 0) return textBlock([...head, '无命中。'].join('\n'));
      const lines = value.results.map((hit, i) => {
        return `${i + 1}. ${hit.title ?? '(无标题)'} — ${hit.document_uri ?? hit.web_url ?? ''}`;
      });
      return textBlock([...head, ...lines].join('\n'));
    },
  };
}