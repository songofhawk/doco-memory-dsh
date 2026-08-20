// @ts-check
/** doco-memory-dsh 类型定义（JSDoc @typedef，无运行时导出）。 */

/**
 * 记忆库布局映射（Doco Memory Layout spec v1 §4.2）。
 * @typedef {{
 *   schema: string;
 *   created_at: string;
 *   updated_at: string;
 *   layout: {
 *     inbox: { folder_id: string; queue_doc: string; reports_doc: string };
 *     profile: { doc: string };
 *     facts: { folder_id: string; global_folder: string; global_doc?: string };
 *     episodes: { folder_id: string; global_doc: string };
 *     runbooks: { folder_id: string; doc?: string };
 *     archive: { folder_id: string };
 *     usage: { doc: string };
 *   };
 *   projects: Array<{
 *     key: string;
 *     repo: string | null;
 *     aliases: string[];
 *     episodes_doc?: string;
 *     facts_folder?: string | null;
 *   }>;
 *   policy: {
 *     append: boolean;
 *     edit: boolean;
 *     retention?: { episodes_max_age_days?: number; tidy_max_items_per_run?: number };
 *     protect?: { pinned_blocks?: string[] };
 *   };
 * }} Manifest
 */

/**
 * doco 服务（doco-dsh 提供，doco-memory-dsh 以 inject:['doco'] 注入）。
 * 只列出本插件消费的面；其余字段为 doco-dsh 内部实现。
 * @typedef {{
 *   pluginName: string;
 *   version: string;
 *   toolPrefix: string;
 *   getConfig(): import('./config.js').MemoryConfig;
 *   getClient(): import('doco-agent-cli').DocoClient;
 *   ensureIdentity(): Promise<{ user: unknown; scopes: string[]; error: import('./errors.js').ErrorValue | null }>;
 *   hasToken(): boolean;
 *   hasScope(scopes: string[], scope: string): boolean;
 *   scopes: { READ: string; WRITE: string; KB_READ: string };
 *   errorValue(code: string, message: string, nextStep?: string): import('./errors.js').ErrorValue;
 *   toErrorValue(error: unknown): import('./errors.js').ErrorValue;
 *   mapApiError(error: unknown): { code: string; message: string; next_step: string; http_status: number|null; retryable: boolean };
 *   DocoPluginError: typeof import('./errors.js').DocoPluginError;
 * }} DocoService
 */

/**
 * 解析结果：init 后得到的记忆库定位。
 * @typedef {{
 *   kb_id: string;
 *   kb_name: string;
 *   mode: 'created' | 'adopted' | 'repaired';
 *   manifest: import('./manifest.js').Manifest;
 *   manifest_doc_id: string;
 * }} MemoryInitResult
 */