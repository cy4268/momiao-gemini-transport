import { createTransportFetch } from './transport.mjs?v=0.2.4';

const ID = 'momiao-gemini-transport';
const SLOT = Symbol.for(`${ID}.runtime`);
let runtime;

function settings() {
  const context = globalThis.SillyTavern.getContext();
  context.extensionSettings[ID] ??= { enabled: false };
  return context.extensionSettings[ID];
}

export function deactivate() {
  const state = runtime;
  if (!state) return;
  state.active = false;
  document.removeEventListener('DOMContentLoaded', state.mount);
  if (state.event) state.context.eventSource.removeListener(state.event, state.mount);
  state.panel?.remove();
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
  const state = { active: true, context, panel: null, status: null, event: null,
    originalFetch: window.fetch, wrappedFetch: null, mount: null, dispose: deactivate };
  runtime = state; window[SLOT] = state;
  const report = text => { if (state.status) state.status.textContent = text; };
  const idle = () => report(settings().enabled ? '已开启，等待 momiao 的 Gemini 聊天请求。' : '已关闭，使用酒馆原来的请求。');
  state.mount = () => {
    if (!state.active || state.panel) return;
    const parent = document.getElementById('extensions_settings');
    if (!parent) return;
    const panel = document.createElement('section');
    panel.id = `${ID}-settings`;
    panel.setAttribute('aria-label', 'Momiao Gemini 防截断');
    const drawer = document.createElement('div');
    drawer.className = 'inline-drawer';
    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header';
    const title = document.createElement('b');
    title.textContent = 'Momiao Gemini 防截断';
    const icon = document.createElement('div');
    icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
    icon.setAttribute('aria-hidden', 'true');
    header.append(title, icon);
    const content = document.createElement('div');
    content.className = 'inline-drawer-content';
    const label = document.createElement('label');
    label.className = 'checkbox_label';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox'; toggle.checked = settings().enabled === true;
    const text = document.createElement('span'); text.textContent = '启用正文工具传输';
    label.append(toggle, text);
    const hint = document.createElement('small');
    hint.style.display = 'block';
    hint.textContent = '让模型把正文放进工具参数，再还原为聊天文字。流式或非流式跟随酒馆的输出设置。使用自定义 OpenAI 连接与 momiao.win；请先停用其他防截断脚本和预设输出工具。';
    const status = document.createElement('p');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin:8px 0 0;overflow-wrap:anywhere;';
    toggle.addEventListener('change', () => {
      settings().enabled = toggle.checked;
      globalThis.SillyTavern.getContext().saveSettingsDebounced();
      idle();
    });
    content.append(label, hint, status);
    drawer.append(header, content); panel.append(drawer); parent.append(panel);
    state.panel = panel; state.status = status; idle();
  };
  state.wrappedFetch = createTransportFetch(state.originalFetch.bind(window), {
    origin: window.location.origin,
    getEnabled: () => state.active && settings().enabled === true,
    onStatus: report,
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
