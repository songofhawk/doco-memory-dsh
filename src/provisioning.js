// @ts-check
/**
 * provisioning（Doco Memory Layout spec v1 §3.2、§6）：`/doco memory init` 的实现。
 *
 * 三模式：
 * - created：新建知识库（默认名「Agent Memory」）+ 全量标准结构 + 写 manifest；
 * - adopted：接管已有库——只创建缺失的文件夹/文档，绝不动已有内容，manifest 仅登记实际结构；
 * - repaired：manifest 缺失/损坏时按名称扫描既有结构，展示给用户确认后重写 manifest。
 *
 * 契约红线：不删除、不移动、不整篇覆盖已有内容；一切写入带幂等键 / If-Match；
 * 需要 knowledge-bases:write（新建/接管文件夹）与 documents:write（建文档）。
 *
 * 幂等键纪律：HTTP 头仅允许 ASCII，且不同目录下的同名 living doc 不能撞键——
 * 因此键一律由 sha256(scope|name) 派生，scope 含 kb/父目录。
 */
import { createHash } from 'node:crypto';
import { errorValue, toErrorValue } from './errors.js';
import {
  MANIFEST_SCHEMA, META_FOLDER_NAME, MANIFEST_TITLE,
  LAYOUT_FOLDERS, LIVING_DOC_TITLES,
  locateManifest, manifestToMarkdown,
} from './manifest.js';

/** @typedef {import('./types.js').DocoService} DocoService */
/** @typedef {import('./types.js').Manifest} Manifest */

/**
 * ASCII 安全的幂等键：prefix + sha256(parts.join('|')) 前 24 位十六进制。
 * HTTP 头仅允许 ASCII（中文标题直接进头会被 fetch 拒绝）；
 * 作用域包含 kb / 父目录，避免不同目录下的同名 living doc（如两个 global）撞键。
 * @param {string} prefix
 * @param {...(string|number|null|undefined)} parts
 */
function idemKey(prefix, ...parts) {
  return prefix + createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 24);
}

/**
 * 分析既有树结构：返回各约定文件夹/文档的现存情况与 id。
 * @param {DocoService} doco
 * @param {string} kbId
 */
export async function inspectExistingStructure(doco, kbId) {
  const tree = (await doco.getClient().getTree(kbId)).data;
  /** @type {Record<string, { id: string; name: string }>} */
  const foldersByName = {};
  /** @type {Record<string, { id: string; title: string; folderId: string|null }>} */
  const docsByTitle = {};
  const visitFolder = (folder, parentId = null) => {
    if (!folder) return;
    if (folder.id && folder.name) foldersByName[folder.name] = { id: String(folder.id), name: folder.name };
    if (Array.isArray(folder.documents)) {
      for (const d of folder.documents) {
        if (d?.id && d?.title) docsByTitle[d.title] = { id: String(d.id), title: d.title, folderId: folder.id ? String(folder.id) : parentId };
      }
    }
    if (Array.isArray(folder.folders)) {
      for (const child of folder.folders) visitFolder(child, folder.id ? String(folder.id) : parentId);
    }
  };
  if (Array.isArray(tree?.folders)) {
    for (const f of tree.folders) visitFolder(f);
  }
  if (Array.isArray(tree?.documents)) {
    for (const d of tree.documents) {
      if (d?.id && d?.title) docsByTitle[d.title] = { id: String(d.id), title: d.title, folderId: null };
    }
  }
  return { foldersByName, docsByTitle };
}

/**
 * 在知识库内创建文件夹（幂等：同名已存在则复用）。
 * @param {DocoService} doco
 * @param {string} kbId
 * @param {string} name
 * @param {string|null} parentId
 * @param {Record<string, { id: string }>} existing
 */
export async function ensureFolder(doco, kbId, name, parentId, existing) {
  if (existing[name]?.id) return String(existing[name].id);
  const body = { name, knowledge_base_id: kbId, ...(parentId ? { parent_id: parentId } : {}) };
  const resp = await doco.getClient().request('POST', '/folders', {
    body,
    headers: { 'Idempotency-Key': idemKey('dm-init-folder-', kbId, parentId, name) },
  });
  const folder = resp?.data ?? {};
  const id = String(folder.id ?? '');
  if (!id) throw new Error(`创建文件夹失败（${name}）：响应缺少 id`);
  return id;
}

/**
 * 在指定文件夹内创建文档（幂等：标题已存在则复用）。
 * @param {DocoService} doco
 * @param {string} kbId
 * @param {string} title
 * @param {string|null} folderId
 * @param {Record<string, { id: string }>} existing
 */
export async function ensureDocument(doco, kbId, title, folderId, existing) {
  if (existing[title]?.id) return { id: String(existing[title].id), created: false };
  const resp = await doco.getClient().createDocument(
    { title, knowledge_base_id: kbId, ...(folderId ? { folder_id: folderId } : {}), document_type: 'document' },
    { idempotencyKey: idemKey('dm-init-doc-', kbId, folderId, title) },
  );
  const doc = resp?.data ?? {};
  const id = String(doc.id ?? doc.document_id ?? '');
  if (!id) throw new Error(`创建文档失败（${title}）：响应缺少 id`);
  return { id, created: true };
}

/**
 * 执行 init。
 * @param {DocoService} doco
 * @param {{ kbId?: string|null; mode: 'auto'|'create'|'adopt'; kbName?: string }} opts
 * @returns {Promise<{ ok: true; result: import('./types.js').MemoryInitResult } |
 *   { ok: false; error: ReturnType<typeof errorValue> }>}
 */
export async function provisionMemory(doco, opts = {}) {
  const { kbId: explicitKbId, mode = 'auto', kbName } = opts;
  try {
    let kbId = explicitKbId || doco.getConfig().defaultKb || null;
    let kbMode;
    let kbNameResolved = kbName || 'Agent Memory';

    // ---- 1. 确定知识库 ----
    if (!kbId) {
      if (mode === 'adopt') {
        return { ok: false, error: errorValue('doco_memory_kb_required', '接管模式需要指定目标知识库（knowledge_base_id）。', '先用 doco_list_knowledge_bases 确认 id，再 /doco memory init 传入。') };
      }
      // 新建模式：创建知识库
      const resp = await doco.getClient().request('POST', '/knowledge-bases', {
        body: { name: kbNameResolved },
        headers: { 'Idempotency-Key': 'dm-init-kb' },
      });
      const kb = resp?.data ?? {};
      kbId = String(kb.id ?? kb.knowledge_base_id ?? '');
      if (!kbId) return { ok: false, error: errorValue('doco_memory_init_failed', '创建知识库失败：响应缺少 id。', '检查 knowledge-bases:write scope 后重试。') };
      kbMode = 'created';
    } else {
      // 检查知识库存在
      try {
        const kb = (await doco.getClient().request('GET', `/knowledge-bases/${encodeURIComponent(kbId)}`)).data ?? {};
        kbNameResolved = kb.name || kbNameResolved;
      } catch (error) {
        return { ok: false, error: toErrorValue(error) };
      }
      kbMode = mode === 'create' ? 'created' : 'adopt';
    }

    // ---- 2. manifest 是否已存在（幂等：重复 init 复用） ----
    // 注意：kbMode 为 adopted 时若已有 manifest，视为 repair/复用（幂等）。
    const existingManifest = await locateManifest(doco, kbId).catch(() => null);
    if (existingManifest?.doc_id) {
      // 已有 manifest：复用。仍需校验可解析，否则提示 repair。
      try {
        const loaded = await (await import('./manifest.js')).loadManifest(doco, kbId, { manifestDocId: existingManifest.doc_id });
        if (loaded.ok) {
          return {
            ok: true,
            result: { kb_id: kbId, kb_name: kbNameResolved, mode: kbMode === 'created' ? 'created' : 'adopted', manifest: loaded.manifest, manifest_doc_id: loaded.doc_id },
          };
        }
      } catch { /* fallthrough to repair */ }
      return { ok: false, error: errorValue('doco_memory_manifest_corrupt', '已存在 _meta/manifest 但无法解析（可能被手工改坏）。', '执行 /doco memory init --repair 重建映射。') };
    }

    // ---- 3. 扫描既有结构（接管模式不覆盖） ----
    const existing = await inspectExistingStructure(doco, kbId);

    // ---- 4. 建标准结构（create 模式全量；adopt 模式补缺失） ----
    const metaFolderId = await ensureFolder(doco, kbId, META_FOLDER_NAME, null, existing.foldersByName);
    const inboxFolderId = await ensureFolder(doco, kbId, LAYOUT_FOLDERS.inbox, null, existing.foldersByName);
    const profileFolderId = await ensureFolder(doco, kbId, LAYOUT_FOLDERS.profileFolder, null, existing.foldersByName);
    const factsFolderId = await ensureFolder(doco, kbId, LAYOUT_FOLDERS.facts, null, existing.foldersByName);
    const globalFolderId = await ensureFolder(doco, kbId, 'global', factsFolderId, existing.foldersByName);
    const episodesFolderId = await ensureFolder(doco, kbId, LAYOUT_FOLDERS.episodes, null, existing.foldersByName);
    const runbooksFolderId = await ensureFolder(doco, kbId, LAYOUT_FOLDERS.runbooks, null, existing.foldersByName);
    const archiveFolderId = await ensureFolder(doco, kbId, LAYOUT_FOLDERS.archive, null, existing.foldersByName);

    const queueDoc = await ensureDocument(doco, kbId, LIVING_DOC_TITLES.queueDoc, inboxFolderId, existing.docsByTitle);
    const reportsDoc = await ensureDocument(doco, kbId, LIVING_DOC_TITLES.reportsDoc, inboxFolderId, existing.docsByTitle);
    const profileDoc = await ensureDocument(doco, kbId, LIVING_DOC_TITLES.profileDoc, profileFolderId, existing.docsByTitle);
    const episodesGlobal = await ensureDocument(doco, kbId, LIVING_DOC_TITLES.episodesGlobal, episodesFolderId, existing.docsByTitle);
    const usageDoc = await ensureDocument(doco, kbId, LIVING_DOC_TITLES.usageDoc, metaFolderId, existing.docsByTitle);
    // facts/global 与 runbooks 内的 living doc（remember 的确定性落位目标；spec §13 前向兼容：可选字段）
    const factsGlobalDoc = await ensureDocument(doco, kbId, LIVING_DOC_TITLES.factsGlobal, globalFolderId, existing.docsByTitle);
    const runbooksDoc = await ensureDocument(doco, kbId, LIVING_DOC_TITLES.runbooksDoc, runbooksFolderId, existing.docsByTitle);

    // ---- 5. 写 manifest ----
    const now = new Date().toISOString();
    /** @type {Manifest} */
    const manifest = {
      schema: MANIFEST_SCHEMA,
      created_at: now,
      updated_at: now,
      layout: {
        inbox: { folder_id: inboxFolderId, queue_doc: queueDoc.id, reports_doc: reportsDoc.id },
        profile: { doc: profileDoc.id },
        facts: { folder_id: factsFolderId, global_folder: globalFolderId, global_doc: factsGlobalDoc.id },
        episodes: { folder_id: episodesFolderId, global_doc: episodesGlobal.id },
        runbooks: { folder_id: runbooksFolderId, doc: runbooksDoc.id },
        archive: { folder_id: archiveFolderId },
        usage: { doc: usageDoc.id },
      },
      projects: [],
      policy: { append: true, edit: false },
    };

    // manifest 文档本体（在 _meta 文件夹内建标题为 manifest 的文档）
    const manifestDoc = await ensureDocument(doco, kbId, MANIFEST_TITLE, metaFolderId, existing.docsByTitle);
    if (manifestDoc.created) {
      const markdown = manifestToMarkdown(manifest);
      // 新建文档在服务端已有初始正文（非空块），PUT 必须带 If-Match，否则 428 precondition_required。
      const cur = await doco.getClient().getContent(manifestDoc.id, 'markdown');
      await doco.getClient().putContent(
        manifestDoc.id,
        { format: 'markdown', content: markdown },
        { ifMatch: cur.etag || undefined },
      );
    }

    return { ok: true, result: { kb_id: kbId, kb_name: kbNameResolved, mode: kbMode, manifest, manifest_doc_id: manifestDoc.id } };
  } catch (error) {
    return { ok: false, error: toErrorValue(error) };
  }
}