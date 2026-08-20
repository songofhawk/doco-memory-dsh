// @ts-check
/**
 * 单测桩：dsh Context 的最小可测替身 + 无脑 identity BuildTool + doco 服务假体。
 * 行为对齐真实 dsh（同 doco-dsh 的 fake-context + 记忆插件扩展）：
 *   - ctx.tools.register 同名抛错；guard / on 可注入并记录；systemPrompt.section 记录；
 *   - ctx.provide(name, value) 记录 providedServices；
 *   - ctx.on('session/end') 记录 handler（供 flush 测试触发）。
 */

export function makeFakeContext() {
  const registeredTools = new Map();
  const disposers = [];
  const guards = [];
  const preExecute = [];
  const promptSections = [];
  const commands = [];
  const providedServices = new Map();
  const sessionEndHandlers = [];

  const ctx = {
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    tools: {
      register(def) {
        if (registeredTools.has(def.name)) throw new Error(`tool "${def.name}" is already registered`);
        registeredTools.set(def.name, def);
        return () => registeredTools.delete(def.name);
      },
      get(name) { return registeredTools.get(name); },
      guard(fn) { guards.push(fn); return () => {}; },
    },
    on(event, handler) {
      if (event === 'tools/pre-execute') preExecute.push(handler);
      if (event === 'session/end') sessionEndHandlers.push(handler);
      return () => {};
    },
    systemPrompt: {
      section(section) { promptSections.push(section); return () => {}; },
    },
    commands: {
      register(def) { commands.push(def); return () => {}; },
    },
    provide(name, value) { providedServices.set(name, value); return () => providedServices.delete(name); },
    effect(fn) {
      const it = fn();
      let step = it.next();
      while (!step.done) {
        if (step.value) disposers.push(step.value);
        step = it.next();
      }
      return () => {};
    },
  };

  return {
    ctx,
    registeredTools,
    disposers,
    guards,
    preExecute,
    promptSections,
    commands,
    providedServices,
    sessionEndHandlers,
  };
}

export function identityBuildTool(def) {
  return { __docoIdentityTool: true, ...def };
}

/**
 * 构造 doco 服务假体（对齐 doco-dsh service.js 服务面）。
 * @param {object} [overrides]
 */
export function makeFakeDocoService(overrides = {}) {
  const client = {
    getTree: async () => ({ data: { id: 'kb1', name: 'kb', folders: [], documents: [] } }),
    getContent: async () => ({ data: { content: '' }, etag: '"v1"' }),
    readDocument: async () => ({ data: { content: 'test content', document_uri: 'doco:doc/doc1' } }),
    searchV2: async () => ({ data: { query: 'q', mode: 'topk', results: [], page: {}, projection: { complete: true, freshness: 'current' } } }),
    putContent: async () => ({ data: {}, etag: '"v2"' }),
    createDocument: async (body) => ({ data: { id: `doc_${String(body?.title ?? 'x').toLowerCase().replace(/[^a-z0-9]/g, '_')}`, title: body?.title } }),
    insertBlocks: async () => ({ data: { version: 'v2' }, etag: '"v2"' }),
    request: async (method, path, opts = {}) => {
      if (path === '/folders' || path.startsWith('/folders')) return { data: { id: 100 + Math.floor(Math.random() * 100) } };
      if (path === '/knowledge-bases' || path.startsWith('/knowledge-bases')) return { data: { id: 'kb1', name: 'Agent Memory' } };
      throw new Error(`unexpected request: ${method} ${path}`);
    },
    ...(overrides.client ?? {}),
  };
  const doco = {
    pluginName: 'doco-dsh',
    version: '0.2.0',
    toolPrefix: 'doco_',
    getConfig: () => ({ baseUrl: 'https://api.example.test/api/v1', defaultKb: 'kb1', token: 'doco_tok_TEST_ONLY_0000000000', webOrigin: 'https://doco.page', allowWrites: false }),
    getClient: () => client,
    ensureIdentity: async () => ({ user: { id: 'u1', name: 'Alice' }, scopes: ['documents:read', 'knowledge-bases:read'], error: null }),
    hasToken: () => true,
    hasScope: (scopes, scope) => Array.isArray(scopes) && scopes.includes(scope),
    scopes: { READ: 'documents:read', WRITE: 'documents:write', KB_READ: 'knowledge-bases:read' },
    errorValue: (code, message, nextStep = '') => ({ kind: 'doco_error', code, message, next_step: nextStep }),
    toErrorValue: (error) => ({ kind: 'doco_error', code: 'doco_internal', message: String(error?.message ?? error), next_step: '' }),
    mapApiError: (error) => ({ code: 'doco_internal', message: String(error?.message ?? error), next_step: '', http_status: null, retryable: false }),
    DocoPluginError: class extends Error {},
    ...overrides,
  };
  return doco;
}