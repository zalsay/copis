import type {
  BrowserAssertStep,
  BrowserClickStep,
  BrowserElementFingerprint,
  BrowserFillStep,
  BrowserLocatorBundle,
  BrowserNavigateStep,
  BrowserPressStep,
  BrowserSelectStep,
  BrowserWaitStep,
  BrowserWorkflowStep,
  BrowserWorkflowValue,
} from '@copis/shared'
import type { BrowserPagePort } from './browser-page-port'

/**
 * 确定性 Workflow 页面执行器所需的底层运行时适配接口
 */
export interface BrowserWorkflowPageRuntime {
  getTab(tabId: string): { id: string; url: string; title: string; isLoading: boolean } | undefined
  navigate(tabId: string, url: string): void
  waitForLoad(tabId: string, timeoutMs: number, signal: AbortSignal): Promise<void>
}

/**
 * 页面级单步输入参数
 */
export interface BrowserWorkflowPageStepInput {
  step:
    | BrowserNavigateStep
    | BrowserClickStep
    | BrowserFillStep
    | BrowserPressStep
    | BrowserSelectStep
    | BrowserWaitStep
    | BrowserAssertStep
  tabId: string
  port: BrowserPagePort
  allowedOrigins: string[]
  variables: Record<string, string | number | boolean>
  signal: AbortSignal
}

/**
 * 页面步骤执行结果
 */
export interface BrowserWorkflowPageStepResult {
  fallbackUsed: boolean
  expectsNewTabAlias?: string
}

export interface LocatorEvaluationOptions {
  bundle: BrowserLocatorBundle
  action?: 'locate' | 'click' | 'fill' | 'select' | 'press' | 'visible' | 'hidden'
  selectValue?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 100

const ALLOWED_PRESS_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
  ' ',
  'Space',
])

const SENSITIVE_SIGNATURE_REGEX = /(?:password|passwd|密码|口令|otp|verification|verify|auth.?code|验证码|校验码|card|credit|cvv|cvc|payment|bank|银行卡|信用卡|支付|captcha|challenge|人机验证|图形码|secret|token|api.?key|密钥|令牌)/i

function delayWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Error('Browser Workflow 已取消'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new Error('Browser Workflow 已取消'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort)
  })
}

function extractOrigin(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.origin
  } catch {
    return ''
  }
}

function compileRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern)
  } catch {
    throw new Error(`无效的 URL 匹配规则: ${pattern}`)
  }
}

function assertPageOriginAndPattern(
  pageUrl: string,
  allowedOrigins: string[],
  stepOrigin: string,
  urlPattern?: string,
  compiledPattern?: RegExp,
): void {
  const origin = extractOrigin(pageUrl)
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new Error(`页面 Origin 不在 Workflow 白名单内: ${origin || pageUrl}`)
  }
  if (stepOrigin && origin !== stepOrigin) {
    throw new Error(`页面 Origin 与步骤不匹配: ${origin} (期望: ${stepOrigin})`)
  }
  if (urlPattern) {
    const regex = compiledPattern ?? compileRegex(urlPattern)
    if (!regex.test(pageUrl)) {
      throw new Error(`页面 URL 不匹配规则: ${pageUrl} (规则: ${urlPattern})`)
    }
  }
}

function resolveWorkflowValue(
  value: BrowserWorkflowValue,
  variables: Record<string, string | number | boolean>,
): string {
  if (value.kind === 'literal') {
    return value.value !== undefined && value.value !== null ? String(value.value) : ''
  }
  if (value.kind === 'variable') {
    const key = value.variableKey
    if (!key || variables[key] === undefined || variables[key] === null) {
      throw new Error(`缺少 Workflow 变量: ${key || 'unknown'}`)
    }
    return String(variables[key])
  }
  return ''
}

function isFingerprintSensitive(fingerprint?: BrowserElementFingerprint): boolean {
  if (!fingerprint) return false
  const inputType = String(fingerprint.inputType || '').toLowerCase()
  if (inputType === 'password' || inputType === 'file') return true
  const texts = [
    fingerprint.accessibleName,
    fingerprint.placeholder,
    fingerprint.nearbyText,
  ].filter(Boolean)
  return texts.some((text) => SENSITIVE_SIGNATURE_REGEX.test(text!))
}

function assertAllowedPressKey(key: string): void {
  if (ALLOWED_PRESS_KEYS.has(key)) return
  if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126) return
  throw new Error(`不支持的页面按键: ${key}`)
}

function resolveKeyCode(key: string): string {
  if (key.length === 1) {
    if (/[a-zA-Z]/.test(key)) return `Key${key.toUpperCase()}`
    if (/[0-9]/.test(key)) return `Digit${key}`
    if (key === ' ') return 'Space'
    return key
  }
  return key
}

function parseSafePoint(point: unknown): { x: number; y: number } {
  if (typeof point === 'object' && point !== null) {
    const record = point as Record<string, unknown>
    const x = record.x
    const y = record.y
    if (
      typeof x === 'number' &&
      Number.isFinite(x) &&
      x >= 0 &&
      x <= 100_000 &&
      typeof y === 'number' &&
      Number.isFinite(y) &&
      y >= 0 &&
      y <= 100_000
    ) {
      return { x, y }
    }
  }
  throw new Error('页面元素坐标无效')
}

interface FrameCandidate {
  id: string
  urls: string[]
  names: string[]
}

function comparableFrameUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

function collectFrameCandidates(
  node: unknown,
  parentUrls: string[],
  parentNames: string[],
  result: FrameCandidate[],
): void {
  if (typeof node !== 'object' || node === null) return
  const record = node as Record<string, unknown>
  const frame = record.frame
  if (typeof frame !== 'object' || frame === null) return
  const frameRecord = frame as Record<string, unknown>
  const id = typeof frameRecord.id === 'string' ? frameRecord.id : undefined
  const url = typeof frameRecord.url === 'string' ? frameRecord.url : ''
  const name = typeof frameRecord.name === 'string' ? frameRecord.name : ''
  const urls = [...parentUrls, url]
  const names = [...parentNames, name]
  if (id) {
    result.push({ id, urls, names })
  }
  if (Array.isArray(record.childFrames)) {
    for (const child of record.childFrames) {
      collectFrameCandidates(child, urls, names, result)
    }
  }
}

function framePathMatches(candidate: FrameCandidate, bundle: BrowserLocatorBundle): boolean {
  const frameUrls = bundle.framePath.frameUrls ?? []
  const frameNames = bundle.framePath.frameNames ?? []
  if (frameUrls.length === 0) return false
  if (candidate.urls.length < frameUrls.length) return false

  const candidateUrlSuffix = candidate.urls.slice(-frameUrls.length)
  const urlMatches = frameUrls.every(
    (url, index) => comparableFrameUrl(url) === comparableFrameUrl(candidateUrlSuffix[index] ?? ''),
  )
  if (!urlMatches) return false

  if (frameNames.length === 0) return true
  if (candidate.names.length < frameNames.length) return false
  const candidateNameSuffix = candidate.names.slice(-frameNames.length)
  return frameNames.every((name, index) => name === (candidateNameSuffix[index] ?? ''))
}

async function resolveFrameExecutionContext(
  port: BrowserPagePort,
  bundle: BrowserLocatorBundle,
  guard: () => void,
): Promise<{ frameId?: string; executionContextId?: number }> {
  const frameUrls = bundle.framePath?.frameUrls ?? []
  if (frameUrls.length === 0) {
    return {}
  }

  guard()
  const response = (await port.send('Page.getFrameTree')) as Record<string, unknown>
  guard()

  const candidates: FrameCandidate[] = []
  if (typeof response === 'object' && response !== null) {
    collectFrameCandidates(response.frameTree, [], [], candidates)
  }

  const matches = candidates.filter((candidate) => framePathMatches(candidate, bundle))
  if (matches.length === 0) {
    throw new Error('Workflow 目标 Frame 不存在或地址已变化')
  }
  if (matches.length > 1) {
    throw new Error('Workflow 目标 Frame 不明确')
  }

  const targetFrame = matches[0]!

  guard()
  const worldResult = (await port.send('Page.createIsolatedWorld', {
    frameId: targetFrame.id,
    worldName: 'copis_workflow_eval',
    grantUniversalAccess: false,
  })) as Record<string, unknown>
  guard()

  if (
    typeof worldResult !== 'object' ||
    worldResult === null ||
    typeof worldResult.executionContextId !== 'number'
  ) {
    throw new Error('无法创建 Workflow Frame 执行环境')
  }

  return { frameId: targetFrame.id, executionContextId: worldResult.executionContextId }
}

async function resolveFrameOwnerOffset(
  port: BrowserPagePort,
  frameId: string,
  guard: () => void,
): Promise<{ x: number; y: number }> {
  guard()
  const owner = (await port.send('DOM.getFrameOwner', { frameId })) as Record<string, unknown>
  guard()

  const backendNodeId =
    typeof owner === 'object' && owner !== null && typeof owner.backendNodeId === 'number'
      ? owner.backendNodeId
      : undefined
  if (backendNodeId === undefined) {
    throw new Error(`无法定位 Workflow Frame 宿主元素: ${frameId}`)
  }

  guard()
  const box = (await port.send('DOM.getBoxModel', { backendNodeId })) as Record<string, unknown>
  guard()

  const model =
    typeof box === 'object' && box !== null && typeof box.model === 'object' && box.model !== null
      ? (box.model as Record<string, unknown>)
      : undefined
  const content = Array.isArray(model?.content) ? (model?.content as unknown[]) : []
  const coordinates = content.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (coordinates.length < 2) {
    throw new Error(`Workflow Frame 宿主坐标无效: ${frameId}`)
  }

  const xValues = coordinates.filter((_, index) => index % 2 === 0)
  const yValues = coordinates.filter((_, index) => index % 2 === 1)
  return { x: Math.min(...xValues), y: Math.min(...yValues) }
}

async function evaluateLocator(
  port: BrowserPagePort,
  bundle: BrowserLocatorBundle,
  action: LocatorEvaluationOptions['action'],
  selectValue: string | undefined,
  executionContextId: number | undefined,
  guard: () => void,
): Promise<Record<string, unknown>> {
  guard()
  const evalParams: Record<string, unknown> = {
    expression: buildLocatorEvaluationSource({ bundle, action, selectValue }),
    returnByValue: true,
    awaitPromise: true,
  }
  if (typeof executionContextId === 'number') {
    evalParams.contextId = executionContextId
  }

  const response = await port.send('Runtime.evaluate', evalParams)
  guard()
  return unwrapEvaluationResult(response)
}

async function evaluatePageText(port: BrowserPagePort, guard: () => void): Promise<string> {
  guard()
  const response = await port.send('Runtime.evaluate', {
    expression: '(() => (document.body ? document.body.innerText || document.body.textContent || "" : ""))()',
    returnByValue: true,
    awaitPromise: true,
  })
  guard()
  return unwrapEvaluationStringResult(response)
}

/**
 * 构建固定只读的页面定位与操作脚本（通过 JSON.stringify 嵌入惰性数据）
 */
export function buildLocatorEvaluationSource(options: LocatorEvaluationOptions): string {
  const payload = JSON.stringify(options)
  return `(() => {
  const options = ${payload};
  const bundle = options.bundle || {};
  const strategies = Array.isArray(bundle.strategies) ? bundle.strategies : [];
  const fingerprint = bundle.fingerprint || {};
  const isInteractiveAction = options.action === 'click' || options.action === 'fill' || options.action === 'press' || options.action === 'select';

  const normalize = (value) => String(value || '').trim().replace(/\\s+/g, ' ');

  const doc = document;

  const isVisible = (element) => {
    if (!element || !element.isConnected) return false;
    const style = window.getComputedStyle ? window.getComputedStyle(element) : element.style;
    if (!style) return false;
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { width: 0, height: 0 };
    return rect.width > 0 && rect.height > 0;
  };

  const isInput = (el) => el && el.tagName && String(el.tagName).toLowerCase() === 'input';
  const isSelect = (el) => el && el.tagName && String(el.tagName).toLowerCase() === 'select';

  const getAccessibleName = (element) => {
    if (!element) return '';
    const ariaLabel = typeof element.getAttribute === 'function' ? element.getAttribute('aria-label') : null;
    if (ariaLabel) return normalize(ariaLabel);
    const labelledBy = typeof element.getAttribute === 'function' ? element.getAttribute('aria-labelledby') : null;
    if (labelledBy) {
      const labelElem = doc.getElementById(labelledBy);
      if (labelElem) return normalize(labelElem.innerText || labelElem.textContent);
    }
    const title = typeof element.getAttribute === 'function' ? element.getAttribute('title') : null;
    if (title) return normalize(title);
    if (element.labels && element.labels.length > 0) {
      const labelText = Array.from(element.labels).map((l) => l.innerText || l.textContent || '').join(' ');
      if (labelText.trim()) return normalize(labelText);
    }
    const alt = typeof element.getAttribute === 'function' ? element.getAttribute('alt') : null;
    if (alt) return normalize(alt);
    const placeholder = typeof element.getAttribute === 'function' ? element.getAttribute('placeholder') : null;
    if (placeholder) return normalize(placeholder);
    if (isInput(element) && (element.type === 'button' || element.type === 'submit' || element.type === 'reset')) {
      return normalize(element.value);
    }
    return normalize(element.innerText || element.textContent || '').slice(0, 200);
  };

  const checkSensitive = (element) => {
    const inputType = isInput(element) ? String(element.type || 'text').toLowerCase() : '';
    if (inputType === 'password') return 'password';
    if (inputType === 'file') return 'file';
    const getAttr = (name) => (typeof element.getAttribute === 'function' ? element.getAttribute(name) || '' : '');
    const signature = [
      getAccessibleName(element),
      element.id || '',
      getAttr('name'),
      getAttr('placeholder'),
      getAttr('autocomplete'),
      getAttr('aria-label'),
    ].join(' ');
    if (/(?:password|passwd|密码|口令)/i.test(signature)) return 'password';
    if (/(?:otp|verification|verify|auth.?code|验证码|校验码)/i.test(signature)) return 'otp';
    if (/(?:card|credit|cvv|cvc|payment|bank|银行卡|信用卡|支付)/i.test(signature)) return 'payment';
    if (/(?:captcha|challenge|人机验证|图形码)/i.test(signature)) return 'captcha';
    if (/(?:secret|token|api.?key|密钥|令牌)/i.test(signature)) return 'secret';
    return null;
  };

  const matchFingerprint = (element) => {
    if (fingerprint.tagName && element.tagName.toLowerCase() !== fingerprint.tagName.toLowerCase()) {
      return false;
    }
    if (fingerprint.inputType) {
      const actualInputType = isInput(element) ? String(element.type || 'text').toLowerCase() : '';
      if (actualInputType !== fingerprint.inputType.toLowerCase()) {
        return false;
      }
    }
    if (fingerprint.accessibleName) {
      const actualAccName = normalize(getAccessibleName(element)).toLowerCase();
      const expectedAccName = normalize(fingerprint.accessibleName).toLowerCase();
      if (actualAccName !== expectedAccName) {
        return false;
      }
    }
    if (typeof fingerprint.enabled === 'boolean') {
      const actualEnabled = !('disabled' in element) || !element.disabled;
      if (actualEnabled !== fingerprint.enabled) {
        return false;
      }
    }
    if (typeof fingerprint.visible === 'boolean') {
      const actualVisible = isVisible(element);
      if (actualVisible !== fingerprint.visible) {
        return false;
      }
    }
    return true;
  };

  const queryByStrategy = (strategy) => {
    try {
      if (strategy.kind === 'testId') {
        const attr = CSS.escape(strategy.attribute);
        const val = CSS.escape(strategy.value);
        return Array.from(doc.querySelectorAll('[' + attr + '="' + val + '"]'));
      }
      if (strategy.kind === 'id') {
        const val = CSS.escape(strategy.value);
        return Array.from(doc.querySelectorAll('#' + val + ', [id="' + val + '"]'));
      }
      if (strategy.kind === 'name') {
        const val = CSS.escape(strategy.value);
        return Array.from(doc.querySelectorAll('[name="' + val + '"]'));
      }
      if (strategy.kind === 'css') {
        return Array.from(doc.querySelectorAll(strategy.value));
      }
      if (strategy.kind === 'role') {
        const role = strategy.role;
        const name = strategy.name ? normalize(strategy.name) : undefined;
        let selector = '[role="' + CSS.escape(role) + '"]';
        if (role === 'button') selector += ', button, input[type="button"], input[type="submit"], input[type="reset"]';
        else if (role === 'link') selector += ', a[href]';
        else if (role === 'checkbox') selector += ', input[type="checkbox"]';
        else if (role === 'radio') selector += ', input[type="radio"]';
        else if (role === 'combobox') selector += ', select';
        else if (role === 'textbox') selector += ', input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea';
        else if (role === 'heading') selector += ', h1, h2, h3, h4, h5, h6';
        else if (role === 'img') selector += ', img';

        const elems = Array.from(doc.querySelectorAll(selector));
        if (name === undefined) return elems;
        return elems.filter((elem) => {
          const accName = getAccessibleName(elem);
          return accName === name || accName.toLowerCase() === name.toLowerCase();
        });
      }
      if (strategy.kind === 'label') {
        const targetLabel = normalize(strategy.value);
        const labels = Array.from(doc.querySelectorAll('label')).filter((l) => normalize(l.innerText || l.textContent) === targetLabel);
        const targetElems = [];
        for (const label of labels) {
          if (label.htmlFor) {
            const target = doc.getElementById(label.htmlFor);
            if (target) targetElems.push(target);
          }
          const nested = label.querySelector('input, select, textarea, button');
          if (nested) targetElems.push(nested);
        }
        if (targetElems.length > 0) return targetElems;
        return Array.from(doc.querySelectorAll('input, select, textarea, button, a')).filter((el) => {
          return getAccessibleName(el) === targetLabel;
        });
      }
      if (strategy.kind === 'text') {
        const targetText = normalize(strategy.value);
        const exact = Boolean(strategy.exact);
        const all = Array.from(doc.querySelectorAll('button, a, p, span, div, h1, h2, h3, h4, h5, h6, li, td, th, label, [role="button"], [role="link"]'));
        const matched = all.filter((el) => {
          const text = normalize(el.innerText || el.textContent);
          return exact ? text === targetText : text.includes(targetText);
        });
        return matched.filter((candidate) => {
          return !matched.some((other) => other !== candidate && candidate.contains(other));
        });
      }
    } catch (_) {
      return [];
    }
    return [];
  };

  for (let strategyIndex = 0; strategyIndex < strategies.length; strategyIndex++) {
    const rawCandidates = queryByStrategy(strategies[strategyIndex]);
    const visibleCandidates = rawCandidates.filter(isVisible);
    if (visibleCandidates.length === 0) continue;
    if (visibleCandidates.length > 1) {
      return { status: 'ambiguous', strategyIndex, count: visibleCandidates.length };
    }
    const target = visibleCandidates[0];

    // 1. 完整指纹一致性检查
    if (!matchFingerprint(target)) {
      continue;
    }

    const enabled = !('disabled' in target) || !target.disabled;
    const sensitiveReason = checkSensitive(target);

    // 2. 在任何副作用前完成所有状态与安全校验
    if (!enabled && isInteractiveAction) {
      return { status: 'found', strategyIndex, enabled: false, visible: true };
    }

    if (sensitiveReason && (options.action === 'fill' || options.action === 'select')) {
      return { status: 'found', strategyIndex, enabled, visible: true, sensitiveReason };
    }

    let optionIndex = -1;
    if (options.action === 'select') {
      if (!isSelect(target)) {
        return { status: 'found', strategyIndex, enabled, visible: true, notSelect: true };
      }
      const selectVal = options.selectValue;
      const optionsList = Array.from(target.options || []);
      optionIndex = optionsList.findIndex((opt) => opt.value === selectVal || normalize(opt.textContent) === selectVal);
      if (optionIndex < 0) {
        return { status: 'found', strategyIndex, enabled, visible: true, optionNotFound: true };
      }
    }

    // 3. 安全检查全部通过后，只有交互动作才允许执行 scroll / focus / mutation
    if (isInteractiveAction) {
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center', inline: 'center' });
      }
      if (typeof target.focus === 'function') {
        target.focus();
      }

      if (options.action === 'select') {
        target.selectedIndex = optionIndex;
        const createEvent = (type) => (typeof Event !== 'undefined' ? new Event(type, { bubbles: true }) : { type, bubbles: true });
        if (typeof target.dispatchEvent === 'function') {
          target.dispatchEvent(createEvent('input'));
          target.dispatchEvent(createEvent('change'));
        }
        return { status: 'found', strategyIndex, point: { x: 0, y: 0 }, enabled: true, visible: true, optionIndex };
      }
    }

    const rect = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 };
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

    return {
      status: 'found',
      strategyIndex,
      point,
      tagName: String(target.tagName || '').toLowerCase(),
      inputType: isInput(target) ? String(target.type || 'text').toLowerCase() : '',
      enabled,
      visible: true,
      sensitiveReason,
    };
  }

  if (fingerprint.tagName && String(fingerprint.tagName).toLowerCase() === 'a' && fingerprint.href) {
    const anchors = Array.from(doc.querySelectorAll('a[href]'));
    const hrefTarget = normalize(fingerprint.href);
    const matchingAnchors = anchors.filter((a) => {
      const href = normalize(typeof a.getAttribute === 'function' ? a.getAttribute('href') || a.href : a.href);
      return href === hrefTarget || href.endsWith(hrefTarget);
    }).filter(isVisible);

    if (matchingAnchors.length > 1) {
      return { status: 'ambiguous', isHrefFallback: true, count: matchingAnchors.length };
    }

    if (matchingAnchors.length === 1) {
      const target = matchingAnchors[0];

      // 1. 完整指纹一致性检查
      if (!matchFingerprint(target)) {
        return { status: 'not_found' };
      }

      const enabled = !('disabled' in target) || !target.disabled;
      const sensitiveReason = checkSensitive(target);

      // 2. 在任何副作用前完成状态与安全校验
      if (options.action === 'select') {
        return { status: 'found', strategyIndex: strategies.length, isHrefFallback: true, enabled, visible: true, notSelect: true };
      }

      if (!enabled && isInteractiveAction) {
        return { status: 'found', strategyIndex: strategies.length, isHrefFallback: true, enabled: false, visible: true };
      }

      if (sensitiveReason && (options.action === 'fill' || options.action === 'select')) {
        return { status: 'found', strategyIndex: strategies.length, isHrefFallback: true, enabled, visible: true, sensitiveReason };
      }

      // 3. 安全检查通过后，只有交互动作才允许执行 scroll / focus
      if (isInteractiveAction) {
        if (typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'center', inline: 'center' });
        }
        if (typeof target.focus === 'function') {
          target.focus();
        }
      }

      const rect = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 };
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return {
        status: 'found',
        strategyIndex: strategies.length,
        isHrefFallback: true,
        point,
        tagName: 'a',
        inputType: '',
        enabled,
        visible: true,
        sensitiveReason,
      };
    }
  }

  return { status: 'not_found' };
})()`
}

function extractEvaluationValue(response: unknown): unknown {
  if (typeof response !== 'object' || response === null) {
    throw new Error('CDP 响应格式无效')
  }
  const record = response as Record<string, unknown>
  if (record.exceptionDetails) {
    const details = record.exceptionDetails as Record<string, unknown>
    const message = typeof details.text === 'string' ? details.text : '页面脚本执行异常'
    throw new Error(`页面脚本执行异常: ${message}`)
  }
  if (!record.result || typeof record.result !== 'object') {
    throw new Error('CDP 评估结果缺失')
  }
  return (record.result as Record<string, unknown>).value
}

function unwrapEvaluationResult(response: unknown): Record<string, unknown> {
  const value = extractEvaluationValue(response)
  if (typeof value !== 'object' || value === null) {
    throw new Error('页面返回结果格式无效')
  }
  return value as Record<string, unknown>
}

function unwrapEvaluationStringResult(response: unknown): string {
  const value = extractEvaluationValue(response)
  if (typeof value !== 'string') {
    throw new Error('页面返回结果格式无效')
  }
  return value
}

async function pollCondition<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw new Error('Browser Workflow 已取消')
    }
    const result = await check()
    if (result) {
      return result === true ? (true as unknown as T) : result
    }
    await delayWithAbort(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal)
  }
  if (signal.aborted) {
    throw new Error('Browser Workflow 已取消')
  }
  throw new Error(timeoutMessage)
}

/**
 * 创建确定性 Browser Workflow 页面执行器
 */
export function createBrowserWorkflowPageExecutor(runtime: BrowserWorkflowPageRuntime): {
  execute(input: BrowserWorkflowPageStepInput): Promise<BrowserWorkflowPageStepResult>
} {
  return {
    async execute(input: BrowserWorkflowPageStepInput): Promise<BrowserWorkflowPageStepResult> {
      const { step, tabId, port, allowedOrigins, variables, signal } = input
      const timeoutMs = typeof step.timeoutMs === 'number' && step.timeoutMs > 0 ? step.timeoutMs : DEFAULT_TIMEOUT_MS
      const compiledStepUrlPattern = step.urlPattern ? compileRegex(step.urlPattern) : undefined

      const requireCurrentTab = (): { id: string; url: string; title: string; isLoading: boolean } => {
        if (signal.aborted) {
          throw new Error('Browser Workflow 已取消')
        }
        const tab = runtime.getTab(tabId)
        if (!tab) {
          throw new Error('当前网页页签不存在')
        }
        return tab
      }

      const guard = (): void => {
        if (signal.aborted) {
          throw new Error('Browser Workflow 已取消')
        }
        const tab = requireCurrentTab()
        if (step.type === 'navigate') {
          assertPageOriginAndPattern(tab.url, allowedOrigins, step.origin)
        } else {
          assertPageOriginAndPattern(tab.url, allowedOrigins, step.origin, step.urlPattern, compiledStepUrlPattern)
        }
      }

      // 1. 处理 navigate 步骤
      if (step.type === 'navigate') {
        const targetOrigin = extractOrigin(step.url)
        if (!targetOrigin || !allowedOrigins.includes(targetOrigin) || targetOrigin !== step.origin) {
          throw new Error(`页面 Origin 不在 Workflow 白名单内: ${targetOrigin || step.url}`)
        }

        runtime.navigate(tabId, step.url)
        await runtime.waitForLoad(tabId, timeoutMs, signal)

        // 导航加载完成后，先校验当前页面真实 Origin（拦截重定向）
        const finalTab = requireCurrentTab()
        assertPageOriginAndPattern(finalTab.url, allowedOrigins, step.origin)

        if (step.urlPattern) {
          await pollCondition(
            async () => {
              const currentTab = requireCurrentTab()
              assertPageOriginAndPattern(currentTab.url, allowedOrigins, step.origin)
              return compiledStepUrlPattern!.test(currentTab.url)
            },
            timeoutMs,
            signal,
            `等待页面 URL 匹配失败: ${step.urlPattern}`,
          )
        }

        return { fallbackUsed: false }
      }

      // 2. 非 navigate 步骤：校验当前页面 Origin
      guard()

      // 解析定位目标的内部执行函数
      const resolveTarget = async (
        bundle: BrowserLocatorBundle,
        action: LocatorEvaluationOptions['action'] = 'locate',
        selectValue?: string,
        allowNotFound = false,
      ): Promise<{ fallbackUsed: boolean; point?: { x: number; y: number } } | undefined> => {
        guard()

        const { frameId, executionContextId } = await resolveFrameExecutionContext(port, bundle, guard)

        const result = await evaluateLocator(port, bundle, action, selectValue, executionContextId, guard)
        const status = String(result.status || '')

        if (status === 'ambiguous') {
          throw new Error('AMBIGUOUS_TARGET: 无法唯一确定 Workflow 元素')
        }
        if (status === 'not_found') {
          if (allowNotFound) return undefined
          throw new Error('无法定位 Workflow 元素: 未找到匹配的可见候选')
        }
        if (status !== 'found') {
          throw new Error(`页面定位返回未知状态: ${status}`)
        }

        const isInteractive = action === 'click' || action === 'fill' || action === 'press' || action === 'select'
        if (result.enabled === false && isInteractive) {
          throw new Error('页面元素当前不可用')
        }
        if (typeof result.sensitiveReason === 'string' && result.sensitiveReason) {
          if (action === 'fill' || action === 'select') {
            throw new Error('Workflow 不允许自动填写敏感字段')
          }
        }
        if (result.notSelect === true) {
          throw new Error('目标元素不是 select 下拉列表')
        }
        if (result.optionNotFound === true) {
          throw new Error('页面选项位置无效')
        }

        const fallbackUsed = (typeof result.strategyIndex === 'number' && result.strategyIndex > 0) || Boolean(result.isHrefFallback)

        let point: { x: number; y: number } | undefined
        if (action === 'click') {
          const inFramePoint = parseSafePoint(result.point)
          if (frameId !== undefined) {
            const offset = await resolveFrameOwnerOffset(port, frameId, guard)
            point = parseSafePoint({ x: inFramePoint.x + offset.x, y: inFramePoint.y + offset.y })
          } else {
            point = inFramePoint
          }
        } else if (action === 'press') {
          point = result.point ? parseSafePoint(result.point) : undefined
        }

        return { fallbackUsed, point }
      }

      // 3. 各操作类型分别派发
      switch (step.type) {
        case 'click': {
          const resolved = await resolveTarget(step.target, 'click')
          if (!resolved || !resolved.point) {
            throw new Error('未获取到元素有效点击坐标')
          }

          const { x, y } = resolved.point
          guard()
          await port.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x,
            y,
            button: 'left',
            clickCount: 1,
          })
          guard()
          await port.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x,
            y,
            button: 'left',
            clickCount: 1,
          })

          if (!step.expect) {
            return { fallbackUsed: resolved.fallbackUsed }
          }

          const expectOutcome = step.expect
          if (expectOutcome.type === 'newTab') {
            return {
              fallbackUsed: resolved.fallbackUsed,
              expectsNewTabAlias: expectOutcome.tabAlias,
            }
          }

          if (expectOutcome.type === 'navigation') {
            const urlPattern = expectOutcome.urlPattern
            if (urlPattern) {
              const compiledNavPattern = compileRegex(urlPattern)
              await pollCondition(
                async () => {
                  const currentTab = requireCurrentTab()
                  const currentOrigin = extractOrigin(currentTab.url)
                  if (!currentOrigin || !allowedOrigins.includes(currentOrigin)) {
                    throw new Error(`页面 Origin 不在 Workflow 白名单内: ${currentOrigin || currentTab.url}`)
                  }
                  return compiledNavPattern.test(currentTab.url)
                },
                timeoutMs,
                signal,
                `等待点击后导航 URL 匹配失败: ${urlPattern}`,
              )
            }
            return { fallbackUsed: resolved.fallbackUsed }
          }

          if (expectOutcome.type === 'visible') {
            const expectTarget = expectOutcome.target
            await pollCondition(
              async () => {
                const expectResolved = await resolveTarget(expectTarget, 'visible', undefined, true)
                return Boolean(expectResolved)
              },
              timeoutMs,
              signal,
              '等待预期元素可见超时',
            )
            return { fallbackUsed: resolved.fallbackUsed }
          }

          return { fallbackUsed: resolved.fallbackUsed }
        }

        case 'fill': {
          if (isFingerprintSensitive(step.target.fingerprint)) {
            throw new Error('Workflow 不允许自动填写敏感字段')
          }
          const text = resolveWorkflowValue(step.value, variables)
          if (text.length > 10_000) {
            throw new Error('单次页面输入不能超过 10000 个字符')
          }

          const resolved = await resolveTarget(step.target, 'fill')
          if (!resolved) {
            throw new Error('无法定位 Workflow 元素')
          }

          const isMac = process.platform === 'darwin'
          const modifier = isMac ? 'Meta' : 'Control'
          const modifierCode = isMac ? 'MetaLeft' : 'ControlLeft'
          const modifierMask = isMac ? 4 : 2

          guard()
          await port.send('Input.dispatchKeyEvent', { type: 'keyDown', key: modifier, code: modifierCode, modifiers: modifierMask })
          guard()
          await port.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: modifierMask })
          guard()
          await port.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: modifierMask })
          guard()
          await port.send('Input.dispatchKeyEvent', { type: 'keyUp', key: modifier, code: modifierCode })
          guard()
          await port.send('Input.insertText', { text })
          return { fallbackUsed: resolved.fallbackUsed }
        }

        case 'press': {
          assertAllowedPressKey(step.key)
          let fallbackUsed = false
          if (step.target) {
            const resolved = await resolveTarget(step.target, 'press')
            fallbackUsed = Boolean(resolved?.fallbackUsed)
          }

          const code = resolveKeyCode(step.key)
          guard()
          await port.send('Input.dispatchKeyEvent', { type: 'keyDown', key: step.key, code })
          guard()
          await port.send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.key, code })
          return { fallbackUsed }
        }

        case 'select': {
          if (isFingerprintSensitive(step.target.fingerprint)) {
            throw new Error('Workflow 不允许自动填写敏感字段')
          }
          const selectValue = resolveWorkflowValue(step.value, variables)
          if (selectValue.length > 500) {
            throw new Error('单次下拉选择值不能超过 500 个字符')
          }
          const resolved = await resolveTarget(step.target, 'select', selectValue)
          return { fallbackUsed: Boolean(resolved?.fallbackUsed) }
        }

        case 'wait': {
          if (step.condition.type === 'url') {
            const pattern = step.condition.pattern
            const compiledWaitPattern = compileRegex(pattern)
            await pollCondition(
              async () => {
                const currentTab = requireCurrentTab()
                assertPageOriginAndPattern(currentTab.url, allowedOrigins, step.origin)
                return compiledWaitPattern.test(currentTab.url)
              },
              timeoutMs,
              signal,
              '等待页面条件超时',
            )
            return { fallbackUsed: false }
          }

          if (step.condition.type === 'text') {
            const expectedText = step.condition.value
            await pollCondition(
              async () => {
                const bodyText = await evaluatePageText(port, guard)
                return bodyText.includes(expectedText)
              },
              timeoutMs,
              signal,
              '等待页面条件超时',
            )
            return { fallbackUsed: false }
          }

          if (step.condition.type === 'visible') {
            const targetBundle = step.condition.target
            const resolved = await pollCondition(
              async () => {
                return resolveTarget(targetBundle, 'visible', undefined, true)
              },
              timeoutMs,
              signal,
              '等待页面条件超时',
            )
            return { fallbackUsed: typeof resolved === 'object' && resolved !== null ? Boolean(resolved.fallbackUsed) : false }
          }

          throw new Error('不支持的 wait 条件类型')
        }

        case 'assert': {
          if (step.condition.type === 'url') {
            const pattern = step.condition.pattern
            const compiledAssertPattern = compileRegex(pattern)
            await pollCondition(
              async () => {
                const currentTab = requireCurrentTab()
                assertPageOriginAndPattern(currentTab.url, allowedOrigins, step.origin)
                return compiledAssertPattern.test(currentTab.url)
              },
              timeoutMs,
              signal,
              `页面断言失败: URL 不匹配规则 ${pattern}`,
            )
            return { fallbackUsed: false }
          }

          if (step.condition.type === 'text') {
            const { value: expectedText, exact } = step.condition
            await pollCondition(
              async () => {
                const rawText = await evaluatePageText(port, guard)
                const text = rawText.trim()
                return exact ? text === expectedText : text.includes(expectedText)
              },
              timeoutMs,
              signal,
              `页面断言失败: 文本不匹配 ${expectedText}`,
            )
            return { fallbackUsed: false }
          }

          if (step.condition.type === 'visible') {
            if (!step.target) {
              throw new Error('visible 断言必须指定 target')
            }
            const targetBundle = step.target
            const resolved = await pollCondition(
              async () => {
                return resolveTarget(targetBundle, 'visible', undefined, true)
              },
              timeoutMs,
              signal,
              '页面断言失败: 目标元素未处于可见状态',
            )
            return { fallbackUsed: typeof resolved === 'object' && resolved !== null ? Boolean(resolved.fallbackUsed) : false }
          }

          if (step.condition.type === 'hidden') {
            if (!step.target) {
              throw new Error('hidden 断言必须指定 target')
            }
            const targetBundle = step.target
            await pollCondition(
              async () => {
                guard()
                const { executionContextId } = await resolveFrameExecutionContext(port, targetBundle, guard)
                const unwrap = await evaluateLocator(port, targetBundle, 'locate', undefined, executionContextId, guard)
                const status = String(unwrap.status || '')
                if (status === 'ambiguous') {
                  throw new Error('AMBIGUOUS_TARGET: 无法唯一确定 Workflow 元素')
                }
                if (status === 'not_found' || unwrap.visible === false) {
                  return true
                }
                if (status === 'found') {
                  return false
                }
                throw new Error(`页面定位返回未知状态: ${status}`)
              },
              timeoutMs,
              signal,
              '页面断言失败: 目标元素仍处于可见状态',
            )
            return { fallbackUsed: false }
          }

          throw new Error('不支持的 assert 条件类型')
        }

        default: {
          const exhaustiveStep: never = step
          throw new Error(`不支持的页面步骤类型: ${(exhaustiveStep as { type?: unknown }).type}`)
        }
      }
    },
  }
}
