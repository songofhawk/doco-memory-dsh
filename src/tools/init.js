// @ts-check
/**
 * doco_memory_init：初始化记忆库（新建/接管/repair）。
 * 写入纪律同 doco-dsh：mode=preview 只展示计划，commit 需宿主审批。
 */
import { toErrorValue, errorValue } from '../errors.js';
import { resolveMemoryConfig } from '../config.js';
import { provisionMemory } from '../provisioning.js';
import { loadManifest } from '../manifest.js';
import { textBlock, toString, normalizeKbId } from './shared.js';

/**
 * @param {{ state: ReturnType<import('../service.js').createMemoryState> }} deps
 */
export function createDocoMemoryInit({ state }) {
  /** @param {unknown} raw */
  const normalizeMode = (raw) => {
    const m = String(raw ?? 'auto').toLowerCase();
    return ['create', 'adopt', 'repair', 'auto'].includes(m) ? m : 'auto';
  };

  return {
    name: 'doco_memory_init',
    description:
      '初始化记忆库（Doco Memory Layout spec v1）：新建知识库或接管已有库，创建标准目录结构并写入 manifest。' +
      ' mode=auto 默认：知识库缺省时新建；已存在则接管并补缺失结构。mode=repair 用于 manifest 损坏时的重建。' +
      ' 写入需 documents:write + knowledge-bases:write scope，且经用户确认。',
    parameters: {
      knowledge_base_id: { type: 'json', description: '可选：目标知识库 id（缺省用 DOCO_MEMORY_KB 或默认配置）' },
      mode: { type: 'string', enum: ['auto', 'create', 'adopt', 'repair'], description: '默认 auto' },
      kb_name: { type: 'string', description: '可选：新建知识库的名称（默认 Agent Memory）' },
    },
    async execute(args) {
      const kbId = normalizeKbId(args?.knowledge_base_id) || state.config.defaultKb;
      const mode = normalizeMode(args?.mode);
      // repair 语义：manifest 损坏时，先尝试读取；失败则强制 adopt 重建
      if (mode === 'repair' && kbId) {
        const loaded = await loadManifest(state.doco, kbId, {});
        if (loaded.ok) {
          return { kind: 'doco_memory_init', mode: 'repair', already_valid: true, idempotent: true, note: 'manifest 可正常解析，无需修复。' };
        }
      }
      const result = await provisionMemory(state.doco, {
        kbId,
        mode,
        kbName: toString(args?.kb_name, undefined),
      });
      if (!result.ok) return result.error;
      const r = result.result;
      state.memory = { kb_id: r.kb_id, manifest: r.manifest, manifest_doc_id: r.manifest_doc_id };
      return {
        kind: 'doco_memory_init',
        mode: r.mode,
        kb_id: r.kb_id,
        kb_name: r.kb_name,
        manifest_doc_id: r.manifest_doc_id,
        layout: {
          inbox_folder: r.manifest.layout.inbox.folder_id,
          queue_doc: r.manifest.layout.inbox.queue_doc,
          profile_doc: r.manifest.layout.profile.doc,
          episodes_global_doc: r.manifest.layout.episodes.global_doc,
          usage_doc: r.manifest.layout.usage.doc,
        },
        note: '记忆库已就绪。role 提示词已注入无内容，仅档案。',
      };
    },
    render(_args, value) {
      if (value.kind === 'doco_error') {
        return textBlock(`Doco 错误（${value.code}）：${value.message}\n下一步：${value.next_step || ''}`);
      }
      if (value.already_valid) return textBlock(`记忆库已就绪：manifest 正常（${value.note || ''}）`);
      return textBlock(
        `记忆库初始化完成（${value.mode}）\n知识库：${value.kb_name} (${value.kb_id})\n` +
        `审阅队列：${value.layout.queue_doc}\n用户画像：${value.layout.profile_doc}\n` +
        `episodes-global：${value.layout.episodes_global_doc}\nusage 台账：${value.layout.usage_doc}\n` +
        `${value.note || ''}`,
      );
    },
  };
}