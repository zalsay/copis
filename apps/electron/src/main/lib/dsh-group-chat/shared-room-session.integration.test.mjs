import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createSharedRoomSession } from './shared-room-session.mjs';

// 显式指定受信的本机安装目录；探针不读取用户的 DSH_HOME、账号、模型密钥或实际工作区。
const runtimeDir = process.env.COPIS_DSH_RC2_RUNTIME;
test('RC2：两群独立会话、发布资料、重复调用、撤回进行中的调用', {
  skip: !runtimeDir,
  timeout: 15000
}, async t => {
  const resolve = createRequire(join(runtimeDir, 'package.json')).resolve;
  const {
    LlmAdapter
  } = await import(pathToFileURL(resolve('@deepseek-ai/dsh-llm')));
  const journalDir = await mkdtemp(join(tmpdir(), 'copis-shared-invocations-'));
  t.after(() => rm(journalDir, {
    recursive: true,
    force: true
  }));
  const seen = [];
  let started;
  const pending = new Promise(r => {
    started = r;
  });
  class OfflineAdapter extends LlmAdapter {
    requestedTool = false;
    async resolveModel(provider, model) {
      return {
        id: model,
        provider,
        name: model
      };
    }
    async *stream(options) {
      const input = JSON.stringify(options.messages);
      seen.push(input);
      assert.equal(options.tools?.length ?? 0, 0, '不应向模型提供工具');
      if (seen.length > 10) throw new Error('测试模型超过预期调用次数');
      if (input.includes('连续工具请求') || input.includes('工具门禁') && !this.requestedTool) {
        this.requestedTool = true;
        const args = '{}';
        yield {
          type: 'block-start',
          index: 0,
          blockType: 'tool-call'
        };
        yield {
          type: 'tool-call-delta',
          index: 0,
          id: 'probe-call',
          name: 'private_reader',
          argumentsDelta: args
        };
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'probe-call',
            name: 'private_reader',
            arguments: args
          }
        };
        yield {
          type: 'finish',
          reason: {
            kind: 'tool-calls'
          }
        };
        return;
      }
      if (input.includes('等待撤回')) {
        started();
        await new Promise(resolve => {
          if (options.signal.aborted) resolve();else options.signal.addEventListener('abort', resolve, {
            once: true
          });
        });
        return;
      }
      yield {
        type: 'block-start',
        index: 0,
        blockType: 'text'
      };
      yield {
        type: 'text-delta',
        index: 0,
        text: '已阅读'
      };
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'text',
          text: '已阅读'
        }
      };
      yield {
        type: 'finish',
        reason: {
          kind: 'stop'
        }
      };
    }
  }
  const open = async (roomId, documents) => {
    const session = await createSharedRoomSession({
      runtimeDir,
      adapter: new OfflineAdapter(),
      provider: 'room-test',
      model: 'offline',
      documents,
      journalDir,
      ownerId: 'owner-a',
      roomId,
      agentId: 'shared-writer'
    });
    t.after(() => session.revoke());
    return session;
  };
  const a = await open('room-a', [{
      title: 'A群资料',
      text: 'A群专属摘要-321'
    }]),
    b = await open('room-b', []);
  const result = await Promise.all([a.submit('call-1', '总结资料'), a.submit('call-1', '总结资料')]);
  assert.deepEqual(result, ['已阅读', '已阅读']);
  assert.equal(await a.submit('call-1', '总结资料'), '已阅读');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /A群专属摘要-321/);
  await b.submit('call-1', 'B群对话');
  assert.equal(seen.length, 2);
  assert.doesNotMatch(seen[1], /A群专属摘要-321|总结资料/);
  const restarted = await open('room-a', []);
  await assert.rejects(restarted.submit('call-1', '重复投递'), /核对/);
  assert.equal(seen.length, 2);
  await a.submit('tools-gate', '工具门禁');
  assert.match(seen.at(-1), /unknown tool|not found|共享群不开放主机工具/i);
  const count = seen.length;
  await assert.rejects(a.submit('step-limit', '连续工具请求'));
  assert.equal(seen.length - count, 2, '无工具会话不得因模型反复请求工具而无限调用');
  const blocked = assert.rejects(b.submit('call-2', '等待撤回'));
  await pending;
  await b.revoke();
  await blocked;
  await assert.rejects(b.submit('call-3', '继续'));
});
