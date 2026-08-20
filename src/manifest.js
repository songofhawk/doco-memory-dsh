// @ts-check
/**
 * manifest（Doco Memory Layout spec v1 §4）：记忆库布局与策略的唯一权威来源。
 *
 * 定位：固定树路径 `_meta/manifest`，用 getTree 结构性遍历发现，不依赖全文搜索
 * （避免索引延迟/stale 影响）。本地仅在初始化后缓存 doc_id，冲突时以 manifest 为准。
 *
 * 读写纪律：
 * - manifest 写回带 If-Match；冲突 → 重读 → 合并 → 重试（withVersionRetry）；
 * - schema 主版本不识别时返回特定错误，绝不静默重建；
 * - repair：manifest 缺失/损坏时按 §3.2 扫描既有结构并展示给用户，用户确认后才重写。
 */
import { toErrorValue } from './errors.js';

export const MANIFEST_SCHEMA = 'doco-memory/1';
export const META_FOLDER_NAME = '_meta';
export const MANIFEST_TITLE = 'manifest';
// 约定结构（§3.1）：文件夹名 → 目录含义；living doc 用标题约定
export const LAYOUT_FOLDERS = Object.freeze({
  inbox: 'inbox',
  profileFolder: 'profile',
  facts: 'facts',
  episodes: 'episodes',
  runbooks: 'runbooks',
  archive: 'archive',
});
export const LIVING_DOC_TITLES = Object.freeze({
  queueDoc: '审阅队列',
  reportsDoc: '遗忘报告',
  profileDoc: '用户画像',
  episodesGlobal: 'global',
  usageDoc: 'usage',
  factsGlobal: 'global',
  runbooksDoc: 'runbooks',
});

/**
 * 从文档正文提取第一个 json code block 的文本。
 * 规范 §4.1：解析只认第一个 `json` code block，其余视为人类可读说明。
 * @param {string} markdown
 * @returns {string | null}
 */
export function extractJsonCodeBlock(markdown) {
  const re = /```json\s*\n([\s\S]*?)```/i;
  const m = typeof markdown === 'string' ? markdown.match(re) : null;
  return m ? m[1] : null;
}

/**
 * 校验并归一化 manifest 对象（未知字段保留，schema 主版本必须匹配）。
 * @param {unknown} raw
 * @returns {{ ok: true; value: import('./types.js').Manifest } | { ok: false; error: import('./errors.js').ErrorValue }}
 */
export function parseManifest(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: toErrorValue(new Error('manifest 内容不是对象')) };
  }
  const schema = typeof raw.schema === 'string' ? raw.schema : '';
  if (!schema.startsWith('doco-memory/')) {
    return { ok: false, error: toErrorValue(new Error('manifest 缺少 schema 字段（doco-memory/<major>）')) };
  }
  const [, major = ''] = schema.split('/');
  const expectedMajor = MANIFEST_SCHEMA.split('/')[1];
  if (major !== expectedMajor) {
    return {
      ok: false,
      error: toErrorValue(new Error(`manifest schema 主版本不兼容：got ${schema}, 本插件支持 ${MANIFEST_SCHEMA}`)),
    };
  }
  return { ok: true, value: /** @type {import('./types.js').Manifest} */ (raw) };
}

/**
 * 把 manifest 序列化为文档正文（json code block + 人类可读说明）。
 * @param {import('./types.js').Manifest} manifest
 * @returns {string}
 */
export function manifestToMarkdown(manifest) {
  return [
    '> 本文件由 doco-memory-dsh 维护，是记忆库布局的唯一权威来源。请勿手工删除。',
    '> 修改文件内容请通过 /doco memory init 或工具调用；直接手工编辑时保持 schema 版本不变。',
    '',
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
    '',
  ].join('\n');
}

/**
 * 用 getTree 的目录树在记忆库内发现 `_meta/manifest` 所在位置。
 * 返回 { folder_id, doc_id } 或 null（未发现）。
 * @param {ReturnType<import('./service.js').DocoService>} doco
 * @param {string} kbId
 */
export async function locateManifest(doco, kbId) {
  try {
    const tree = (await doco.getClient().getTree(kbId)).data;
    if (!tree?.folders) return null;
    return findMetaManifestInFolders(tree.folders, null);
  } catch {
    return null;
  }
}

/** 递归找 folder 名为 _meta 下标题为 manifest 的文档。 */
function findMetaManifestInFolders(folders, parentFolderId) {
  for (const folder of folders) {
    if (folder?.name === META_FOLDER_NAME) {
      const docs = Array.isArray(folder.documents) ? folder.documents : [];
      const manifestDoc = docs.find((d) => d?.title === MANIFEST_TITLE);
      if (manifestDoc?.id) {
        return { folder_id: folder.id, doc_id: String(manifestDoc.id) };
      }
    }
    const deeper = findMetaManifestInFolders(Array.isArray(folder?.folders) ? folder.folders : [], folder?.id ?? parentFolderId);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * 读取并解析 manifest。
 * @param {ReturnType<import('./service.js').DocoService>} doco
 * @param {string} kbId
 * @param {{ manifestDocId?: string | null }} [opts] 已缓存的 doc_id（未提供时走 getTree 发现）
 * @returns {Promise<{ ok: true; manifest: import('./types.js').Manifest; doc_id: string; version: string|null } |
 *   { ok: false; error: import('./errors.js').ErrorValue; reason: 'not_found'|'unparseable'|'incompatible'|'network' }>}
 */
export async function loadManifest(doco, kbId, opts = {}) {
  let docId = opts.manifestDocId || null;
  if (!docId) {
    let located = null;
    try {
      located = await locateManifest(doco, kbId);
    } catch { /* 网络/解析失败按未发现处理 */ }
    docId = located?.doc_id ?? null;
    if (!docId) {
      return {
        ok: false,
        error: toErrorValue(new Error('未找到 _meta/manifest：该知识库尚未初始化为记忆库（请先 /doco memory init）')),
        reason: 'not_found',
      };
    }
  }
  try {
    const content = await doco.getClient().getContent(docId, 'markdown');
    const text = typeof content?.data?.content === 'string' ? content.data.content : '';
    const json = extractJsonCodeBlock(text);
    if (!json) {
      return { ok: false, error: toErrorValue(new Error('manifest 正文缺少 json code block，无法解析')), reason: 'unparseable' };
    }
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, error: toErrorValue(new Error('manifest json 解析失败（可能被手工改坏）')), reason: 'unparseable' };
    }
    const result = parseManifest(parsed);
    if (!result.ok) return { ok: false, error: result.error, reason: 'incompatible' };
    return { ok: true, manifest: result.value, doc_id: docId, version: content.etag ?? null };
  } catch (error) {
    return { ok: false, error: toErrorValue(error), reason: 'network' };
  }
}

/**
 * 写回 manifest（If-Match + 409 自动重读重试）。
 * @param {ReturnType<import('./service.js').DocoService>} doco
 * @param {string} docId
 * @param {import('./types.js').Manifest} manifest
 * @param {{ ifMatch?: string | null }} [opts]
 */
export async function saveManifest(doco, docId, manifest, opts = {}) {
  manifest.updated_at = new Date().toISOString();
  const markdown = manifestToMarkdown(manifest);
  try {
    await doco.getClient().putContent(docId, { format: 'markdown', content: markdown }, { ifMatch: opts.ifMatch ?? undefined });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toErrorValue(error) };
  }
}