window.__ModuleLoader__.load({
  id: "@copis-ext/creation-web",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __moduleCache = /* @__PURE__ */ new WeakMap;
var __toCommonJS = (from) => {
  var entry = __moduleCache.get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function")
    __getOwnPropNames(from).map((key) => !__hasOwnProp.call(entry, key) && __defProp(entry, key, {
      get: () => from[key],
      enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
    }));
  __moduleCache.set(from, entry);
  return entry;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// dsh-plugins/copis-creation-web/src/client.tsx
var exports_client = {};
__export(exports_client, {
  isSettingsTarget: () => isSettingsTarget,
  inject: () => inject,
  apply: () => apply,
  CreationSidebarNavigation: () => CreationSidebarNavigation,
  CopisShellOverlayManager: () => CopisShellOverlayManager,
  CopisSearchModal: () => CopisSearchModal
});
module.exports = __toCommonJS(exports_client);

// ../../node_modules/lucide-react/dist/esm/createLucideIcon.js
var import_react2 = require("react");

// ../../node_modules/lucide-react/dist/esm/shared/src/utils.js
var toKebabCase = (string) => string.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
var mergeClasses = (...classes) => classes.filter((className, index, array) => {
  return Boolean(className) && className.trim() !== "" && array.indexOf(className) === index;
}).join(" ").trim();

// ../../node_modules/lucide-react/dist/esm/Icon.js
var import_react = require("react");

// ../../node_modules/lucide-react/dist/esm/defaultAttributes.js
var defaultAttributes = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};

// ../../node_modules/lucide-react/dist/esm/Icon.js
var Icon = import_react.forwardRef(({
  color = "currentColor",
  size = 24,
  strokeWidth = 2,
  absoluteStrokeWidth,
  className = "",
  children,
  iconNode,
  ...rest
}, ref) => {
  return import_react.createElement("svg", {
    ref,
    ...defaultAttributes,
    width: size,
    height: size,
    stroke: color,
    strokeWidth: absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth,
    className: mergeClasses("lucide", className),
    ...rest
  }, [
    ...iconNode.map(([tag, attrs]) => import_react.createElement(tag, attrs)),
    ...Array.isArray(children) ? children : [children]
  ]);
});

// ../../node_modules/lucide-react/dist/esm/createLucideIcon.js
var createLucideIcon = (iconName, iconNode) => {
  const Component = import_react2.forwardRef(({ className, ...props }, ref) => import_react2.createElement(Icon, {
    ref,
    iconNode,
    className: mergeClasses(`lucide-${toKebabCase(iconName)}`, className),
    ...props
  }));
  Component.displayName = `${iconName}`;
  return Component;
};

// ../../node_modules/lucide-react/dist/esm/icons/book-open.js
var BookOpen = createLucideIcon("BookOpen", [
  ["path", { d: "M12 7v14", key: "1akyts" }],
  [
    "path",
    {
      d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
      key: "ruj8y"
    }
  ]
]);

// ../../node_modules/lucide-react/dist/esm/icons/bot.js
var Bot = createLucideIcon("Bot", [
  ["path", { d: "M12 8V4H8", key: "hb8ula" }],
  ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2", key: "enze0r" }],
  ["path", { d: "M2 14h2", key: "vft8re" }],
  ["path", { d: "M20 14h2", key: "4cs60a" }],
  ["path", { d: "M15 13v2", key: "1xurst" }],
  ["path", { d: "M9 13v2", key: "rq6x2g" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/brain.js
var Brain = createLucideIcon("Brain", [
  [
    "path",
    {
      d: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z",
      key: "l5xja"
    }
  ],
  [
    "path",
    {
      d: "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z",
      key: "ep3f8r"
    }
  ],
  ["path", { d: "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4", key: "1p4c4q" }],
  ["path", { d: "M17.599 6.5a3 3 0 0 0 .399-1.375", key: "tmeiqw" }],
  ["path", { d: "M6.003 5.125A3 3 0 0 0 6.401 6.5", key: "105sqy" }],
  ["path", { d: "M3.477 10.896a4 4 0 0 1 .585-.396", key: "ql3yin" }],
  ["path", { d: "M19.938 10.5a4 4 0 0 1 .585.396", key: "1qfode" }],
  ["path", { d: "M6 18a4 4 0 0 1-1.967-.516", key: "2e4loj" }],
  ["path", { d: "M19.967 17.484A4 4 0 0 1 18 18", key: "159ez6" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/calendar-clock.js
var CalendarClock = createLucideIcon("CalendarClock", [
  ["path", { d: "M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5", key: "1osxxc" }],
  ["path", { d: "M16 2v4", key: "4m81vk" }],
  ["path", { d: "M8 2v4", key: "1cmpym" }],
  ["path", { d: "M3 10h5", key: "r794hk" }],
  ["path", { d: "M17.5 17.5 16 16.3V14", key: "akvzfd" }],
  ["circle", { cx: "16", cy: "16", r: "6", key: "qoo3c4" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/loader-circle.js
var LoaderCircle = createLucideIcon("LoaderCircle", [
  ["path", { d: "M21 12a9 9 0 1 1-6.219-8.56", key: "13zald" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/puzzle.js
var Puzzle = createLucideIcon("Puzzle", [
  [
    "path",
    {
      d: "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z",
      key: "w46dr5"
    }
  ]
]);

// ../../node_modules/lucide-react/dist/esm/icons/search.js
var Search = createLucideIcon("Search", [
  ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }],
  ["path", { d: "m21 21-4.3-4.3", key: "1qie3q" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/timer.js
var Timer = createLucideIcon("Timer", [
  ["line", { x1: "10", x2: "14", y1: "2", y2: "2", key: "14vaq8" }],
  ["line", { x1: "12", x2: "15", y1: "14", y2: "11", key: "17fdiu" }],
  ["circle", { cx: "12", cy: "14", r: "8", key: "1e1u0o" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/trending-up.js
var TrendingUp = createLucideIcon("TrendingUp", [
  ["polyline", { points: "22 7 13.5 15.5 8.5 10.5 2 17", key: "126l90" }],
  ["polyline", { points: "16 7 22 7 22 13", key: "kwv8wd" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/users-round.js
var UsersRound = createLucideIcon("UsersRound", [
  ["path", { d: "M18 21a8 8 0 0 0-16 0", key: "3ypg7q" }],
  ["circle", { cx: "10", cy: "8", r: "5", key: "o932ke" }],
  ["path", { d: "M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3", key: "10s06x" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/x.js
var X = createLucideIcon("X", [
  ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
  ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
]);
// dsh-plugins/copis-creation-web/src/client.tsx
var import_react4 = require("react");

// dsh-plugins/copis-creation-web/src/CreationReturnToAgentControl.tsx
var import_react3 = require("react");
var import_react_dom = require("react-dom");
var jsx_runtime = require("react/jsx-runtime");
function CreationReturnToAgentControl({ wide, menuRef, onReturn }) {
  const [host, setHost] = import_react3.useState(null);
  import_react3.useLayoutEffect(() => {
    const sidebar = menuRef.current?.closest('[class*="_root"], [class*="SidebarRoot"], [class*="_sidebarCol"], [class*="sidebarCol"], aside');
    const settings = sidebar?.querySelector('[class*="settingsArea"], [class*="SettingsArea"]');
    if (!settings?.parentElement)
      return;
    const element = document.createElement("div");
    element.className = "copis-return-agent-host";
    settings.before(element);
    setHost(element);
    return () => {
      element.remove();
    };
  }, [menuRef]);
  if (!host)
    return null;
  return import_react_dom.createPortal(/* @__PURE__ */ jsx_runtime.jsxs("button", {
    type: "button",
    className: `${wide ? "copis-menu-item" : "copis-rail-menu-item"} copis-return-agent-button`,
    title: "返回 Agent 模式",
    "aria-label": "返回 Agent 模式",
    onClick: onReturn,
    children: [
      /* @__PURE__ */ jsx_runtime.jsx(Bot, {
        size: wide ? 16 : 18,
        strokeWidth: 1.8
      }),
      wide && /* @__PURE__ */ jsx_runtime.jsx("span", {
        children: "返回 Agent 模式"
      })
    ]
  }), host);
}

// dsh-plugins/copis-creation-web/src/client.tsx
var jsx_runtime2 = require("react/jsx-runtime");
var CREATION_STYLES_ID = "copis-creation-web-styles";
var SIDEBAR_MENU_ITEMS = [
  { id: "search", label: "搜索", icon: Search, action: "search" },
  { id: "schedule", label: "日程表", icon: CalendarClock, view: "planning", tab: "schedule" },
  { id: "automations", label: "定时任务", icon: Timer, view: "automations" },
  { id: "memory", label: "记忆", icon: Brain, view: "memory" },
  { id: "knowledge", label: "知识库", icon: BookOpen, view: "knowledge" },
  { id: "expert-team", label: "专家团队", icon: UsersRound, view: "expert-team" },
  { id: "group-chat", label: "群聊协作", icon: UsersRound, view: "group-chat" },
  { id: "agent-skills", label: "技能市场", icon: Puzzle, view: "agent-skills" },
  { id: "fund-stock", label: "我的投资", icon: TrendingUp, view: "fund-stock" }
];
var CREATION_UI_CSS = `
  [class*="_logoRow"],
  [class*="logoRow"],
  [class*="_localBuildBrand"],
  [class*="localBuildBrand"] {
    display: none !important;
  }

  /* 侧边栏容器背景：对齐 Agent 模式 (hsl(var(--muted))) */
  .copis-creation-sidebar,
  .hHd-Xa_root,
  [class*="SidebarRoot_root"],
  [class*="SidebarRoot"],
  [class*="_sidebarCol"],
  [class*="sidebarCol"],
  aside.copis-creation-sidebar {
    background: var(--dsw-specific-sidebar-fill, hsl(0 0% 96.1%)) !important;
  }
  body[data-ds-dark-theme] .copis-creation-sidebar,
  body[data-ds-dark-theme] .hHd-Xa_root,
  body[data-ds-dark-theme] [class*="SidebarRoot_root"],
  body[data-ds-dark-theme] [class*="SidebarRoot"],
  body[data-ds-dark-theme] [class*="_sidebarCol"],
  body[data-ds-dark-theme] [class*="sidebarCol"],
  body[data-ds-dark-theme] aside.copis-creation-sidebar {
    background: var(--dsw-specific-sidebar-fill, hsl(0 0% 17%)) !important;
  }

  /* 隐藏 DSH 原生侧栏中遗留的旧版静态菜单（无 data-copis-placement），只保留 copis-creation-web 插件动态挂载的导航菜单 */
  .copis-menu-section:not([data-copis-placement="before-workspaces"]),
  .copis-rail-menu-section:not([data-copis-placement="before-workspaces"]) {
    display: none !important;
  }

  .copis-return-agent-host {
    display: flex;
    flex: none;
    justify-content: center;
    margin: 0 0 8px;
    padding: 0 2px;
  }

  .copis-menu-section {
    box-sizing: border-box;
    display: grid;
    flex: none;
    gap: 0;
    width: 100%;
    margin: 0 0 8px;
    padding: 0 2px;
  }

  .copis-menu-item {
    appearance: none;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 31px;
    padding: 5px 8px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--dsw-alias-label-primary, inherit);
    font-size: 14px;
    font-weight: 400;
    line-height: 1.25;
    text-align: left;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
    user-select: none;
  }

  .copis-menu-item:hover,
  .copis-menu-item:focus-visible {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
    outline: 0;
  }

  .copis-menu-item[data-active="true"] {
    background: rgba(255, 255, 255, 0.12) !important;
    color: #ffffff !important;
    font-weight: 500 !important;
  }

  .copis-menu-item svg {
    flex: none;
    width: 15px;
    height: 15px;
    color: var(--dsw-alias-label-secondary, #90939e);
  }

  .copis-menu-item[data-active="true"] svg {
    color: #ffffff !important;
  }

  .copis-menu-item > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .copis-menu-item > .copis-dsh-menu-hide-btn {
    position: static !important;
    margin-left: auto;
    flex: none;
    display: none;
    padding: 1px 6px;
    font-size: 11px;
    line-height: 16px;
    border-radius: 9999px;
    background: rgba(0, 0, 0, 0.08);
    color: var(--dsw-alias-label-secondary, #71717a);
    border: none;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .copis-menu-item:hover > .copis-dsh-menu-hide-btn {
    display: inline-flex;
    align-items: center;
  }

  .copis-menu-item > .copis-dsh-menu-hide-btn:hover {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .copis-rail-menu-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    width: 100%;
    margin-bottom: 8px;
  }

  .copis-rail-menu-item {
    appearance: none;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--dsw-alias-label-secondary, #71717a);
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .copis-rail-menu-item:hover,
  .copis-rail-menu-item:focus-visible {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
    color: var(--dsw-alias-label-primary, #18181b);
    outline: 0;
  }

  .copis-rail-menu-item[data-active="true"] {
    background: rgba(255, 255, 255, 0.12) !important;
    color: #ffffff !important;
  }

  .copis-rail-menu-item svg {
    width: 16px;
    height: 16px;
  }

  button[class*="_newSession"],
  button[class*="newSession"] {
    border-radius: 7px !important;
    font-size: 14px !important;
    background: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    color: #f1f5f9 !important;
    transition: all 120ms ease !important;
  }
  button[class*="_newSession"]:hover,
  button[class*="newSession"]:hover {
    background: rgba(255, 255, 255, 0.09) !important;
    border-color: rgba(255, 255, 255, 0.14) !important;
  }

  [class*="sessionRow"],
  [class*="SessionRow"] {
    border-radius: 7px !important;
    font-size: 14px !important;
    transition: all 120ms ease !important;
  }
  [class*="sessionRow"]:hover,
  [class*="SessionRow"]:hover {
    background: rgba(255, 255, 255, 0.04) !important;
  }
  /* WorkBuddy 浅灰/曜石微高光卡片会话行选中态，彻底去除紫色 */
  .YDXeBa_sessionRow.YDXeBa_selected,
  .YDXeBa_searchResultRow.YDXeBa_selected,
  .YDXeBa_projectRow.active,
  [class*="sessionRow"][class*="selected"],
  [class*="searchResultRow"][class*="selected"],
  [class*="projectRow"][class*="active"],
  [class*="sessionRow"][data-selected="true"],
  [class*="SessionRow"][data-selected="true"] {
    background: rgba(255, 255, 255, 0.1) !important;
    color: #ffffff !important;
    font-weight: 500 !important;
  }
  .YDXeBa_sessionRow.YDXeBa_selected *,
  [class*="sessionRow"][class*="selected"] * {
    color: #ffffff !important;
  }
  .YDXeBa_sessionRow.YDXeBa_selected [class*="date"],
  .YDXeBa_sessionRow.YDXeBa_selected [class*="time"],
  [class*="sessionRow"][class*="selected"] [class*="date"],
  [class*="sessionRow"][class*="selected"] [class*="time"],
  [class*="sessionRow"][class*="selected"] span:last-child {
    color: #a1a1aa !important;
  }
  [class*="sessionRow"][class*="selected"] svg,
  [class*="searchResultRow"][class*="selected"] svg,
  [class*="projectRow"][class*="active"] svg {
    color: #d4d4d8 !important;
  }
  /* 侧栏工作区目录/项目图标：全部对齐 WorkBuddy 浅银灰色，绝不显示亮紫色 */
  .YDXeBa_projectRow svg,
  [class*="projectRow"] svg,
  [class*="workspaceRow"] svg {
    color: #a1a1aa !important;
  }

  /* WorkBuddy 风格顶部 Tab 导航（对话 / 轨迹）：纯净白色文字与白色指示条 */
  .wSkVaW_tab,
  [class*="wSkVaW_tab"],
  [class*="_tab"][role="tab"] {
    color: #94a3b8 !important;
    font-weight: 500 !important;
    transition: color 120ms ease !important;
  }
  .wSkVaW_tab:hover,
  [class*="wSkVaW_tab"]:hover,
  [class*="_tab"][role="tab"]:hover {
    color: #cbd5e1 !important;
  }
  .wSkVaW_tabActive,
  [class*="wSkVaW_tabActive"],
  [class*="_tabActive"],
  button[role="tab"][aria-selected="true"],
  [class*="tab"][class*="active"],
  [class*="tab"][data-active="true"] {
    color: #ffffff !important;
    font-weight: 600 !important;
  }
  .wSkVaW_tabActive:after,
  [class*="wSkVaW_tabActive"]:after,
  [class*="_tabActive"]:after,
  button[role="tab"][aria-selected="true"]:after,
  [class*="tab"][class*="active"]:after,
  [class*="tab"][data-active="true"]:after {
    background: #ffffff !important;
    height: 2px !important;
    border-radius: 1px !important;
  }

  /* WorkBuddy 菜单徽标样式：全灰阶轻量微胶囊 */
  .copis-menu-badge {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.02em;
    background: rgba(255, 255, 255, 0.08);
    color: #d4d4d8;
    border: 1px solid rgba(255, 255, 255, 0.08);
    flex: none;
    line-height: 14px;
  }
  .copis-menu-badge-beta {
    background: rgba(255, 255, 255, 0.08);
    color: #d4d4d8;
    border-color: rgba(255, 255, 255, 0.08);
  }
  .copis-menu-badge-flexible {
    background: rgba(255, 255, 255, 0.06);
    color: #a1a1aa;
    border-color: rgba(255, 255, 255, 0.06);
  }

  /* 优雅紫色半透明毛玻璃 Composer 输入胶囊卡片（背景更深，紫色更淡内敛） */
  [class*="uV2eYG_card"],
  [class*="_card"][class*="composer"] {
    border-radius: 20px !important;
    background: color-mix(in srgb, var(--creation-ui-primary, #a855f7) 7%, rgba(16, 17, 24, 0.90)) !important;
    -webkit-backdrop-filter: blur(24px) !important;
    backdrop-filter: blur(24px) !important;
    border: 1px solid color-mix(in srgb, var(--creation-ui-primary, #a855f7) 12%, rgba(255, 255, 255, 0.08)) !important;
    box-shadow: 0 16px 40px -8px rgba(0, 0, 0, 0.6), 0 0 20px -4px color-mix(in srgb, var(--creation-ui-primary, #a855f7) 8%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
    margin-bottom: 16px !important;
    padding-top: 10px !important;
  }

  body:not([data-ds-dark-theme]) [class*="uV2eYG_card"],
  body:not([data-ds-dark-theme]) [class*="_card"][class*="composer"] {
    background: color-mix(in srgb, var(--creation-ui-primary, #6c00cc) 4%, rgba(255, 255, 255, 0.88)) !important;
    border: 1px solid color-mix(in srgb, var(--creation-ui-primary, #6c00cc) 10%, rgba(0, 0, 0, 0.08)) !important;
    box-shadow: 0 16px 36px -8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.8) !important;
  }

  [class*="uV2eYG_input"] {
    color: #f1f5f9 !important;
    font-size: 13.5px !important;
    line-height: 22px !important;
  }

  [class*="uV2eYG_placeholder"] {
    color: #64748b !important;
    font-size: 13.5px !important;
  }

  [class*="uV2eYG_add"] {
    background: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 9999px !important;
    color: #cbd5e1 !important;
  }

  [class*="uV2eYG_add"]:hover {
    background: rgba(255, 255, 255, 0.09) !important;
    color: #ffffff !important;
  }

  [class*="uV2eYG_select"] {
    background-color: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 9999px !important;
    color: #e2e8f0 !important;
    font-size: 12px !important;
    padding: 0 20px 0 10px !important;
  }

  [class*="uV2eYG_select"]:hover {
    background-color: rgba(255, 255, 255, 0.09) !important;
  }

  /* WorkBuddy 浅曜石灰极简发送按钮，彻底消除红色与亮紫色 */
  [class*="uV2eYG_primary"],
  button[class*="uV2eYG_primary"],
  [class*="composer"] button[type="submit"] {
    border-radius: 9999px !important;
    background: #3f414a !important; /* fallback token: var(--ui-primary) */
    color: #f1f5f9 !important;
    border: 1px solid rgba(255, 255, 255, 0.14) !important;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25) !important;
    transition: transform 120ms ease, background-color 120ms ease, border-color 120ms ease !important;
  }

  [class*="uV2eYG_primary"]:hover:not(:disabled),
  button[class*="uV2eYG_primary"]:hover:not(:disabled),
  [class*="composer"] button[type="submit"]:hover:not(:disabled) {
    background: #4d505a !important;
    border-color: rgba(255, 255, 255, 0.24) !important;
    color: #ffffff !important;
    transform: scale(1.05) !important;
  }

  [class*="uV2eYG_primary"]:disabled,
  button[class*="uV2eYG_primary"]:disabled,
  [class*="composer"] button[type="submit"]:disabled {
    background: rgba(255, 255, 255, 0.06) !important;
    color: rgba(255, 255, 255, 0.25) !important;
    border: 1px solid rgba(255, 255, 255, 0.05) !important;
    box-shadow: none !important;
    cursor: not-allowed !important;
    transform: none !important;
  }

  [class*="uV2eYG_root"]::after {
    content: "内容由 AI 生成，请核实重要信息";
    display: block;
    margin-top: 6px;
    font-size: 11px;
    color: rgba(148, 163, 184, 0.6);
    text-align: center;
    user-select: none;
  }

  /* 页面视口与对话容器：彻底消除横向多余滚动条与 hover 闪烁 */
  html,
  body,
  [class*="_centerCol"],
  [class*="centerCol"],
  [class*="_frame"],
  [class*="frame"],
  [data-view="conversation"],
  main,
  [class*="uV2eYG_root"] {
    overflow-x: clip !important;
    max-width: 100% !important;
  }

  /* 强制屏蔽页面与卡片底部的横向多余滚动条 */
  html::-webkit-scrollbar:horizontal,
  body::-webkit-scrollbar:horizontal,
  [class*="_centerCol"]::-webkit-scrollbar:horizontal,
  [class*="centerCol"]::-webkit-scrollbar:horizontal,
  [class*="uV2eYG_root"]::-webkit-scrollbar:horizontal,
  [class*="uV2eYG_card"]::-webkit-scrollbar:horizontal,
  [class*="uV2eYG_row"]::-webkit-scrollbar:horizontal {
    display: none !important;
    height: 0 !important;
    width: 0 !important;
  }

  /* 上下文用量圆环（ContextMeter）与底部工具按钮悬浮 Tooltip 定位边界防溢出保护 */
  [class*="JObwrW_root"] {
    overflow: visible !important;
  }

  [class*="JObwrW_root"] [role="tooltip"],
  [class*="JObwrW_root"] [class*="tooltip"],
  [class*="JObwrW_root"] [class*="Tooltip"] {
    right: 0 !important;
    left: auto !important;
    max-width: 240px !important;
    white-space: nowrap !important;
    pointer-events: none !important;
  }

  /* 全局 Tooltip 浮层尺寸保护：避免绝对定位或动画帧撑大视口底部 */
  [role="tooltip"],
  [class*="tooltip"],
  [class*="Tooltip"] {
    max-width: calc(100vw - 32px) !important;
    word-break: break-word !important;
    pointer-events: none !important;
  }

  /* 当 Copis 子视图（规划/记忆/知识库/专家团队等）激活时：
     1. 彻底隐藏 DSH 原生中间对话区、欢迎屏、输入区与右侧详情栏；
     2. 强制 DSH 外层 Frame 与侧边栏独占整个 WebContentsView 视口 (100%)；
     3. 强制 DSH 侧边栏保持展开宽态 (Wide)，严禁误折叠为窄 Rail。 */
  body.copis-subview-active [class*="_centerCol"],
  body.copis-subview-active [class*="centerCol"],
  body.copis-subview-active [class*="_detailsCol"],
  body.copis-subview-active [class*="detailsCol"],
  body.copis-subview-active [class*="_handle"],
  body.copis-subview-active [class*="handle"],
  body.copis-subview-active [data-view="conversation"],
  body.copis-subview-active main {
    display: none !important;
    width: 0 !important;
    min-width: 0 !important;
    max-width: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }

  body.copis-subview-active [class*="_frame"],
  body.copis-subview-active [class*="frame"] {
    display: flex !important;
    grid-template-columns: 100% !important;
    width: 100% !important;
    height: 100% !important;
  }

  body.copis-subview-active [class*="_sidebarCol"],
  body.copis-subview-active [class*="sidebarCol"] {
    display: flex !important;
    flex: 1 1 100% !important;
    width: 100% !important;
    max-width: 100% !important;
    height: 100% !important;
    border-right: none !important;
  }

  body.copis-subview-active aside.copis-creation-sidebar,
  body.copis-subview-active aside.hHd-Xa_root,
  body.copis-subview-active aside[class*="SidebarRoot"],
  body.copis-subview-active aside {
    width: 100% !important;
    padding: 6px var(--dsh-sidebar-inline-padding, 12px) !important;
  }

  /* 当子视图激活时，原「新会话」按钮无缝切换为「返回会话」按钮（WorkBuddy 浅灰质感） */
  body.copis-subview-active button[class*="_newSession"],
  body.copis-subview-active button[class*="newSession"] {
    display: flex !important;
    align-items: center !important;
    width: 100% !important;
    height: 36px !important;
    margin: 0 0 12px !important;
    padding: 0 12px !important;
    gap: 8px !important;
    background: rgba(255, 255, 255, 0.08) !important; /* fallback token: var(--creation-ui-primary-background) */
    color: #ffffff !important;
    border: 1px solid rgba(255, 255, 255, 0.14) !important;
    border-radius: 7px !important;
    align-self: stretch !important;
    cursor: pointer !important;
    transition: background-color 150ms ease, border-color 150ms ease !important;
    box-sizing: border-box !important;
  }

  body.copis-subview-active button[class*="_newSession"]:hover,
  body.copis-subview-active button[class*="newSession"]:hover {
    background: rgba(255, 255, 255, 0.12) !important;
    border-color: rgba(255, 255, 255, 0.22) !important;
  }

  /* 隐藏原「新建会话」图标 */
  body.copis-subview-active button[class*="_newSession"] svg,
  body.copis-subview-active button[class*="newSession"] svg {
    display: none !important;
  }

  /* 注入返回会话矢量箭头图标（仅作用于外层 button 前缀） */
  body.copis-subview-active button[class*="_newSession"]::before,
  body.copis-subview-active button[class*="newSession"]::before {
    content: "" !important;
    display: inline-block !important;
    width: 15px !important;
    height: 15px !important;
    flex: none !important;
    background-color: currentColor !important;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m12 19-7-7 7-7'/%3E%3Cpath d='M19 12H5'/%3E%3C/svg%3E") no-repeat center / contain !important;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m12 19-7-7 7-7'/%3E%3Cpath d='M19 12H5'/%3E%3C/svg%3E") no-repeat center / contain !important;
  }

  /* 隐藏原「新会话」文字，替换为「返回会话」，确保内部 label 绝不带多余边框、背景或伪类箭头 */
  body.copis-subview-active [class*="newSessionLabel"],
  body.copis-subview-active [class*="_newSessionLabel"] {
    font-size: 0 !important;
    max-width: none !important;
    opacity: 1 !important;
    display: inline-flex !important;
    align-items: center !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
    overflow: hidden !important;
    border: none !important;
    background: transparent !important;
    padding: 0 !important;
    margin: 0 !important;
    height: auto !important;
    color: currentColor !important;
    box-shadow: none !important;
  }

  body.copis-subview-active [class*="newSessionLabel"]::before,
  body.copis-subview-active [class*="_newSessionLabel"]::before {
    content: none !important;
    display: none !important;
  }

  body.copis-subview-active [class*="newSessionLabel"]::after,
  body.copis-subview-active [class*="_newSessionLabel"]::after {
    content: "返回会话" !important;
    font-size: 14px !important;
    font-weight: 600 !important;
    line-height: 20px !important;
    color: currentColor !important;
    white-space: nowrap !important;
    border: none !important;
    background: transparent !important;
    padding: 0 !important;
    margin: 0 !important;
  }

  /* 在按钮最右侧展示精致的 Esc 快捷键胶囊（仅作用于外层 button 自身） */
  body.copis-subview-active button[class*="_newSession"]::after,
  body.copis-subview-active button[class*="newSession"]::after {
    content: "Esc" !important;
    margin-left: auto !important;
    font-size: 10px !important;
    font-weight: 500 !important;
    font-family: ui-monospace, monospace !important;
    line-height: 1 !important;
    padding: 2px 5px !important;
    border-radius: 4px !important;
    border: 1px solid currentColor !important;
    opacity: 0.7 !important;
    background: transparent !important;
    color: currentColor !important;
    flex: none !important;
  }

  body.copis-subview-active [class*="_regionArea"],
  body.copis-subview-active [class*="regionArea"] {
    display: flex !important;
    flex-direction: column !important;
    margin-left: -4px !important;
    margin-right: calc(-1 * var(--dsh-sidebar-inline-padding, 12px)) !important;
    padding-left: 4px !important;
  }

  /* 确保侧边栏工作区顶栏未展开搜索时，搜索按钮与操作按钮完整呈现，防止被 flex 压缩或裁剪 */
  [class*="sectionHeader"] {
    display: flex !important;
    align-items: center !important;
  }
  [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) {
    display: flex !important;
    min-width: 28px !important;
    max-width: 28px !important;
    flex: 0 0 28px !important;
    margin-left: auto !important;
    opacity: 1 !important;
    visibility: visible !important;
  }
  [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) [class*="search"] {
    display: flex !important;
    width: 28px !important;
    height: 28px !important;
  }
  [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) [class*="searchButton"] {
    display: inline-flex !important;
    width: 28px !important;
    height: 28px !important;
  }
  [class*="headerActions"]:not([class*="headerActionsHidden"]):not([class*="_headerActionsHidden"]) {
    display: flex !important;
    align-items: center !important;
    gap: 4px !important;
    min-width: 60px !important;
    max-width: none !important;
    flex: 0 0 auto !important;
    opacity: 1 !important;
    visibility: visible !important;
  }

  body.copis-subview-active .copis-menu-section {
    display: grid !important;
  }

  body.copis-subview-active [class*="_footArea"],
  body.copis-subview-active [class*="footArea"] {
    align-items: stretch !important;
  }

  .copis-return-agent-host {
    display: flex;
    justify-content: center;
    width: 100%;
    min-width: 0;
  }

  .copis-return-agent-button.copis-menu-item {
    width: 100%;
  }

  /* 隐藏顶部右上角原生的 session-log-download 及任何 Agent 模式切换按钮 */
  button[class*="sessionLogButton"],
  button[title*="返回 Agent 模式"]:not(.copis-return-agent-button),
  button[title*="返回Agent 模式"]:not(.copis-return-agent-button),
  button[aria-label*="返回 Agent 模式"]:not(.copis-return-agent-button),
  button[aria-label*="返回Agent 模式"]:not(.copis-return-agent-button),
  [data-slot-id="session-log-download"] {
    display: none !important;
  }

  /* 搜索浮层全局遮罩与弹窗：保持底层 DSH 视图完全可见，绝不触发全黑全白 */
  .copis-search-modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 14vh;
    animation: copis-search-modal-fade-in 140ms ease-out;
  }

  @keyframes copis-search-modal-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .copis-search-modal-card {
    width: 580px;
    max-width: calc(100vw - 32px);
    max-height: 520px;
    background: var(--dsw-alias-bg-base, #ffffff);
    color: var(--dsw-alias-label-primary, #18181b);
    border: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.1));
    border-radius: 12px;
    box-shadow: 0 20px 48px -12px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.05);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: var(--dsw-font-family, system-ui, sans-serif);
    animation: copis-search-modal-scale-in 140ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes copis-search-modal-scale-in {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(-8px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .copis-search-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
  }

  .copis-search-main-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 14px;
    color: var(--dsw-alias-label-primary, inherit);
    line-height: 20px;
  }

  .copis-search-main-input::placeholder {
    color: var(--dsw-alias-label-tertiary, #a1a1aa);
  }

  .copis-search-submit-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    background: rgba(255, 255, 255, 0.15);
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.1);
    cursor: pointer;
    transition: all 120ms ease;
  }

  .copis-search-submit-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.22);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .copis-search-submit-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .copis-search-results-list {
    max-height: 380px;
    overflow-y: auto;
    padding: 4px 0;
  }

  .copis-search-item-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    cursor: pointer;
    border: none;
    background: transparent;
    width: 100%;
    text-align: left;
    color: inherit;
    font-family: inherit;
    transition: background-color 100ms ease;
  }

  .copis-search-item-row:hover,
  .copis-search-item-row[data-selected="true"] {
    background: rgba(255, 255, 255, 0.08) !important;
  }

  .copis-search-badge-creation {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    color: #e4e4e7;
    border: 1px solid rgba(255, 255, 255, 0.1);
    font-weight: 500;
    flex-shrink: 0;
  }

  .copis-search-badge-agent {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(240, 154, 67, 0.15);
    color: #f09a43;
    font-weight: 500;
    flex-shrink: 0;
  }

  .copis-search-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    border-top: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.06));
    font-size: 11px;
    color: var(--dsw-alias-label-tertiary, #a1a1aa);
    background: var(--dsw-alias-bg-base, inherit);
    flex-shrink: 0;
  }

  /* 彻底屏蔽 DSH 原生设置弹窗与遮罩层，统一由 Copis 全屏设置面板接管 */
  [class*="VOzbGW_panel"],
  [class*="VOzbGW_overlay"],
  [class*="VOzbGW_mask"],
  [class*="settingsArea"] [role="dialog"],
  [class*="SettingsArea"] [role="dialog"],
  [class*="SettingsPanel"],
  [class*="settingsPanel"] {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
`;
function installCreationStyles() {
  if (typeof document === "undefined")
    return;
  if (document.getElementById(CREATION_STYLES_ID))
    return;
  const style = document.createElement("style");
  style.id = CREATION_STYLES_ID;
  style.textContent = CREATION_UI_CSS;
  document.head.appendChild(style);
}
function isSettingsTarget(target) {
  if (!target)
    return false;
  const btn = target.closest("button");
  if (!btn)
    return false;
  if (btn.closest('[class*="composer"], [class*="Composer"], [class*="uV2eYG"], [class*="_centerCol"], [class*="centerCol"], [class*="chatArea"], [class*="messageList"], [class*="sessionView"], [class*="_detailsCol"]')) {
    return false;
  }
  const inSidebar = Boolean(btn.closest('aside, [class*="SidebarRoot"], [class*="sidebar"], [class*="_sidebarCol"], [class*="footArea"], [class*="FootArea"], [class*="settingsArea"], [class*="SettingsArea"], .copis-creation-sidebar'));
  if (!inSidebar) {
    return false;
  }
  if (btn.closest('[class*="settingsArea"], [class*="SettingsArea"]'))
    return true;
  if (btn.closest('[class*="triggerRow"], [class*="TriggerRow"]') && btn.getAttribute("aria-haspopup") === "dialog")
    return true;
  if (btn.matches('button[class*="trigger"][aria-haspopup="dialog"], button[class*="Trigger"][aria-haspopup="dialog"]'))
    return true;
  const aria = (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").toLowerCase();
  if (aria.includes("设置") || aria.includes("setting"))
    return true;
  const text = (btn.textContent || "").trim().toLowerCase();
  if (text.includes("设置") || text.includes("setting"))
    return true;
  return false;
}
function sendNavigation(view, tab) {
  if (view && view !== "conversations") {
    document.body?.classList.add("copis-subview-active");
    document.documentElement?.classList.add("copis-subview-active");
  } else {
    document.body?.classList.remove("copis-subview-active");
    document.documentElement?.classList.remove("copis-subview-active");
  }
  if (view === "settings") {
    if (window.copisBridge?.openSettings) {
      window.copisBridge.openSettings();
      return;
    }
    window.postMessage({ type: "COPIS_OPEN_SETTINGS" }, "*");
    return;
  }
  if (window.copisBridge?.navigate) {
    window.copisBridge.navigate(view, tab);
    return;
  }
  window.postMessage({ type: "COPIS_NAVIGATE", view, tab }, "*");
}
function sendSearchRequest() {
  window.dispatchEvent(new CustomEvent("COPIS_OPEN_SEARCH_MODAL"));
  if (window.copisBridge?.openSearch) {
    window.copisBridge.openSearch();
    return;
  }
  window.postMessage({ type: "COPIS_OPEN_SEARCH" }, "*");
}
function getInitialHiddenMenuIds() {
  if (typeof window === "undefined")
    return [];
  try {
    return window.copisBridge?.getHiddenMenuItems?.() ?? [];
  } catch {
    return [];
  }
}
function attachSidebarMenu(element) {
  const sidebar = element.closest('[class*="_root"]') ?? element.closest('[class*="SidebarRoot"]') ?? element.closest('[class*="_sidebarCol"], [class*="sidebarCol"]') ?? element.closest("aside");
  if (!sidebar)
    return;
  sidebar.classList.add("copis-creation-sidebar");
  const legacySections = sidebar.querySelectorAll('.copis-menu-section:not([data-copis-placement="before-workspaces"]), .copis-rail-menu-section:not([data-copis-placement="before-workspaces"])');
  legacySections.forEach((el) => el.remove());
  const target = sidebar.querySelector('[class*="_regionArea"], [class*="regionArea"]') ?? sidebar.querySelector('button[class*="_newSession"], button[class*="newSession"]');
  if (target && element.parentElement !== sidebar) {
    sidebar.insertBefore(element, target);
  }
}
var cachedCordisContext = null;
function CreationSidebarNavigation(props) {
  const [activeView, setActiveView] = import_react4.useState("conversations");
  const [hiddenMenuIds, setHiddenMenuIds] = import_react4.useState(getInitialHiddenMenuIds);
  const rootRef = import_react4.useRef(null);
  const isSubviewActive = activeView !== "conversations";
  const effectiveCtx = props.ctx ?? cachedCordisContext;
  const wide = isSubviewActive || Boolean(props.wide) || !props.collapsed && (props.width === undefined || props.width >= 200);
  import_react4.useLayoutEffect(() => {
    if (rootRef.current) {
      attachSidebarMenu(rootRef.current);
      const sidebar = rootRef.current.closest('[class*="_root"], [class*="SidebarRoot"], [class*="_sidebarCol"], [class*="sidebarCol"], aside');
      if (sidebar && !isSubviewActive && typeof document !== "undefined" && !document.body.classList.contains("copis-subview-active")) {
        const w = sidebar.getBoundingClientRect().width;
        if (w >= 200 && w <= 360 && window.copisBridge?.reportSidebarInfo) {
          window.copisBridge.reportSidebarInfo({ width: Math.round(w), wide: true });
        }
      }
    }
  }, [props.collapsed, props.width, hiddenMenuIds, activeView, isSubviewActive]);
  import_react4.useEffect(() => {
    if (!isSubviewActive)
      return;
    let calling = false;
    const expandIfCollapsed = () => {
      if (calling)
        return;
      const frame2 = document.querySelector("[data-sidebar-collapsed]");
      const sidebar = rootRef.current?.closest('aside.copis-creation-sidebar, aside.hHd-Xa_root, aside[class*="SidebarRoot"], aside');
      const isCollapsed = Boolean(frame2 || props.collapsed === true || sidebar?.classList.contains("hHd-Xa_collapsed")) && props.wide !== true;
      if (isCollapsed && effectiveCtx?.layout?.toggleSidebar) {
        calling = true;
        try {
          effectiveCtx.layout.toggleSidebar();
        } catch (err) {
          console.warn("[Copis Creation Web] 自动展开侧边栏失败:", err);
        } finally {
          setTimeout(() => {
            calling = false;
          }, 60);
        }
      }
    };
    expandIfCollapsed();
    const timer1 = setTimeout(expandIfCollapsed, 60);
    const timer2 = setTimeout(expandIfCollapsed, 200);
    let observer = null;
    const frame = document.querySelector('[class*="_frame"], [class*="frame"]') || document.body;
    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => {
        expandIfCollapsed();
      });
      observer.observe(frame, { attributes: true, attributeFilter: ["data-sidebar-collapsed", "class"] });
    }
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      observer?.disconnect();
    };
  }, [isSubviewActive, props.collapsed, props.wide, effectiveCtx]);
  import_react4.useEffect(() => {
    const handleTopButtonClick = (event) => {
      if (!isSubviewActive)
        return;
      const target = event.target;
      const topBtn = target?.closest('button[class*="_newSession"], button[class*="newSession"]');
      if (!topBtn)
        return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setActiveView("conversations");
      document.body?.classList.remove("copis-subview-active");
      document.documentElement?.classList.remove("copis-subview-active");
      sendNavigation("conversations");
    };
    document.addEventListener("click", handleTopButtonClick, true);
    return () => document.removeEventListener("click", handleTopButtonClick, true);
  }, [isSubviewActive]);
  import_react4.useEffect(() => {
    const topBtn = document.querySelector('button[class*="_newSession"], button[class*="newSession"]');
    if (!topBtn)
      return;
    if (isSubviewActive) {
      topBtn.setAttribute("data-copis-return-button", "true");
      topBtn.setAttribute("title", "返回会话 (Esc)");
      topBtn.setAttribute("aria-label", "返回会话 (Esc)");
    } else {
      topBtn.removeAttribute("data-copis-return-button");
      topBtn.setAttribute("title", "新建会话");
      topBtn.setAttribute("aria-label", "新建会话");
    }
  }, [isSubviewActive]);
  import_react4.useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname.toLowerCase();
      if (path.includes("planning"))
        setActiveView("planning");
      else if (path.includes("automations"))
        setActiveView("automations");
      else if (path.includes("memory"))
        setActiveView("memory");
      else if (path.includes("knowledge"))
        setActiveView("knowledge");
      else if (path.includes("expert-team"))
        setActiveView("expert-team");
      else if (path.includes("agent-skills"))
        setActiveView("agent-skills");
      else if (path.includes("fund-stock"))
        setActiveView("fund-stock");
      else
        setActiveView("conversations");
    };
    handlePopState();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  import_react4.useEffect(() => {
    const handleActiveViewMessage = (event) => {
      if (event.data && typeof event.data === "object") {
        const d = event.data;
        if (d.type === "COPIS_ACTIVE_VIEW_CHANGE") {
          if (d.view === "conversations") {
            setActiveView("conversations");
            document.body?.classList.remove("copis-subview-active");
            document.documentElement?.classList.remove("copis-subview-active");
          } else if (d.view) {
            setActiveView(d.view);
            document.body?.classList.add("copis-subview-active");
            document.documentElement?.classList.add("copis-subview-active");
          }
        } else if (d.type === "COPIS_SUBVIEW_CHANGE") {
          if (!d.subview) {
            setActiveView("conversations");
            document.body?.classList.remove("copis-subview-active");
            document.documentElement?.classList.remove("copis-subview-active");
          } else {
            setActiveView(d.subview);
            document.body?.classList.add("copis-subview-active");
            document.documentElement?.classList.add("copis-subview-active");
          }
        }
      }
    };
    window.addEventListener("message", handleActiveViewMessage);
    return () => window.removeEventListener("message", handleActiveViewMessage);
  }, []);
  import_react4.useEffect(() => {
    const handleHiddenItemsChange = (event) => {
      const customEvent = event;
      if (Array.isArray(customEvent.detail?.hiddenMenuIds)) {
        setHiddenMenuIds(customEvent.detail.hiddenMenuIds);
      } else {
        setHiddenMenuIds(getInitialHiddenMenuIds());
      }
    };
    window.addEventListener("COPIS_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED", handleHiddenItemsChange);
    return () => window.removeEventListener("COPIS_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED", handleHiddenItemsChange);
  }, []);
  import_react4.useEffect(() => {
    const openCopisSettings = (event) => {
      const target = event.target;
      if (!isSettingsTarget(target))
        return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setActiveView("settings");
      sendNavigation("settings");
    };
    document.addEventListener("click", openCopisSettings, true);
    return () => document.removeEventListener("click", openCopisSettings, true);
  }, []);
  const selectItem = (item) => {
    if (item.action === "search") {
      sendSearchRequest();
      return;
    }
    if (!item.view)
      return;
    setActiveView(item.view);
    document.body?.classList.add("copis-subview-active");
    document.documentElement?.classList.add("copis-subview-active");
    sendNavigation(item.view, item.tab);
  };
  const handleHideMenuItem = (menuId) => {
    setHiddenMenuIds((prev) => Array.from(new Set([...prev, menuId])));
    if (window.copisBridge?.hideMenuItem) {
      window.copisBridge.hideMenuItem(menuId);
    }
  };
  const visibleMenuItems = SIDEBAR_MENU_ITEMS.filter((item) => !hiddenMenuIds.includes(item.id));
  const returnControl = /* @__PURE__ */ jsx_runtime2.jsx(CreationReturnToAgentControl, {
    wide,
    menuRef: rootRef,
    onReturn: () => window.copisBridge?.switchMode?.("agent")
  });
  if (!wide) {
    return /* @__PURE__ */ jsx_runtime2.jsxs(jsx_runtime2.Fragment, {
      children: [
        /* @__PURE__ */ jsx_runtime2.jsx("div", {
          ref: rootRef,
          className: "copis-rail-menu-section",
          "data-copis-placement": "before-workspaces",
          children: visibleMenuItems.map((item) => {
            const Icon2 = item.icon;
            return /* @__PURE__ */ jsx_runtime2.jsx("button", {
              type: "button",
              className: "copis-rail-menu-item",
              "data-copis-menu-id": item.id,
              "data-active": item.view === activeView ? "true" : "false",
              "aria-label": item.label,
              title: item.label,
              onClick: () => selectItem(item),
              children: /* @__PURE__ */ jsx_runtime2.jsx(Icon2, {
                size: 18,
                strokeWidth: 1.8
              })
            }, item.id);
          })
        }),
        returnControl
      ]
    });
  }
  return /* @__PURE__ */ jsx_runtime2.jsxs(jsx_runtime2.Fragment, {
    children: [
      /* @__PURE__ */ jsx_runtime2.jsx("div", {
        ref: rootRef,
        className: "copis-menu-section",
        "data-copis-placement": "before-workspaces",
        children: visibleMenuItems.map((item) => {
          const Icon2 = item.icon;
          return /* @__PURE__ */ jsx_runtime2.jsxs("button", {
            type: "button",
            className: "copis-menu-item",
            "data-copis-menu-id": item.id,
            "data-active": item.view === activeView ? "true" : "false",
            onClick: () => selectItem(item),
            children: [
              /* @__PURE__ */ jsx_runtime2.jsx(Icon2, {
                size: 16,
                strokeWidth: 1.8
              }),
              /* @__PURE__ */ jsx_runtime2.jsx("span", {
                children: item.label
              }),
              item.badge && /* @__PURE__ */ jsx_runtime2.jsx("span", {
                className: `copis-menu-badge ${item.badge === "BETA" ? "copis-menu-badge-beta" : "copis-menu-badge-flexible"}`,
                children: item.badge
              }),
              /* @__PURE__ */ jsx_runtime2.jsx("button", {
                type: "button",
                className: "copis-dsh-menu-hide-btn",
                onClick: (e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleHideMenuItem(item.id);
                },
                "aria-label": `隐藏${item.label}`,
                title: "隐藏此菜单",
                children: "隐藏"
              })
            ]
          }, item.id);
        })
      }),
      returnControl
    ]
  });
}
function HighlightSearchText({ text, query }) {
  if (!query || !query.trim())
    return /* @__PURE__ */ jsx_runtime2.jsx(jsx_runtime2.Fragment, {
      children: text
    });
  const trimmed = query.trim();
  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const parts = [];
  let lastIndex = 0;
  let idx = lowerText.indexOf(lowerQuery);
  while (idx !== -1) {
    if (idx > lastIndex) {
      parts.push(/* @__PURE__ */ jsx_runtime2.jsx("span", {
        children: text.slice(lastIndex, idx)
      }, `t-${lastIndex}`));
    }
    parts.push(/* @__PURE__ */ jsx_runtime2.jsx("mark", {
      style: {
        background: "rgba(255, 255, 255, 0.18)",
        color: "#ffffff",
        borderRadius: 2,
        padding: "0 2px",
        fontWeight: 600
      },
      children: text.slice(idx, idx + trimmed.length)
    }, `m-${idx}`));
    lastIndex = idx + trimmed.length;
    idx = lowerText.indexOf(lowerQuery, lastIndex);
  }
  if (lastIndex < text.length) {
    parts.push(/* @__PURE__ */ jsx_runtime2.jsx("span", {
      children: text.slice(lastIndex)
    }, `end-${lastIndex}`));
  }
  return /* @__PURE__ */ jsx_runtime2.jsx(jsx_runtime2.Fragment, {
    children: parts
  });
}
function CopisSearchModal(props) {
  const [query, setQuery] = import_react4.useState("");
  const [committedQuery, setCommittedQuery] = import_react4.useState("");
  const [loading, setLoading] = import_react4.useState(false);
  const [hasSearched, setHasSearched] = import_react4.useState(false);
  const [titleResults, setTitleResults] = import_react4.useState([]);
  const [contentResults, setContentResults] = import_react4.useState([]);
  const [selectedIndex, setSelectedIndex] = import_react4.useState(0);
  const inputRef = import_react4.useRef(null);
  const isComposingRef = import_react4.useRef(false);
  const searchTokenRef = import_react4.useRef(0);
  import_react4.useEffect(() => {
    if (props.open) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    } else {
      setQuery("");
      setCommittedQuery("");
      setTitleResults([]);
      setContentResults([]);
      setHasSearched(false);
      setSelectedIndex(0);
    }
  }, [props.open]);
  const runSearch = import_react4.useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setTitleResults([]);
      setContentResults([]);
      setHasSearched(false);
      setCommittedQuery("");
      return;
    }
    const token = ++searchTokenRef.current;
    setCommittedQuery(q);
    setHasSearched(true);
    setLoading(true);
    setSelectedIndex(0);
    const qLower = q.toLowerCase();
    const titles = [];
    try {
      const listSnapshot = props.ctx.sessions?.list?.getSnapshot();
      if (listSnapshot?.byId) {
        for (const [id, s] of Object.entries(listSnapshot.byId)) {
          const t = s?.title || "新会话";
          if (t.toLowerCase().includes(qLower)) {
            titles.push({
              id,
              title: t,
              source: "creation",
              updatedAt: s?.updatedAt || s?.createdAt || 0
            });
          }
        }
      }
    } catch (err) {
      console.warn("[CopisSearchModal] 读取 DSH 会话失败:", err);
    }
    try {
      if (window.copisBridge?.getAgentSessions) {
        const agentSessions = await window.copisBridge.getAgentSessions();
        if (token === searchTokenRef.current && Array.isArray(agentSessions)) {
          for (const s of agentSessions) {
            if (s?.title && s.title.toLowerCase().includes(qLower)) {
              titles.push({
                id: s.id,
                title: s.title,
                source: "agent",
                updatedAt: s.updatedAt || 0
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn("[CopisSearchModal] 读取 Agent 会话失败:", err);
    }
    if (token !== searchTokenRef.current)
      return;
    titles.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    setTitleResults(titles);
    try {
      if (window.copisBridge?.searchAgentSessionMessages) {
        const messageResults = await window.copisBridge.searchAgentSessionMessages(q);
        if (token === searchTokenRef.current && Array.isArray(messageResults)) {
          const titleIds = new Set(titles.map((t) => t.id));
          const contents = messageResults.filter((r) => !titleIds.has(r.sessionId)).map((r) => ({
            id: r.sessionId,
            title: r.sessionTitle,
            source: "agent",
            snippet: r.snippet,
            matchStart: r.matchStart,
            matchLength: r.matchLength
          }));
          setContentResults(contents);
        }
      }
    } catch (err) {
      console.warn("[CopisSearchModal] 搜索消息全文失败:", err);
    } finally {
      if (token === searchTokenRef.current) {
        setLoading(false);
      }
    }
  }, [query, props.ctx.sessions]);
  const allResults = import_react4.useMemo(() => [...titleResults, ...contentResults], [titleResults, contentResults]);
  const navigateToResult = import_react4.useCallback((item) => {
    props.onClose();
    if (item.source === "creation") {
      try {
        if (props.ctx.sessions?.open) {
          props.ctx.sessions.open(item.id);
        } else if (props.ctx.sessions?.select) {
          props.ctx.sessions.select(item.id);
        } else {
          const el = document.querySelector(`[data-session-id="${item.id}"]`);
          el?.click();
        }
      } catch {
        const el = document.querySelector(`[data-session-id="${item.id}"]`);
        el?.click();
      }
    } else {
      if (window.copisBridge?.openSession) {
        window.copisBridge.openSession("agent", item.id, item.title);
      } else if (window.copisBridge?.switchMode) {
        window.copisBridge.switchMode("agent");
      }
    }
  }, [props.ctx.sessions, props.onClose]);
  const handleKeyDown = import_react4.useCallback((e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => allResults.length > 0 ? (prev + 1) % allResults.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => allResults.length > 0 ? (prev - 1 + allResults.length) % allResults.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isComposingRef.current)
        return;
      if (query.trim() !== committedQuery || !hasSearched) {
        runSearch();
      } else if (allResults[selectedIndex]) {
        navigateToResult(allResults[selectedIndex]);
      }
    }
  }, [allResults, committedQuery, hasSearched, navigateToResult, props, query, runSearch, selectedIndex]);
  if (!props.open)
    return null;
  const isQueryDirty = query.trim() !== committedQuery;
  return /* @__PURE__ */ jsx_runtime2.jsx("div", {
    className: "copis-search-modal-backdrop",
    onClick: (e) => {
      if (e.target === e.currentTarget) {
        props.onClose();
      }
    },
    children: /* @__PURE__ */ jsx_runtime2.jsxs("div", {
      className: "copis-search-modal-card",
      onKeyDown: handleKeyDown,
      children: [
        /* @__PURE__ */ jsx_runtime2.jsxs("div", {
          className: "copis-search-input-row",
          children: [
            /* @__PURE__ */ jsx_runtime2.jsx(Search, {
              size: 16,
              style: { color: "var(--dsw-alias-label-tertiary, #a1a1aa)", flexShrink: 0 }
            }),
            /* @__PURE__ */ jsx_runtime2.jsx("input", {
              ref: inputRef,
              type: "text",
              className: "copis-search-main-input",
              value: query,
              placeholder: "输入关键词，按 Enter 或点击搜索",
              onChange: (e) => setQuery(e.target.value),
              onCompositionStart: () => {
                isComposingRef.current = true;
              },
              onCompositionEnd: () => {
                isComposingRef.current = false;
              }
            }),
            query && /* @__PURE__ */ jsx_runtime2.jsx("button", {
              type: "button",
              onClick: () => {
                setQuery("");
                setCommittedQuery("");
                setTitleResults([]);
                setContentResults([]);
                setHasSearched(false);
                setSelectedIndex(0);
                inputRef.current?.focus();
              },
              style: {
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--dsw-alias-label-tertiary, #a1a1aa)",
                padding: "2px",
                display: "inline-flex",
                alignItems: "center"
              },
              title: "清空",
              children: /* @__PURE__ */ jsx_runtime2.jsx(X, {
                size: 14
              })
            }),
            /* @__PURE__ */ jsx_runtime2.jsxs("button", {
              type: "button",
              className: "copis-search-submit-btn",
              disabled: !query.trim() || loading,
              onClick: () => void runSearch(),
              children: [
                loading ? /* @__PURE__ */ jsx_runtime2.jsx(LoaderCircle, {
                  size: 13,
                  className: "copis-spin"
                }) : /* @__PURE__ */ jsx_runtime2.jsx(Search, {
                  size: 13
                }),
                /* @__PURE__ */ jsx_runtime2.jsx("span", {
                  children: "搜索"
                })
              ]
            })
          ]
        }),
        /* @__PURE__ */ jsx_runtime2.jsxs("div", {
          className: "copis-search-results-list",
          children: [
            !hasSearched && /* @__PURE__ */ jsx_runtime2.jsx("div", {
              style: { padding: "36px 16px", textAlign: "center", fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
              children: "输入关键词后按 Enter 或点击搜索开始查找"
            }),
            hasSearched && loading && allResults.length === 0 && /* @__PURE__ */ jsx_runtime2.jsxs("div", {
              style: { padding: "36px 16px", textAlign: "center", fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" },
              children: [
                /* @__PURE__ */ jsx_runtime2.jsx(LoaderCircle, {
                  size: 14,
                  className: "copis-spin"
                }),
                /* @__PURE__ */ jsx_runtime2.jsx("span", {
                  children: "正在搜索..."
                })
              ]
            }),
            hasSearched && !loading && allResults.length === 0 && /* @__PURE__ */ jsx_runtime2.jsxs("div", {
              style: { padding: "36px 16px", textAlign: "center", fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
              children: [
                '未找到与 "',
                committedQuery,
                '" 匹配的会话内容'
              ]
            }),
            titleResults.length > 0 && /* @__PURE__ */ jsx_runtime2.jsxs("div", {
              children: [
                /* @__PURE__ */ jsx_runtime2.jsxs("div", {
                  style: { padding: "6px 14px 2px", fontSize: "11px", fontWeight: 600, color: "var(--dsw-alias-label-tertiary, #a1a1aa)", textTransform: "uppercase" },
                  children: [
                    "会话匹配 (",
                    titleResults.length,
                    ")"
                  ]
                }),
                titleResults.map((item, idx) => /* @__PURE__ */ jsx_runtime2.jsxs("button", {
                  type: "button",
                  className: "copis-search-item-row",
                  "data-selected": selectedIndex === idx ? "true" : "false",
                  onClick: () => navigateToResult(item),
                  onMouseEnter: () => setSelectedIndex(idx),
                  children: [
                    item.source === "creation" ? /* @__PURE__ */ jsx_runtime2.jsx("span", {
                      className: "copis-search-badge-creation",
                      children: "创造"
                    }) : /* @__PURE__ */ jsx_runtime2.jsx("span", {
                      className: "copis-search-badge-agent",
                      children: "Agent"
                    }),
                    /* @__PURE__ */ jsx_runtime2.jsx("span", {
                      style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px", fontWeight: 500 },
                      children: /* @__PURE__ */ jsx_runtime2.jsx(HighlightSearchText, {
                        text: item.title,
                        query: committedQuery
                      })
                    })
                  ]
                }, `title-${item.id}-${idx}`))
              ]
            }),
            contentResults.length > 0 && /* @__PURE__ */ jsx_runtime2.jsxs("div", {
              style: { borderTop: "0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08))", marginTop: "4px", paddingTop: "4px" },
              children: [
                /* @__PURE__ */ jsx_runtime2.jsxs("div", {
                  style: { padding: "6px 14px 2px", fontSize: "11px", fontWeight: 600, color: "var(--dsw-alias-label-tertiary, #a1a1aa)", textTransform: "uppercase" },
                  children: [
                    "消息内容匹配 (",
                    contentResults.length,
                    ")"
                  ]
                }),
                contentResults.map((item, idx) => {
                  const globalIdx = titleResults.length + idx;
                  return /* @__PURE__ */ jsx_runtime2.jsxs("button", {
                    type: "button",
                    className: "copis-search-item-row",
                    "data-selected": selectedIndex === globalIdx ? "true" : "false",
                    onClick: () => navigateToResult(item),
                    onMouseEnter: () => setSelectedIndex(globalIdx),
                    style: { flexDirection: "column", alignItems: "flex-start", gap: "3px" },
                    children: [
                      /* @__PURE__ */ jsx_runtime2.jsxs("div", {
                        style: { display: "flex", alignItems: "center", gap: "8px", width: "100%" },
                        children: [
                          /* @__PURE__ */ jsx_runtime2.jsx("span", {
                            className: "copis-search-badge-agent",
                            children: "Agent"
                          }),
                          /* @__PURE__ */ jsx_runtime2.jsx("span", {
                            style: { fontSize: "12px", fontWeight: 500, opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                            children: item.title
                          })
                        ]
                      }),
                      item.snippet && /* @__PURE__ */ jsx_runtime2.jsx("div", {
                        style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #71717a)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%", paddingLeft: "4px" },
                        children: /* @__PURE__ */ jsx_runtime2.jsx(HighlightSearchText, {
                          text: item.snippet,
                          query: committedQuery
                        })
                      })
                    ]
                  }, `content-${item.id}-${idx}`);
                })
              ]
            })
          ]
        }),
        /* @__PURE__ */ jsx_runtime2.jsxs("div", {
          className: "copis-search-footer",
          children: [
            /* @__PURE__ */ jsx_runtime2.jsxs("span", {
              children: [
                "↵ ",
                isQueryDirty || !hasSearched ? "搜索" : "打开"
              ]
            }),
            /* @__PURE__ */ jsx_runtime2.jsx("span", {
              children: "↑↓ 选择"
            }),
            /* @__PURE__ */ jsx_runtime2.jsx("span", {
              children: "Esc 关闭"
            })
          ]
        })
      ]
    })
  });
}
function CopisShellOverlayManager(props) {
  const [searchOpen, setSearchOpen] = import_react4.useState(false);
  import_react4.useEffect(() => {
    const handleOpenSearch = () => setSearchOpen(true);
    const handleMessage = (event) => {
      if (event.data && typeof event.data === "object" && (event.data.type === "COPIS_OPEN_SEARCH_MODAL" || event.data.type === "COPIS_OPEN_SEARCH")) {
        setSearchOpen(true);
      }
    };
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("COPIS_OPEN_SEARCH_MODAL", handleOpenSearch);
    window.addEventListener("message", handleMessage);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("COPIS_OPEN_SEARCH_MODAL", handleOpenSearch);
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
  return searchOpen ? /* @__PURE__ */ jsx_runtime2.jsx(CopisSearchModal, {
    open: true,
    onClose: () => setSearchOpen(false),
    ctx: props.ctx
  }) : null;
}
var inject = ["slots", "layout", "sessions", "workspaces"];
function apply(ctx) {
  cachedCordisContext = ctx;
  console.log("[Copis Creation Web] 客户端插件正在激活...", ctx);
  installCreationStyles();
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "copis-creation-sidebar", order: -100 }, (props) => /* @__PURE__ */ jsx_runtime2.jsx(CreationSidebarNavigation, {
    ...props,
    ctx
  })));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "copis-shell-overlay-manager",
    order: 100
  }, () => /* @__PURE__ */ jsx_runtime2.jsx(CopisShellOverlayManager, {
    ctx
  })));
  console.log("[Copis Creation Web] 客户端插件插槽注入完成");
}

    exports.apply = typeof apply !== "undefined" ? apply : undefined;
    exports.inject = typeof inject !== "undefined" ? inject : undefined;
    exports.default = { apply: exports.apply, inject: exports.inject };
    return module.exports;
  }
});
