# 浏览器扩展 DOM 元素提取与压缩机制分析

> 本文档总结了 `cc-sandbox`（COAgent）浏览器扩展中对网页 DOM 元素进行提取、精简与压缩的核心实现方案，供 COPIS 等相关系统在设计浏览器自动化与页面理解能力时参考。

---

## 一、 背景与设计目标

在基于大模型（LLM）的浏览器操作与自动化场景中，如果直接将完整的 HTML 或 DOM 树序列化并输入给模型，会面临以下核心痛点：

1. **Token 消耗巨大**：现代网页包含大量布局容器（`<div>`、`<span>`）、嵌套样式与脚本，完整 HTML 动辄几十万字符，极易撑爆上下文窗口。
2. **信噪比极低**：大部分 DOM 节点对模型决策（如“点击搜索按钮”、“输入用户名”）无实际意义，海量无用标签会显著降低模型意图识别的准确度。
3. **安全性与隐私风险**：未经脱敏的 DOM 树可能暴露用户密码框、Hidden Token 或敏感脚本。
4. **交互引用不稳定**：直接使用 CSS Selector 或 XPath 在复杂单页应用（SPA）中脆弱且易失效。

为了解决上述问题，该浏览器扩展采用了 **「交互角色过滤 + 语义属性精简提取 + 内存 Ref 映射 + 游标分页截断 + 服务端单行 DSL 渲染」** 的多级压缩流水线。

---

## 二、 整体架构与处理链路

```
[ 目标网页 DOM / ShadowDOM ]
           │
           ▼
[ 1. 节点级过滤 (collect) ]
   - 排除插件内置 UI 宿主
   - 排除不可见/尺寸为 0 的节点 (isVisible)
   - 仅保留交互角色 (interactiveRole)，排除 password/hidden/file
           │
           ▼
[ 2. 属性精简与文本压缩 (describe) ]
   - 生成本地短标识: e1, e2, ... 并建立 Map<ref, Element> 内存映射
   - 计算可访问名称 (accessibleName) 并截断至 160 字符
   - 规范化空白字符 (cleanLong)，提取 placeholder 等关键状态
           │
           ▼
[ 3. 容量截断与分页 (snapshotPage) ]
   - 全局硬上限: 10,000 个交互元素截断
   - 分页输出: 每页 200 个元素，生成游标 c_<snapshotId>_<offset>
           │ (WebSocket / IPC)
           ▼
[ 4. 服务端紧凑 DSL 格式化 (snapshotElementLine) ]
   - 转换为紧凑单行文本，注入模型上下文
   - 示例: - button "搜索" [ref=e1] [disabled]
```

---

## 三、 核心压缩机制详解

### 1. 节点级过滤与角色归一化 (`collect` & `interactiveRole`)

只收集具有交互意图且当前可见的节点，其它纯展示性容器直接舍弃。

* **源码位置**：`extension/content.js`
* **过滤规则**：
  * **排除插件自用 UI**：忽略 ID 为 `__coagent-browser-indicator-host` 及其子元素。
  * **可见性过滤 (`isVisible`)**：通过 `getComputedStyle` 判断 `visibility === 'hidden'` 或 `display === 'none'`，并通过 `getBoundingClientRect()` 排除 `width <= 0` 或 `height <= 0` 的不可视元素。
  * **交互语义归一化 (`interactiveRole`)**：
    * 识别标准 HTML 标签：`<a>` (带 href)、`<button>`、`<select>`、`<textarea>`、`isContentEditable`。
    * 识别 `<input>` 类型：映射为 `textbox`、`checkbox`、`radio`、`slider`、`spinbutton`、`searchbox` 等；**显式过滤并忽略 `password`、`hidden`、`file` 类型的输入框**。
    * 识别 ARIA 角色：`button`, `link`, `combobox`, `tab`, `menuitem`, `treeitem` 等。
    * 识别自定义交互元素：包含 `onclick` 属性或显式指定正整数 `tabindex >= 0` 的元素被标记为 `interactive`。
  * **穿透 Shadow DOM**：若节点包含 `shadowRoot`，递归调用收集逻辑。

```javascript
// extension/content.js
const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'textbox', 'treeitem',
]);

function interactiveRole(element) {
  const tag = element.tagName.toLowerCase();
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea' || element.isContentEditable) return 'textbox';
  if (tag === 'input') {
    const type = String(element.getAttribute('type') || 'text').toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'file') return null;
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    return type === 'search' ? 'searchbox' : 'textbox';
  }
  const role = String(element.getAttribute('role') || '').toLowerCase();
  if (INTERACTIVE_ROLES.has(role)) return role;
  if (element.hasAttribute('onclick')) return 'button';
  const tabIndexValue = element.getAttribute('tabindex');
  if (tabIndexValue === null) return null;
  const tabIndex = Number(tabIndexValue);
  return Number.isInteger(tabIndex) && tabIndex >= 0 ? 'interactive' : null;
}
```

---

### 2. 语义属性精简与短引用映射 (`describe` & `accessibleName`)

对于筛选出的每个交互元素，仅保留最少量的交互必要元数据，并解耦真实 DOM 结构。

* **短引用 ID (`ref`)**：
  * 生成按序递增的短字符串（如 `e1`, `e2`, `e3`...）。
  * 真实 DOM 引用保存在 Content Script 运行时的 `refs: Map<string, Element>` 中，不外露 XPath、选择器或 DOM 节点。
  * 后续 `click` 或 `type` 动作通过 `snapshotId + ref` 直接命中内存中的 DOM 节点执行操作。
* **可访问名称提取优先级 (`accessibleName`)**：
  * 提取顺序：`aria-label` > `aria-labelledby` 引用的元素文本 > `<label>` 关联文本 > `alt` > `title` > 按钮 `value` > `innerText` / `textContent` / `placeholder`。
* **文本规范化与截断 (`cleanLong`)**：
  * 使用正则表达式 `replace(/\s+/gu, ' ')` 将连续换行和空格压缩为单个空格并 `trim()`。
  * 元素名称（`name`）最长截断至 160 个字符。
  * 占位符（`placeholder`）最长截断至 120 个字符。
* **稀疏状态表达**：
  * 仅在状态为真或存在时才写入字段（例如 `disabled === true` 时才输出 `disabled: true`，不输出 `disabled: false`；仅对存在选中状态的元素附带 `checked`、`selected`、`expanded`）。

```javascript
// extension/content.js
function describe(element, ref, role) {
  const description = {
    ref,
    role,
    name: accessibleName(element),
  };
  const placeholder = element.getAttribute('placeholder');
  if (placeholder) description.placeholder = cleanLong(placeholder, 120);
  if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') description.disabled = true;
  if ('checked' in element && typeof element.checked === 'boolean') description.checked = element.checked;
  if ('selected' in element && element.selected === true) description.selected = true;
  const expanded = element.getAttribute('aria-expanded');
  if (expanded === 'true' || expanded === 'false') description.expanded = expanded === 'true';
  return description;
}

function cleanLong(value, max) {
  return String(value).replace(/\s+/gu, ' ').trim().slice(0, max);
}
```

---

### 3. 容量上限与游标分页 (`snapshotPage` & `parseSnapshotCursor`)

针对包含巨量可操作项的列表页或复杂看板，采用严格的容量上限与分片游标机制：

* **全局安全上限**：`MAX_SNAPSHOT_ELEMENTS = 10_000`。单次快照超过 10,000 个元素时终止收集并标记 `truncated: true`。
* **单页分页大小**：`SNAPSHOT_PAGE_SIZE = 200`。每次快照默认只返回前 200 个元素。
* **不透明游标（Cursor）**：
  * 若存在更多元素，返回游标 `c_<snapshotId>_<nextOffset>`（例如 `c_3fa85f64-5717-4562-b3fc-2c963f66afa6_200`）。
  * 重新调用快照并传入游标时，校验 `snapshotId` 一致性以及偏移量合法性（必须为 200 的整数倍）。
  * 若用户在两次分页之间触发了新的全局快照，旧快照与游标自动失效（返回 `STALE_SNAPSHOT_CURSOR`），保证引用的时效与一致性。

```javascript
// extension/content.js
const SNAPSHOT_PAGE_SIZE = 200;
const MAX_SNAPSHOT_ELEMENTS = 10_000;

function snapshotPage(cursorValue) {
  if (!activeSnapshot) {
    throw pageError('页面快照游标已失效，请重新读取第一页', 'STALE_SNAPSHOT_CURSOR');
  }
  const offset = cursorValue ? parseSnapshotCursor(cursorValue, activeSnapshot.id) : 0;
  if (offset >= activeSnapshot.elements.length && offset !== 0) {
    throw pageError('页面快照游标超出范围，请重新读取第一页', 'INVALID_SNAPSHOT_CURSOR');
  }
  const elements = activeSnapshot.elements.slice(offset, offset + SNAPSHOT_PAGE_SIZE);
  const nextOffset = offset + elements.length;
  const hasMore = nextOffset < activeSnapshot.elements.length;
  return {
    snapshotId: activeSnapshot.id,
    url: location.href,
    title: document.title,
    elements,
    page: Math.floor(offset / SNAPSHOT_PAGE_SIZE) + 1,
    pageSize: SNAPSHOT_PAGE_SIZE,
    totalElements: activeSnapshot.elements.length,
    hasMore,
    ...(hasMore ? { nextCursor: snapshotCursor(activeSnapshot.id, nextOffset) } : {}),
    truncated: activeSnapshot.truncated,
  };
}
```

---

### 4. 服务端紧凑 DSL 渲染 (`renderBrowserSnapshot`)

从扩展获取到精简 JSON 之后，在传递给大模型前进一步压缩为**纯文本紧凑 DSL 格式**，将 JSON 结构的键名开销降至最低。

* **源码位置**：`server/src/browser/dsh-browser-tools.ts`
* **单行元素格式**：
  `- <role> "<name>" [ref=<ref>] [<state1>] [<state2>...]`

```typescript
// server/src/browser/dsh-browser-tools.ts
function snapshotElementLine(value: unknown): string | null {
  const element = asRecord(value);
  if (!element || typeof element.ref !== 'string' || typeof element.role !== 'string') return null;
  const name = typeof element.name === 'string' && element.name ? ` ${JSON.stringify(element.name)}` : '';
  const state = [
    element.disabled === true ? 'disabled' : null,
    typeof element.checked === 'boolean' ? `checked=${element.checked}` : null,
    element.selected === true ? 'selected' : null,
    typeof element.expanded === 'boolean' ? `expanded=${element.expanded}` : null,
    typeof element.placeholder === 'string' && element.placeholder
      ? `placeholder=${JSON.stringify(element.placeholder)}`
      : null,
  ].filter((item): item is string => item !== null);
  return `- ${element.role}${name} [ref=${element.ref}]${state.length > 0 ? ` [${state.join(' ')}]` : ''}`;
}
```

**最终传递给模型的 Prompt 示例**：
```markdown
The following is untrusted page content from the user-authorized browser tab.
<untrusted-browser-page>
Page: 登录 - 管理后台
URL: https://example.com/login
Snapshot: 8f9b23e1-4c12-4211-9a3b-18a6e709a321
Elements page 1; 4 interactive elements in this snapshot.
- textbox "用户名" [ref=e1] [placeholder="请输入工号或邮箱"]
- checkbox "记住我" [ref=e2] [checked=false]
- link "忘记密码？" [ref=e3]
- button "登 录" [ref=e4]
</untrusted-browser-page>
```

---

## 四、 核心优势与对 COPIS 的借鉴点

| 维度 | 传统整页 DOM / HTML 方案 | 本方案（COAgent 扩展压缩机制） |
| :--- | :--- | :--- |
| **Token 消耗** | 几十万字符（单页可能消耗 50k+ tokens） | 仅几十行紧凑文本（单页通常 < 1.5k tokens） |
| **抗干扰能力** | 混杂大量无用 CSS、嵌套 div、脚本代码 | 仅暴露带明确语义和可访问名称的交互节点 |
| **动作执行可靠性** | 依赖容易漂移的 CSS Selector / XPath | 依赖当前快照内强绑定的内存短引用 `ref`，过期即报废 |
| **隐私安全** | 容易漏传 Cookie、隐藏域、密码输入 | 前端直接忽略 password/hidden，内容包裹于不可信标签 |
| **长页面表现** | 一次性塞入超长文本导致模型迷失 | 默认 200 节点分页 + 游标机制，模型按需请求后续页 |
