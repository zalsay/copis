/**
 * 网页密码自动填充与表单捕获注入脚本生成器
 */

export interface AutofillAccountItem {
  id: string
  username: string
  passwordPlain: string
  usernameElement?: string
  passwordElement?: string
}

export interface AutofillTheme {
  primaryColor?: string
  primaryBackground?: string
  isDark?: boolean
}

export interface AutofillCredentialsPayload {
  username?: string
  passwordPlain?: string
  usernameElement?: string
  passwordElement?: string
  loginId?: string
  accounts?: AutofillAccountItem[]
  theme?: AutofillTheme
}

export interface AutofillSubmitPayload {
  origin: string
  username: string
  password: string
  actionUrl?: string
  usernameElement?: string
  passwordElement?: string
}

export const COPIS_AUTOFILL_MSG_PREFIX = '__COPIS_AUTOFILL_MSG__:'

/**
 * 共享的 DOM 元素检测与值填充逻辑
 */
const SHARED_AUTOFILL_HELPERS = `
  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
        return false;
      }
    } else {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || el.getClientRects().length > 0;
  }

  function setInputValue(el, val) {
    if (!el) return false;
    try {
      if (el.value === val && val !== '') return true;

      el.focus();

      // 1. React 15/16/17/18/19 的 _valueTracker 兼容处理
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === 'function') {
        tracker.setValue(val === '' ? ' ' : '');
      }

      // 2. 原生属性 setter 调用（绕过框架重写属性）
      const proto = Object.getPrototypeOf(el) || window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, val);
      } else {
        el.value = val;
      }

      // 3. 派发复合事件：InputEvent (insertReplacementText), Event(input), Event(change), keyup, blur
      try {
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertReplacementText',
          data: val,
        }));
      } catch {
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      }

      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));

      return true;
    } catch {
      return false;
    }
  }

  function findInputs(data) {
    // 查找密码框候选元素
    const allPasswordCandidates = Array.from(document.querySelectorAll(
      'input[type="password"], input[autocomplete*="password"], input[name*="password" i], input[id*="password" i], input[name*="passwd" i], input[id*="passwd" i], input[name*="pwd" i], input[id*="pwd" i]'
    )).filter(isElementVisible);

    let pwdInput = null;
    if (data.passwordElement) {
      pwdInput = allPasswordCandidates.find(el => el.name === data.passwordElement || el.id === data.passwordElement);
    }
    if (!pwdInput) {
      pwdInput = allPasswordCandidates.find(el => el.type === 'password') || allPasswordCandidates[0] || null;
    }

    // 查找用户名输入框
    let userInput = null;

    if (data.usernameElement) {
      try {
        const candidate = document.querySelector('input[name="' + CSS.escape(data.usernameElement) + '"]')
          || document.getElementById(data.usernameElement);
        if (candidate && isElementVisible(candidate)) {
          userInput = candidate;
        }
      } catch {}
    }

    const container = pwdInput
      ? (pwdInput.form || pwdInput.closest('form') || pwdInput.closest('div[class*="login" i], div[class*="auth" i], div[class*="form" i], div[class*="card" i], div[class*="modal" i]') || pwdInput.parentElement)
      : document;

    if (!userInput && container) {
      const textInputs = Array.from(container.querySelectorAll(
        'input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]):not([type="color"]):not([type="image"])'
      )).filter(isElementVisible);

      userInput = textInputs.find(input => {
        const ac = (input.getAttribute('autocomplete') || '').toLowerCase();
        return ac === 'username' || ac === 'email' || ac === 'tel';
      });

      if (!userInput) {
        userInput = textInputs.find(input => input.type === 'email');
      }

      if (!userInput) {
        userInput = textInputs.find(input => {
          const str = (input.name + ' ' + input.id + ' ' + (input.placeholder || '') + ' ' + (input.getAttribute('aria-label') || '')).toLowerCase();
          return /user|email|login|account|phone|uname|账号|用户名|手机|邮箱/.test(str);
        });
      }

      if (!userInput && pwdInput) {
        const idx = textInputs.indexOf(pwdInput);
        if (idx > 0) {
          userInput = textInputs[idx - 1];
        } else if (textInputs.length > 0) {
          userInput = textInputs[0];
        }
      }
    }

    if (!userInput) {
      const allText = Array.from(document.querySelectorAll(
        'input[autocomplete="username"], input[autocomplete="email"], input[type="email"], input[name*="user" i], input[id*="user" i], input[name*="login" i], input[id*="login" i], input[name*="account" i], input[id*="account" i]'
      )).filter(isElementVisible);
      if (allText.length > 0) {
        userInput = allText[0];
      }
    }

    return { pwdInput, userInput };
  }
`

/**
 * 构建页面加载时注入的凭据捕获监听脚本
 */
export function buildAutofillDetectionScript(): string {
  return `
(() => {
  if (window.__copisAutofillDetectionInstalled) return;
  window.__copisAutofillDetectionInstalled = true;

  const MSG_PREFIX = ${JSON.stringify(COPIS_AUTOFILL_MSG_PREFIX)};

  function sendMsg(type, payload) {
    try {
      console.log(MSG_PREFIX + JSON.stringify({ type, payload }));
    } catch {}
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    } else {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || el.getClientRects().length > 0;
  }

  function findUsernameInput(pwdInput) {
    if (!pwdInput) return null;

    const form = pwdInput.form || pwdInput.closest('form') || pwdInput.closest('div[class*="login" i], div[class*="auth" i], div[class*="form" i], div[class*="card" i]') || pwdInput.parentElement;
    if (form) {
      const formInputs = Array.from(form.querySelectorAll('input:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])')).filter(isElementVisible);
      
      const autoMatch = formInputs.find(input => {
        const ac = (input.getAttribute('autocomplete') || '').toLowerCase();
        return ac === 'username' || ac === 'email' || ac === 'tel';
      });
      if (autoMatch) return autoMatch;

      const emailMatch = formInputs.find(input => input.type === 'email');
      if (emailMatch) return emailMatch;

      const keywordMatch = formInputs.find(input => {
        const key = (input.name + ' ' + input.id + ' ' + (input.placeholder || '') + ' ' + (input.getAttribute('aria-label') || '')).toLowerCase();
        return /user|email|login|account|phone|uname|账号|用户名|手机|邮箱/.test(key);
      });
      if (keywordMatch) return keywordMatch;

      const pwdIndex = formInputs.indexOf(pwdInput);
      if (pwdIndex > 0) return formInputs[pwdIndex - 1];
      if (formInputs.length > 0) return formInputs[0];
    }

    const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])')).filter(isElementVisible);
    const pwdGlobalIndex = allInputs.indexOf(pwdInput);
    if (pwdGlobalIndex > 0) {
      for (let i = pwdGlobalIndex - 1; i >= 0; i--) {
        const candidate = allInputs[i];
        if (candidate.type !== 'password') {
          return candidate;
        }
      }
    }

    return null;
  }

  let lastSubmittedPayload = null;
  let lastSubmitTime = 0;

  function captureAndSubmit(contextEl) {
    try {
      const root = contextEl ? (contextEl.closest('form') || contextEl.closest('div[class*="login" i], div[class*="auth" i], div[class*="form" i], div[class*="card" i]') || document) : document;
      const pwdInputs = Array.from(root.querySelectorAll(
        'input[type="password"], input[autocomplete*="password"], input[name*="password" i], input[id*="password" i], input[name*="passwd" i], input[id*="passwd" i], input[name*="pwd" i], input[id*="pwd" i]'
      )).filter(el => isElementVisible(el) && el.value);

      if (pwdInputs.length === 0) return;

      const pwdInput = pwdInputs[0];
      const password = pwdInput.value;
      if (!password) return;

      const userInput = findUsernameInput(pwdInput);
      const username = userInput ? userInput.value.trim() : '';

      if (!username || !password) return;

      const now = Date.now();
      if (
        lastSubmittedPayload &&
        lastSubmittedPayload.username === username &&
        lastSubmittedPayload.password === password &&
        now - lastSubmitTime < 1500
      ) {
        return;
      }

      const form = pwdInput.form || pwdInput.closest('form');
      const actionUrl = form ? (form.getAttribute('action') || form.action || location.href) : location.href;

      lastSubmittedPayload = { username, password };
      lastSubmitTime = now;

      sendMsg('login-submit', {
        origin: location.origin,
        username,
        password,
        actionUrl,
        usernameElement: userInput ? (userInput.name || userInput.id || '') : '',
        passwordElement: pwdInput.name || pwdInput.id || '',
      });
    } catch {}
  }

  // 1. 监听所有表单提交事件（捕获阶段）
  document.addEventListener('submit', (e) => {
    captureAndSubmit(e.target);
  }, true);

  // 2. 监听点击登录/提交按钮
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target) return;
    const btn = target.closest('button, input[type="submit"], input[type="button"], a[role="button"]');
    if (!btn) return;

    const text = ((btn.innerText || btn.value || '') + ' ' + (btn.getAttribute('aria-label') || '')).trim().toLowerCase();
    if (
      btn.type === 'submit' ||
      /log\\s*in|sign\\s*in|submit|登\\s*录|注\\s*册|确\\s*认|进入/.test(text)
    ) {
      captureAndSubmit(btn);
    }
  }, true);

  // 3. 监听回车按键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.isContentEditable)) {
        captureAndSubmit(active);
      }
    }
  }, true);
})();
`
}

/**
 * 构建常驻页面的智能自动填充监听器（支持 SPA 异步挂载与重试）
 */
export function buildAutofillWatcherScript(payload: AutofillCredentialsPayload): string {
  const safeData = JSON.stringify(payload)
  const safeMsgPrefix = JSON.stringify(COPIS_AUTOFILL_MSG_PREFIX)

  return `
(() => {
  try {
    const data = ${safeData};
    const MSG_PREFIX = ${safeMsgPrefix};

    function sendMsg(type, p) {
      try {
        console.log(MSG_PREFIX + JSON.stringify({ type, payload: p }));
      } catch {}
    }

    ${SHARED_AUTOFILL_HELPERS}

    // 规范化待选账号列表
    let accounts = Array.isArray(data.accounts) ? data.accounts : [];
    if (accounts.length === 0 && (data.username || data.passwordPlain)) {
      accounts.push({
        id: data.loginId || 'default',
        username: data.username || '',
        passwordPlain: data.passwordPlain || '',
        usernameElement: data.usernameElement,
        passwordElement: data.passwordElement,
      });
    }

    if (window.__copisAutofillWatcherCleanup) {
      window.__copisAutofillWatcherCleanup();
    }

    let activeInput = null;
    let selectedIndex = -1;
    let observer = null;

    function isRelevantInput(el) {
      if (!el || el.tagName !== 'INPUT' || !el.isConnected || !isElementVisible(el)) return false;
      const type = (el.type || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'reset'].includes(type)) {
        return false;
      }
      if (type === 'password') return true;

      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (ac.includes('username') || ac.includes('email') || ac.includes('account') || ac.includes('current-password')) {
        return true;
      }

      const form = el.form || el.closest('form') || el.closest('div[class*="login" i], div[class*="auth" i], div[class*="form" i], div[class*="card" i], div[class*="modal" i]') || el.parentElement;
      if (form && form.querySelector('input[type="password"]')) {
        return true;
      }

      const str = (el.name + ' ' + el.id + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      if (/user|email|login|account|phone|uname|账号|用户名|手机|邮箱/.test(str)) {
        return true;
      }

      return false;
    }

    function getHost() {
      let host = document.getElementById('__copis_autofill_dropdown_host__');
      if (!host) {
        host = document.createElement('div');
        host.id = '__copis_autofill_dropdown_host__';
        host.style.position = 'fixed';
        host.style.top = '0';
        host.style.left = '0';
        host.style.width = '0';
        host.style.height = '0';
        host.style.zIndex = '2147483647';
        host.style.pointerEvents = 'none';
        (document.body || document.documentElement).appendChild(host);
      }
      if (!host.shadowRoot) {
        host.attachShadow({ mode: 'open' });
      }
      return host;
    }

    function hideDropdown() {
      const host = document.getElementById('__copis_autofill_dropdown_host__');
      if (host && host.shadowRoot) {
        host.shadowRoot.innerHTML = '';
      }
      activeInput = null;
      selectedIndex = -1;
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
    }

    function fillAccount(acc, targetEl) {
      if (!acc) return;
      const { pwdInput, userInput } = findInputs(acc, targetEl);
      let usernameFilled = false;
      let passwordFilled = false;

      if (userInput && acc.username) {
        usernameFilled = setInputValue(userInput, acc.username);
      }
      if (pwdInput && acc.passwordPlain) {
        passwordFilled = setInputValue(pwdInput, acc.passwordPlain);
      }

      if (usernameFilled || passwordFilled) {
        sendMsg('autofill-applied', {
          origin: location.origin,
          username: acc.username,
          loginId: acc.id || acc.loginId,
        });
      }

      hideDropdown();
    }

    function updatePosition() {
      if (!activeInput || !activeInput.isConnected || !isElementVisible(activeInput)) {
        hideDropdown();
        return;
      }
      const host = getHost();
      const dropdown = host.shadowRoot ? host.shadowRoot.querySelector('.copis-dropdown') : null;
      if (!dropdown) return;

      const rect = activeInput.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        hideDropdown();
        return;
      }

      const dHeight = dropdown.offsetHeight || (accounts.length * 48 + 12);
      const gap = 4;
      let top = rect.bottom + gap;

      if (top + dHeight > window.innerHeight && rect.top - gap - dHeight > 0) {
        top = rect.top - gap - dHeight;
      }

      let left = rect.left;
      const width = Math.min(Math.max(rect.width, 240), 360);
      if (left + width > window.innerWidth) {
        left = Math.max(8, window.innerWidth - width - 8);
      }

      dropdown.style.top = Math.round(top) + 'px';
      dropdown.style.left = Math.round(left) + 'px';
      dropdown.style.width = Math.round(width) + 'px';
    }

    function onDocPointerDown(e) {
      if (e.target === activeInput) return;
      const host = document.getElementById('__copis_autofill_dropdown_host__');
      if (host && e.composedPath && e.composedPath().includes(host)) return;
      hideDropdown();
    }

    function onDocKeyDown(e) {
      const host = getHost();
      const dropdown = host.shadowRoot ? host.shadowRoot.querySelector('.copis-dropdown') : null;
      if (!dropdown) return;

      const items = Array.from(dropdown.querySelectorAll('.copis-item'));
      if (items.length === 0) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideDropdown();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % items.length;
        renderSelection(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        renderSelection(items);
      } else if (e.key === 'Enter' && selectedIndex >= 0 && selectedIndex < items.length) {
        e.preventDefault();
        e.stopPropagation();
        const chosenAcc = accounts[selectedIndex];
        if (chosenAcc) fillAccount(chosenAcc, activeInput);
      }
    }

    function renderSelection(items) {
      items.forEach((it, idx) => {
        if (idx === selectedIndex) {
          it.classList.add('selected');
          it.scrollIntoView({ block: 'nearest' });
        } else {
          it.classList.remove('selected');
        }
      });
    }

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function showDropdown(inputEl) {
      if (!accounts || accounts.length === 0) return;
      if (activeInput === inputEl && getHost().shadowRoot && getHost().shadowRoot.querySelector('.copis-dropdown')) {
        updatePosition();
        return;
      }

      activeInput = inputEl;
      selectedIndex = -1;

      const host = getHost();
      const shadow = host.shadowRoot;

      const theme = data.theme || {};
      const isDark = typeof theme.isDark === 'boolean'
        ? theme.isDark
        : Boolean(
            document.documentElement.classList.contains('dark') ||
            (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
          );

      const primaryColor = theme.primaryColor || (window.getComputedStyle(document.documentElement).getPropertyValue('--ui-primary') || '').trim() || '#f09a43';
      const primaryBackground = theme.primaryBackground || 'rgba(240, 154, 67, 0.2)';

      const themeStyles = isDark ? \`
        --c-bg: #18181b;
        --c-fg: #f4f4f5;
        --c-border: rgba(255, 255, 255, 0.12);
        --c-sub: #a1a1aa;
        --c-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
      \` : \`
        --c-bg: #ffffff;
        --c-fg: #0f172a;
        --c-border: rgba(0, 0, 0, 0.10);
        --c-sub: #64748b;
        --c-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.12), 0 8px 10px -6px rgba(0, 0, 0, 0.08);
      \`;

      shadow.innerHTML = \`
        <style>
          .copis-dropdown {
            --ui-primary: \${primaryColor};
            --ui-primary-background: \${primaryBackground};
            \${themeStyles}
            position: fixed;
            pointer-events: auto;
            box-sizing: border-box;
            background: var(--c-bg);
            color: var(--c-fg);
            border: 1px solid var(--c-border);
            border-radius: 8px;
            box-shadow: var(--c-shadow);
            padding: 4px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 13px;
            line-height: 1.4;
            overflow: hidden;
            user-select: none;
            z-index: 2147483647;
            animation: copis-in 0.12s cubic-bezier(0.16, 1, 0.3, 1);
          }
          @keyframes copis-in {
            from { opacity: 0; transform: translateY(-3px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .copis-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 5px 8px 4px 8px;
            margin-bottom: 3px;
            border-bottom: 1px solid var(--c-border);
            font-size: 11px;
            color: var(--c-sub);
          }
          .copis-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-weight: 500;
            color: var(--ui-primary);
            background: var(--ui-primary-background);
            padding: 1px 6px;
            border-radius: 4px;
          }
          .copis-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 7px 9px;
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.1s ease, border-color 0.1s ease;
            border: 1px solid transparent;
          }
          .copis-item:hover, .copis-item.selected {
            background: var(--ui-primary-background);
            border-color: color-mix(in srgb, var(--ui-primary) 30%, transparent);
          }
          .copis-item:hover .copis-user, .copis-item.selected .copis-user {
            color: var(--ui-primary);
          }
          .copis-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
            border-radius: 50%;
            background: var(--ui-primary-background);
            color: var(--ui-primary);
            flex-shrink: 0;
            transition: transform 0.12s ease;
          }
          .copis-item:hover .copis-icon, .copis-item.selected .copis-icon {
            transform: scale(1.05);
          }
          .copis-info {
            display: flex;
            flex-direction: column;
            min-width: 0;
            flex: 1;
          }
          .copis-user {
            font-weight: 500;
            color: var(--c-fg);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            transition: color 0.1s ease;
          }
          .copis-sub {
            font-size: 11px;
            color: var(--c-sub);
            margin-top: 1px;
          }
        </style>
        <div class="copis-dropdown">
          <div class="copis-header">
            <span>使用已保存的账号</span>
            <span class="copis-badge">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>
                <circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>
              </svg>
              Copis
            </span>
          </div>
          \${accounts.map((acc, index) => \`
            <div class="copis-item" data-index="\${index}">
              <div class="copis-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>
                  <circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>
                </svg>
              </div>
              <div class="copis-info">
                <div class="copis-user">\${escapeHtml(acc.username)}</div>
                <div class="copis-sub">已保存的密码</div>
              </div>
            </div>
          \`).join('')}
        </div>
      \`;

      const itemEls = shadow.querySelectorAll('.copis-item');
      itemEls.forEach((el, index) => {
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const chosen = accounts[index];
          if (chosen) fillAccount(chosen, activeInput);
        });
      });

      updatePosition();

      window.addEventListener('scroll', updatePosition, { capture: true, passive: true });
      window.addEventListener('resize', updatePosition, { passive: true });
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('keydown', onDocKeyDown, true);
    }

    // 用户点击或聚焦到相关输入框时弹出待选下拉浮层
    const handleInputTrigger = (e) => {
      const target = e.target;
      if (isRelevantInput(target)) {
        showDropdown(target);
      }
    };

    document.addEventListener('focusin', handleInputTrigger, { capture: true, passive: true });
    document.addEventListener('click', handleInputTrigger, { capture: true, passive: true });

    // 输入过程中若值发生变化，可联动过滤或隐藏浮层
    const handleInputFilter = (e) => {
      if (e.target !== activeInput) return;
      const val = (activeInput.value || '').trim().toLowerCase();
      if (!val) {
        showDropdown(activeInput);
        return;
      }
      const matched = accounts.filter(a => a.username.toLowerCase().includes(val));
      if (matched.length === 0) {
        hideDropdown();
      }
    };
    document.addEventListener('input', handleInputFilter, { capture: true, passive: true });

    // MutationObserver 监听输入框移除并清理浮层
    if (window.MutationObserver) {
      observer = new MutationObserver(() => {
        if (activeInput && (!activeInput.isConnected || !isElementVisible(activeInput))) {
          hideDropdown();
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    function cleanup() {
      hideDropdown();
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      document.removeEventListener('focusin', handleInputTrigger, true);
      document.removeEventListener('click', handleInputTrigger, true);
      document.removeEventListener('input', handleInputFilter, true);
      const host = document.getElementById('__copis_autofill_dropdown_host__');
      if (host) host.remove();
    }

    window.__copisAutofillWatcherCleanup = cleanup;
  } catch {}
})();
`
}

/**
 * 构建单次主动执行自动填充的脚本（用户点击“填充”按钮触发）
 */
export function buildAutofillExecutionScript(payload: AutofillCredentialsPayload): string {
  const safeData = JSON.stringify(payload)
  return `
(() => {
  try {
    const data = ${safeData};

    ${SHARED_AUTOFILL_HELPERS}

    const { pwdInput, userInput } = findInputs(data);
    let usernameFilled = false;
    let passwordFilled = false;

    if (userInput && data.username) {
      usernameFilled = setInputValue(userInput, data.username);
    }

    if (pwdInput && data.passwordPlain) {
      passwordFilled = setInputValue(pwdInput, data.passwordPlain);
    }

    return {
      success: Boolean(usernameFilled || passwordFilled),
      usernameFilled,
      passwordFilled,
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
})();
`
}
