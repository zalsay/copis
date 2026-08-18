import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type BrowserPageCursorPhase = 'move' | 'press' | 'type' | 'select' | 'key' | 'scroll' | 'hide'

export interface BrowserPageCursorInput {
  phase: BrowserPageCursorPhase
  x?: number
  y?: number
}

const MAX_CURSOR_COORDINATE = 100_000
const CURSOR_RESOURCE_NAME = 'cursor_rainbow.svg'
const CURSOR_MOVE_DURATION_MS = 420
const CURSOR_MOVE_FALLBACK_MS = CURSOR_MOVE_DURATION_MS + 80
const CURSOR_AUTO_HIDE_DELAY_MS = 2_000

export interface BrowserPageCursorResourcePathOptions {
  resourcesPath?: string
  moduleDir?: string
  cwd?: string
  exists?: (candidate: string) => boolean
}

export function resolveBrowserPageCursorResourcePath(
  options: BrowserPageCursorResourcePathOptions = {},
): string | undefined {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  const moduleDir = options.moduleDir ?? __dirname
  const cwd = options.cwd ?? process.cwd()
  const exists = options.exists ?? existsSync
  const packagedResourcePath = typeof resourcesPath === 'string' && resourcesPath.length > 0
    ? join(resourcesPath, CURSOR_RESOURCE_NAME)
    : undefined

  const resourcePath = [
    packagedResourcePath,
    join(moduleDir, 'resources', CURSOR_RESOURCE_NAME),
    typeof cwd === 'string' && cwd.length > 0
      ? join(cwd, 'resources', CURSOR_RESOURCE_NAME)
      : undefined,
    join(moduleDir, '../../../resources', CURSOR_RESOURCE_NAME),
  ].find((candidate): candidate is string => candidate !== undefined && exists(candidate))

  return resourcePath
}

function loadCursorSvgDataUrl(): string {
  const resourcePath = resolveBrowserPageCursorResourcePath()

  if (!resourcePath) {
    throw new Error(`AI 浏览器指针资源不存在: ${CURSOR_RESOURCE_NAME}`)
  }

  return `data:image/svg+xml;base64,${readFileSync(resourcePath).toString('base64')}`
}

const CURSOR_SVG_DATA_URL = loadCursorSvgDataUrl()

function safeCoordinate(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_CURSOR_COORDINATE, value))
}

function coordinateExpression(value: number | undefined, centerExpression: string | undefined): string {
  if (value === undefined && centerExpression) {
    return `Math.max(0, Math.min(${MAX_CURSOR_COORDINATE}, ${centerExpression}))`
  }
  return String(safeCoordinate(value))
}

export function buildBrowserPageCursorSource(input: BrowserPageCursorInput): string {
  const phase = JSON.stringify(input.phase)
  const x = coordinateExpression(input.x, input.phase === 'scroll' ? 'window.innerWidth / 2' : undefined)
  const y = coordinateExpression(input.y, input.phase === 'scroll' ? 'window.innerHeight / 2' : undefined)
  const xDeclaration = input.x === undefined && input.phase === 'scroll'
    ? `const x = Number.isFinite(${x}) ? ${x} : 0;`
    : `const x = ${x};`
  const yDeclaration = input.y === undefined && input.phase === 'scroll'
    ? `const y = Number.isFinite(${y}) ? ${y} : 0;`
    : `const y = ${y};`

  return `(() => {
  const marker = 'data-copis-ai-browser-cursor';
  const phase = ${phase};
  const cursorImage = ${JSON.stringify(CURSOR_SVG_DATA_URL)};
  ${xDeclaration}
  ${yDeclaration}
  const existing = document.querySelector('[' + marker + ']');
  if (phase === 'hide') {
    if (existing instanceof HTMLElement) {
      if (typeof existing.__copisAiBrowserCursorHideTimer === 'number') {
        window.clearTimeout(existing.__copisAiBrowserCursorHideTimer);
      }
      existing.remove();
    }
    return { ok: true };
  }
  const root = document.documentElement || document.body;
  if (!root) return { ok: false };
  const cursorState = (() => {
    const existingState = window.__copisAiBrowserCursorState;
    if (existingState && typeof existingState === 'object') return existingState;
    const nextState = {};
    window.__copisAiBrowserCursorState = nextState;
    return nextState;
  })();
  let cursor = existing instanceof HTMLElement ? existing : null;
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.setAttribute(marker, '');
    cursor.setAttribute('aria-hidden', 'true');
    root.appendChild(cursor);
  }
  let style = document.querySelector('[data-copis-ai-browser-cursor-style]');
  if (!(style instanceof HTMLStyleElement)) {
    style = document.createElement('style');
    style.setAttribute('data-copis-ai-browser-cursor-style', '');
    style.textContent = '@keyframes copis-ai-browser-cursor-move { 0% { opacity: 0; transform: translate(-2px, -2px) scale(.65); } 35% { opacity: 1; transform: translate(-2px, -2px) scale(1); } 100% { opacity: .9; transform: translate(-2px, -2px) scale(1); } } @keyframes copis-ai-browser-cursor-press { 0% { opacity: 1; transform: translate(-2px, -2px) scale(1); } 45% { opacity: 1; transform: translate(-2px, -2px) scale(.72); } 100% { opacity: .9; transform: translate(-2px, -2px) scale(1); } }';
    (document.head || root).appendChild(style);
  }
  if (typeof cursor.__copisAiBrowserCursorHideTimer === 'number') {
    window.clearTimeout(cursor.__copisAiBrowserCursorHideTimer);
  }
  const token = (typeof cursor.__copisAiBrowserCursorToken === 'number' ? cursor.__copisAiBrowserCursorToken : 0) + 1;
  cursor.__copisAiBrowserCursorToken = token;
  const hasPreviousPosition = Number.isFinite(cursorState.x) && Number.isFinite(cursorState.y);
  const startX = !hasPreviousPosition ? Math.max(0, Math.min(${MAX_CURSOR_COORDINATE}, window.innerWidth / 2)) : cursorState.x;
  const startY = !hasPreviousPosition ? Math.max(0, Math.min(${MAX_CURSOR_COORDINATE}, window.innerHeight / 2)) : cursorState.y;
  const moveNeeded = !hasPreviousPosition || cursorState.x !== x || cursorState.y !== y;
  cursor.style.cssText = 'pointer-events:none;position:fixed;z-index:2147483647;width:44px;height:56px;left:' + startX + 'px;top:' + startY + 'px;display:block;contain:strict;opacity:.95;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));background-image:url(' + cursorImage + ');background-repeat:no-repeat;background-position:center;background-size:contain;transition:left ${CURSOR_MOVE_DURATION_MS}ms ease,top ${CURSOR_MOVE_DURATION_MS}ms ease;animation:' + (phase === 'press' ? 'copis-ai-browser-cursor-press' : 'copis-ai-browser-cursor-move') + ' 520ms ease-out both;';
  cursor.__copisAiBrowserCursorX = x;
  cursor.__copisAiBrowserCursorY = y;
  const scheduleCursorHide = () => {
    cursor.__copisAiBrowserCursorHideTimer = window.setTimeout(() => {
      if (cursor && cursor.__copisAiBrowserCursorToken === token) cursor.remove();
    }, ${CURSOR_AUTO_HIDE_DELAY_MS});
  };
  const waitForCursorPaint = () => new Promise((resolve) => {
    let completed = false;
    let fallbackTimer;
    const finish = () => {
      if (completed) return;
      completed = true;
      window.clearTimeout(fallbackTimer);
      window.setTimeout(resolve, 80);
    };
    fallbackTimer = window.setTimeout(finish, 120);
    if (typeof window.requestAnimationFrame !== 'function') {
      finish();
      return;
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(finish);
    });
  });
  const waitForCursorMove = () => new Promise((resolve) => window.setTimeout(resolve, ${CURSOR_MOVE_FALLBACK_MS}));
  return waitForCursorPaint().then(() => {
    if (moveNeeded) {
      cursor.style.left = x + 'px';
      cursor.style.top = y + 'px';
    }
    return moveNeeded ? waitForCursorMove() : undefined;
  }).then(() => {
    if (cursor.__copisAiBrowserCursorToken === token) {
      cursorState.x = x;
      cursorState.y = y;
      scheduleCursorHide();
    }
    return { ok: true, x, y, phase };
  });
})()`
}
