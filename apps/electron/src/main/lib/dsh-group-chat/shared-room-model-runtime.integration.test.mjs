import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createPackage } from '@electron/asar';

const require = createRequire(import.meta.url);
const runtime = process.env.COPIS_DSH_RC2_RUNTIME;
const binary = process.env.COPIS_ROOM_RUST_BINARY;
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
function responses(res, model) {
  const part = { type: 'output_text', text: '本机回答', annotations: [] };
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [part] };
  const response = {
    id: 'resp_fixture',
    object: 'response',
    model,
    status: 'completed',
    output: [item],
    usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
  };
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: part.text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ])
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

test(
  '真实 Electron ASAR → RC2 → 账号自定义渠道 / Rust 群主专用内置代理',
  { skip: !runtime || !binary, timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'copis-room-model-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const calls = [];
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP438AARwzEcQB+ohfxXaFgBQAAAABJRU5ErkJggg==';
    const endpoint = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.end('{}');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      // 只保存身份分类，不在断言或日志中输出 Authorization。
      const blocks = (data.input ?? data.messages ?? []).flatMap(m => Array.isArray(m.content) ? m.content : []);
      const image = blocks.find(part => part.type === 'input_image' || part.type === 'image');
      const encoded = image?.source?.data ?? image?.image_url?.split(',')[1];
      calls.push({
        // 只记录真实 wire 图片块（模型适配器可能重采样），不把提示词或图像内容打入日志。
        hasImage: typeof encoded === 'string' && Buffer.from(encoded, 'base64').length > 16,
        model: data.model,
        path: req.url,
        owner:
          data.model === 'custom'
            ? req.headers['x-api-key'] === 'fixture-custom'
            : req.headers.authorization === 'Bearer fixture-owner',
        tools: data.tools?.length ?? 0,
      });
      res.setHeader('Content-Type', 'text/event-stream');
      if (data.model !== 'custom') return responses(res, data.model);
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: 'custom',
            content: [],
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '本机回答' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ];
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    const upstream = `http://127.0.0.1:${await listen(endpoint)}`;
    t.after(() => endpoint.close());
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise((r) => reservation.close(r));
    await mkdir(join(dir, 'cwd'));
    const rust = spawn(binary, [], {
      cwd: dir,
      env: {
        COPIS_PAYMENT_WORKSPACE_SLUG: 'default',
        COPIS_PAYMENT_WORKSPACE_PROJECT_ROOT: dir,
        COPIS_PAYMENT_WORKSPACE_CWD: join(dir, 'cwd'),
        COPIS_PAYMENT_HOME_ROOT: join(dir, '.copis', 'payment'),
        HOME: dir,
        PATH: process.env.PATH,
        COPIS_CONFIG_DIR: dir,
        COPIS_MEMORY_DIR: dir,
        COPIS_HTTP_API_PORT: String(port),
        COPIS_BACKEND_URL: upstream,
        COPIS_AUTH_ISSUER: upstream,
        COPIS_MODEL_REQUEST_BASE_URL: upstream,
        COPIS_HTTP_API_INTERNAL_TOKEN: 'fixture-internal',
      },
    });
    t.after(() => rust.kill());
    let rustDiagnostic = '';
    rust.stderr.on('data', (s) => {
      rustDiagnostic += s;
    });
    createInterface({ input: rust.stdout }).on('line', (line) => {
      const [id, , path] = line.split('\t');
      const load = Buffer.from(path, 'hex').toString() === '/api/internal/auth-storage/load';
      const body = load ? { accessToken: 'fixture-owner', provider: 'legacy', user: { id: 'owner' } } : {};
      rust.stdin.write(`${id}\t200\t${Buffer.from(JSON.stringify(body)).toString('hex')}\n`);
    });
    const rustURL = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      if (
        await fetch(rustURL + '/health').then(
          () => true,
          () => false,
        )
      )
        break;
      assert.ok(i < 100 && rust.exitCode === null, '隔离 Rust 未启动: ' + rustDiagnostic);
      await new Promise((r) => setTimeout(r, 40));
    }
    const app = join(dir, 'app');
    await mkdir(app);
    const grantPath = rustURL + '/api/internal/shared-room-model-capability';
    const command = JSON.stringify({ action: 'issue', userId: 'owner', modelId: 'fast', reasoningEffort: 'low' });
    for (const headers of [
      {},
      { 'X-Copis-Internal-Token': 'fixture-internal', Origin: 'http://localhost:5173' },
    ]) {
      assert.equal(
        (await fetch(grantPath, { method: 'POST', body: command, headers })).ok,
        false,
        '只能由可信主进程签发',
      );
    }
    const root = join(dir, '.copis');
    const modules = join(root, 'modules');
    const versionDir = 'versions/dsh/fixture-rc2';
    const installed = resolve(runtime, '..');
    const lock = JSON.parse(await readFile(join(installed, 'module-lock.json'), 'utf8'));
    await mkdir(join(modules, 'versions/dsh'), { recursive: true });
    await symlink(installed, join(modules, versionDir), 'junction');
    const manifest = join(modules, 'active.json');
    await writeFile(manifest, JSON.stringify({ modules: { dsh: { ...lock.package, versionDir } } }));
    const catalogFile = join(root, 'working-model-catalog.json');
    const account = (key) => ({
      apiKeys: { a: Buffer.from(key).toString('base64') },
      catalog: {
        categories: [],
        models: [
          {
            id: 'a',
            name: '本机测试',
            modelId: 'custom',
            protocol: 'anthropic-messages',
            thinkingLevel: 'low',
            baseUrl: upstream,
          },
        ],
      },
    });
    const ownerAccount = account('fixture-custom');
    ownerAccount.catalog.models.push({ ...ownerAccount.catalog.models[0], id: 'no-owner-key' });
    const otherAccount = account('fixture-other');
    otherAccount.catalog.models[0].id = 'no-owner-key';
    otherAccount.apiKeys = { 'no-owner-key': Buffer.from('fixture-other').toString('base64') };
    await writeFile(
      catalogFile,
      JSON.stringify({
        version: 1,
        accounts: { owner: ownerAccount, other: otherAccount },
      }),
    );
    const fixtures = {
      'settings-service': `export const getSettings=()=>globalThis.roomSettings,updateSettings=()=>{throw Error()};`,
      'working-api-service': `export const getWorkingApiClient=()=>({baseUrl:${JSON.stringify(rustURL)},getCachedUser:()=>({id:'owner'}),getIdentityRevision:()=>globalThis.rev});`,
      'working-auth-store': `export const getWorkingTokenStore=()=>({getUser:()=>({id:'owner'})}),subscribeWorkingIdentity=()=>()=>{};`,
      'safe-storage': `export const safeStorage={isEncryptionAvailable:()=>true,decryptString:b=>b.toString()};`,
      'channel-manager': `export const testChannelDirect=()=>{throw Error()};`,
      'proxy-settings-service': `export const getEffectiveProxyUrl=()=>{throw Error()};`,
      'http-api-server': `export const getHttpApiInternalToken=()=>'fixture-internal';`,
      'dsh-model-config': `export const resolveDshWorkingReasoningEffort=()=>'low';`,
    };
    const bootstrap = `const {app}=require('electron');const assert=require('node:assert/strict');
    import {openRoomModelRuntime as open,getRoomModelCatalog as list} from './shared-room-model-runtime';
    app.whenReady().then(async()=>{
      assert.ok(__filename.includes('.asar')); assert.equal(require('node:os').homedir(),${JSON.stringify(dir)}); globalThis.rev=1;
      const b={roomId:'r',workspaceId:'w',userId:'owner',roomAgentId:'a',displayName:'助手'};
      globalThis.roomSettings={};
      const builtin=list('owner').current, custom={channelId:'copis-custom-a',modelId:'custom'};
      assert.deepEqual(builtin,{channelId:'copis-working-deepseek',modelId:'deepseek-v4-flash'});
      assert.deepEqual(list('owner').options.filter(o=>o.channelId.startsWith('copis-custom-')),[{...custom,name:'本机测试'}]);
      const old=await open(b); assert.deepEqual(old.modelSelection,builtin);
      await assert.rejects(open({...b,modelSelection:{...custom,modelId:'removed'}}));
      const next=await open({...b,modelSelection:custom}); assert.deepEqual(next.modelSelection,custom);
      assert.deepEqual(list('owner',next.modelSelection).current,custom);
      const pro={channelId:builtin.channelId,modelId:'deepseek-v4-pro'};
      const nonDefault=await open({...b,modelSelection:pro}); assert.deepEqual(nonDefault.modelSelection,pro);
      for(const [i,s] of [old,next,nonDefault].entries()){
        const id='call'+i;
        const images=i<2?[{mimeType:'image/png',bytes:Buffer.from(${JSON.stringify(png)},'base64')}]:[];
        assert.deepEqual(await Promise.all([s.submit(id,'你好',images),s.submit(id,'你好',images)]),['本机回答','本机回答']);
      }
      globalThis.rev++;
      for(const [i,s] of [old,next,nonDefault].entries()){
        await assert.rejects(s.submit('changed','切号')); await s.revoke();
        const restarted=await open({...b,modelSelection:s.modelSelection});
        await assert.rejects(restarted.submit('call'+i,'重投')); await restarted.revoke();
      }
      await assert.rejects(open({...b,userId:'other'}));
      globalThis.roomSettings={agentChannelId:'unknown'}; await assert.rejects(open(b));
      globalThis.roomSettings={agentChannelId:'copis-custom-a',agentModelId:'other-model'}; await assert.rejects(open(b));
      globalThis.roomSettings={}; const fs=require('node:fs'); const manifest=${JSON.stringify(manifest)}; const activeFile=fs.readFileSync(manifest); fs.unlinkSync(manifest); await assert.rejects(open(b)); fs.writeFileSync(manifest,activeFile);
      globalThis.roomSettings={agentChannelId:'copis-custom-a',agentModelId:'custom'};
      const active=await open(b); const file=${JSON.stringify(catalogFile)};
      const catalog=JSON.parse(fs.readFileSync(file,'utf8')); delete catalog.accounts.owner; fs.writeFileSync(file,JSON.stringify(catalog));
      const remaining=list('owner',active.modelSelection); assert.equal(remaining.current,null);
      assert.ok(remaining.options.some(o=>o.channelId===builtin.channelId && o.modelId===builtin.modelId));
      assert.ok(!remaining.options.some(o=>o.channelId===custom.channelId));
      await assert.rejects(active.submit('removed','原账号的密钥已撤回')); await active.revoke();
      await assert.rejects(open(b));
    }).then(()=>app.exit(0),err=>{console.error(err.message);app.exit(1)});`;
    await build({
      stdin: { contents: bootstrap, resolveDir: import.meta.dirname },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: join(app, 'main.cjs'),
      plugins: [
        {
          name: '隔离账号与配置',
          setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
              const name =
                args.path === 'electron' && args.importer.endsWith('working-model-catalog.ts')
                  ? 'safe-storage'
                  : args.path.replace(/^\.\.?\//, '');
              if (Object.hasOwn(fixtures, name)) return { path: name, namespace: 'fixture' };
            });
            b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: fixtures[args.path] }));
          },
        },
      ],
    });
    await writeFile(
      join(app, 'package.json'),
      JSON.stringify({ name: 'room-probe', version: '1.0.0', main: 'main.cjs' }),
    );
    const archive = join(dir, 'app.asar');
    await createPackage(app, archive);
    const electron = spawn(require('electron'), [archive, `--user-data-dir=${dir}/profile`], {
      env: {
        HOME: dir,
        USERPROFILE: dir,
        COPIS_DEV: '0',
        PATH: process.env.PATH,
        TMPDIR: tmpdir(),
        DSH_HOME: join(dir, 'dsh'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    t.after(() => electron.kill());
    let diagnostic = '';
    electron.stderr.on('data', (s) => {
      diagnostic += s;
    });
    assert.equal(
      (await once(electron, 'exit'))[0],
      0,
      diagnostic.replace(/fixture-[\w-]+|cwm_room_[a-f0-9]{64}/g, '[测试值]'),
    );
    assert.deepEqual(calls, [
      { hasImage: true, model: 'deepseek-v4-flash', path: '/v1/responses', owner: true, tools: 0 },
      { hasImage: true, model: 'custom', path: '/v1/messages?beta=true', owner: true, tools: 0 },
      { hasImage: false, model: 'deepseek-v4-pro', path: '/v1/responses', owner: true, tools: 0 },
    ]);
  },
);
