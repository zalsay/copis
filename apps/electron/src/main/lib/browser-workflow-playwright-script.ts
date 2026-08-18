import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWorkflowStep, BrowserWorkflowVersion } from '@copis/shared'
import { getAgentWorkspace, getAgentWorkspaceBrowserWorkflowsDir } from './agent-workspace-manager'
import { assertBrowserWorkflowVersion } from './browser-workflow-schema'

function assertSafeWorkflowId(workflowId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(workflowId)) throw new Error('Browser Workflow ID 不合法')
  return workflowId
}

function resolveWorkflowDirectory(workspaceId: string, workflowId: string): string {
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace) throw new Error('Browser Workflow 工作区不存在')
  return join(getAgentWorkspaceBrowserWorkflowsDir(workspace), assertSafeWorkflowId(workflowId))
}

function writeAtomically(filePath: string, source: string): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, source, 'utf8')
    renameSync(temporaryPath, filePath)
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
  }
}

function compileVersion(version: BrowserWorkflowVersion): {
  schemaVersion: 1
  workflowId: string
  version: number
  start: BrowserWorkflowVersion['start']
  allowedOrigins: string[]
  variables: Array<Pick<BrowserWorkflowVersion['variables'][number], 'key' | 'type' | 'required' | 'options'>>
  steps: BrowserWorkflowStep[]
} {
  return {
    schemaVersion: 1,
    workflowId: version.workflowId,
    version: version.version,
    start: version.start,
    allowedOrigins: [...new Set([version.start.origin, ...version.steps.map((step) => step.origin)])],
    variables: version.variables.map((variable) => ({
      key: variable.key,
      type: variable.type,
      required: variable.required,
      ...(variable.options ? { options: variable.options } : {}),
    })),
    steps: version.steps,
  }
}

/** 生成只依赖运行时环境变量的 Playwright Workflow ESM 脚本。 */
export function buildBrowserWorkflowPlaywrightScript(version: BrowserWorkflowVersion): string {
  assertBrowserWorkflowVersion(version)
  const workflow = JSON.stringify(compileVersion(version), null, 2)
  return `/* Copis Browser Workflow v${version.version}；运行时参数只从受控环境变量读取。 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const workflow = ${workflow};
const DEFAULT_TIMEOUT = 15000;
const endpoint = requiredEnv('COPIS_PLAYWRIGHT_CDP_ENDPOINT');
const targetId = requiredEnv('COPIS_PLAYWRIGHT_TARGET_ID');
const coreEntry = requiredEnv('COPIS_PLAYWRIGHT_CORE_ENTRY');
const requireFromScript = createRequire(import.meta.url);
const artifactDirectory = process.env.COPIS_PLAYWRIGHT_ARTIFACT_DIR || '';
const variables = parseVariables(process.env.COPIS_PLAYWRIGHT_VARIABLES);
const commands = [];
const commandWaiters = [];
let inputBuffer = '';
let browser;
let context;
let currentPage;
const pages = new Map();
const ignoredSessions = new Set();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  let newlineIndex = inputBuffer.indexOf('\\n');
  while (newlineIndex >= 0) {
    const line = inputBuffer.slice(0, newlineIndex).trim();
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    newlineIndex = inputBuffer.indexOf('\\n');
    if (!line) continue;
    try {
      const command = JSON.parse(line);
      if (!command || typeof command.type !== 'string') continue;
      const waiterIndex = commandWaiters.findIndex((waiter) => waiter.type === command.type);
      if (waiterIndex >= 0) {
        const waiter = commandWaiters.splice(waiterIndex, 1)[0];
        waiter.resolve(command);
      } else {
        commands.push(command);
      }
    } catch (_) {
      // 主进程只发送结构化控制消息，忽略损坏的输入行。
    }
  }
});

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error('缺少 Playwright Workflow 运行参数: ' + name);
  return value;
}

function parseVariables(value) {
  if (!value) return {};
  let parsed;
  try { parsed = JSON.parse(value); } catch (_) { throw new Error('Playwright Workflow 变量不是有效 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Playwright Workflow 变量格式无效');
  return parsed;
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\\n');
}

function waitForCommand(type) {
  const commandIndex = commands.findIndex((command) => command.type === type);
  if (commandIndex >= 0) return Promise.resolve(commands.splice(commandIndex, 1)[0]);
  return new Promise((resolve) => commandWaiters.push({ type, resolve }));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timeoutFor(step) {
  return typeof step.timeoutMs === 'number' && step.timeoutMs > 0 ? step.timeoutMs : DEFAULT_TIMEOUT;
}

function normalizedUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return String(value);
  }
}

function originOf(value) {
  try { return new URL(String(value)).origin; } catch (_) { return ''; }
}

function assertOrigin(page, expectedOrigin) {
  const origin = originOf(page.url());
  if (!origin || !workflow.allowedOrigins.includes(origin)) throw new Error('页面 Origin 不在 Workflow 白名单内: ' + origin);
  if (expectedOrigin && origin !== expectedOrigin) throw new Error('页面 Origin 与步骤不匹配: ' + origin);
}

async function createCdpTransport(endpoint) {
  const baseEndpoint = String(endpoint).replace(/\\/+$/, '');
  const response = await fetch(baseEndpoint + '/json/version');
  if (!response.ok) throw new Error('获取 Electron CDP WebSocket 地址失败: HTTP ' + response.status);
  let details;
  try {
    details = await response.json();
  } catch (_) {
    throw new Error('Electron CDP 版本信息不是有效 JSON');
  }
  const wsEndpoint = details && typeof details.webSocketDebuggerUrl === 'string'
    ? details.webSocketDebuggerUrl
    : '';
  if (!wsEndpoint) throw new Error('Electron CDP 版本信息缺少 webSocketDebuggerUrl');
  const initialIgnoredTargetIds = new Set();
  try {
    const targetResponse = await fetch(baseEndpoint + '/json');
    if (targetResponse.ok) {
      const targets = await targetResponse.json();
      if (Array.isArray(targets)) {
        for (const target of targets) {
          const targetUrl = target && typeof target.url === 'string' ? target.url : '';
          const origin = originOf(targetUrl);
          if (target && target.type === 'page' && typeof target.id === 'string'
            && target.id !== targetId && targetUrl !== 'about:blank'
            && (!origin || !workflow.allowedOrigins.includes(origin))) {
            initialIgnoredTargetIds.add(target.id);
          }
        }
      }
    }
  } catch (_) {
    // DevTools 的 /json 列表不是所有 Electron 版本都提供，连接仍可继续。
  }

  const socket = new WebSocket(wsEndpoint);
  socket.binaryType = 'arraybuffer';
  let closed = false;
  let resolveOpen;
  let rejectOpen;
  const explicitlyAttachedTargetIds = new Set();
  const openPromise = new Promise((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  const transport = {
    onmessage: undefined,
    onclose: undefined,
    send(message) {
      if (closed) throw new Error('Electron CDP WebSocket 已关闭');
      if (message.method === 'Target.attachToTarget' && message.params && message.params.targetId) {
        explicitlyAttachedTargetIds.add(message.params.targetId);
      }
      socket.send(JSON.stringify(message));
    },
    close() {
      if (!closed) socket.close();
    },
  };
  function shouldIgnoreMessage(message) {
    if (message.method === 'Target.attachedToTarget') {
      const targetInfo = message.params && message.params.targetInfo;
      const sessionId = message.params && message.params.sessionId;
      if (sessionId && targetInfo && initialIgnoredTargetIds.has(targetInfo.targetId)
        && !explicitlyAttachedTargetIds.has(targetInfo.targetId)) {
        ignoredSessions.add(sessionId);
        return true;
      }
    }
    if (message.sessionId && ignoredSessions.has(message.sessionId)) return true;
    if (message.method === 'Target.detachedFromTarget' && message.params && message.params.sessionId) {
      ignoredSessions.delete(message.params.sessionId);
      return true;
    }
    return false;
  }
  socket.addEventListener('open', () => {
    resolveOpen();
  });
  socket.addEventListener('message', async (event) => {
    try {
      const data = event.data;
      const text = typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(data))
          : ArrayBuffer.isView(data)
            ? new TextDecoder().decode(data)
            : data && typeof data.text === 'function'
              ? await data.text()
              : String(data);
      const message = JSON.parse(text);
      if (shouldIgnoreMessage(message)) return;
      if (transport.onmessage) transport.onmessage(message);
    } catch (error) {
      transport.onclose?.(error instanceof Error ? error.message : String(error));
    }
  });
  socket.addEventListener('error', () => {
    const error = new Error('Electron CDP WebSocket 连接失败');
    rejectOpen(error);
    transport.onclose?.(error.message);
  });
  socket.addEventListener('close', (event) => {
    closed = true;
    transport.onclose?.(event.reason || 'Electron CDP WebSocket 已关闭');
  });
  try {
    await openPromise;
  } catch (error) {
    transport.close();
    throw error;
  }
  return transport;
}

async function connectToTarget() {
  const imported = requireFromScript(coreEntry);
  const chromium = imported.chromium;
  if (!chromium || typeof chromium.connectOverCDP !== 'function') throw new Error('Playwright Core 入口不可用');
  const transport = await createCdpTransport(endpoint);
  browser = await chromium.connectOverCDP(transport);
  const deadline = Date.now() + DEFAULT_TIMEOUT;
  while (Date.now() < deadline) {
    for (const candidateContext of browser.contexts()) {
      for (const page of candidateContext.pages()) {
        let cdp;
        try {
          cdp = await candidateContext.newCDPSession(page);
          const info = await cdp.send('Target.getTargetInfo');
          if (info && info.targetInfo && info.targetInfo.targetId === targetId) {
            context = candidateContext;
            currentPage = page;
            pages.set(workflow.start.tabAlias, page);
            return;
          }
        } catch (_) {
          // 页面可能正在导航，下一轮重新枚举目标。
        } finally {
          await cdp?.detach().catch(() => undefined);
        }
      }
    }
    await sleep(50);
  }
  throw new Error('未找到指定的 Workflow CDP target');
}

function frameFor(page, locator) {
  const frameUrls = locator.framePath && Array.isArray(locator.framePath.frameUrls) ? locator.framePath.frameUrls : [];
  const frameNames = locator.framePath && Array.isArray(locator.framePath.frameNames) ? locator.framePath.frameNames : [];
  if (frameUrls.length === 0 && frameNames.length === 0) return page.mainFrame();
  const matches = page.frames().filter((frame) => {
    if (frame === page.mainFrame()) return false;
    const urls = [frame.url()];
    const names = [frame.name()];
    const urlMatch = frameUrls.length === 0 || (frameUrls.length === 1
      ? normalizedUrl(frameUrls[0]) === normalizedUrl(urls[urls.length - 1])
      : frameUrls.length === urls.length && frameUrls.every((value, index) => normalizedUrl(value) === normalizedUrl(urls[index])));
    const nameMatch = frameNames.length === 0 || (frameNames.length === 1
      ? frameNames[0] === names[names.length - 1]
      : frameNames.length === names.length && frameNames.every((value, index) => value === names[index]));
    return urlMatch && nameMatch;
  });
  if (matches.length !== 1) throw new Error(matches.length === 0 ? 'Workflow 目标 Frame 不存在或地址已变化' : 'Workflow 目标 Frame 不明确，已拒绝执行');
  return matches[0];
}

function locatorForStrategy(frame, strategy) {
  if (strategy.kind === 'testId') return frame.locator('[' + strategy.attribute + '=' + JSON.stringify(strategy.value) + ']');
  if (strategy.kind === 'id') return frame.locator('#' + strategy.value.replace(/([\\\\.#:,\\[\\]])/g, '\\\\$1'));
  if (strategy.kind === 'name') return frame.locator('[name=' + JSON.stringify(strategy.value) + ']');
  if (strategy.kind === 'css') return frame.locator(strategy.value);
  if (strategy.kind === 'label') return frame.getByLabel(strategy.value, { exact: true });
  if (strategy.kind === 'role') return frame.getByRole(strategy.role, strategy.name ? { name: strategy.name } : undefined);
  if (strategy.kind === 'text') return frame.getByText(strategy.value, { exact: strategy.exact });
  return undefined;
}

async function resolveLocator(page, bundle) {
  const frame = frameFor(page, bundle);
  const strategies = Array.isArray(bundle.strategies) ? bundle.strategies : [];
  for (let strategyIndex = 0; strategyIndex < strategies.length; strategyIndex += 1) {
    const locator = locatorForStrategy(frame, strategies[strategyIndex]);
    if (!locator) continue;
    const count = await locator.count();
    if (count === 0) continue;
    const candidates = [];
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) candidates.push(candidate);
    }
    if (candidates.length === 1) return { locator: candidates[0], fallbackUsed: strategyIndex > 0 };
    if (candidates.length > 1) throw new Error('AMBIGUOUS_TARGET: 无法唯一确定 Workflow 元素');
  }
  const fingerprint = bundle.fingerprint || {};
  if (fingerprint.tagName === 'a' && fingerprint.href) {
    const locator = frame.locator('a[href=' + JSON.stringify(fingerprint.href) + ']');
    if (await locator.count() === 1 && await locator.isVisible().catch(() => false)) return { locator, fallbackUsed: true };
  }
  throw new Error('无法定位 Workflow 元素');
}

function valueFor(value) {
  if (!value || value.kind === 'literal') return value && value.value !== undefined ? String(value.value) : '';
  const resolved = variables[value.variableKey];
  if (resolved === undefined || resolved === null) throw new Error('缺少 Workflow 变量: ' + (value.variableKey || 'unknown'));
  return String(resolved);
}

async function waitUntil(check, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error('等待页面条件超时');
}

async function activePage(alias) {
  const page = pages.get(alias);
  if (!page || page.isClosed()) throw new Error('找不到页签别名: ' + alias);
  currentPage = page;
  return page;
}

async function executeStep(step) {
  const page = await activePage(step.tabAlias);
  const timeout = timeoutFor(step);
  if (step.type === 'openTab') {
    const next = await context.newPage();
    pages.set(step.newTabAlias, next);
    currentPage = next;
    if (step.url) {
      if (!workflow.allowedOrigins.includes(originOf(step.url))) throw new Error('页面 Origin 不在 Workflow 白名单内: ' + originOf(step.url));
      await next.goto(step.url, { waitUntil: 'load', timeout });
      assertOrigin(next, step.origin);
    }
    return;
  }
  if (step.type === 'switchTab') {
    await activePage(step.targetTabAlias);
    assertOrigin(currentPage, step.origin);
    return;
  }
  if (step.type === 'closeTab') {
    const target = await activePage(step.targetTabAlias);
    void target.close().catch(() => undefined);
    pages.delete(step.targetTabAlias);
    if (currentPage === target) currentPage = page;
    return;
  }
  if (step.type === 'navigate') {
    if (!workflow.allowedOrigins.includes(originOf(step.url)) || originOf(step.url) !== step.origin) throw new Error('导航地址不在 Workflow Origin 白名单内');
    await page.goto(step.url, { waitUntil: 'load', timeout });
    await waitUntil(() => {
      assertOrigin(page, step.origin);
      return !step.urlPattern || new RegExp(step.urlPattern).test(page.url());
    }, timeout);
    return;
  }
  assertOrigin(page, step.origin);
  if (step.type === 'manual') {
    emit({ type: 'waiting_user', stepId: step.id, message: step.instruction });
    await waitForCommand('continue_manual');
    assertOrigin(page, step.origin);
    emit({ type: 'resumed', stepId: step.id });
    return;
  }
  if (step.type === 'click') {
    const resolved = await resolveLocator(page, step.target);
    if (resolved.fallbackUsed) emit({ type: 'fallback_used', stepId: step.id });
    const before = new Set(context.pages());
    await resolved.locator.click({ timeout });
    if (!step.expect) return;
    if (step.expect.type === 'newTab') {
      await waitUntil(() => context.pages().some((candidate) => !before.has(candidate)), timeout);
      const next = context.pages().find((candidate) => !before.has(candidate));
      if (!next) throw new Error('Workflow 新页签没有返回有效页签');
      pages.set(step.expect.tabAlias, next);
      currentPage = next;
      assertOrigin(next, '');
      return;
    }
    if (step.expect.type === 'navigation') {
      await waitUntil(() => {
        const origin = originOf(page.url());
        if (!origin || !workflow.allowedOrigins.includes(origin)) throw new Error('页面 Origin 不在 Workflow 白名单内: ' + origin);
        return !step.expect.urlPattern || new RegExp(step.expect.urlPattern).test(page.url());
      }, timeout);
      return;
    }
    const expected = await resolveLocator(page, step.expect.target);
    await expected.locator.waitFor({ state: 'visible', timeout });
    return;
  }
  if (step.type === 'fill') {
    const resolved = await resolveLocator(page, step.target);
    if (resolved.fallbackUsed) emit({ type: 'fallback_used', stepId: step.id });
    await resolved.locator.fill(valueFor(step.value), { timeout });
    return;
  }
  if (step.type === 'press') {
    if (!step.target) await page.keyboard.press(step.key);
    else {
      const resolved = await resolveLocator(page, step.target);
      if (resolved.fallbackUsed) emit({ type: 'fallback_used', stepId: step.id });
      await resolved.locator.press(step.key, { timeout });
    }
    return;
  }
  if (step.type === 'select') {
    const resolved = await resolveLocator(page, step.target);
    if (resolved.fallbackUsed) emit({ type: 'fallback_used', stepId: step.id });
    await resolved.locator.selectOption(valueFor(step.value), { timeout });
    return;
  }
  if (step.type === 'wait') {
    await waitUntil(async () => {
      assertOrigin(page, step.origin);
      if (step.condition.type === 'url') return new RegExp(step.condition.pattern).test(page.url());
      if (step.condition.type === 'text') return (await page.locator('body').innerText().catch(() => '')).includes(step.condition.value);
      const resolved = await resolveLocator(page, step.condition.target).catch(() => undefined);
      return Boolean(resolved && await resolved.locator.isVisible().catch(() => false));
    }, timeout);
    return;
  }
  if (step.type === 'assert') {
    await waitUntil(async () => {
      assertOrigin(page, step.origin);
      if (step.condition.type === 'url') return new RegExp(step.condition.pattern).test(page.url());
      if (step.condition.type === 'text') {
        const text = await page.locator('body').innerText().catch(() => '');
        return step.condition.exact ? text.trim() === step.condition.value : text.includes(step.condition.value);
      }
      if (!step.target) return false;
      const resolved = await resolveLocator(page, step.target).catch(() => undefined);
      const visible = Boolean(resolved && await resolved.locator.isVisible().catch(() => false));
      return step.condition.type === 'hidden' ? !visible : visible;
    }, timeout);
  }
}

function isDisconnected(error) {
  const message = String(error && error.message ? error.message : error);
  return /Target page, context or browser has been closed|browser has been closed|Browser has been closed|Target .* closed|Connection closed|Protocol error/i.test(message);
}

async function writeFailureArtifacts(error, stepId) {
  if (!artifactDirectory) return;
  await mkdir(artifactDirectory, { recursive: true });
  const artifacts = [];
  const page = currentPage;
  if (page && !page.isClosed()) {
    try {
      await page.screenshot({ path: join(artifactDirectory, 'failure.png'), fullPage: true });
      artifacts.push('failure.png');
    } catch (_) {}
  }
  try {
    const url = page && !page.isClosed() ? page.url() : '';
    await writeFile(join(artifactDirectory, 'failure.json'), JSON.stringify({ capturedAt: Date.now(), stepId, message: String(error && error.message ? error.message : error), url: originOf(url) ? normalizedUrl(url) : '' }, null, 2));
    artifacts.push('failure.json');
  } catch (_) {}
  if (artifacts.length) emit({ type: 'artifacts', artifacts });
}

async function main() {
  await connectToTarget();
  emit({ type: 'ready', targetId });
  let index = 0;
  while (index < workflow.steps.length) {
    const step = workflow.steps[index];
    emit({ type: 'step_started', stepId: step.id });
    try {
      await executeStep(step);
      emit({ type: 'step_completed', stepId: step.id });
      index += 1;
    } catch (error) {
      if (isDisconnected(error)) {
        emit({ type: 'paused', stepId: step.id, message: '网页 CDP 会话已断开' });
        await waitForCommand('resume_cdp');
        await connectToTarget();
        emit({ type: 'resumed', stepId: step.id });
        continue;
      }
      await writeFailureArtifacts(error, step.id);
      throw new Error('步骤 ' + step.id + '（' + step.type + '）失败: ' + String(error && error.message ? error.message : error));
    }
  }
  emit({ type: 'completed' });
}

try {
  await main();
} catch (error) {
  emit({ type: 'error', message: String(error && error.message ? error.message : error) });
  process.exitCode = 1;
} finally {
  process.stdin.destroy();
  await browser?.close().catch(() => undefined);
}
`
}

export function getBrowserWorkflowPlaywrightScriptSha256(version: BrowserWorkflowVersion): string {
  return createHash('sha256').update(buildBrowserWorkflowPlaywrightScript(version)).digest('hex')
}

export function assertBrowserWorkflowPlaywrightScriptIntegrity(
  version: BrowserWorkflowVersion,
  scriptPath: string,
): void {
  const expected = version.approval.playwrightScriptSha256
  if (!expected) {
    throw new Error('已确认 Browser Workflow 缺少 Playwright 脚本摘要，请重新确认并生成版本')
  }
  let actual: string
  try {
    actual = createHash('sha256').update(readFileSync(scriptPath)).digest('hex')
  } catch {
    throw new Error('Playwright Workflow 脚本无法读取，请重新确认并生成版本')
  }
  if (actual !== expected) {
    throw new Error('Playwright Workflow 脚本校验失败：脚本内容已变化，请重新确认并生成版本')
  }
}

function writeVersionScript(workspaceId: string, version: BrowserWorkflowVersion, fileName: string): string {
  const directory = join(resolveWorkflowDirectory(workspaceId, version.workflowId), 'playwright')
  const path = join(directory, fileName)
  writeAtomically(path, buildBrowserWorkflowPlaywrightScript(version))
  return path
}

export function getBrowserWorkflowPlaywrightVersionPath(
  workspaceId: string,
  workflowId: string,
  version: number,
): string {
  return join(resolveWorkflowDirectory(workspaceId, workflowId), 'playwright', `v${version}.mjs`)
}

export function writeBrowserWorkflowPlaywrightDraft(workspaceId: string, version: BrowserWorkflowVersion): string {
  return writeVersionScript(workspaceId, version, 'draft.mjs')
}

export function writeBrowserWorkflowPlaywrightVersion(workspaceId: string, version: BrowserWorkflowVersion): string {
  return writeVersionScript(workspaceId, version, `v${version.version}.mjs`)
}
