import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransportFetch } from './transport.mjs';

// One request/response regression. The only double is the remote network boundary.
test('tool transport displays fragmented text early and never conceals an incomplete reply', { timeout: 5000 }, async () => {
  const encoder = new TextEncoder();
  const origin = 'http://localhost:8000';
  const url = `${origin}/api/backends/chat-completions/generate`;
  const body = { chat_completion_source: 'custom', custom_api_format: 'openai_compat',
    custom_url: 'https://momiao.win/v1', model: 'AIS/gemini-4-argon', stream: true,
    messages: [{ role: 'user', content: '写一句问候' }], max_tokens: 1024 };
  const signal = new AbortController().signal;
  let upstream, sent, capturedSignal, calls = 0;
  const statuses = [], routes = [];
  const wrapped = createTransportFetch(async (input, init) => {
    calls++;
    sent = JSON.parse(init.body); capturedSignal = init.signal;
    return new Response(new ReadableStream({ start(controller) { upstream = controller; } }),
      { headers: { 'content-type': 'text/event-stream' } });
  }, { origin, getEnabled: () => true, getMonitoring: () => true,
    onRoute: route => routes.push(route), onStatus: text => statuses.push(text) });

  const response = await wrapped(url, { method: 'POST', body: JSON.stringify(body), signal });
  assert.equal(sent.tools?.[0]?.function?.parameters?.properties?.content?.type, 'string');
  assert.equal(sent.custom_url, body.custom_url);
  assert.equal(sent.model, body.model);
  assert.equal(capturedSignal, signal);
  assert.deepEqual(sent.messages.find(m => m.role === 'user'), body.messages[0]);
  const name = sent.tools[0].function.name;
  const reader = response.body.getReader();
  const packet = (argumentsText, first = false) => `data: ${JSON.stringify({ id: 'test', ...(first ? { model: 'gemini-3.1-flash-lite' } : {}), choices: [{ index: 0,
    delta: { tool_calls: [{ index: 0, ...(first ? { id: 'call-1', type: 'function' } : {}),
      function: { ...(first ? { name } : {}), arguments: argumentsText } }] }, finish_reason: null }] })}\r\n\r\n`;
  // Split inside Chinese UTF-8 bytes as well as inside JSON unicode escapes.
  const first = encoder.encode(packet('{"content":"你好，', true));
  const boundary = first.indexOf(0xe4) + 1;
  upstream.enqueue(first.slice(0, boundary)); upstream.enqueue(first.slice(boundary));
  const firstRead = await reader.read();
  let output = new TextDecoder().decode(firstRead.value);
  assert.match(output, /你好/); // Must arrive before upstream is allowed to finish.
  for (const fragment of ['\\uD83', 'D\\uDE0', 'A\\n\\"朋友\\"\\\\结束', '"}']) upstream.enqueue(encoder.encode(packet(fragment)));
  upstream.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":9}}\n\ndata: [DONE]\n\n'));
  upstream.close();
  for (;;) { const r = await reader.read(); if (r.done) break; output += new TextDecoder().decode(r.value); }
  const frames = output.split(/\r?\n/).filter(x => x.startsWith('data: ') && x !== 'data: [DONE]').map(x => JSON.parse(x.slice(6)));
  assert.equal(frames.map(x => x.choices?.[0]?.delta?.content || '').join(''), '你好，😊\n"朋友"\\结束');
  assert.equal(frames.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(frames.at(-1).usage.completion_tokens, 9);
  assert.ok(frames.every(x => !x.choices?.[0]?.delta?.tool_calls));
  assert.match(output, /data: \[DONE\]/);
  assert.equal(calls, 1);
  assert.equal(routes.at(-1).requestedModel, body.model);
  assert.deepEqual(routes.at(-1).fields, [{ field: 'model', value: 'gemini-3.1-flash-lite' }]);
  assert.deepEqual(routes.at(-1).finishReasons, ['tool_calls']);
  assert.equal(routes.at(-1).state, 'complete');
  assert.doesNotMatch(JSON.stringify(routes), /写一句问候|朋友|结束/);

  const incomplete = await wrapped(url, { method: 'POST', body: JSON.stringify(body), signal });
  upstream.enqueue(encoder.encode(packet('{"content":"已收到半句', true))); upstream.close();
  const partial = await incomplete.text();
  assert.match(partial, /已收到半句/);
  assert.match(partial, /"error"/);
  assert.doesNotMatch(partial, /data: \[DONE\]/);
  assert.equal(calls, 2); // No hidden retry.

  const limited = await wrapped(url, { method: 'POST', body: JSON.stringify(body), signal });
  upstream.enqueue(encoder.encode(packet('{"content":"长度受限的半句', true)));
  upstream.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'));
  upstream.close();
  const limitedText = await limited.text();
  assert.match(limitedText, /长度受限的半句/);
  assert.match(limitedText, /"finish_reason":"length"/);
  assert.ok(statuses.at(-1).includes('长度上限'));

  let cancelled = false;
  const cancelFetch = createTransportFetch(async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }), { origin, getEnabled: () => true });
  const cancellable = await cancelFetch(url, { method: 'POST', body: JSON.stringify(body) });
  await cancellable.body.cancel();
  assert.equal(cancelled, true);

  const jsonFetch = createTransportFetch(async request => {
    assert.equal(request.headers.get('x-test-header'), 'preserved');
    const payload = await request.json();
    assert.equal(payload.tools[0].function.name, name);
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'call-json', type: 'function', function: { name, arguments: '{"content":"一次性回复"}' } }] },
      finish_reason: 'tool_calls' }], usage: { completion_tokens: 5 } });
  }, { origin, getEnabled: () => true });
  const jsonReply = await jsonFetch(new Request(url, { method: 'POST', headers: { 'x-test-header': 'preserved' },
    body: JSON.stringify({ ...body, stream: false }) }));
  const json = await jsonReply.json();
  assert.equal(json.choices[0].message.content, '一次性回复');
  assert.equal(json.choices[0].message.tool_calls, undefined);
  assert.equal(json.choices[0].finish_reason, 'stop');
  assert.equal(json.usage.completion_tokens, 5);

  const contradictory = await wrapped(url, { method: 'POST', body: JSON.stringify(body) });
  upstream.enqueue(encoder.encode(packet('{"content":"上游文字"}', true)));
  upstream.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n'));
  upstream.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  upstream.close();
  const inconsistent = await contradictory.text();
  assert.match(inconsistent, /"error"/);
  assert.doesNotMatch(inconsistent, /data: \[DONE\]/);
  assert.notEqual(statuses.at(-1), '工具正文接收完成');

  const oversized = await wrapped(url, { method: 'POST', body: JSON.stringify(body) });
  // Each line fits individually; a single unfinished multi-line event does not.
  const line = encoder.encode(`data: ${'x'.repeat(2100000)}\n`);
  upstream.enqueue(line); upstream.enqueue(line); upstream.close();
  assert.match(await oversized.text(), /event_too_large/);

  // Observation works with protection off and never edits the response or prompt.
  const observed = [];
  const raw = 'data: {"model":"gemini-4-argon","modelVersion":"gemini-3.1-flash-lite","choices":[]}\n\n' +
    'data: {"model":"gemini-4-argon","choices":[{"delta":{"content":"ordinary"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const monitor = createTransportFetch(async (_input, init) => {
    assert.deepEqual(JSON.parse(init.body), body);
    return new Response(raw, { headers: { 'content-type': 'text/event-stream' } });
  }, { origin, getMonitoring: () => true, onRoute: route => observed.push(route) });
  assert.equal(await (await monitor(url, { method: 'POST', body: JSON.stringify(body) })).text(), raw);
  assert.deepEqual(observed.at(-1).fields, [
    { field: 'model', value: 'gemini-4-argon' }, { field: 'modelVersion', value: 'gemini-3.1-flash-lite' },
  ]);
  const absent = [];
  const missing = createTransportFetch(async () => Response.json({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] }),
    { origin, getMonitoring: () => true, onRoute: route => absent.push(route) });
  await (await missing(url, { method: 'POST', body: JSON.stringify({ ...body, stream: false }) })).text();
  assert.deepEqual(absent.at(-1).fields, []); // Never fill a missing response model from the request.
  assert.equal(absent.at(-1).state, 'complete');

  const malformed = 'data: invalid-json\n\ndata: [DONE]\n\n';
  const tolerant = createTransportFetch(async () => new Response(malformed, { headers: { 'content-type': 'text/event-stream' } }),
    { origin, getMonitoring: () => true, onRoute: () => { throw new Error('panel closed'); } });
  assert.equal(await (await tolerant(url, { method: 'POST', body: JSON.stringify(body) })).text(), malformed);
});
