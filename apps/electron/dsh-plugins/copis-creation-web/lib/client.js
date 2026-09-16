window.__ModuleLoader__.load({
  id: "@copis-ext/creation-web",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// apps/electron/dsh-plugins/copis-creation-web/src/client.tsx
var exports_client = {};
__export(exports_client, {
  isSettingsTarget: () => isSettingsTarget,
  inject: () => inject,
  apply: () => apply,
  CreationSidebarNavigation: () => CreationSidebarNavigation,
  CopisShellOverlayManager: () => CopisShellOverlayManager,
  CopisSearchModal: () => CopisSearchModal,
  CopisHeaderUtilities: () => CopisHeaderUtilities,
  CopisDetailsPanel: () => CopisDetailsPanel
});
module.exports = __toCommonJS(exports_client);
// node_modules/lucide-react/dist/esm/createLucideIcon.js
var import_react2 = require("react");

// node_modules/lucide-react/dist/esm/shared/src/utils.js
var toKebabCase = (string) => string.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
var mergeClasses = (...classes) => classes.filter((className, index, array) => {
  return Boolean(className) && className.trim() !== "" && array.indexOf(className) === index;
}).join(" ").trim();

// node_modules/lucide-react/dist/esm/Icon.js
var import_react = require("react");

// node_modules/lucide-react/dist/esm/defaultAttributes.js
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

// node_modules/lucide-react/dist/esm/Icon.js
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

// node_modules/lucide-react/dist/esm/createLucideIcon.js
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

// node_modules/lucide-react/dist/esm/icons/loader-circle.js
var LoaderCircle = createLucideIcon("LoaderCircle", [
  ["path", { d: "M21 12a9 9 0 1 1-6.219-8.56", key: "13zald" }]
]);
// node_modules/lucide-react/dist/esm/icons/users-round.js
var UsersRound = createLucideIcon("UsersRound", [
  ["path", { d: "M18 21a8 8 0 0 0-16 0", key: "3ypg7q" }],
  ["circle", { cx: "10", cy: "8", r: "5", key: "o932ke" }],
  ["path", { d: "M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3", key: "10s06x" }]
]);
// node_modules/lucide-react/dist/esm/icons/book-open.js
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
// node_modules/lucide-react/dist/esm/icons/brain.js
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
// node_modules/lucide-react/dist/esm/icons/calendar-clock.js
var CalendarClock = createLucideIcon("CalendarClock", [
  ["path", { d: "M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5", key: "1osxxc" }],
  ["path", { d: "M16 2v4", key: "4m81vk" }],
  ["path", { d: "M8 2v4", key: "1cmpym" }],
  ["path", { d: "M3 10h5", key: "r794hk" }],
  ["path", { d: "M17.5 17.5 16 16.3V14", key: "akvzfd" }],
  ["circle", { cx: "16", cy: "16", r: "6", key: "qoo3c4" }]
]);
// node_modules/lucide-react/dist/esm/icons/check.js
var Check = createLucideIcon("Check", [["path", { d: "M20 6 9 17l-5-5", key: "1gmf2c" }]]);
// node_modules/lucide-react/dist/esm/icons/chevron-down.js
var ChevronDown = createLucideIcon("ChevronDown", [
  ["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]
]);
// node_modules/lucide-react/dist/esm/icons/chevron-left.js
var ChevronLeft = createLucideIcon("ChevronLeft", [
  ["path", { d: "m15 18-6-6 6-6", key: "1wnfg3" }]
]);
// node_modules/lucide-react/dist/esm/icons/chevron-right.js
var ChevronRight = createLucideIcon("ChevronRight", [
  ["path", { d: "m9 18 6-6-6-6", key: "mthhwq" }]
]);
// node_modules/lucide-react/dist/esm/icons/copy.js
var Copy = createLucideIcon("Copy", [
  ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2", key: "17jyea" }],
  ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2", key: "zix9uf" }]
]);
// node_modules/lucide-react/dist/esm/icons/external-link.js
var ExternalLink = createLucideIcon("ExternalLink", [
  ["path", { d: "M15 3h6v6", key: "1q9fwt" }],
  ["path", { d: "M10 14 21 3", key: "gplh6r" }],
  ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6", key: "a6xqqp" }]
]);
// node_modules/lucide-react/dist/esm/icons/file-code.js
var FileCode = createLucideIcon("FileCode", [
  ["path", { d: "M10 12.5 8 15l2 2.5", key: "1tg20x" }],
  ["path", { d: "m14 12.5 2 2.5-2 2.5", key: "yinavb" }],
  ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "tnqrlb" }],
  ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z", key: "1mlx9k" }]
]);
// node_modules/lucide-react/dist/esm/icons/folder-open.js
var FolderOpen = createLucideIcon("FolderOpen", [
  [
    "path",
    {
      d: "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
      key: "usdka0"
    }
  ]
]);
// node_modules/lucide-react/dist/esm/icons/folder.js
var Folder = createLucideIcon("Folder", [
  [
    "path",
    {
      d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
      key: "1kt360"
    }
  ]
]);
// node_modules/lucide-react/dist/esm/icons/panel-right-close.js
var PanelRightClose = createLucideIcon("PanelRightClose", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M15 3v18", key: "14nvp0" }],
  ["path", { d: "m8 9 3 3-3 3", key: "12hl5m" }]
]);
// node_modules/lucide-react/dist/esm/icons/panel-right.js
var PanelRight = createLucideIcon("PanelRight", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M15 3v18", key: "14nvp0" }]
]);
// node_modules/lucide-react/dist/esm/icons/puzzle.js
var Puzzle = createLucideIcon("Puzzle", [
  [
    "path",
    {
      d: "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z",
      key: "w46dr5"
    }
  ]
]);
// node_modules/lucide-react/dist/esm/icons/refresh-cw.js
var RefreshCw = createLucideIcon("RefreshCw", [
  ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", key: "v9h5vc" }],
  ["path", { d: "M21 3v5h-5", key: "1q7to0" }],
  ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", key: "3uifl3" }],
  ["path", { d: "M8 16H3v5", key: "1cv678" }]
]);
// node_modules/lucide-react/dist/esm/icons/search.js
var Search = createLucideIcon("Search", [
  ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }],
  ["path", { d: "m21 21-4.3-4.3", key: "1qie3q" }]
]);
// node_modules/lucide-react/dist/esm/icons/timer.js
var Timer = createLucideIcon("Timer", [
  ["line", { x1: "10", x2: "14", y1: "2", y2: "2", key: "14vaq8" }],
  ["line", { x1: "12", x2: "15", y1: "14", y2: "11", key: "17fdiu" }],
  ["circle", { cx: "12", cy: "14", r: "8", key: "1e1u0o" }]
]);
// node_modules/lucide-react/dist/esm/icons/trending-up.js
var TrendingUp = createLucideIcon("TrendingUp", [
  ["polyline", { points: "22 7 13.5 15.5 8.5 10.5 2 17", key: "126l90" }],
  ["polyline", { points: "16 7 22 7 22 13", key: "kwv8wd" }]
]);
// node_modules/lucide-react/dist/esm/icons/x.js
var X = createLucideIcon("X", [
  ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
  ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
]);
// apps/electron/dsh-plugins/copis-creation-web/src/client.tsx
var import_react3 = require("react");

// apps/electron/src/renderer/components/ui/copis-logo-icon.tsx
var React = __toESM(require("react"));
var jsx_runtime = require("react/jsx-runtime");
var CopisLogoIcon = React.forwardRef(({ size = 16, width, height, className, fill = "currentColor", ...props }, ref) => {
  const computedWidth = width ?? size;
  const computedHeight = height ?? size;
  return /* @__PURE__ */ jsx_runtime.jsxs("svg", {
    ref,
    viewBox: "347 347 560 560",
    width: computedWidth,
    height: computedHeight,
    fill,
    className,
    "aria-hidden": "true",
    ...props,
    children: [
      /* @__PURE__ */ jsx_runtime.jsx("path", {
        d: "M 725.5 791.5 L 738.5 790.1 L 754.5 786.2 L 773.5 779.2 L 785.5 773.2 L 800.5 764.2 L 812.5 755.3 L 825.3 743.5 L 835.2 732.5 L 843.3 721.5 L 852.2 706.5 L 859.2 691.5 L 864.2 677.5 L 871.2 644.5 L 872.3 631.5 L 872.3 608.5 L 870.2 589.5 L 867.1 574.5 L 857.2 545.5 L 850.2 531.5 L 842.0 518.5 L 823.5 496.8 L 800.5 478.9 L 788.5 472.0 L 774.5 465.8 L 758.5 460.8 L 742.5 457.8 L 715.5 456.7 L 697.5 458.8 L 681.5 462.8 L 663.5 469.8 L 648.5 478.0 L 633.5 488.7 L 616.7 504.5 L 605.8 517.5 L 597.8 529.5 L 590.7 542.5 L 583.7 558.5 L 578.9 573.5 L 574.9 592.5 L 572.8 616.5 L 572.7 695.5 L 574.5 697.0 L 589.5 687.1 L 601.3 675.5 L 609.2 665.5 L 622.1 643.5 L 637.5 609.0 L 650.5 583.4 L 660.5 568.4 L 675.5 553.5 L 684.3 547.5 L 694.3 542.5 L 702.8 539.5 L 713.5 537.4 L 732.5 537.4 L 740.2 538.5 L 750.6 541.5 L 763.4 547.5 L 774.6 555.5 L 787.5 569.5 L 795.5 583.4 L 800.5 597.4 L 802.6 607.5 L 802.6 634.5 L 800.5 644.6 L 795.5 658.5 L 789.5 669.5 L 782.5 678.7 L 771.5 689.5 L 759.6 697.5 L 746.8 703.5 L 732.8 707.5 L 724.5 708.6 L 703.5 708.6 L 694.5 731.5 L 686.5 746.5 L 675.5 762.6 L 658.1 783.5 L 671.5 788.1 L 687.5 791.2 L 703.5 792.4 L 725.5 791.5 Z"
      }),
      /* @__PURE__ */ jsx_runtime.jsx("path", {
        d: "M 563.5 803.5 L 579.5 801.3 L 597.5 796.2 L 613.5 789.3 L 629.5 780.2 L 640.5 772.2 L 656.2 757.5 L 665.3 746.5 L 675.1 731.5 L 682.3 717.5 L 688.1 702.5 L 695.1 672.5 L 696.3 657.5 L 696.4 573.5 L 695.5 571.7 L 694.5 572.0 L 682.5 582.0 L 665.9 600.5 L 652.8 621.5 L 634.5 660.8 L 625.5 676.5 L 611.9 692.5 L 598.5 703.5 L 587.6 709.5 L 573.7 714.5 L 563.6 716.5 L 549.5 717.0 L 538.2 716.5 L 522.1 712.5 L 509.0 706.5 L 498.5 699.5 L 486.5 687.5 L 479.4 677.5 L 472.5 663.7 L 467.5 646.5 L 466.1 628.5 L 467.5 609.7 L 471.5 595.3 L 478.5 580.5 L 491.6 563.5 L 503.5 553.5 L 517.4 545.5 L 527.3 541.5 L 543.6 537.5 L 555.5 536.4 L 573.5 537.3 L 585.5 516.7 L 599.5 498.5 L 615.5 482.5 L 632.2 469.5 L 631.5 467.8 L 620.5 462.9 L 597.5 455.8 L 572.5 452.0 L 550.5 451.8 L 530.5 453.9 L 515.5 456.9 L 496.5 462.7 L 481.5 468.9 L 466.5 476.8 L 451.5 486.7 L 427.9 507.5 L 415.9 521.5 L 405.7 536.5 L 395.7 555.5 L 389.8 570.5 L 384.9 587.5 L 381.8 604.5 L 380.7 615.5 L 380.7 640.5 L 382.9 658.5 L 386.7 675.5 L 391.7 691.5 L 398.8 708.5 L 406.8 723.5 L 416.8 738.5 L 424.8 748.5 L 441.5 765.3 L 464.5 782.1 L 479.5 790.0 L 497.5 797.0 L 512.5 801.2 L 532.5 804.2 L 563.5 803.5 Z"
      })
    ]
  });
});
CopisLogoIcon.displayName = "CopisLogoIcon";

// apps/electron/dsh-plugins/copis-creation-web/src/client.tsx
var jsx_runtime2 = require("react/jsx-runtime");
var CREATION_STYLES_ID = "copis-creation-web-styles";
var SIDEBAR_MENU_ITEMS = [
  { id: "search", label: "搜索", icon: Search, action: "search" },
  { id: "schedule", label: "日程表", icon: CalendarClock, view: "planning", tab: "schedule" },
  { id: "automations", label: "定时任务", icon: Timer, view: "automations" },
  { id: "memory", label: "记忆", icon: Brain, view: "memory" },
  { id: "knowledge", label: "知识库", icon: BookOpen, view: "knowledge" },
  { id: "expert-team", label: "专家团队", icon: UsersRound, view: "expert-team" },
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
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15)) !important;
    color: var(--creation-ui-primary, #6c00cc) !important;
    font-weight: 600 !important;
  }

  .copis-menu-item svg {
    flex: none;
    width: 15px;
    height: 15px;
    color: var(--dsw-alias-label-secondary, #71717a);
  }

  .copis-menu-item[data-active="true"] svg {
    color: var(--creation-ui-primary, #6c00cc) !important;
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
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15)) !important;
    color: var(--creation-ui-primary, #6c00cc) !important;
  }

  .copis-rail-menu-item svg {
    width: 16px;
    height: 16px;
  }

  button[class*="_newSession"],
  button[class*="newSession"] {
    border-radius: 7px !important;
    font-size: 14px !important;
  }

  [class*="sessionRow"],
  [class*="SessionRow"] {
    border-radius: 7px !important;
    font-size: 14px !important;
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

  body.copis-subview-active .hHd-Xa_root,
  body.copis-subview-active [class*="_root"],
  body.copis-subview-active [class*="SidebarRoot"],
  body.copis-subview-active aside {
    width: 100% !important;
    padding: 6px var(--dsh-sidebar-inline-padding, 12px) !important;
  }

  /* 当子视图激活时，原「新会话」按钮无缝切换为「返回会话」按钮 */
  body.copis-subview-active button[class*="_newSession"],
  body.copis-subview-active button[class*="newSession"] {
    display: flex !important;
    align-items: center !important;
    width: 100% !important;
    height: 36px !important;
    margin: 0 0 12px !important;
    padding: 0 12px !important;
    gap: 8px !important;
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.12)) !important;
    color: var(--creation-ui-primary, #6c00cc) !important;
    border: 1px solid var(--creation-ui-primary-background, rgba(108, 0, 204, 0.25)) !important;
    border-radius: 7px !important;
    align-self: stretch !important;
    cursor: pointer !important;
    transition: background-color 150ms ease, border-color 150ms ease !important;
    box-sizing: border-box !important;
  }

  body.copis-subview-active button[class*="_newSession"]:hover,
  body.copis-subview-active button[class*="newSession"]:hover {
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.2)) !important;
    border-color: var(--creation-ui-primary, #6c00cc) !important;
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

  /* 当子视图激活时，彻底隐藏浮动工具栏（工作区、Agent模式），避免挤占/遮挡侧栏顶部 */
  body.copis-subview-active .copis-hero-utilities-overlay {
    display: none !important;
  }

  body.copis-subview-active [class*="_regionArea"],
  body.copis-subview-active [class*="regionArea"] {
    display: flex !important;
    flex-direction: column !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    padding-left: 0 !important;
  }

  body.copis-subview-active .copis-menu-section {
    display: grid !important;
  }

  body.copis-subview-active [class*="_footArea"],
  body.copis-subview-active [class*="footArea"] {
    align-items: stretch !important;
  }

  /* 中部对话区右上角工具栏 */
  .copis-header-utilities-bar {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .copis-hero-utilities-overlay {
    position: fixed;
    top: 14px;
    right: 18px;
    z-index: 80;
    display: flex;
    align-items: center;
    gap: 6px;
    pointer-events: auto;
  }

  .copis-header-action-btn {
    appearance: none;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px;
    border-radius: 7px;
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.12));
    background: var(--dsw-alias-button-elevated-fill, rgba(120, 120, 128, 0.06));
    color: var(--dsw-alias-label-primary, inherit);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 120ms ease;
    user-select: none;
  }

  .copis-header-action-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.15));
    border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.2));
  }

  .copis-header-action-btn:active {
    transform: scale(0.97);
  }

  .copis-header-btn-agent {
    border: 1px solid color-mix(in srgb, var(--ui-primary, #f09a43) 30%, transparent) !important;
    background: var(--ui-primary-background, rgba(240, 161, 90, 0.15)) !important;
    color: var(--ui-primary, #f09a43) !important;
    border-radius: 7px !important;
    font-size: 13px !important;
    font-weight: 500 !important;
  }

  .copis-header-btn-agent:hover {
    background: color-mix(in srgb, var(--ui-primary, #f09a43) 22%, var(--ui-primary-background, rgba(240, 161, 90, 0.15))) !important;
    border-color: color-mix(in srgb, var(--ui-primary, #f09a43) 50%, transparent) !important;
  }

  .copis-header-btn-workspace {
    width: 30px !important;
    height: 30px !important;
    padding: 0 !important;
    border-radius: 7px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
  }

  .copis-header-btn-workspace[data-active="true"] {
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15)) !important;
    border-color: var(--creation-ui-primary, #6c00cc) !important;
    color: var(--creation-ui-primary, #6c00cc) !important;
  }

  /* 右侧工作区文件抽屉样式 */
  .copis-details-drawer-root {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 380px;
    max-width: calc(100vw - 60px);
    z-index: 100;
    background: var(--dsw-alias-bg-base, #ffffff);
    border-left: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.1));
    box-shadow: -6px 0 24px rgba(0, 0, 0, 0.18);
    display: flex;
    flex-direction: column;
    animation: copis-drawer-slide-in 160ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes copis-drawer-slide-in {
    from {
      transform: translateX(100%);
    }
    to {
      transform: translateX(0);
    }
  }

  .copis-details-drawer-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 99;
    background: rgba(0, 0, 0, 0.15);
    backdrop-filter: blur(1px);
    animation: copis-drawer-fade-in 160ms ease;
  }

  @keyframes copis-drawer-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
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
    background: var(--creation-ui-primary, #6c00cc);
    color: #ffffff;
    border: none;
    cursor: pointer;
    transition: opacity 120ms ease;
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
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.08));
  }

  .copis-search-badge-creation {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.12));
    color: var(--creation-ui-primary, #6c00cc);
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

  /* 右侧文件操作区面板样式 */
  .copis-details-panel-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--dsw-alias-bg-base, inherit);
    color: var(--dsw-alias-label-primary, inherit);
    font-family: var(--dsw-font-family, system-ui, sans-serif);
  }

  .copis-details-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px 8px;
    border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
    gap: 8px;
  }

  .copis-details-tabs-group {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--dsw-alias-input-bg, rgba(120, 120, 128, 0.08));
    padding: 2px;
    border-radius: 8px;
  }

  .copis-details-tab-button {
    appearance: none;
    border: none;
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    background: transparent;
    color: var(--dsw-alias-label-secondary, #71717a);
    transition: all 120ms ease;
  }

  .copis-details-tab-button[data-active="true"] {
    background: var(--dsw-alias-bg-base, #ffffff);
    color: var(--dsw-alias-label-primary, #18181b);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .copis-details-close-btn {
    appearance: none;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--dsw-alias-label-secondary, #71717a);
    border-radius: 6px;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .copis-details-close-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.12));
    color: var(--dsw-alias-label-primary, #18181b);
  }

  .copis-details-content-body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 10px 12px;
    overflow: hidden;
  }

  .copis-workspace-search-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 8px;
    background: var(--dsw-alias-input-bg, rgba(120, 120, 128, 0.08));
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
    margin-bottom: 8px;
  }

  .copis-workspace-search-input {
    border: none;
    background: transparent;
    outline: none;
    font-size: 12px;
    width: 100%;
    color: var(--dsw-alias-label-primary, inherit);
  }

  .copis-workspace-refresh-btn {
    appearance: none;
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    color: var(--dsw-alias-label-tertiary, #a1a1aa);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 120ms ease;
  }

  .copis-workspace-refresh-btn:hover {
    color: var(--dsw-alias-label-primary, inherit);
  }

  .copis-tree-container {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .copis-tree-node-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 6px;
    border-radius: 5px;
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    transition: background-color 100ms ease;
  }

  .copis-tree-node-row:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.08));
  }

  .copis-tree-node-row[data-selected="true"] {
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.12));
    color: var(--creation-ui-primary, #6c00cc);
  }

  .copis-preview-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    gap: 8px;
    overflow: hidden;
  }

  .copis-preview-nav-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 8px;
    border-radius: 6px;
    background: var(--dsw-alias-input-bg, rgba(120, 120, 128, 0.08));
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.06));
    font-size: 12px;
    flex-shrink: 0;
  }

  .copis-preview-btn {
    appearance: none;
    border: none;
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--dsw-alias-label-secondary, #71717a);
    transition: background-color 120ms ease, color 120ms ease;
  }

  .copis-preview-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.15));
    color: var(--dsw-alias-label-primary, #18181b);
  }

  .copis-code-view-wrapper {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border-radius: 6px;
    background: var(--dsw-alias-input-bg, rgba(120, 120, 128, 0.04));
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.06));
    padding: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 12px;
    line-height: 18px;
    white-space: pre;
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
  if (text.includes("设置") || text.includes("setting")) {
    if (btn.closest('[class*="footArea"], [class*="FootArea"], [class*="SidebarRoot"], [class*="_root"], aside')) {
      return true;
    }
  }
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
function handleSwitchToAgent() {
  if (window.copisBridge?.switchMode) {
    window.copisBridge.switchMode("agent");
  }
  window.postMessage({ type: "COPIS_SWITCH_MODE", mode: "agent" }, "*");
}
function getFileIconColor(name) {
  const ext = (name || "").split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "#3178c6";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "#f59e0b";
    case "vue":
      return "#42b883";
    case "html":
    case "htm":
      return "#e44d26";
    case "css":
    case "scss":
    case "less":
      return "#06b6d4";
    case "json":
      return "#eab308";
    case "md":
    case "markdown":
      return "#3b82f6";
    case "py":
      return "#38bdf8";
    case "rs":
      return "#f97316";
    case "sh":
    case "bash":
    case "zsh":
      return "#22c55e";
    case "yaml":
    case "yml":
      return "#a855f7";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
    case "ico":
      return "#ec4899";
    default:
      return "var(--dsw-alias-label-tertiary, #a1a1aa)";
  }
}
function formatSize(bytes) {
  if (bytes === undefined || bytes === null)
    return "";
  if (bytes < 1024)
    return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const target = sidebar.querySelector('[class*="_regionArea"], [class*="regionArea"]') ?? sidebar.querySelector('button[class*="_newSession"], button[class*="newSession"]');
  if (target && element.parentElement !== sidebar) {
    sidebar.insertBefore(element, target);
  }
}
var cachedCordisContext = null;
function CreationSidebarNavigation(props) {
  const [activeView, setActiveView] = import_react3.useState("conversations");
  const [hiddenMenuIds, setHiddenMenuIds] = import_react3.useState(getInitialHiddenMenuIds);
  const rootRef = import_react3.useRef(null);
  const isSubviewActive = activeView !== "conversations";
  const effectiveCtx = props.ctx ?? cachedCordisContext;
  const wide = isSubviewActive || Boolean(props.wide) || !props.collapsed && (props.width === undefined || props.width >= 200);
  import_react3.useLayoutEffect(() => {
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
  import_react3.useEffect(() => {
    if (!isSubviewActive)
      return;
    let calling = false;
    const expandIfCollapsed = () => {
      if (calling)
        return;
      const frame2 = document.querySelector("[data-sidebar-collapsed]");
      const sidebar = rootRef.current?.closest('[class*="_root"], [class*="SidebarRoot"], [class*="_sidebarCol"], [class*="sidebarCol"], aside');
      const isCollapsed = Boolean(frame2 || props.collapsed === true || props.wide === false || sidebar?.classList.contains("hHd-Xa_collapsed") || sidebar?.matches('[class*="_collapsed"], [class*="collapsed"]'));
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
  import_react3.useEffect(() => {
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
  import_react3.useEffect(() => {
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
  import_react3.useEffect(() => {
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
  import_react3.useEffect(() => {
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
  import_react3.useEffect(() => {
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
  import_react3.useEffect(() => {
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
  if (!wide) {
    return /* @__PURE__ */ jsx_runtime2.jsx("div", {
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
    });
  }
  return /* @__PURE__ */ jsx_runtime2.jsx("div", {
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
  });
}
function CopisHeaderUtilities(props) {
  const [detailsOpen, setDetailsOpen] = import_react3.useState(false);
  import_react3.useEffect(() => {
    const checkDetailsState = () => {
      if (typeof document === "undefined")
        return;
      const isDrawerOpen = Boolean(document.querySelector(".copis-details-drawer-root"));
      const detailsCol = document.querySelector('[class*="detailsCol"], [class*="_detailsCol"]');
      const isCollapsed = Boolean(document.querySelector("[data-details-collapsed]"));
      if (isDrawerOpen) {
        setDetailsOpen(true);
      } else if (detailsCol) {
        setDetailsOpen(!isCollapsed);
      } else {
        setDetailsOpen(false);
      }
    };
    checkDetailsState();
    const observer = new MutationObserver(checkDetailsState);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["data-details-collapsed"]
    });
    const handleToggleEvent = () => {
      requestAnimationFrame(checkDetailsState);
    };
    window.addEventListener("COPIS_TOGGLE_WORKSPACE_DRAWER", handleToggleEvent);
    return () => {
      observer.disconnect();
      window.removeEventListener("COPIS_TOGGLE_WORKSPACE_DRAWER", handleToggleEvent);
    };
  }, []);
  const handleToggleWorkspaceDetails = () => {
    if (typeof document === "undefined")
      return;
    const detailsCol = document.querySelector('[class*="detailsCol"], [class*="_detailsCol"]');
    const isDrawerOpen = Boolean(document.querySelector(".copis-details-drawer-root"));
    const isCollapsed = Boolean(document.querySelector("[data-details-collapsed]"));
    if (detailsCol) {
      if (isCollapsed) {
        props.ctx.layout?.openDetails();
        setDetailsOpen(true);
      } else {
        props.ctx.layout?.closeDetails();
        setDetailsOpen(false);
      }
    } else {
      window.dispatchEvent(new CustomEvent("COPIS_TOGGLE_WORKSPACE_DRAWER"));
      setDetailsOpen(!isDrawerOpen);
    }
  };
  return /* @__PURE__ */ jsx_runtime2.jsxs("div", {
    className: "copis-header-utilities-bar",
    children: [
      /* @__PURE__ */ jsx_runtime2.jsxs("button", {
        type: "button",
        className: "copis-header-action-btn copis-header-btn-agent",
        onClick: handleSwitchToAgent,
        title: "切换回 Agent 模式",
        "aria-label": "返回 Agent 模式",
        children: [
          /* @__PURE__ */ jsx_runtime2.jsx(CopisLogoIcon, {
            size: 14,
            style: { color: "var(--ui-primary, #f09a43)", flexShrink: 0 }
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("span", {
            children: "Agent 模式"
          })
        ]
      }),
      /* @__PURE__ */ jsx_runtime2.jsx("button", {
        type: "button",
        className: "copis-header-action-btn copis-header-btn-workspace",
        "data-active": detailsOpen ? "true" : "false",
        onClick: handleToggleWorkspaceDetails,
        title: detailsOpen ? "折叠工作区文件面板" : "展开工作区文件面板",
        "aria-label": detailsOpen ? "折叠工作区文件面板" : "展开工作区文件面板",
        children: detailsOpen ? /* @__PURE__ */ jsx_runtime2.jsx(PanelRightClose, {
          size: 15,
          strokeWidth: 1.8
        }) : /* @__PURE__ */ jsx_runtime2.jsx(PanelRight, {
          size: 15,
          strokeWidth: 1.8
        })
      })
    ]
  });
}
function CopisDetailsPanel(props) {
  const [activeTab, setActiveTab] = import_react3.useState("files");
  const [filterText, setFilterText] = import_react3.useState("");
  const [rootEntries, setRootEntries] = import_react3.useState([]);
  const [expandedDirs, setExpandedDirs] = import_react3.useState(() => new Set);
  const [childrenMap, setChildrenMap] = import_react3.useState(() => new Map);
  const [loadingMap, setLoadingMap] = import_react3.useState(() => new Map);
  const [isRootLoading, setIsRootLoading] = import_react3.useState(false);
  const [refreshCount, setRefreshCount] = import_react3.useState(0);
  const [previewingFile, setPreviewingFile] = import_react3.useState(null);
  const [previewState, setPreviewState] = import_react3.useState({
    loading: false,
    content: "",
    error: null,
    isImage: false,
    imageUrl: ""
  });
  const [copied, setCopied] = import_react3.useState(false);
  const sessionCwd = import_react3.useMemo(() => {
    const listSnapshot = props.ctx.sessions?.list?.getSnapshot();
    const targetSessionId = props.sessionId || listSnapshot?.current;
    if (targetSessionId && listSnapshot?.byId[targetSessionId]) {
      return listSnapshot.byId[targetSessionId].cwd;
    }
    return;
  }, [props.sessionId, props.ctx.sessions]);
  import_react3.useEffect(() => {
    if (!sessionCwd)
      return;
    let cancelled = false;
    setIsRootLoading(true);
    if (window.copisBridge?.listDirectory) {
      window.copisBridge.listDirectory(undefined, sessionCwd).then((entries) => {
        if (!cancelled) {
          setRootEntries(Array.isArray(entries) ? entries : []);
          setIsRootLoading(false);
        }
      }).catch(() => {
        if (!cancelled) {
          setRootEntries([]);
          setIsRootLoading(false);
        }
      });
    } else {
      setIsRootLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [sessionCwd, refreshCount]);
  const toggleFolder = (folderPath) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
        if (!childrenMap.has(folderPath)) {
          setLoadingMap((lm) => new Map(lm).set(folderPath, true));
          if (window.copisBridge?.listDirectory) {
            window.copisBridge.listDirectory(folderPath, sessionCwd).then((kids) => {
              setChildrenMap((cm) => new Map(cm).set(folderPath, Array.isArray(kids) ? kids : []));
              setLoadingMap((lm) => {
                const n = new Map(lm);
                n.delete(folderPath);
                return n;
              });
            }).catch(() => {
              setChildrenMap((cm) => new Map(cm).set(folderPath, []));
              setLoadingMap((lm) => {
                const n = new Map(lm);
                n.delete(folderPath);
                return n;
              });
            });
          } else {
            setLoadingMap((lm) => {
              const n = new Map(lm);
              n.delete(folderPath);
              return n;
            });
          }
        }
      }
      return next;
    });
  };
  const handleRefresh = () => {
    setChildrenMap(new Map);
    setExpandedDirs(new Set);
    setRefreshCount((c) => c + 1);
  };
  const openPreview = (file) => {
    setPreviewingFile(file);
    setActiveTab("preview");
    setPreviewState({ loading: true, content: "", error: null, isImage: false, imageUrl: "" });
    if (window.copisBridge?.readFile) {
      window.copisBridge.readFile(file.path, sessionCwd).then((res) => {
        if (!res) {
          setPreviewState({ loading: false, content: "", error: "无法读取文件", isImage: false, imageUrl: "" });
        } else if (!res.success) {
          setPreviewState({ loading: false, content: "", error: res.error || "读取失败", isImage: false, imageUrl: "" });
        } else if (res.isImage) {
          setPreviewState({ loading: false, content: "", error: null, isImage: true, imageUrl: res.content || "" });
        } else {
          setPreviewState({ loading: false, content: res.content || "", error: null, isImage: false, imageUrl: "" });
        }
      }).catch((err) => {
        setPreviewState({ loading: false, content: "", error: String(err?.message || err), isImage: false, imageUrl: "" });
      });
    } else {
      setPreviewState({ loading: false, content: "", error: "未连接到 Copis 文件服务", isImage: false, imageUrl: "" });
    }
  };
  const handleLocateFile = (filePath) => {
    if (window.copisBridge?.showItemInFolder) {
      window.copisBridge.showItemInFolder(filePath, sessionCwd);
    }
  };
  const handleCopyContent = () => {
    if (!previewState.content)
      return;
    navigator.clipboard.writeText(previewState.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  const handleClose = () => {
    if (props.closeDetails) {
      props.closeDetails();
    } else {
      props.ctx.layout?.closeDetails();
    }
  };
  const allLoadedFiles = import_react3.useMemo(() => {
    const list = [];
    const scan = (items) => {
      for (const item of items) {
        if (item.isDirectory) {
          const kids = childrenMap.get(item.path);
          if (kids)
            scan(kids);
        } else {
          list.push(item);
        }
      }
    };
    scan(rootEntries);
    return list;
  }, [rootEntries, childrenMap]);
  const filteredFiles = import_react3.useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q)
      return [];
    return allLoadedFiles.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
  }, [filterText, allLoadedFiles]);
  const renderTreeNodes = (items, depth = 0) => {
    return items.map((item) => {
      const isDir = item.isDirectory;
      const isExpanded = isDir && expandedDirs.has(item.path);
      const isLoadingChild = isDir && loadingMap.get(item.path);
      const children = isDir ? childrenMap.get(item.path) || [] : [];
      const isSelected = previewingFile?.path === item.path && activeTab === "preview";
      return /* @__PURE__ */ jsx_runtime2.jsxs("div", {
        style: { display: "flex", flexDirection: "column" },
        children: [
          /* @__PURE__ */ jsx_runtime2.jsxs("div", {
            className: "copis-tree-node-row",
            "data-selected": isSelected ? "true" : "false",
            style: { paddingLeft: `${depth * 14 + 6}px` },
            onClick: () => {
              if (isDir) {
                toggleFolder(item.path);
              } else {
                openPreview(item);
              }
            },
            title: item.path,
            children: [
              isDir ? /* @__PURE__ */ jsx_runtime2.jsx("span", {
                style: { display: "inline-flex", alignItems: "center", width: "12px" },
                children: isExpanded ? /* @__PURE__ */ jsx_runtime2.jsx(ChevronDown, {
                  size: 12
                }) : /* @__PURE__ */ jsx_runtime2.jsx(ChevronRight, {
                  size: 12
                })
              }) : /* @__PURE__ */ jsx_runtime2.jsx("span", {
                style: { width: "12px", flexShrink: 0 }
              }),
              isDir ? isExpanded ? /* @__PURE__ */ jsx_runtime2.jsx(FolderOpen, {
                size: 14,
                style: { color: "var(--creation-ui-primary, #6c00cc)" }
              }) : /* @__PURE__ */ jsx_runtime2.jsx(Folder, {
                size: 14,
                style: { color: "var(--creation-ui-primary, #6c00cc)" }
              }) : /* @__PURE__ */ jsx_runtime2.jsx(FileCode, {
                size: 14,
                style: { color: getFileIconColor(item.name) }
              }),
              /* @__PURE__ */ jsx_runtime2.jsx("span", {
                style: {
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontWeight: isDir ? 500 : 400
                },
                children: item.name
              }),
              !isDir && item.size !== undefined && /* @__PURE__ */ jsx_runtime2.jsx("span", {
                style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", flexShrink: 0 },
                children: formatSize(item.size)
              })
            ]
          }),
          isDir && isExpanded && /* @__PURE__ */ jsx_runtime2.jsx("div", {
            children: isLoadingChild ? /* @__PURE__ */ jsx_runtime2.jsx("div", {
              style: { padding: "4px 0 4px 28px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
              children: "加载中..."
            }) : children.length > 0 ? renderTreeNodes(children, depth + 1) : /* @__PURE__ */ jsx_runtime2.jsx("div", {
              style: { padding: "4px 0 4px 28px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
              children: "(空目录)"
            })
          })
        ]
      }, item.path);
    });
  };
  return /* @__PURE__ */ jsx_runtime2.jsxs("div", {
    className: "copis-details-panel-root",
    children: [
      /* @__PURE__ */ jsx_runtime2.jsxs("div", {
        className: "copis-details-header-row",
        children: [
          /* @__PURE__ */ jsx_runtime2.jsxs("div", {
            className: "copis-details-tabs-group",
            children: [
              /* @__PURE__ */ jsx_runtime2.jsx("button", {
                type: "button",
                className: "copis-details-tab-button",
                "data-active": activeTab === "files" || activeTab === "preview" ? "true" : "false",
                onClick: () => setActiveTab("files"),
                children: "工作区"
              }),
              /* @__PURE__ */ jsx_runtime2.jsx("button", {
                type: "button",
                className: "copis-details-tab-button",
                "data-active": activeTab === "tool" ? "true" : "false",
                onClick: () => setActiveTab("tool"),
                children: "工具"
              })
            ]
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("button", {
            type: "button",
            className: "copis-details-close-btn",
            onClick: handleClose,
            "aria-label": "关闭详情面板",
            title: "关闭",
            children: /* @__PURE__ */ jsx_runtime2.jsx(X, {
              size: 14
            })
          })
        ]
      }),
      /* @__PURE__ */ jsx_runtime2.jsx("div", {
        className: "copis-details-content-body",
        children: activeTab === "tool" ? /* @__PURE__ */ jsx_runtime2.jsx("div", {
          style: { flex: 1, minHeight: 0, overflowY: "auto" },
          children: props.renderSlot ? props.renderSlot("conversation.details.tool", {}) : /* @__PURE__ */ jsx_runtime2.jsx("div", {
            style: { textAlign: "center", padding: "40px 10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", fontSize: "12px" },
            children: "当前无活跃的工具调用信息"
          })
        }) : activeTab === "preview" && previewingFile ? /* @__PURE__ */ jsx_runtime2.jsxs("div", {
          className: "copis-preview-container",
          children: [
            /* @__PURE__ */ jsx_runtime2.jsxs("div", {
              className: "copis-preview-nav-bar",
              children: [
                /* @__PURE__ */ jsx_runtime2.jsxs("button", {
                  type: "button",
                  className: "copis-preview-btn",
                  onClick: () => setActiveTab("files"),
                  children: [
                    /* @__PURE__ */ jsx_runtime2.jsx(ChevronLeft, {
                      size: 13
                    }),
                    /* @__PURE__ */ jsx_runtime2.jsx("span", {
                      children: "返回"
                    })
                  ]
                }),
                /* @__PURE__ */ jsx_runtime2.jsx("span", {
                  style: {
                    fontWeight: 600,
                    maxWidth: "180px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  },
                  title: previewingFile.path,
                  children: previewingFile.name
                }),
                /* @__PURE__ */ jsx_runtime2.jsxs("div", {
                  style: { display: "flex", alignItems: "center", gap: "4px" },
                  children: [
                    !previewState.isImage && previewState.content && /* @__PURE__ */ jsx_runtime2.jsxs("button", {
                      type: "button",
                      className: "copis-preview-btn",
                      onClick: handleCopyContent,
                      title: "复制代码内容",
                      children: [
                        copied ? /* @__PURE__ */ jsx_runtime2.jsx(Check, {
                          size: 12,
                          style: { color: "#22c55e" }
                        }) : /* @__PURE__ */ jsx_runtime2.jsx(Copy, {
                          size: 12
                        }),
                        /* @__PURE__ */ jsx_runtime2.jsx("span", {
                          children: copied ? "已复制" : "复制"
                        })
                      ]
                    }),
                    /* @__PURE__ */ jsx_runtime2.jsxs("button", {
                      type: "button",
                      className: "copis-preview-btn",
                      onClick: () => handleLocateFile(previewingFile.path),
                      title: "在系统文件管理器中显示",
                      children: [
                        /* @__PURE__ */ jsx_runtime2.jsx(ExternalLink, {
                          size: 12
                        }),
                        /* @__PURE__ */ jsx_runtime2.jsx("span", {
                          children: "定位"
                        })
                      ]
                    })
                  ]
                })
              ]
            }),
            previewState.loading ? /* @__PURE__ */ jsx_runtime2.jsx("div", {
              style: { textAlign: "center", padding: "60px 10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", fontSize: "12px" },
              children: "正在读取文件内容..."
            }) : previewState.error ? /* @__PURE__ */ jsx_runtime2.jsxs("div", {
              style: {
                padding: "20px",
                borderRadius: "8px",
                background: "rgba(239, 68, 68, 0.08)",
                border: "0.5px solid rgba(239, 68, 68, 0.2)",
                textAlign: "center",
                fontSize: "12px"
              },
              children: [
                /* @__PURE__ */ jsx_runtime2.jsx("div", {
                  style: { color: "#ef4444", fontWeight: 600, marginBottom: "6px" },
                  children: "预览失败"
                }),
                /* @__PURE__ */ jsx_runtime2.jsx("div", {
                  style: { color: "var(--dsw-alias-label-secondary, #71717a)", marginBottom: "12px" },
                  children: previewState.error
                }),
                /* @__PURE__ */ jsx_runtime2.jsx("button", {
                  type: "button",
                  className: "copis-header-action-btn",
                  onClick: () => openPreview(previewingFile),
                  children: "重试"
                })
              ]
            }) : previewState.isImage ? /* @__PURE__ */ jsx_runtime2.jsx("div", {
              style: { display: "flex", alignItems: "center", justifyContent: "center", flex: 1, overflow: "auto", padding: "10px" },
              children: /* @__PURE__ */ jsx_runtime2.jsx("img", {
                src: previewState.imageUrl,
                alt: previewingFile.name,
                style: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: "6px" }
              })
            }) : /* @__PURE__ */ jsx_runtime2.jsx("div", {
              className: "copis-code-view-wrapper",
              children: /* @__PURE__ */ jsx_runtime2.jsx("code", {
                children: previewState.content || "// 空文件"
              })
            })
          ]
        }) : /* @__PURE__ */ jsx_runtime2.jsxs("div", {
          style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
          children: [
            /* @__PURE__ */ jsx_runtime2.jsxs("div", {
              style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" },
              children: [
                /* @__PURE__ */ jsx_runtime2.jsxs("div", {
                  className: "copis-workspace-search-bar",
                  style: { flex: 1, marginBottom: 0 },
                  children: [
                    /* @__PURE__ */ jsx_runtime2.jsx(Search, {
                      size: 13,
                      style: { color: "var(--dsw-alias-label-tertiary, #a1a1aa)" }
                    }),
                    /* @__PURE__ */ jsx_runtime2.jsx("input", {
                      type: "text",
                      className: "copis-workspace-search-input",
                      placeholder: "搜索文件...",
                      value: filterText,
                      onChange: (e) => setFilterText(e.target.value)
                    }),
                    filterText && /* @__PURE__ */ jsx_runtime2.jsx("button", {
                      type: "button",
                      className: "copis-workspace-refresh-btn",
                      onClick: () => setFilterText(""),
                      title: "清空搜索",
                      children: /* @__PURE__ */ jsx_runtime2.jsx(X, {
                        size: 12
                      })
                    })
                  ]
                }),
                /* @__PURE__ */ jsx_runtime2.jsx("button", {
                  type: "button",
                  className: "copis-header-action-btn",
                  style: { height: "28px", padding: "0 8px" },
                  onClick: handleRefresh,
                  title: "刷新文件树",
                  children: /* @__PURE__ */ jsx_runtime2.jsx(RefreshCw, {
                    size: 12
                  })
                })
              ]
            }),
            sessionCwd && /* @__PURE__ */ jsx_runtime2.jsxs("div", {
              style: {
                fontSize: "11px",
                color: "var(--dsw-alias-label-tertiary, #a1a1aa)",
                marginBottom: "6px",
                padding: "2px 4px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              },
              title: sessionCwd,
              children: [
                "根目录: ",
                /* @__PURE__ */ jsx_runtime2.jsx("span", {
                  style: { color: "var(--dsw-alias-label-secondary, #71717a)" },
                  children: sessionCwd.split(/[/\\]/).pop() || sessionCwd
                })
              ]
            }),
            /* @__PURE__ */ jsx_runtime2.jsx("div", {
              className: "copis-tree-container",
              children: filterText.trim() ? filteredFiles.length > 0 ? /* @__PURE__ */ jsx_runtime2.jsxs("div", {
                children: [
                  /* @__PURE__ */ jsx_runtime2.jsxs("div", {
                    style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", padding: "4px 6px" },
                    children: [
                      "匹配结果 (",
                      filteredFiles.length,
                      ")"
                    ]
                  }),
                  filteredFiles.map((file) => /* @__PURE__ */ jsx_runtime2.jsxs("div", {
                    className: "copis-tree-node-row",
                    onClick: () => openPreview(file),
                    title: file.path,
                    children: [
                      /* @__PURE__ */ jsx_runtime2.jsx(FileCode, {
                        size: 14,
                        style: { color: getFileIconColor(file.name) }
                      }),
                      /* @__PURE__ */ jsx_runtime2.jsx("span", {
                        style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                        children: file.name
                      }),
                      file.size !== undefined && /* @__PURE__ */ jsx_runtime2.jsx("span", {
                        style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
                        children: formatSize(file.size)
                      })
                    ]
                  }, file.path))
                ]
              }) : /* @__PURE__ */ jsx_runtime2.jsx("div", {
                style: { textAlign: "center", padding: "40px 10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", fontSize: "12px" },
                children: "未找到匹配的文件"
              }) : isRootLoading ? /* @__PURE__ */ jsx_runtime2.jsx("div", {
                style: { textAlign: "center", padding: "40px 10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", fontSize: "12px" },
                children: "正在加载工作区文件..."
              }) : rootEntries.length > 0 ? renderTreeNodes(rootEntries, 0) : /* @__PURE__ */ jsx_runtime2.jsxs("div", {
                style: { textAlign: "center", padding: "40px 10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", fontSize: "12px" },
                children: [
                  /* @__PURE__ */ jsx_runtime2.jsx("p", {
                    children: "工作区为空"
                  }),
                  /* @__PURE__ */ jsx_runtime2.jsx("p", {
                    style: { fontSize: "11px", marginTop: "4px" },
                    children: sessionCwd ? "当前目录未包含可展示的文件" : "等待会话初始化..."
                  })
                ]
              })
            })
          ]
        })
      })
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
        background: "var(--creation-ui-primary-background, rgba(108, 0, 204, 0.2))",
        color: "var(--creation-ui-primary, #6c00cc)",
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
  const [query, setQuery] = import_react3.useState("");
  const [committedQuery, setCommittedQuery] = import_react3.useState("");
  const [loading, setLoading] = import_react3.useState(false);
  const [hasSearched, setHasSearched] = import_react3.useState(false);
  const [titleResults, setTitleResults] = import_react3.useState([]);
  const [contentResults, setContentResults] = import_react3.useState([]);
  const [selectedIndex, setSelectedIndex] = import_react3.useState(0);
  const inputRef = import_react3.useRef(null);
  const isComposingRef = import_react3.useRef(false);
  const searchTokenRef = import_react3.useRef(0);
  import_react3.useEffect(() => {
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
  const runSearch = import_react3.useCallback(async () => {
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
  const allResults = import_react3.useMemo(() => [...titleResults, ...contentResults], [titleResults, contentResults]);
  const navigateToResult = import_react3.useCallback((item) => {
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
  const handleKeyDown = import_react3.useCallback((e) => {
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
  const [drawerOpen, setDrawerOpen] = import_react3.useState(false);
  const [searchOpen, setSearchOpen] = import_react3.useState(false);
  const [hasSessionHeader, setHasSessionHeader] = import_react3.useState(false);
  const [isSubviewActive, setIsSubviewActive] = import_react3.useState(() => {
    if (typeof document === "undefined")
      return false;
    return document.body?.classList.contains("copis-subview-active") || document.documentElement?.classList.contains("copis-subview-active");
  });
  import_react3.useEffect(() => {
    const handleToggle = () => setDrawerOpen((prev) => !prev);
    window.addEventListener("COPIS_TOGGLE_WORKSPACE_DRAWER", handleToggle);
    return () => window.removeEventListener("COPIS_TOGGLE_WORKSPACE_DRAWER", handleToggle);
  }, []);
  import_react3.useEffect(() => {
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
  import_react3.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && drawerOpen) {
        e.preventDefault();
        setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [drawerOpen]);
  import_react3.useEffect(() => {
    const checkState = () => {
      if (typeof document === "undefined")
        return;
      const headerItem = document.querySelector(".copis-header-utilities-bar:not(.copis-hero-utilities-overlay .copis-header-utilities-bar)");
      setHasSessionHeader(Boolean(headerItem));
      setIsSubviewActive(document.body?.classList.contains("copis-subview-active") || document.documentElement?.classList.contains("copis-subview-active"));
    };
    checkState();
    const observer = new MutationObserver(checkState);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return /* @__PURE__ */ jsx_runtime2.jsxs(jsx_runtime2.Fragment, {
    children: [
      !hasSessionHeader && !isSubviewActive && /* @__PURE__ */ jsx_runtime2.jsx("div", {
        className: "copis-hero-utilities-overlay",
        children: /* @__PURE__ */ jsx_runtime2.jsx(CopisHeaderUtilities, {
          ctx: props.ctx
        })
      }),
      drawerOpen && /* @__PURE__ */ jsx_runtime2.jsxs(jsx_runtime2.Fragment, {
        children: [
          /* @__PURE__ */ jsx_runtime2.jsx("div", {
            className: "copis-details-drawer-backdrop",
            onClick: () => setDrawerOpen(false),
            "aria-label": "关闭文件面板"
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("div", {
            className: "copis-details-drawer-root",
            children: /* @__PURE__ */ jsx_runtime2.jsx(CopisDetailsPanel, {
              ctx: props.ctx,
              closeDetails: () => setDrawerOpen(false)
            })
          })
        ]
      }),
      searchOpen && /* @__PURE__ */ jsx_runtime2.jsx(CopisSearchModal, {
        open: searchOpen,
        onClose: () => setSearchOpen(false),
        ctx: props.ctx
      })
    ]
  });
}
var inject = ["slots", "layout", "sessions"];
function apply(ctx) {
  cachedCordisContext = ctx;
  console.log("[Copis Creation Web] 客户端插件正在激活...", ctx);
  installCreationStyles();
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "copis-creation-sidebar", order: -100 }, (props) => /* @__PURE__ */ jsx_runtime2.jsx(CreationSidebarNavigation, {
    ...props,
    ctx
  })));
  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities",
    id: "copis-session-header-utilities",
    order: 100
  }, (props) => /* @__PURE__ */ jsx_runtime2.jsx(CopisHeaderUtilities, {
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
