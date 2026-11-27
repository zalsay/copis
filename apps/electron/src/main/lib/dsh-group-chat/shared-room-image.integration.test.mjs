import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { createSharedRoomSession } from './shared-room-session.mjs';

const runtimeDir = process.env.COPIS_DSH_RC2_RUNTIME;


test('RC2 原生图片：两种协议发送图片且后续轮次不重发', { skip: !runtimeDir, timeout: 30000 }, async t => {
  const sharp = createRequire(join(runtimeDir, 'package.json'))('sharp');
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#12aa57' } }).png().toBuffer();
  const dir = await mkdtemp(join(tmpdir(), 'room-images-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push(JSON.parse(body));
    res.setHeader('content-type', 'text/event-stream');
    const anthropic = req.url.includes('/messages');
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '好的', annotations: [] }] };
    const response = { id: 'resp_fixture', object: 'response', model: 'vision', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 } };
    const events = anthropic ? [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'vision', content: [], usage: { input_tokens: 4, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ] : [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...item.content[0], text: '' } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '好的' },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  for (const protocol of ['openai-responses', 'anthropic-messages']) {
    const session = await createSharedRoomSession({ runtimeDir, provider: `test-${protocol}`, model: 'vision', documents: [], journalDir: dir, ownerId: 'test', roomId: protocol, agentId: 'agent', transport: { protocol, baseURL: `http://127.0.0.1:${server.address().port}/v1`, readKey: () => 'fixture', assertActive() {} } });
    t.after(() => session.revoke());
    await session.submit('image', '看图', [{ bytes: png, mimeType: 'image/png' }]);
    await session.submit('text', '继续');
    const first = calls.at(-2), second = calls.at(-1);
    const content = protocol === 'openai-responses' ? first.input.flatMap(m => m.content || []) : first.messages.flatMap(m => Array.isArray(m.content) ? m.content : []);
    const image = content.find(b => b.type === (protocol === 'openai-responses' ? 'input_image' : 'image'));
    assert.ok(image, `缺少 ${protocol} 原生图片块`);
    const encoded = protocol === 'openai-responses' ? image.image_url.split(',')[1] : image.source.data;
    const sent = Buffer.from(encoded, 'base64');
    assert.deepEqual(await sharp(sent).removeAlpha().raw().toBuffer(), await sharp(png).removeAlpha().raw().toBuffer(), '模型收到的图片像素必须与输入一致');
    assert.ok(!JSON.stringify(content.filter(b => b.type === 'text' || b.type === 'input_text')).includes(encoded), '图片不能混入文本');
    assert.equal(JSON.stringify(second).includes(encoded), false, '后续文本轮次不应重发旧图');
    assert.equal(first.tools?.length ?? 0, 0);
    await assert.rejects(session.submit('invalid', '坏图', [{ bytes: Buffer.from('bad'), mimeType: 'image/png' }]));
    await session.submit('again', '再看', [{ bytes: png, mimeType: 'image/png' }]);
    const last = JSON.stringify(calls.at(-1));
    assert.ok(last.includes(encoded), '后续图片轮次应仍能正常发送');
  }
});
