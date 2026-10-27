import { createRouteRecord } from './routing.mjs';

const TOOL = 'momiao_reply';
const PATH = '/api/backends/chat-completions/generate';
const LIMIT = 4 * 1024 * 1024;
const encoder = new TextEncoder();

function fault(code, message) {
  return Object.assign(new Error(message), { code });
}

function prepare(body) {
  if (!Array.isArray(body.messages) || !body.messages.length) return '没有可发送的聊天消息';
  if (['quiet', 'impersonate'].includes(body.type)) return '辅助生成不使用正文工具';
  if (body.custom_api_format && body.custom_api_format !== 'openai_compat') return '请选择 OpenAI Chat Completions 协议';
  let extra = {};
  try {
    extra = typeof body.custom_include_body === 'string' && body.custom_include_body.trim()
      ? JSON.parse(body.custom_include_body) : body.custom_include_body || {};
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error();
  } catch { return '附加请求体须为空或 JSON 对象；此版本不改写 YAML'; }
  if (body.custom_exclude_body?.trim() && body.custom_exclude_body.trim() !== '[]') return '请先检查附加参数中的排除字段，避免删掉工具';
  const fields = ['tools', 'functions', 'tool_choice', 'function_call', 'messages', 'model', 'stream'];
  if (fields.some(key => Object.hasOwn(extra, key))) return '附加请求体已控制工具、模型或消息，请先移除冲突项';
  if (body.tools?.length || body.functions?.length || (body.tool_choice != null && body.tool_choice !== 'auto') || body.function_call != null) {
    return '已有工具调用；请停用旧防截断脚本及预设里的输出工具后再试';
  }
  if ([body, extra].some(value => value.json_schema || value.responseSchema ||
    (value.response_format && value.response_format.type !== 'text') ||
    (value.n != null && value.n !== 1) || (value.best_of != null && value.best_of !== 1) ||
    value.enable_web_search || value.request_images)) return '结构化输出、多候选或其他工具功能与此模式冲突';
  if (body.messages.some(message => ['tool', 'function'].includes(message?.role) || message?.tool_calls?.length || message?.function_call || message?.tool_call_id)) {
    return '聊天含工具调用历史，本次保持原请求';
  }
  const tools = [{ type: 'function', function: { name: TOOL,
    description: 'Deliver the complete final answer to the user. This only displays text and performs no external action.',
    parameters: { type: 'object', properties: { content: { type: 'string', description: 'The final answer, preserving its formatting.' } },
      required: ['content'], additionalProperties: false } } }];
  const choice = { type: 'function', function: { name: TOOL } };
  let instruction = `Deliver your final answer by calling ${TOOL} exactly once. Put the final answer in its content string. Do not repeat the answer outside the tool. Preserve the requested language and formatting.`;
  if (body.type === 'continue') instruction += ' Continue the last assistant message with new text only; do not repeat its existing text.';
  return { ...body, messages: [{ role: 'system', content: instruction }, ...body.messages], tools,
    tool_choice: choice, custom_include_body: JSON.stringify({ ...extra, tools, tool_choice: choice, parallel_tool_calls: false }) };
}

// A single output-only string: scan once, retain incomplete escapes across chunks.
// No evaluation of model output, and no repair of incomplete JSON into "success".
class ContentDecoder {
  raw = ''; text = ''; offset = 0; started = false; closed = false; high = '';
  add(fragment) {
    if (typeof fragment !== 'string') throw fault('invalid_arguments', '上游工具参数不是字符串');
    this.raw += fragment;
    if (this.raw.length > LIMIT) throw fault('reply_too_large', '工具回复超过 4 MiB 字符上限');
    if (!this.started) {
      const prefix = /^\s*\{\s*"content"\s*:\s*"/.exec(this.raw);
      if (!prefix) return '';
      this.offset = prefix[0].length; this.started = true;
    }
    let output = '';
    while (!this.closed && this.offset < this.raw.length) {
      let char = this.raw[this.offset], width = 1;
      if (char === '"') { this.closed = true; this.offset++; break; }
      if (char === '\\') {
        if (this.offset + 1 >= this.raw.length) break;
        const escape = this.raw[this.offset + 1];
        if (escape === 'u') {
          if (this.offset + 6 > this.raw.length) break;
          const hex = this.raw.slice(this.offset + 2, this.offset + 6);
          if (!/^[\da-f]{4}$/i.test(hex)) throw fault('invalid_arguments', '工具回复含无效 Unicode 转义');
          char = String.fromCharCode(parseInt(hex, 16)); width = 6;
        } else {
          const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (!Object.hasOwn(escapes, escape)) throw fault('invalid_arguments', '工具回复含无效 JSON 转义');
          char = escapes[escape]; width = 2;
        }
      } else if (char.charCodeAt(0) < 32) throw fault('invalid_arguments', '工具字符串含未转义的控制字符');
      this.offset += width;
      const code = char.charCodeAt(0);
      if (this.high) {
        if (code < 0xdc00 || code > 0xdfff) throw fault('invalid_arguments', '工具回复的 Unicode 字符不完整');
        output += this.high + char; this.high = '';
      } else if (code >= 0xd800 && code <= 0xdbff) this.high = char;
      else if (code >= 0xdc00 && code <= 0xdfff) throw fault('invalid_arguments', '工具回复的 Unicode 字符不完整');
      else output += char;
    }
    this.text += output;
    return output;
  }
  finish() {
    let value;
    try { value = JSON.parse(this.raw); } catch { throw fault('incomplete_arguments', '工具回复没有完整结束，已保留收到的正文'); }
    if (!this.closed || this.high || !value || Object.keys(value).length !== 1 || typeof value.content !== 'string' || value.content !== this.text) {
      throw fault('invalid_arguments', '工具回复格式与约定不符，已保留收到的正文');
    }
    if (!this.text.trim()) throw fault('empty_reply', '上游返回了空的工具正文');
    return this.text;
  }
}

function responseHeaders(response, type) {
  const headers = new Headers(response.headers);
  for (const key of ['content-length', 'content-encoding', 'etag']) headers.delete(key);
  headers.set('content-type', type);
  return headers;
}

function completionStatus(reason, usedTool) {
  if (reason === 'length') return '回复达到输出长度上限；已保留收到的文字，可手动继续';
  if (reason === 'content_filter') return '上游因内容过滤结束；已保留收到的文字';
  if (!['stop', 'tool_calls'].includes(reason)) return `上游结束原因：${reason}；请检查回复是否完整`;
  return usedTool ? '工具正文接收完成' : '上游未使用正文工具，本次显示普通回复';
}

function errorPacket(error) {
  return error.upstream || { error: { message: error.message || '接收回复失败', type: 'momiao_transport_error', code: error.code || 'stream_interrupted' } };
}

function restoreStream(response, onStatus) {
  const reader = response.body.getReader(), utf8 = new TextDecoder('utf-8', { fatal: true });
  const content = new ContentDecoder();
  let buffer = '', lines = [], eventSize = 0, toolName = '', toolID, argumentsPending = '', usedTool = false;
  let reason, ended = false, stopped = false, delivered = false, ordinary = false;
  const stream = new ReadableStream({
    async pull(controller) {
      let written = false;
      const emit = data => { controller.enqueue(encoder.encode(typeof data === 'string' ? data : `data: ${JSON.stringify(data)}\n\n`)); written = true; };
      const event = () => {
        if (!lines.length) return;
        const data = lines.join('\n'); lines = []; eventSize = 0;
        if (data === '[DONE]') {
          if (!reason) throw fault('missing_finish_reason', '连接提前结束，未收到模型结束原因');
          if (!usedTool && !ordinary) throw fault('empty_reply', '上游没有返回正文');
          ended = true; emit('data: [DONE]\n\n'); onStatus(completionStatus(reason, usedTool)); return;
        }
        let frame;
        try { frame = JSON.parse(data); } catch { throw fault('invalid_stream', '上游返回的流式数据不是有效 JSON'); }
        if (frame.error) throw Object.assign(fault('upstream_error', '上游返回错误；已保留收到的正文'), { upstream: frame });
        for (const choice of frame.choices || []) {
          if ((choice.index ?? 0) !== 0) throw fault('multiple_choices', '上游返回了多个候选，本次无法安全还原');
          const delta = choice.delta || {};
          if (reason && (choice.finish_reason || Object.values(delta).some(value => value != null && value !== '' && !(Array.isArray(value) && !value.length)))) {
            throw fault('data_after_finish', '上游在结束后又返回正文或结束原因；已保留原始结束状态');
          }
          let decoded = '';
          if (delta.tool_calls?.length) {
            if (reason || delta.tool_calls.length !== 1) throw fault('unexpected_tool', '上游返回了额外工具调用');
            const call = delta.tool_calls[0], fn = call.function || {};
            if ((call.index ?? 0) !== 0 || (call.id && toolID && call.id !== toolID)) throw fault('unexpected_tool', '上游返回了多个工具调用');
            toolID ||= call.id; usedTool = true;
            if (fn.name) {
              if (fn.name !== TOOL) throw fault('unexpected_tool', '上游调用了非正文工具，本插件不会执行它');
              toolName = fn.name;
            }
            if (fn.arguments != null) {
              if (typeof fn.arguments !== 'string') throw fault('invalid_arguments', '上游工具参数不是字符串');
              argumentsPending += fn.arguments;
            }
            if (argumentsPending.length > LIMIT) throw fault('reply_too_large', '工具回复过大');
            if (toolName) { decoded = content.add(argumentsPending); argumentsPending = ''; }
            delete delta.tool_calls;
          }
          if (delta.content) ordinary = true;
          if (decoded) delta.content = (delta.content || '') + decoded;
          if (delta.content && !delivered) { delivered = true; onStatus('正在接收正文…'); }
          if (choice.finish_reason) {
            reason = choice.finish_reason;
            if (usedTool && ['tool_calls', 'stop'].includes(reason)) {
              if (!toolName) throw fault('missing_tool_name', '上游工具缺少名称');
              content.finish(); choice.finish_reason = 'stop';
            } else if (reason === 'tool_calls') throw fault('missing_tool', '上游宣告工具结束，但没有返回工具参数');
          }
          choice.delta = delta;
        }
        emit(frame);
      };
      try {
        while (!written && !stopped) {
          const next = await reader.read();
          buffer += next.done ? utf8.decode() : utf8.decode(next.value, { stream: true });
          if (buffer.length > LIMIT) throw fault('event_too_large', '单个流式事件超过大小限制');
          let end;
          while ((end = buffer.indexOf('\n')) >= 0 && !ended) {
            const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
            if (!line) event();
            else if (line.startsWith('data:')) {
              eventSize += line.length;
              if (eventSize > LIMIT) throw fault('event_too_large', '单个流式事件超过大小限制');
              lines.push(line.slice(5).replace(/^ /, ''));
            }
            else if (line.startsWith(':')) emit(': keepalive\n\n');
          }
          if (ended) { stopped = true; await reader.cancel(); controller.close(); return; }
          if (next.done) throw fault('stream_interrupted', '连接中断或缺少结束标记，已保留收到的正文');
        }
      } catch (error) {
        if (stopped) return;
        stopped = true;
        onStatus(error.name === 'AbortError' ? '已停止生成，未自动重试' : error.message);
        emit(errorPacket(error)); controller.close();
        await reader.cancel().catch(() => {});
      }
    },
    async cancel(reason) { stopped = true; onStatus('已停止接收，未自动重试'); await reader.cancel(reason).catch(() => {}); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText,
    headers: responseHeaders(response, 'text/event-stream; charset=utf-8') });
}

async function restoreJSON(response, stream, onStatus) {
  const value = await response.json();
  if (value.error) throw Object.assign(fault('upstream_error', '上游返回错误'), { upstream: value });
  if (!Array.isArray(value.choices) || value.choices.length !== 1) throw fault('invalid_response', '上游没有返回单条有效回复');
  const choice = value.choices[0], message = choice.message;
  if (!message || !choice.finish_reason) throw fault('invalid_response', '上游回复缺少内容或结束原因');
  const usedTool = Boolean(message.tool_calls?.length);
  if (usedTool) {
    if (message.tool_calls.length !== 1 || message.tool_calls[0].function?.name !== TOOL) throw fault('unexpected_tool', '上游调用了非正文工具，本插件不会执行它');
    const content = new ContentDecoder();
    content.add(message.tool_calls[0].function.arguments);
    message.content = ['length', 'content_filter'].includes(choice.finish_reason) ? content.text : content.finish();
    delete message.tool_calls;
    if (choice.finish_reason === 'tool_calls') choice.finish_reason = 'stop';
  }
  if (!usedTool && choice.finish_reason === 'tool_calls') throw fault('missing_tool', '上游宣告工具结束，但没有返回工具参数');
  if (typeof message.content !== 'string' || !message.content.trim()) throw fault('empty_reply', '上游没有返回正文');
  onStatus(completionStatus(choice.finish_reason, usedTool));
  if (stream) {
    choice.delta = message; delete choice.message;
    return new Response(`data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`,
      { headers: responseHeaders(response, 'text/event-stream; charset=utf-8') });
  }
  return new Response(JSON.stringify(value), { headers: responseHeaders(response, 'application/json; charset=utf-8') });
}

export function createTransportFetch(originalFetch, { origin, getEnabled = () => false, onStatus = () => {},
  getMonitoring = () => false, onRoute = () => {} }) {
  return async function momiaoFetch(input, init) {
    const enabled = getEnabled(), monitoring = getMonitoring();
    if (!enabled && !monitoring) return originalFetch(input, init);
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin); }
    catch { return originalFetch(input, init); }
    const isRequest = input instanceof Request;
    if (url.origin !== origin || url.pathname !== PATH || (init?.method || (isRequest ? input.method : 'GET')).toUpperCase() !== 'POST') return originalFetch(input, init);
    let body;
    try { body = JSON.parse(typeof init?.body === 'string' ? init.body : isRequest && init?.body == null ? await input.clone().text() : 'null'); }
    catch { return originalFetch(input, init); }
    if (body?.chat_completion_source !== 'custom') return originalFetch(input, init);
    let upstream;
    try { upstream = new URL(body.custom_url); } catch { return originalFetch(input, init); }
    if (upstream.protocol !== 'https:' || upstream.hostname !== 'momiao.win' || !/(^|\/)gemini[-_]/i.test(body.model || '') || /image|embedding/i.test(body.model)) return originalFetch(input, init);
    const prepared = enabled ? prepare(body) : null;
    const useTool = prepared && typeof prepared !== 'string';
    const route = monitoring ? createRouteRecord(body.model, useTool ? 'tool' : 'observe', onRoute) : null;
    if (!useTool) {
      if (typeof prepared === 'string') onStatus(`本次按普通请求发送：${prepared}`);
      try { const response = await originalFetch(input, init); return route ? route.observe(response) : response; }
      catch (error) { route?.fail(); throw error; }
    }
    onStatus('已启用正文工具，等待上游回复…');
    const options = { ...init, body: JSON.stringify(prepared) };
    let response;
    try {
      response = isRequest ? await originalFetch(new Request(input, options)) : await originalFetch(input, options);
      if (route) response = route.observe(response);
      if (!response.ok) { onStatus(`上游 HTTP ${response.status}，未自动重试`); return response; }
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        if (!body.stream) { await response.body?.cancel(); throw fault('unexpected_stream', '上游为非流式请求返回了流式数据'); }
        if (!response.body) throw fault('empty_reply', '上游没有返回响应内容');
        return restoreStream(response, onStatus);
      }
      return await restoreJSON(response, body.stream === true, onStatus);
    } catch (error) {
      route?.fail();
      onStatus(error.name === 'AbortError' ? '已停止生成，未自动重试' : `请求未完成：${error.message}`);
      if (!response || error.name === 'AbortError') throw error;
      return new Response(JSON.stringify(errorPacket(error)), { status: 502, headers: { 'content-type': 'application/json' } });
    }
  };
}
