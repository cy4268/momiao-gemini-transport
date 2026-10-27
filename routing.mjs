// Observe only explicit response metadata. A returned name is a claim by the
// responding adapter, not proof of the model running behind Google's endpoint.
const LIMIT = 4 * 1024 * 1024;
let sequence = 0;

export function createRouteRecord(requestedModel, mode, onRoute) {
  const record = { id: ++sequence, startedAt: Date.now(), requestedModel: String(requestedModel).slice(0, 256),
    mode, state: 'waiting', httpStatus: null, fields: [], finishReasons: [], note: '' };
  const publish = () => {
    try { onRoute({ ...record, fields: record.fields.map(item => ({ ...item })), finishReasons: [...record.finishReasons] }); }
    catch { /* UI observation must never affect generation. */ }
  };
  const finish = state => {
    if (['complete', 'cancelled', 'error', 'incomplete'].includes(record.state)) return;
    record.state = state; publish();
  };
  publish();
  return {
    fail: () => finish('error'),
    observe(response) {
      record.httpStatus = response.status;
      record.state = response.ok ? 'receiving' : 'error'; publish();
      if (!response.ok || !response.body) { finish('incomplete'); return response; }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      const sse = response.headers.get('content-type')?.includes('text/event-stream');
      let buffer = '', lines = [], size = 0, disabled = false, done = false;
      const note = text => { if (record.note !== text) { record.note = text; publish(); } };
      const parse = text => {
        let value;
        try { value = JSON.parse(text); }
        catch { note('有元数据无法解析；原始回复继续传递'); return; }
        if (!value || typeof value !== 'object') return;
        let changed = false;
        for (const [field, candidate] of [
          ['model', value.model], ['modelVersion', value.modelVersion],
          ['response.model', value.response?.model], ['response.modelVersion', value.response?.modelVersion],
        ]) {
          if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 256) continue;
          if (record.fields.some(item => item.field === field && item.value === candidate)) continue;
          if (record.fields.length >= 16) { note('模型字段过多，仅保留前 16 个'); continue; }
          record.fields.push({ field, value: candidate }); changed = true;
        }
        if (Array.isArray(value.choices)) for (const choice of value.choices) {
          const reason = choice?.finish_reason;
          if (typeof reason === 'string' && reason.length <= 80 && !record.finishReasons.includes(reason) && record.finishReasons.length < 8) {
            record.finishReasons.push(reason); changed = true;
          }
        }
        if (changed) publish();
        if (value.error) finish('error');
      };
      const inspect = chunk => {
        if (disabled || done) return;
        buffer += chunk;
        if (buffer.length > LIMIT) {
          disabled = true; buffer = ''; lines = [];
          note('单个元数据事件过大，已停止解析；原始回复继续传递'); return;
        }
        if (!sse) return;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0 && !done) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          if (!line) {
            if (!lines.length) continue;
            const data = lines.join('\n'); lines = []; size = 0;
            if (data === '[DONE]') { done = true; finish('complete'); }
            else parse(data);
          } else if (line.startsWith('data:')) {
            size += line.length;
            if (size > LIMIT) {
              disabled = true; lines = []; buffer = '';
              note('单个元数据事件过大，已停止解析；原始回复继续传递'); return;
            }
            lines.push(line.slice(5).replace(/^ /, ''));
          }
        }
      };
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              inspect(decoder.decode());
              if (!sse && !disabled) parse(buffer);
              finish(sse && !done ? 'incomplete' : 'complete');
              controller.close(); return;
            }
            inspect(decoder.decode(next.value, { stream: true }));
            controller.enqueue(next.value);
          } catch (error) { finish('error'); controller.error(error); }
        },
        async cancel(reason) { finish('cancelled'); await reader.cancel(reason); },
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  };
}
