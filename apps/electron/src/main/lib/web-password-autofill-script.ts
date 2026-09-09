/**
 * 网页密码自动填充与表单捕获注入脚本生成器
 */

export interface AutofillCredentialsPayload {
  username: string
  passwordPlain: string
  usernameElement?: string
  passwordElement?: string
  loginId?: string
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

    if (window.__copisAutofillWatcherCleanup) {
      window.__copisAutofillWatcherCleanup();
    }

    let isCompleted = false;
    let observer = null;
    let retryTimers = [];

    function tryFill() {
      if (isCompleted) return true;
      const { pwdInput, userInput } = findInputs(data);
      let usernameFilled = false;
      let passwordFilled = false;

      if (userInput && data.username) {
        usernameFilled = setInputValue(userInput, data.username);
      }

      if (pwdInput && data.passwordPlain) {
        passwordFilled = setInputValue(pwdInput, data.passwordPlain);
      }

      const hasBoth = Boolean(userInput && pwdInput);
      const filledBoth = Boolean(usernameFilled && passwordFilled);
      const filledAny = Boolean(usernameFilled || passwordFilled);

      if (filledAny) {
        sendMsg('autofill-applied', {
          origin: location.origin,
          username: data.username,
          loginId: data.loginId,
        });
      }

      if (filledBoth || (!pwdInput && usernameFilled) || (pwdInput && passwordFilled)) {
        isCompleted = true;
        cleanup();
        return true;
      }

      return false;
    }

    function cleanup() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      for (const t of retryTimers) {
        clearTimeout(t);
      }
      retryTimers = [];
    }

    window.__copisAutofillWatcherCleanup = cleanup;

    // 1. 立即执行一次
    if (tryFill()) return;

    // 2. 监听 DOM 变动（针对 React / Vue 等 SPA 异步渲染组件）
    if (window.MutationObserver) {
      let debounceTimer = null;
      observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (tryFill()) cleanup();
        }, 50);
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'type'],
      });
    }

    // 3. 递增间隔重试序列
    const intervals = [100, 250, 500, 1000, 2000, 3500, 5000];
    for (const delay of intervals) {
      const timer = setTimeout(() => {
        if (tryFill()) cleanup();
      }, delay);
      retryTimers.push(timer);
    }

    // 4. 监听焦点切入（用户点击/聚焦输入框时快速补充回填）
    const handleFocusIn = (e) => {
      const target = e.target;
      if (!target || target.tagName !== 'INPUT') return;
      if (target.type === 'password' || target.type === 'email' || target.type === 'text') {
        if (!target.value) {
          tryFill();
        }
      }
    };
    document.addEventListener('focusin', handleFocusIn, { capture: true, passive: true });

    // 10 秒后释放 observer
    setTimeout(() => {
      cleanup();
    }, 10000);
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
