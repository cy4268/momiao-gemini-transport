import { createTransportFetch } from './transport.mjs';

const ID = 'momiao-gemini-transport';
const SLOT = Symbol.for(`${ID}.runtime`);
let runtime;

function settings() {
  const context = globalThis.SillyTavern.getContext();
  context.extensionSettings[ID] ??= { enabled: false };
  context.extensionSettings[ID].monitor ??= true;
  return context.extensionSettings[ID];
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function routeSummary(route) {
  if (!route.fields.length) return '未收到模型字段，真实路由无法核实';
  const normalize = name => name.split('/').at(-1).toLowerCase();
  return route.fields.some(item => normalize(item.value) !== normalize(route.requestedModel))
    ? '返回名称有差异，请核对字段；不能据此断定降级'
    : '返回名称相同；仍无法证明实际执行模型';
}

function openRoutes(state) {
  if (state.popup || !state.active) return;
  const { Popup, POPUP_TYPE } = state.context;
  if (typeof Popup !== 'function' || POPUP_TYPE?.TEXT == null) {
    state.report('当前宿主缺少原生弹窗接口，请使用兼容的 ST 1.19 / TT 2.4。'); return;
  }
  const content = element('section');
  content.id = `${ID}-routes`;
  content.style.cssText = 'text-align:left;overflow-wrap:anywhere;min-width:0;';
  const title = element('h3', 'Momiao · 模型路由');
  const hint = element('p', '记录请求名和收到的模型字段。字段可能被中转回填；没有可信版本信息时，无法判断 Google 的实际模型。');
  hint.style.cssText = 'font-size:.9em;opacity:.85;';
  const controls = element('div');
  controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;align-items:center;';
  for (const [key, text] of [['enabled', '正文工具传输'], ['monitor', '观察模型字段']]) {
    const label = element('label', '', 'checkbox_label');
    const input = element('input'); input.type = 'checkbox'; input.checked = settings()[key] === true;
    input.addEventListener('change', () => {
      settings()[key] = input.checked; state.context.saveSettingsDebounced();
      if (key === 'enabled' && state.toggle) state.toggle.checked = input.checked;
      state.idle();
    });
    label.append(input, element('span', text)); controls.append(label);
  }
  const clear = element('button', '清空记录', 'menu_button'); clear.type = 'button';
  clear.addEventListener('click', () => {
    state.clearedThrough = Math.max(state.clearedThrough, ...state.routes.map(route => route.id));
    state.routes = []; state.renderRoutes();
  });
  controls.append(clear);
  const status = element('p'); status.setAttribute('role', 'status');
  const list = element('div');
  state.renderRoutes = () => {
    status.textContent = state.lastStatus;
    list.replaceChildren();
    if (!state.routes.length) list.append(element('p', '暂无记录。开启观察后，通过 momiao 的 Gemini 连接发送一条消息。'));
    for (const [index, route] of state.routes.entries()) {
      const item = element('details'); item.open = index === 0;
      item.style.cssText = 'border-top:1px solid var(--SmartThemeBorderColor,#888);padding:10px 0;';
      const time = new Date(route.startedAt).toLocaleTimeString();
      const summary = element('summary', `${time} · ${route.requestedModel}`);
      summary.style.cursor = 'pointer';
      item.append(summary, element('p', routeSummary(route)));
      const fields = element('dl'); fields.style.cssText = 'margin:8px 0;';
      const add = (label, value) => {
        const term = element('dt', label); term.style.cssText = 'font-size:.85em;opacity:.75;margin-top:8px;';
        const data = element('dd', value); data.style.cssText = 'margin:2px 0 0;user-select:text;';
        fields.append(term, data);
      };
      add('发送的模型名', route.requestedModel);
      if (!route.fields.length) add('响应中的模型字段', '未提供 / 尚未收到');
      for (const field of route.fields) add(`响应字段 ${field.field}`, field.value);
      const states = { waiting: '等待响应', receiving: '接收中', complete: '响应读取结束',
        incomplete: '连接结束，未收到完整结束标记', cancelled: '已取消接收', error: '请求或响应异常' };
      add('接收状态', `${states[route.state] || route.state}${route.httpStatus ? ` · HTTP ${route.httpStatus}` : ''}`);
      if (route.finishReasons.length) add('原始结束原因', route.finishReasons.join(' / '));
      add('本次模式', route.mode === 'tool' ? '正文工具传输' : '仅观察，原请求发送');
      item.append(fields);
      if (/^(AIS|快速v|AIStuidio|AIStudio-Anti)\//i.test(route.requestedModel)) {
        item.append(element('small', '2026-10-27 源码核对：这些连接中的适配器可能使用请求名填写返回模型字段。本条记录不能证明 Google 的真实路由。'));
      }
      if (route.note) item.append(element('p', route.note));
      list.append(item);
    }
  };
  content.append(title, hint, controls, status, list,
    element('small', '仅保留本次打开酒馆期间最近 10 条记录；刷新即清空，不记录提示词、正文或密钥。开关对下一次请求生效。'));
  state.renderRoutes();
  state.popup = new Popup(content, POPUP_TYPE.TEXT, '', { okButton: '关闭', allowVerticalScrolling: true,
    onClose: () => { state.popup = null; state.renderRoutes = null; } });
  state.popup.show().catch(() => { state.popup = null; state.renderRoutes = null; state.report('无法打开原生弹窗'); });
}

export function deactivate() {
  const state = runtime;
  if (!state) return;
  state.active = false;
  document.removeEventListener('DOMContentLoaded', state.mount);
  if (state.event) state.context.eventSource.removeListener(state.event, state.mount);
  state.panel?.remove();
  state.menu?.remove();
  state.popup?.complete(state.context.POPUP_RESULT?.CANCELLED ?? 0).catch(() => {});
  state.routes = []; state.renderRoutes = null;
  if (window.fetch === state.wrappedFetch) window.fetch = state.originalFetch;
  // A later extension may have wrapped us. Leave that wrapper in place; our
  // inactive closure becomes a pass-through rather than removing someone else's work.
  if (window[SLOT] === state) delete window[SLOT];
  runtime = null;
}

export function activate() {
  if (runtime?.active) return;
  window[SLOT]?.dispose();
  const context = globalThis.SillyTavern?.getContext?.();
  if (!context?.extensionSettings || typeof context.saveSettingsDebounced !== 'function' ||
      !globalThis.ReadableStream || !globalThis.TextDecoder || !globalThis.Response) {
    console.warn('[Momiao Gemini] 宿主缺少必要能力，请使用 SillyTavern 1.19 或 TT 2.4 的兼容环境。');
    return;
  }
  const state = { active: true, context, panel: null, status: null, event: null, menu: null, popup: null,
    routes: [], clearedThrough: 0, lastStatus: '', renderRoutes: null, toggle: null,
    originalFetch: window.fetch, wrappedFetch: null, mount: null, dispose: deactivate };
  runtime = state; window[SLOT] = state;
  const report = text => {
    if (!state.active) return;
    state.lastStatus = text;
    if (state.status) state.status.textContent = text;
    state.renderRoutes?.();
  };
  state.report = report;
  const idle = () => report(settings().enabled ? '已开启正文工具，等待 momiao 的 Gemini 请求。'
    : settings().monitor ? '正文工具关闭；仍观察模型字段，使用原请求。' : '正文工具和模型观察均已关闭。');
  state.idle = idle;
  state.mount = () => {
    if (!state.active) return;
    const menu = document.getElementById('extensionsMenu');
    if (menu && !state.menu) {
      const entry = element('div', '', 'list-group-item flex-container flexGap5');
      entry.id = `${ID}-menu`; entry.setAttribute('role', 'button'); entry.tabIndex = 0;
      const icon = element('i', '', 'fa-solid fa-route extensionsMenuExtensionButton'); icon.setAttribute('aria-hidden', 'true');
      entry.append(icon, element('span', 'Momiao 模型路由'));
      entry.addEventListener('click', () => openRoutes(state));
      entry.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); entry.click(); }
      });
      menu.append(entry); state.menu = entry;
    }
    if (state.panel) return;
    const parent = document.getElementById('extensions_settings');
    if (!parent) return;
    const panel = document.createElement('section');
    panel.id = `${ID}-settings`;
    panel.setAttribute('aria-label', 'Momiao Gemini 防截断');
    panel.style.cssText = 'border:1px solid var(--SmartThemeBorderColor,#888);border-radius:8px;padding:12px;margin:8px 0;';
    const title = document.createElement('h4');
    title.textContent = 'Momiao Gemini 防截断'; title.style.margin = '0 0 8px';
    const label = document.createElement('label');
    label.className = 'checkbox_label';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox'; toggle.checked = settings().enabled === true;
    state.toggle = toggle;
    const text = document.createElement('span'); text.textContent = '启用正文工具传输';
    label.append(toggle, text);
    const hint = document.createElement('small');
    hint.style.display = 'block';
    hint.textContent = '让模型把正文放进工具参数，再还原为聊天文字。使用自定义 OpenAI 连接与 momiao.win；请先停用其他防截断脚本和预设输出工具。';
    const status = document.createElement('p');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin:8px 0 0;overflow-wrap:anywhere;';
    toggle.addEventListener('change', () => {
      settings().enabled = toggle.checked;
      globalThis.SillyTavern.getContext().saveSettingsDebounced();
      idle();
    });
    const open = element('button', '查看模型路由', 'menu_button'); open.type = 'button';
    open.addEventListener('click', () => openRoutes(state));
    panel.append(title, label, hint, open, status); parent.append(panel);
    state.panel = panel; state.status = status; idle();
  };
  state.wrappedFetch = createTransportFetch(state.originalFetch.bind(window), {
    origin: window.location.origin,
    getEnabled: () => state.active && settings().enabled === true,
    getMonitoring: () => state.active && settings().monitor === true,
    onStatus: report,
    onRoute: route => {
      if (!state.active || route.id <= state.clearedThrough) return;
      state.routes = [route, ...state.routes.filter(item => item.id !== route.id)]
        .sort((a, b) => b.id - a.id).slice(0, 10);
      state.renderRoutes?.();
    },
  });
  window.fetch = state.wrappedFetch;
  state.mount();
  const events = context.eventTypes ?? context.event_types;
  if (events && typeof context.eventSource?.on === 'function' && typeof context.eventSource?.removeListener === 'function') {
    state.event = events.APP_READY ?? events.APP_INITIALIZED;
    if (state.event) context.eventSource.on(state.event, state.mount);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', state.mount, { once: true });
}

// Both pinned hosts load an ES module; hooks additionally cover toggling/reload.
activate();
