// @ts-check
/**
 * doco_memory_context：当前项目上下文包。
 * 读取 profile（用户画像）+ 当前项目 episodes 近期条目，在 token 预算内返回，
 * 用于会话开场对齐（角色/偏好/约定/近期经验）。
 */
import { ensureProjectsFresh, loadManifest } from '../manifest.js';
import { recordCite } from '../usage.js';
import { normalizeKbId, textBlock, toNumInRange } from './shared.js';
import { resolveProject } from './recall.js';

/**
 * @param {{ state: ReturnType<import('../service.js').createMemoryState>; name: string }} deps
 */
export function createDocoMemoryContext({ state, name }) {
  return {
    name,
    description:
      '读取当前项目的记忆上下文包：用户画像（profile）+ 近期经验条目（episodes），在 token 预算内返回。' +
      ' 会话开场对齐用；返回内容带来源，回答引用时区分「记忆明确记录」与「你的推断」。',
    parameters: {
      project: { type: 'string', description: '可选：项目 key；缺省自动解析当前工作区。' },
      budget: { type: 'integer', description: '可选：token 预算（64–50000），默认 DOCO_MEMORY_CONTEXT_BUDGET。' },
      cite: { type: 'boolean', description: '可选：读取内容是否计入引用台账（实际用于回答时传 true）。' },
    },
    async execute(args) {
      const budget = toNumInRange(args?.budget, state.config.contextBudget, 64, 50000);

      // 定位记忆库 + manifest
      let kbId = state.memory?.kb_id || normalizeKbId(state.config.defaultKb) || normalizeKbId(state.doco.getConfig().defaultKb);
      let manifest = state.memory?.manifest ?? null;
      if (!manifest && kbId) {
        const loaded = await loadManifest(state.doco, kbId, { manifestDocId: state.memory?.manifest_doc_id ?? null });
        if (!loaded.ok) {
          return state.doco.errorValue('doco_memory_not_initialized', '记忆库未初始化或 manifest 不可用：' + loaded.error.message, '先执行 doco_memory_init。');
        }
        manifest = loaded.manifest;
        state.memory = { kb_id: kbId, manifest, manifest_doc_id: loaded.doc_id };
      }
      if (!manifest || !kbId) {
        return state.doco.errorValue('doco_memory_not_initialized', '尚未初始化记忆库。', '先执行 doco_memory_init。');
      }

      // 项目解析前尽力刷新缓存（工作区自动匹配依赖最新 projects 登记）
      await ensureProjectsFresh(state, kbId);
      manifest = state.memory?.manifest ?? manifest;

      let projectKey = null;
      if (String(args?.project ?? '').toLowerCase() === 'global') {
        projectKey = 'global';
      } else if (args?.project) {
        projectKey = String(args.project);
      } else {
        const hit = resolveProject(manifest, { repo: state.context?.repo ?? null, path: state.context?.workspacePath ?? null });
        projectKey = hit?.key ?? 'global';
      }

      // 目标文档（budget 内尽量少读）：
      // 1. profile（必读，无预算则截断）
      // 2. 项目 episodes（如果项目有 episodes_doc 且预算剩余）
      const reads = [];
      reads.push({ docId: manifest.layout.profile.doc, label: 'profile' });
      if (projectKey !== 'global') {
        const proj = (manifest.projects || []).find((p) => p.key === projectKey);
        if (proj?.episodes_doc) reads.push({ docId: proj.episodes_doc, label: `episodes/<${projectKey}>` });
      } else {
        reads.push({ docId: manifest.layout.episodes.global_doc, label: 'episodes/global' });
      }

      /** @type {Array<{ label: string; text: string; uri: string | null }>} */
      const sections = [];
      let usedBudget = 0;
      for (const read of reads) {
        try {
          const content = await state.doco.getClient().readDocument(read.docId, { locale: 'all' });
          const text = typeof content?.data?.content === 'string' ? content.data.content : '';
          // 预算控制：剩余不足一半则只取前 ~budget 长度
          const remaining = budget - usedBudget;
          if (text.length > remaining && remaining > 0) {
            sections.push({ label: read.label, text: text.slice(0, remaining) + '\n…（已按预算截断，可 doco_read 续读）', uri: content?.data?.document_uri ?? null });
            usedBudget = budget;
            break;
          }
          sections.push({ label: read.label, text, uri: content?.data?.document_uri ?? null });
          usedBudget += text.length / 4; // 粗估 token
        } catch (error) {
          sections.push({ label: read.label, text: '', uri: null, error: state.doco.toErrorValue(error) });
        }
      }

      if (args?.cite) {
        for (const read of reads) {
          if (read.docId) recordCite(state, read.docId);
        }
      }

      return {
        kind: 'doco_memory_context',
        scope: projectKey,
        budget_used_estimate: usedBudget,
        sections: sections.map((s) => ({ label: s.label, text: s.text, uri: s.uri, ...(s.error ? { error: s.error } : {}) })),
        note: '上下文包为粗略对齐，具体事实请 doco_read 原文核实。',
      };
    },
    render(_args, value) {
      if (value.kind === 'doco_error') return textBlock(`Doco 错误（${value.code}）：${value.message}\n下一步：${value.next_step || ''}`);
      const head = [`记忆上下文包（scope=${value.scope}，约 ${value.budget_used_estimate} token）`];
      const body = value.sections.map((s) => `--- ${s.label} ---\n${s.error ? `（错误 ${s.error.code}）` : s.text + (s.uri ? `\n来源：${s.uri}` : '')}`);
      return textBlock([...head, ...body, value.note || ''].join('\n'));
    },
  };
}