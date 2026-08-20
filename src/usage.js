// @ts-check
/**
 * 引用瘦台账（Doco Memory Layout spec v1 §5）：
 * 只记服务端无法感知的信号——块级「实际被写进回答」的引用计数。
 * 会话内聚合到内存缓冲，至多 flush 一次（会话结束/切换项目）；flush 带 If-Match，
 * 冲突时重读按「计数相加」合并（加法可交换，合并安全）。
 *
 * 台账文档 `_meta/usage` 是 living doc 但绝不参与归档型遗忘。
 */
import { toErrorValue } from './errors.js';
import { extractJsonCodeBlock } from './manifest.js';

export const USAGE_SCHEMA = 'doco-memory-usage/1';

/**
 * @param {ReturnType<import('./service.js').createMemoryState>} state
 */
export function recordCite(state, blockId) {
  if (!blockId || typeof blockId !== 'string') return;
  const buf = state.citeBuffer;
  buf.set(blockId, (buf.get(blockId) ?? 0) + 1);
}

/**
 * 解析 usage 文档正文（缺省空台账）。
 * @param {string} markdown
 */
export function parseUsageDoc(markdown) {
  const json = extractJsonCodeBlock(markdown);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed?.schema !== USAGE_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 读当前台账（合并缓冲）。
 * @param {ReturnType<import('./service.js').createMemoryState>} state
 * @param {string} usageDocId
 */
export async function loadUsage(state, usageDocId) {
  try {
    const content = await state.doco.getClient().getContent(usageDocId, 'markdown');
    const text = typeof content?.data?.content === 'string' ? content.data.content : '';
    const doc = parseUsageDoc(text) ?? { schema: USAGE_SCHEMA, cites: {} };
    // 叠入本地缓冲
    const merged = { schema: USAGE_SCHEMA, cites: { ...(doc.cites ?? {}) } };
    for (const [blockId, count] of state.citeBuffer.entries()) {
      const prev = merged.cites[blockId];
      merged.cites[blockId] = { count: (prev?.count ?? 0) + count, last: new Date().toISOString() };
    }
    return { ok: true, doc: merged };
  } catch (error) {
    return { ok: false, error: toErrorValue(error) };
  }
}

/**
 * flush：把缓冲写入台账文档（若 usageDocId 不可用则返回错误，不清空缓冲）。
 * @param {ReturnType<import('./service.js').createMemoryState>} state
 * @param {{ usageDocId?: string|null }} [opts]
 */
export async function flushUsage(state, opts = {}) {
  if (state.citeBuffer.size === 0) return { ok: true, flushed: 0 };
  const usageDocId = opts.usageDocId ?? state.memory?.manifest?.layout?.usage?.doc ?? null;
  if (!usageDocId) {
    return { ok: false, error: toErrorValue(new Error('未初始化记忆库：缺少 usage 台账文档 id（先 /doco memory init）')), flushed: 0 };
  }
  // 先读后写（If-Match）
  const read = await loadUsage(state, usageDocId);
  if (!read.ok) return { ok: false, error: read.error, flushed: 0 };
  const markdown = ['```json', JSON.stringify(read.doc, null, 2), '```'].join('\n');
  let ifMatch;
  try {
    const current = await state.doco.getClient().getContent(usageDocId, 'markdown');
    ifMatch = current?.etag ?? undefined;
  } catch (error) {
    return { ok: false, error: toErrorValue(error), flushed: 0 };
  }
  try {
    await state.doco.getClient().putContent(usageDocId, { format: 'markdown', content: markdown }, { ifMatch });
    const flushed = state.citeBuffer.size;
    state.citeBuffer.clear();
    return { ok: true, flushed };
  } catch (error) {
    // 409：重读合并后重试一次
    if (error?.status === 409 || error?.status === 412) {
      try {
        const reread = await loadUsage(state, usageDocId);
        if (!reread.ok) return { ok: false, error: reread.error, flushed: 0 };
        const retryMarkdown = ['```json', JSON.stringify(reread.doc, null, 2), '```'].join('\n');
        const fresh = await state.doco.getClient().getContent(usageDocId, 'markdown');
        await state.doco.getClient().putContent(usageDocId, { format: 'markdown', content: retryMarkdown }, { ifMatch: fresh?.etag ?? undefined });
        const flushed = state.citeBuffer.size;
        state.citeBuffer.clear();
        return { ok: true, flushed };
      } catch (retryError) {
        return { ok: false, error: toErrorValue(retryError), flushed: 0 };
      }
    }
    return { ok: false, error: toErrorValue(error), flushed: 0 };
  }
}