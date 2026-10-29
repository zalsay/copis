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
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
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
  CopisSearchModal: () => CopisSearchModal,
  CopisInspectorPanel: () => CopisInspectorPanel,
  CopisHeaderUtilities: () => CopisHeaderUtilities,
  CopisDetailsPanel: () => CopisDetailsPanel
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

// ../../node_modules/lucide-react/dist/esm/icons/arrow-left.js
var ArrowLeft = createLucideIcon("ArrowLeft", [
  ["path", { d: "m12 19-7-7 7-7", key: "1l729n" }],
  ["path", { d: "M19 12H5", key: "x3x0zl" }]
]);

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

// ../../node_modules/lucide-react/dist/esm/icons/check.js
var Check = createLucideIcon("Check", [["path", { d: "M20 6 9 17l-5-5", key: "1gmf2c" }]]);

// ../../node_modules/lucide-react/dist/esm/icons/chevron-down.js
var ChevronDown = createLucideIcon("ChevronDown", [
  ["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/chevron-right.js
var ChevronRight = createLucideIcon("ChevronRight", [
  ["path", { d: "m9 18 6-6-6-6", key: "mthhwq" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/circle-alert.js
var CircleAlert = createLucideIcon("CircleAlert", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["line", { x1: "12", x2: "12", y1: "8", y2: "12", key: "1pkeuh" }],
  ["line", { x1: "12", x2: "12.01", y1: "16", y2: "16", key: "4dfq90" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/circle-check.js
var CircleCheck = createLucideIcon("CircleCheck", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "m9 12 2 2 4-4", key: "dzmm74" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/clock.js
var Clock = createLucideIcon("Clock", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["polyline", { points: "12 6 12 12 16 14", key: "68esgv" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/copy.js
var Copy = createLucideIcon("Copy", [
  ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2", key: "17jyea" }],
  ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2", key: "zix9uf" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/external-link.js
var ExternalLink = createLucideIcon("ExternalLink", [
  ["path", { d: "M15 3h6v6", key: "1q9fwt" }],
  ["path", { d: "M10 14 21 3", key: "gplh6r" }],
  ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6", key: "a6xqqp" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/file-check.js
var FileCheck = createLucideIcon("FileCheck", [
  ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", key: "1rqfz7" }],
  ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "tnqrlb" }],
  ["path", { d: "m9 15 2 2 4-4", key: "1grp1n" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/file-code.js
var FileCode = createLucideIcon("FileCode", [
  ["path", { d: "M10 12.5 8 15l2 2.5", key: "1tg20x" }],
  ["path", { d: "m14 12.5 2 2.5-2 2.5", key: "yinavb" }],
  ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "tnqrlb" }],
  ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z", key: "1mlx9k" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/file-text.js
var FileText = createLucideIcon("FileText", [
  ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", key: "1rqfz7" }],
  ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "tnqrlb" }],
  ["path", { d: "M10 9H8", key: "b1mrlr" }],
  ["path", { d: "M16 13H8", key: "t4e002" }],
  ["path", { d: "M16 17H8", key: "z1uh3a" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/folder-code.js
var FolderCode = createLucideIcon("FolderCode", [
  ["path", { d: "M10 10.5 8 13l2 2.5", key: "m4t9c1" }],
  ["path", { d: "m14 10.5 2 2.5-2 2.5", key: "14w2eb" }],
  [
    "path",
    {
      d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z",
      key: "1u1bxd"
    }
  ]
]);

// ../../node_modules/lucide-react/dist/esm/icons/folder-open.js
var FolderOpen = createLucideIcon("FolderOpen", [
  [
    "path",
    {
      d: "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
      key: "usdka0"
    }
  ]
]);

// ../../node_modules/lucide-react/dist/esm/icons/folder.js
var Folder = createLucideIcon("Folder", [
  [
    "path",
    {
      d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
      key: "1kt360"
    }
  ]
]);

// ../../node_modules/lucide-react/dist/esm/icons/layers.js
var Layers = createLucideIcon("Layers", [
  [
    "path",
    {
      d: "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
      key: "8b97xw"
    }
  ],
  ["path", { d: "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65", key: "dd6zsq" }],
  ["path", { d: "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65", key: "ep9fru" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/loader-circle.js
var LoaderCircle = createLucideIcon("LoaderCircle", [
  ["path", { d: "M21 12a9 9 0 1 1-6.219-8.56", key: "13zald" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/message-square.js
var MessageSquare = createLucideIcon("MessageSquare", [
  ["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", key: "1lielz" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/panel-left-close.js
var PanelLeftClose = createLucideIcon("PanelLeftClose", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M9 3v18", key: "fh3hqa" }],
  ["path", { d: "m16 15-3-3 3-3", key: "14y99z" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/panel-left-open.js
var PanelLeftOpen = createLucideIcon("PanelLeftOpen", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M9 3v18", key: "fh3hqa" }],
  ["path", { d: "m14 9 3 3-3 3", key: "8010ee" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/panel-right-close.js
var PanelRightClose = createLucideIcon("PanelRightClose", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M15 3v18", key: "14nvp0" }],
  ["path", { d: "m8 9 3 3-3 3", key: "12hl5m" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/panel-right.js
var PanelRight = createLucideIcon("PanelRight", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M15 3v18", key: "14nvp0" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/plus.js
var Plus = createLucideIcon("Plus", [
  ["path", { d: "M5 12h14", key: "1ays0h" }],
  ["path", { d: "M12 5v14", key: "s699le" }]
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

// ../../node_modules/lucide-react/dist/esm/icons/refresh-cw.js
var RefreshCw = createLucideIcon("RefreshCw", [
  ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", key: "v9h5vc" }],
  ["path", { d: "M21 3v5h-5", key: "1q7to0" }],
  ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", key: "3uifl3" }],
  ["path", { d: "M8 16H3v5", key: "1cv678" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/rotate-ccw.js
var RotateCcw = createLucideIcon("RotateCcw", [
  ["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", key: "1357e3" }],
  ["path", { d: "M3 3v5h5", key: "1xhq8a" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/search.js
var Search = createLucideIcon("Search", [
  ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }],
  ["path", { d: "m21 21-4.3-4.3", key: "1qie3q" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/send.js
var Send = createLucideIcon("Send", [
  [
    "path",
    {
      d: "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
      key: "1ffxy3"
    }
  ],
  ["path", { d: "m21.854 2.147-10.94 10.939", key: "12cjpa" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/shield-alert.js
var ShieldAlert = createLucideIcon("ShieldAlert", [
  [
    "path",
    {
      d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
      key: "oel41y"
    }
  ],
  ["path", { d: "M12 8v4", key: "1got3b" }],
  ["path", { d: "M12 16h.01", key: "1drbdi" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/sparkles.js
var Sparkles = createLucideIcon("Sparkles", [
  [
    "path",
    {
      d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
      key: "4pj2yx"
    }
  ],
  ["path", { d: "M20 3v4", key: "1olli1" }],
  ["path", { d: "M22 5h-4", key: "1gvqau" }],
  ["path", { d: "M4 17v2", key: "vumght" }],
  ["path", { d: "M5 18H3", key: "zchphs" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/timer.js
var Timer = createLucideIcon("Timer", [
  ["line", { x1: "10", x2: "14", y1: "2", y2: "2", key: "14vaq8" }],
  ["line", { x1: "12", x2: "15", y1: "14", y2: "11", key: "17fdiu" }],
  ["circle", { cx: "12", cy: "14", r: "8", key: "1e1u0o" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/trash-2.js
var Trash2 = createLucideIcon("Trash2", [
  ["path", { d: "M3 6h18", key: "d0wm0j" }],
  ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", key: "4alrt4" }],
  ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", key: "v07s0e" }],
  ["line", { x1: "10", x2: "10", y1: "11", y2: "17", key: "1uufr5" }],
  ["line", { x1: "14", x2: "14", y1: "11", y2: "17", key: "xtxkd" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/trending-up.js
var TrendingUp = createLucideIcon("TrendingUp", [
  ["polyline", { points: "22 7 13.5 15.5 8.5 10.5 2 17", key: "126l90" }],
  ["polyline", { points: "16 7 22 7 22 13", key: "kwv8wd" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/user-check.js
var UserCheck = createLucideIcon("UserCheck", [
  ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", key: "1yyitq" }],
  ["circle", { cx: "9", cy: "7", r: "4", key: "nufk8" }],
  ["polyline", { points: "16 11 18 13 22 9", key: "1pwet4" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/user.js
var User = createLucideIcon("User", [
  ["path", { d: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", key: "975kel" }],
  ["circle", { cx: "12", cy: "7", r: "4", key: "17ys0d" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/users-round.js
var UsersRound = createLucideIcon("UsersRound", [
  ["path", { d: "M18 21a8 8 0 0 0-16 0", key: "3ypg7q" }],
  ["circle", { cx: "10", cy: "8", r: "5", key: "o932ke" }],
  ["path", { d: "M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3", key: "10s06x" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/users.js
var Users = createLucideIcon("Users", [
  ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", key: "1yyitq" }],
  ["circle", { cx: "9", cy: "7", r: "4", key: "nufk8" }],
  ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87", key: "kshegd" }],
  ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75", key: "1da9ce" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/x.js
var X = createLucideIcon("X", [
  ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
  ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
]);
// dsh-plugins/copis-creation-web/src/client.tsx
var import_react7 = require("react");

// dsh-plugins/copis-creation-web/src/inspector/CopisInspectorPanel.tsx
var import_react6 = require("react");

// dsh-plugins/copis-creation-web/src/inspector/FilesInspectorTab.tsx
var import_react3 = __toESM(require("react"));
var jsx_runtime = require("react/jsx-runtime");
function formatSize(bytes) {
  if (bytes === undefined || bytes === null)
    return "";
  if (bytes < 1024)
    return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function getFileIconColor(name) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx"].includes(ext))
    return "#3b82f6";
  if (["js", "jsx"].includes(ext))
    return "#eab308";
  if (["json"].includes(ext))
    return "#fb923c";
  if (["css", "scss", "less"].includes(ext))
    return "#38bdf8";
  if (["html", "htm"].includes(ext))
    return "#f97316";
  if (["md", "txt"].includes(ext))
    return "#94a3b8";
  if (["py"].includes(ext))
    return "#34d399";
  if (["png", "jpg", "jpeg", "svg", "webp", "gif"].includes(ext))
    return "#ec4899";
  return "#a1a1aa";
}
function FilesInspectorTab({ sessionCwd, onSelectFile }) {
  const [filterText, setFilterText] = import_react3.useState("");
  const [rootEntries, setRootEntries] = import_react3.useState([]);
  const [expandedDirs, setExpandedDirs] = import_react3.useState(() => new Set);
  const [childrenMap, setChildrenMap] = import_react3.useState(() => new Map);
  const [loadingMap, setLoadingMap] = import_react3.useState(() => new Map);
  const [isRootLoading, setIsRootLoading] = import_react3.useState(false);
  const [refreshCount, setRefreshCount] = import_react3.useState(0);
  const [treeCollapsed, setTreeCollapsed] = import_react3.useState(false);
  const [previewingFile, setPreviewingFile] = import_react3.useState(null);
  const [previewState, setPreviewState] = import_react3.useState({
    loading: false,
    content: "",
    error: null,
    isImage: false,
    imageUrl: ""
  });
  const [copied, setCopied] = import_react3.useState(false);
  import_react3.useEffect(() => {
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
    onSelectFile?.(file.path);
    setPreviewState({ loading: true, content: "", error: null, isImage: false, imageUrl: "" });
    if (window.copisBridge?.readFile) {
      window.copisBridge.readFile(file.path, sessionCwd).then((res) => {
        if (!res) {
          setPreviewState({ loading: false, content: "", error: "无法读取文件内容", isImage: false, imageUrl: "" });
        } else if (!res.success) {
          setPreviewState({ loading: false, content: "", error: res.error || "读取失败", isImage: false, imageUrl: "" });
        } else if (res.isImage) {
          setPreviewState({ loading: false, content: "", error: null, isImage: true, imageUrl: res.content || "" });
        } else {
          const rawContent = res.content || "";
          const lines = rawContent ? rawContent.split(`
`).length : 0;
          setPreviewState({
            loading: false,
            content: rawContent,
            error: null,
            isImage: false,
            imageUrl: "",
            lineCount: lines
          });
        }
      }).catch((err) => {
        setPreviewState({
          loading: false,
          content: "",
          error: String(err?.message || err),
          isImage: false,
          imageUrl: ""
        });
      });
    } else {
      setPreviewState({
        loading: false,
        content: "",
        error: "未连接到 Copis 文件服务",
        isImage: false,
        imageUrl: ""
      });
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
  const handleLocateFile = (filePath) => {
    if (window.copisBridge?.showItemInFolder) {
      window.copisBridge.showItemInFolder(filePath, sessionCwd);
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
      const isSelected = previewingFile?.path === item.path;
      return /* @__PURE__ */ jsx_runtime.jsxs("div", {
        style: { display: "flex", flexDirection: "column" },
        children: [
          /* @__PURE__ */ jsx_runtime.jsxs("div", {
            className: "copis-tree-node-row",
            "data-selected": isSelected ? "true" : "false",
            style: { paddingLeft: `${depth * 14 + 8}px` },
            onClick: () => {
              if (isDir) {
                toggleFolder(item.path);
              } else {
                openPreview(item);
              }
            },
            title: item.path,
            children: [
              isDir ? /* @__PURE__ */ jsx_runtime.jsx("span", {
                style: { display: "inline-flex", alignItems: "center", width: "12px" },
                children: isExpanded ? /* @__PURE__ */ jsx_runtime.jsx(ChevronDown, {
                  size: 12
                }) : /* @__PURE__ */ jsx_runtime.jsx(ChevronRight, {
                  size: 12
                })
              }) : /* @__PURE__ */ jsx_runtime.jsx("span", {
                style: { width: "12px", flexShrink: 0 }
              }),
              isDir ? isExpanded ? /* @__PURE__ */ jsx_runtime.jsx(FolderOpen, {
                size: 14,
                style: { color: "#a1a1aa", flexShrink: 0 }
              }) : /* @__PURE__ */ jsx_runtime.jsx(Folder, {
                size: 14,
                style: { color: "#a1a1aa", flexShrink: 0 }
              }) : /* @__PURE__ */ jsx_runtime.jsx(FileCode, {
                size: 14,
                style: { color: getFileIconColor(item.name), flexShrink: 0 }
              }),
              /* @__PURE__ */ jsx_runtime.jsx("span", {
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
              !isDir && item.size !== undefined && /* @__PURE__ */ jsx_runtime.jsx("span", {
                style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", flexShrink: 0 },
                children: formatSize(item.size)
              })
            ]
          }),
          isDir && isExpanded && /* @__PURE__ */ jsx_runtime.jsx("div", {
            children: isLoadingChild ? /* @__PURE__ */ jsx_runtime.jsx("div", {
              style: { padding: "4px 0 4px 32px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
              children: "加载中..."
            }) : children.length > 0 ? renderTreeNodes(children, depth + 1) : /* @__PURE__ */ jsx_runtime.jsx("div", {
              style: { padding: "4px 0 4px 32px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
              children: "(空目录)"
            })
          })
        ]
      }, item.path);
    });
  };
  const pathBreadcrumb = import_react3.useMemo(() => {
    if (previewingFile) {
      return previewingFile.path.replace(/^\//, "").split("/");
    }
    return ["工作区根目录"];
  }, [previewingFile]);
  return /* @__PURE__ */ jsx_runtime.jsxs("div", {
    className: "copis-inspector-files-container",
    "data-testid": "copis-inspector-files-panel",
    children: [
      /* @__PURE__ */ jsx_runtime.jsxs("div", {
        className: "copis-inspector-files-topbar",
        children: [
          /* @__PURE__ */ jsx_runtime.jsx("button", {
            type: "button",
            className: "copis-inspector-tool-icon-btn",
            onClick: () => setTreeCollapsed((prev) => !prev),
            title: treeCollapsed ? "展开目录树" : "收起目录树",
            "aria-label": treeCollapsed ? "展开目录树" : "收起目录树",
            children: treeCollapsed ? /* @__PURE__ */ jsx_runtime.jsx(PanelLeftOpen, {
              size: 14
            }) : /* @__PURE__ */ jsx_runtime.jsx(PanelLeftClose, {
              size: 14
            })
          }),
          /* @__PURE__ */ jsx_runtime.jsx("div", {
            className: "copis-inspector-files-breadcrumb",
            title: sessionCwd || "",
            children: pathBreadcrumb.map((seg, idx) => /* @__PURE__ */ jsx_runtime.jsxs(import_react3.default.Fragment, {
              children: [
                idx > 0 && /* @__PURE__ */ jsx_runtime.jsx("span", {
                  style: { opacity: 0.4 },
                  children: "/"
                }),
                /* @__PURE__ */ jsx_runtime.jsx("span", {
                  style: { fontWeight: idx === pathBreadcrumb.length - 1 ? 500 : 400 },
                  children: seg
                })
              ]
            }, `${seg}-${idx}`))
          }),
          /* @__PURE__ */ jsx_runtime.jsxs("div", {
            className: "copis-inspector-files-topbar-actions",
            children: [
              previewingFile && !previewState.isImage && previewState.content && /* @__PURE__ */ jsx_runtime.jsx("button", {
                type: "button",
                className: "copis-inspector-tool-icon-btn",
                onClick: handleCopyContent,
                title: "复制代码",
                children: copied ? /* @__PURE__ */ jsx_runtime.jsx(Check, {
                  size: 13,
                  style: { color: "#22c55e" }
                }) : /* @__PURE__ */ jsx_runtime.jsx(Copy, {
                  size: 13
                })
              }),
              previewingFile && /* @__PURE__ */ jsx_runtime.jsx("button", {
                type: "button",
                className: "copis-inspector-tool-icon-btn",
                onClick: () => handleLocateFile(previewingFile.path),
                title: "在系统文件管理器中显示",
                children: /* @__PURE__ */ jsx_runtime.jsx(ExternalLink, {
                  size: 13
                })
              }),
              /* @__PURE__ */ jsx_runtime.jsx("button", {
                type: "button",
                className: "copis-inspector-tool-icon-btn",
                onClick: handleRefresh,
                title: "刷新目录树",
                children: /* @__PURE__ */ jsx_runtime.jsx(RefreshCw, {
                  size: 13
                })
              })
            ]
          })
        ]
      }),
      /* @__PURE__ */ jsx_runtime.jsxs("div", {
        className: "copis-inspector-files-body",
        children: [
          !treeCollapsed && /* @__PURE__ */ jsx_runtime.jsxs("div", {
            className: "copis-inspector-files-tree-col",
            children: [
              /* @__PURE__ */ jsx_runtime.jsxs("div", {
                className: "copis-workspace-search-bar",
                style: { margin: "8px 8px 6px 8px" },
                children: [
                  /* @__PURE__ */ jsx_runtime.jsx(Search, {
                    size: 13,
                    className: "copis-workspace-search-icon"
                  }),
                  /* @__PURE__ */ jsx_runtime.jsx("input", {
                    type: "text",
                    placeholder: "搜索文件...",
                    value: filterText,
                    onChange: (e) => setFilterText(e.target.value),
                    className: "copis-workspace-search-input"
                  })
                ]
              }),
              /* @__PURE__ */ jsx_runtime.jsx("div", {
                style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "0 4px 12px 4px" },
                children: isRootLoading ? /* @__PURE__ */ jsx_runtime.jsx("div", {
                  style: { textAlign: "center", padding: "30px 10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", fontSize: "11px" },
                  children: "正在扫描工作区目录..."
                }) : filterText.trim() ? filteredFiles.length > 0 ? filteredFiles.map((file) => /* @__PURE__ */ jsx_runtime.jsxs("div", {
                  className: "copis-tree-node-row",
                  "data-selected": previewingFile?.path === file.path ? "true" : "false",
                  style: { paddingLeft: "12px" },
                  onClick: () => openPreview(file),
                  children: [
                    /* @__PURE__ */ jsx_runtime.jsx(FileCode, {
                      size: 14,
                      style: { color: getFileIconColor(file.name), flexShrink: 0 }
                    }),
                    /* @__PURE__ */ jsx_runtime.jsxs("div", {
                      style: { display: "flex", flexDirection: "column", minWidth: 0, flex: 1 },
                      children: [
                        /* @__PURE__ */ jsx_runtime.jsx("span", {
                          style: { fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                          children: file.name
                        }),
                        /* @__PURE__ */ jsx_runtime.jsx("span", {
                          style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                          children: file.path
                        })
                      ]
                    })
                  ]
                }, file.path)) : /* @__PURE__ */ jsx_runtime.jsx("div", {
                  style: { textAlign: "center", padding: "30px 10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", fontSize: "11px" },
                  children: "未匹配到文件"
                }) : rootEntries.length > 0 ? renderTreeNodes(rootEntries) : /* @__PURE__ */ jsx_runtime.jsxs("div", {
                  style: { textAlign: "center", padding: "30px 10px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", fontSize: "11px" },
                  children: [
                    /* @__PURE__ */ jsx_runtime.jsx("div", {
                      style: { marginBottom: "8px" },
                      children: "工作区暂无文件"
                    }),
                    /* @__PURE__ */ jsx_runtime.jsx("button", {
                      type: "button",
                      className: "copis-header-action-btn",
                      style: { fontSize: "11px", padding: "3px 10px" },
                      onClick: handleRefresh,
                      children: "重新扫描"
                    })
                  ]
                })
              })
            ]
          }),
          /* @__PURE__ */ jsx_runtime.jsx("div", {
            className: "copis-inspector-files-preview-col",
            children: !previewingFile ? /* @__PURE__ */ jsx_runtime.jsxs("div", {
              className: "copis-inspector-empty-state",
              children: [
                /* @__PURE__ */ jsx_runtime.jsx(FileText, {
                  size: 32,
                  style: { opacity: 0.25, marginBottom: "8px" }
                }),
                /* @__PURE__ */ jsx_runtime.jsx("div", {
                  style: { fontSize: "13px", fontWeight: 500, color: "var(--dsw-alias-label-secondary, #a1a1aa)" },
                  children: "未选择文件"
                }),
                /* @__PURE__ */ jsx_runtime.jsx("div", {
                  style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #71717a)", marginTop: "4px" },
                  children: "在左侧文件树中点击任意文件即可查看内容与高亮预览"
                })
              ]
            }) : previewState.loading ? /* @__PURE__ */ jsx_runtime.jsx("div", {
              className: "copis-inspector-empty-state",
              children: /* @__PURE__ */ jsx_runtime.jsx("div", {
                style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
                children: "正在加载文件内容..."
              })
            }) : previewState.error ? /* @__PURE__ */ jsx_runtime.jsxs("div", {
              className: "copis-inspector-empty-state",
              children: [
                /* @__PURE__ */ jsx_runtime.jsx("div", {
                  style: { color: "#ef4444", fontWeight: 600, fontSize: "12px", marginBottom: "6px" },
                  children: "预览失败"
                }),
                /* @__PURE__ */ jsx_runtime.jsx("div", {
                  style: { color: "var(--dsw-alias-label-secondary, #a1a1aa)", fontSize: "11px", marginBottom: "12px" },
                  children: previewState.error
                }),
                /* @__PURE__ */ jsx_runtime.jsx("button", {
                  type: "button",
                  className: "copis-header-action-btn",
                  onClick: () => openPreview(previewingFile),
                  children: "重试"
                })
              ]
            }) : previewState.isImage ? /* @__PURE__ */ jsx_runtime.jsx("div", {
              style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", overflow: "auto", padding: "16px" },
              children: /* @__PURE__ */ jsx_runtime.jsx("img", {
                src: previewState.imageUrl,
                alt: previewingFile.name,
                style: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: "6px" }
              })
            }) : /* @__PURE__ */ jsx_runtime.jsxs("div", {
              className: "copis-inspector-code-viewer",
              children: [
                /* @__PURE__ */ jsx_runtime.jsxs("div", {
                  className: "copis-inspector-code-meta",
                  children: [
                    /* @__PURE__ */ jsx_runtime.jsx("span", {
                      children: previewingFile.name
                    }),
                    previewState.lineCount !== undefined && /* @__PURE__ */ jsx_runtime.jsxs("span", {
                      children: [
                        previewState.lineCount,
                        " 行"
                      ]
                    }),
                    previewingFile.size !== undefined && /* @__PURE__ */ jsx_runtime.jsx("span", {
                      children: formatSize(previewingFile.size)
                    })
                  ]
                }),
                /* @__PURE__ */ jsx_runtime.jsx("div", {
                  className: "copis-code-view-wrapper",
                  style: { flex: 1, margin: 0, borderRadius: 0, border: "none" },
                  children: /* @__PURE__ */ jsx_runtime.jsx("code", {
                    children: previewState.content || "// 空文件"
                  })
                })
              ]
            })
          })
        ]
      })
    ]
  });
}

// dsh-plugins/copis-creation-web/src/inspector/SideChatInspectorTab.tsx
var import_react4 = require("react");
var jsx_runtime2 = require("react/jsx-runtime");
var PRESET_PROMPTS = [
  "分析当前工作区架构与文件结构",
  "检查代码是否有潜在 Bug 与性能风险",
  "帮我构思重构当前模块的设计方案"
];
function SideChatInspectorTab({
  tabId,
  sessionCwd,
  onTitleChange
}) {
  const [messages, setMessages] = import_react4.useState([
    {
      id: "welcome",
      role: "assistant",
      content: "你好！我是工作区侧边助手。你可以针对当前工作区文件、架构设计或代码重构随时向我提问。",
      createdAt: Date.now(),
      status: "done"
    }
  ]);
  const [inputValue, setInputValue] = import_react4.useState("");
  const [isSending, setIsSending] = import_react4.useState(false);
  const messagesEndRef = import_react4.useRef(null);
  const inputRef = import_react4.useRef(null);
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  import_react4.useEffect(() => {
    scrollToBottom();
  }, [messages]);
  const handleSend = async (contentToSend) => {
    const text = (contentToSend || inputValue).trim();
    if (!text || isSending)
      return;
    const userMsgId = `user-${Date.now()}`;
    const newMessages = [
      ...messages,
      {
        id: userMsgId,
        role: "user",
        content: text,
        createdAt: Date.now(),
        status: "done"
      }
    ];
    setMessages(newMessages);
    setInputValue("");
    setIsSending(true);
    const firstUserMsg = newMessages.find((m) => m.role === "user");
    if (firstUserMsg && onTitleChange) {
      const summary = text.slice(0, 10) + (text.length > 10 ? "..." : "");
      onTitleChange(tabId, summary);
    }
    const assistantMsgId = `ai-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: assistantMsgId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        status: "streaming"
      }
    ]);
    try {
      let replyContent = "";
      if (window.copisBridge?.sendAgentMessage) {
        try {
          const res = await window.copisBridge.sendAgentMessage(text, { cwd: sessionCwd });
          replyContent = res?.text || `已收到关于 "${text}" 的咨询。当前工作区：${sessionCwd || "默认"}`;
        } catch {
          replyContent = `已记录你的问题：“${text}”。针对当前工作区（${sessionCwd || "本地"}），建议先核对相关模块的导出与类型声明。`;
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (text.includes("分析") || text.includes("架构")) {
          replyContent = `【工作区分析】当前项目基于 Electron + Cordis + React 架构。已为你检索工作区关键入口与模块，模块间采用插件化解耦设计，具备良好的扩展能力。`;
        } else if (text.includes("Bug") || text.includes("风险") || text.includes("检查")) {
          replyContent = `【风险排查】未发现阻塞级语法异常。建议保持组件生命周期中的 AbortSignal 取消监听，避免异步状态在组件卸载后发生竞态更新。`;
        } else {
          replyContent = `已收到你的侧边提问：“${text}”。我会持续结合右侧文件预览与工作区上下文为你提供实时的编码与重构支持。`;
        }
      }
      setMessages((prev) => prev.map((m) => m.id === assistantMsgId ? { ...m, content: replyContent, status: "done" } : m));
    } catch {
      setMessages((prev) => prev.map((m) => m.id === assistantMsgId ? { ...m, content: "生成回复时遇到问题，请重试。", status: "error" } : m));
    } finally {
      setIsSending(false);
    }
  };
  const handleClear = () => {
    setMessages([
      {
        id: "welcome-reset",
        role: "assistant",
        content: "对话已清空。有什么可以帮你的？",
        createdAt: Date.now(),
        status: "done"
      }
    ]);
    if (onTitleChange) {
      onTitleChange(tabId, "侧边聊天");
    }
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };
  return /* @__PURE__ */ jsx_runtime2.jsxs("div", {
    className: "copis-inspector-sidechat-container",
    "data-testid": "copis-inspector-sidechat-panel",
    children: [
      /* @__PURE__ */ jsx_runtime2.jsxs("div", {
        className: "copis-inspector-sidechat-topbar",
        children: [
          /* @__PURE__ */ jsx_runtime2.jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 500 },
            children: [
              /* @__PURE__ */ jsx_runtime2.jsx(MessageSquare, {
                size: 14,
                style: { color: "#cbd5e1" }
              }),
              /* @__PURE__ */ jsx_runtime2.jsx("span", {
                children: "侧边上下文助手"
              })
            ]
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("div", {
            style: { display: "flex", alignItems: "center", gap: "4px" },
            children: /* @__PURE__ */ jsx_runtime2.jsx("button", {
              type: "button",
              className: "copis-inspector-tool-icon-btn",
              onClick: handleClear,
              title: "清空会话记录",
              children: /* @__PURE__ */ jsx_runtime2.jsx(Trash2, {
                size: 13
              })
            })
          })
        ]
      }),
      /* @__PURE__ */ jsx_runtime2.jsxs("div", {
        className: "copis-inspector-sidechat-messages",
        children: [
          messages.map((msg) => {
            const isUser = msg.role === "user";
            return /* @__PURE__ */ jsx_runtime2.jsxs("div", {
              className: `copis-sidechat-message-row ${isUser ? "copis-sidechat-message--user" : "copis-sidechat-message--assistant"}`,
              children: [
                /* @__PURE__ */ jsx_runtime2.jsx("div", {
                  className: "copis-sidechat-avatar",
                  children: isUser ? /* @__PURE__ */ jsx_runtime2.jsx(User, {
                    size: 13
                  }) : /* @__PURE__ */ jsx_runtime2.jsx(Bot, {
                    size: 13,
                    style: { color: "#cbd5e1" }
                  })
                }),
                /* @__PURE__ */ jsx_runtime2.jsxs("div", {
                  className: "copis-sidechat-bubble",
                  children: [
                    /* @__PURE__ */ jsx_runtime2.jsx("div", {
                      className: "copis-sidechat-bubble-content",
                      children: msg.status === "streaming" && !msg.content ? /* @__PURE__ */ jsx_runtime2.jsx("span", {
                        className: "copis-sidechat-thinking",
                        children: "正在思考中..."
                      }) : msg.content
                    }),
                    /* @__PURE__ */ jsx_runtime2.jsx("div", {
                      className: "copis-sidechat-time",
                      children: new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    })
                  ]
                })
              ]
            }, msg.id);
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("div", {
            ref: messagesEndRef
          })
        ]
      }),
      messages.length <= 2 && /* @__PURE__ */ jsx_runtime2.jsx("div", {
        className: "copis-sidechat-preset-chips",
        children: PRESET_PROMPTS.map((prompt) => /* @__PURE__ */ jsx_runtime2.jsxs("button", {
          type: "button",
          className: "copis-sidechat-chip-btn",
          onClick: () => handleSend(prompt),
          children: [
            /* @__PURE__ */ jsx_runtime2.jsx(Sparkles, {
              size: 11,
              style: { color: "#cbd5e1", flexShrink: 0 }
            }),
            /* @__PURE__ */ jsx_runtime2.jsx("span", {
              children: prompt
            })
          ]
        }, prompt))
      }),
      /* @__PURE__ */ jsx_runtime2.jsxs("div", {
        className: "copis-inspector-sidechat-input-box",
        children: [
          /* @__PURE__ */ jsx_runtime2.jsx("textarea", {
            ref: inputRef,
            value: inputValue,
            onChange: (e) => setInputValue(e.target.value),
            onKeyDown: handleKeyDown,
            placeholder: "问问当前工作区代码与架构... (Enter 发送, Shift+Enter 换行)",
            rows: 2,
            className: "copis-sidechat-textarea",
            disabled: isSending
          }),
          /* @__PURE__ */ jsx_runtime2.jsxs("div", {
            className: "copis-sidechat-input-actions",
            children: [
              /* @__PURE__ */ jsx_runtime2.jsx("span", {
                style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #71717a)" },
                children: "Enter 发送"
              }),
              /* @__PURE__ */ jsx_runtime2.jsx("button", {
                type: "button",
                className: "copis-sidechat-send-btn",
                onClick: () => handleSend(),
                disabled: !inputValue.trim() || isSending,
                title: "发送",
                children: isSending ? /* @__PURE__ */ jsx_runtime2.jsx(RotateCcw, {
                  size: 13,
                  className: "copis-spin"
                }) : /* @__PURE__ */ jsx_runtime2.jsx(Send, {
                  size: 13
                })
              })
            ]
          })
        ]
      })
    ]
  });
}

// dsh-plugins/copis-creation-web/src/inspector/TeamInspectorTab.tsx
var import_react5 = require("react");
var jsx_runtime3 = require("react/jsx-runtime");
var DEFAULT_MEMBERS = [
  {
    id: "lead",
    name: "创造模式主智能体 (Lead)",
    role: "lead",
    status: "running",
    description: "负责整体任务规划、多智能体协同分工与核心业务推进",
    skills: ["全局规划", "任务分发", "代码综合"]
  },
  {
    id: "expert-ui",
    name: "UI 设计大师 (Dashi Design)",
    role: "expert",
    status: "idle",
    description: "专精 ShadcnUI、WorkBuddy 浅灰高光风格与现代毛玻璃视觉",
    skills: ["组件设计", "毛玻璃视觉", "CSS微动效"]
  },
  {
    id: "expert-arch",
    name: "系统架构师 (Arch Expert)",
    role: "expert",
    status: "ready",
    description: "负责模块间解耦、IPC通信链路保障与状态原子化治理",
    skills: ["Jotai原子管理", "IPC安全桥接", "BDD契约"]
  },
  {
    id: "worker-review",
    name: "代码审查员 (Code Reviewer)",
    role: "worker",
    status: "idle",
    description: "负责排查潜在空指针、异步竞态与代码重构建议",
    skills: ["静态检查", "TypeScript严格类型", "规范审查"]
  }
];
var DEFAULT_TASKS = [
  {
    id: "task-1",
    subject: "移植 cc-sandbox 侧边 Inspector 多页签系统架构",
    description: "实现顶部 Tab 导航、加号下拉菜单、关闭策略以及多面板分发容器",
    ownerName: "创造模式主智能体 (Lead)",
    status: "completed",
    ready: true,
    writeScopes: ["src/inspector/CopisInspectorPanel.tsx", "src/inspector/inspectorTypes.ts"]
  },
  {
    id: "task-2",
    subject: "升级工作区文件检查器（双栏/可折叠文件树+高亮预览）",
    description: "复刻 FilesInspectorTab，支持面包屑、系统定位、快速复制及代码行统计",
    ownerName: "UI 设计大师 (Dashi Design)",
    status: "completed",
    ready: true,
    writeScopes: ["src/inspector/FilesInspectorTab.tsx"]
  },
  {
    id: "task-3",
    subject: "构建轻量侧边聊天通道（Side Chat）",
    description: "实现独立上下文提问流、预设快捷推荐、首条消息动态更新 Tab 标题",
    ownerName: "创造模式主智能体 (Lead)",
    status: "completed",
    ready: true,
    writeScopes: ["src/inspector/SideChatInspectorTab.tsx"]
  },
  {
    id: "task-4",
    subject: "协同团队面板与任务编排看板（Team & Tasks）",
    description: "展现团队成员状态（处理中/空闲/待命）、任务依赖看板及智能体会话回溯",
    ownerName: "系统架构师 (Arch Expert)",
    status: "in_progress",
    ready: true,
    writeScopes: ["src/inspector/TeamInspectorTab.tsx"]
  },
  {
    id: "task-5",
    subject: "全仓 BDD 契约测试验证与最终验收准备",
    description: "编写覆盖文件、侧边聊天与团队三大面板的自动化测试，执行类型检查与构建",
    ownerName: "代码审查员 (Code Reviewer)",
    status: "pending",
    ready: false,
    blockedBy: ["task-4"],
    writeScopes: ["src/client.test.ts"]
  }
];
function TeamInspectorTab({}) {
  const [members] = import_react5.useState(DEFAULT_MEMBERS);
  const [tasks] = import_react5.useState(DEFAULT_TASKS);
  const [selectedMemberId, setSelectedMemberId] = import_react5.useState(null);
  const [expandedTaskId, setExpandedTaskId] = import_react5.useState("task-4");
  const selectedMember = members.find((m) => m.id === selectedMemberId);
  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const inProgressCount = tasks.filter((t) => t.status === "in_progress").length;
  const pendingCount = tasks.filter((t) => t.status === "pending").length;
  if (selectedMember) {
    return /* @__PURE__ */ jsx_runtime3.jsxs("div", {
      className: "copis-inspector-team-container",
      "data-testid": "copis-inspector-subagent-view",
      children: [
        /* @__PURE__ */ jsx_runtime3.jsxs("div", {
          className: "copis-inspector-team-topbar",
          children: [
            /* @__PURE__ */ jsx_runtime3.jsxs("button", {
              type: "button",
              className: "copis-team-back-btn",
              onClick: () => setSelectedMemberId(null),
              children: [
                /* @__PURE__ */ jsx_runtime3.jsx(ArrowLeft, {
                  size: 13
                }),
                /* @__PURE__ */ jsx_runtime3.jsx("span", {
                  children: "返回团队看板"
                })
              ]
            }),
            /* @__PURE__ */ jsx_runtime3.jsx("div", {
              style: { fontSize: "12px", fontWeight: 600, color: "#f4f4f5" },
              children: selectedMember.name
            })
          ]
        }),
        /* @__PURE__ */ jsx_runtime3.jsxs("div", {
          style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "16px" },
          children: [
            /* @__PURE__ */ jsx_runtime3.jsxs("div", {
              className: "copis-team-member-card",
              style: { marginBottom: "16px" },
              children: [
                /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                  style: { display: "flex", alignItems: "center", gap: "10px" },
                  children: [
                    /* @__PURE__ */ jsx_runtime3.jsx("div", {
                      className: "copis-team-avatar-box",
                      children: /* @__PURE__ */ jsx_runtime3.jsx(Bot, {
                        size: 18,
                        style: { color: "#cbd5e1" }
                      })
                    }),
                    /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                      style: { flex: 1 },
                      children: [
                        /* @__PURE__ */ jsx_runtime3.jsx("div", {
                          style: { fontSize: "13px", fontWeight: 600, color: "#f4f4f5" },
                          children: selectedMember.name
                        }),
                        /* @__PURE__ */ jsx_runtime3.jsx("div", {
                          style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", marginTop: "2px" },
                          children: selectedMember.description
                        })
                      ]
                    })
                  ]
                }),
                selectedMember.skills && /* @__PURE__ */ jsx_runtime3.jsx("div", {
                  style: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "12px" },
                  children: selectedMember.skills.map((skill) => /* @__PURE__ */ jsx_runtime3.jsxs("span", {
                    className: "copis-team-skill-chip",
                    children: [
                      /* @__PURE__ */ jsx_runtime3.jsx(Sparkles, {
                        size: 10,
                        style: { color: "#cbd5e1" }
                      }),
                      skill
                    ]
                  }, skill))
                })
              ]
            }),
            /* @__PURE__ */ jsx_runtime3.jsx("div", {
              style: { fontSize: "12px", fontWeight: 600, color: "#a1a1aa", marginBottom: "8px" },
              children: "智能体执行上下文与记录"
            }),
            /* @__PURE__ */ jsx_runtime3.jsxs("div", {
              className: "copis-team-subagent-log-box",
              children: [
                /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                  className: "copis-team-subagent-log-item",
                  children: [
                    /* @__PURE__ */ jsx_runtime3.jsx("span", {
                      className: "copis-team-log-time",
                      children: "14:48:20"
                    }),
                    /* @__PURE__ */ jsx_runtime3.jsx("span", {
                      className: "copis-team-log-text",
                      children: "智能体已就绪并加载专精规则集"
                    })
                  ]
                }),
                /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                  className: "copis-team-subagent-log-item",
                  children: [
                    /* @__PURE__ */ jsx_runtime3.jsx("span", {
                      className: "copis-team-log-time",
                      children: "14:50:05"
                    }),
                    /* @__PURE__ */ jsx_runtime3.jsx("span", {
                      className: "copis-team-log-text",
                      children: "接收任务指令：执行模块功能拓展与样式微调"
                    })
                  ]
                }),
                /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                  className: "copis-team-subagent-log-item",
                  children: [
                    /* @__PURE__ */ jsx_runtime3.jsx("span", {
                      className: "copis-team-log-time",
                      children: "14:52:12"
                    }),
                    /* @__PURE__ */ jsx_runtime3.jsx("span", {
                      className: "copis-team-log-text",
                      style: { color: "#e4e4e7" },
                      children: "✓ 已完成上下文检查，正在待命监听新指令"
                    })
                  ]
                })
              ]
            })
          ]
        })
      ]
    });
  }
  return /* @__PURE__ */ jsx_runtime3.jsxs("div", {
    className: "copis-inspector-team-container",
    "data-testid": "copis-inspector-team-panel",
    children: [
      /* @__PURE__ */ jsx_runtime3.jsxs("div", {
        className: "copis-inspector-team-topbar",
        children: [
          /* @__PURE__ */ jsx_runtime3.jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 500 },
            children: [
              /* @__PURE__ */ jsx_runtime3.jsx(Users, {
                size: 14,
                style: { color: "#cbd5e1" }
              }),
              /* @__PURE__ */ jsx_runtime3.jsx("span", {
                children: "团队概览"
              })
            ]
          }),
          /* @__PURE__ */ jsx_runtime3.jsxs("div", {
            className: "copis-team-stats-badge",
            children: [
              /* @__PURE__ */ jsx_runtime3.jsxs("span", {
                children: [
                  members.length,
                  " 位成员"
                ]
              }),
              /* @__PURE__ */ jsx_runtime3.jsx("span", {
                style: { opacity: 0.4 },
                children: "·"
              }),
              /* @__PURE__ */ jsx_runtime3.jsxs("span", {
                children: [
                  tasks.length,
                  " 项任务"
                ]
              })
            ]
          })
        ]
      }),
      /* @__PURE__ */ jsx_runtime3.jsxs("div", {
        style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px" },
        children: [
          /* @__PURE__ */ jsx_runtime3.jsxs("div", {
            style: { marginBottom: "20px" },
            children: [
              /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                className: "copis-team-section-header",
                children: [
                  /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                    style: { display: "flex", alignItems: "center", gap: "6px" },
                    children: [
                      /* @__PURE__ */ jsx_runtime3.jsx(UserCheck, {
                        size: 13,
                        style: { color: "#cbd5e1" }
                      }),
                      /* @__PURE__ */ jsx_runtime3.jsx("span", {
                        children: "协同成员"
                      })
                    ]
                  }),
                  /* @__PURE__ */ jsx_runtime3.jsx("span", {
                    style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #71717a)" },
                    children: members.length
                  })
                ]
              }),
              /* @__PURE__ */ jsx_runtime3.jsx("div", {
                style: { display: "flex", flexDirection: "column", gap: "6px" },
                children: members.map((member) => {
                  const isRunning = member.status === "running";
                  const isReady = member.status === "ready";
                  return /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                    className: "copis-team-member-item",
                    onClick: () => setSelectedMemberId(member.id),
                    title: "点击查看执行上下文",
                    children: [
                      /* @__PURE__ */ jsx_runtime3.jsx("div", {
                        className: "copis-team-avatar-mini",
                        children: /* @__PURE__ */ jsx_runtime3.jsx(Bot, {
                          size: 14,
                          style: { color: member.role === "lead" ? "#ffffff" : "#a1a1aa" }
                        })
                      }),
                      /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                        style: { flex: 1, minWidth: 0 },
                        children: [
                          /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                            style: { display: "flex", alignItems: "center", gap: "6px" },
                            children: [
                              /* @__PURE__ */ jsx_runtime3.jsx("span", {
                                style: { fontSize: "12px", fontWeight: 500, color: "#f4f4f5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                                children: member.name
                              }),
                              member.role === "lead" && /* @__PURE__ */ jsx_runtime3.jsx("span", {
                                className: "copis-team-role-tag",
                                children: "LEAD"
                              })
                            ]
                          }),
                          member.description && /* @__PURE__ */ jsx_runtime3.jsx("div", {
                            style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "2px" },
                            children: member.description
                          })
                        ]
                      }),
                      /* @__PURE__ */ jsx_runtime3.jsx("div", {
                        className: `copis-team-status-chip ${isRunning ? "copis-team-status--running" : isReady ? "copis-team-status--ready" : "copis-team-status--idle"}`,
                        children: isRunning ? "处理中" : isReady ? "就绪" : "空闲"
                      })
                    ]
                  }, member.id);
                })
              })
            ]
          }),
          /* @__PURE__ */ jsx_runtime3.jsxs("div", {
            children: [
              /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                className: "copis-team-section-header",
                children: [
                  /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                    style: { display: "flex", alignItems: "center", gap: "6px" },
                    children: [
                      /* @__PURE__ */ jsx_runtime3.jsx(Layers, {
                        size: 13,
                        style: { color: "#cbd5e1" }
                      }),
                      /* @__PURE__ */ jsx_runtime3.jsx("span", {
                        children: "任务编排"
                      })
                    ]
                  }),
                  /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                    style: { display: "flex", gap: "8px", fontSize: "11px" },
                    children: [
                      /* @__PURE__ */ jsx_runtime3.jsxs("span", {
                        style: { color: "#22c55e" },
                        children: [
                          completedCount,
                          " 已完成"
                        ]
                      }),
                      /* @__PURE__ */ jsx_runtime3.jsxs("span", {
                        style: { color: "#e4e4e7" },
                        children: [
                          inProgressCount,
                          " 进行中"
                        ]
                      }),
                      /* @__PURE__ */ jsx_runtime3.jsxs("span", {
                        style: { color: "#a1a1aa" },
                        children: [
                          pendingCount,
                          " 待处理"
                        ]
                      })
                    ]
                  })
                ]
              }),
              /* @__PURE__ */ jsx_runtime3.jsx("div", {
                style: { display: "flex", flexDirection: "column", gap: "6px" },
                children: tasks.map((task) => {
                  const isExpanded = expandedTaskId === task.id;
                  const isCompleted = task.status === "completed";
                  const isInProgress = task.status === "in_progress";
                  return /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                    className: "copis-team-task-item",
                    children: [
                      /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                        className: "copis-team-task-header",
                        onClick: () => setExpandedTaskId(isExpanded ? null : task.id),
                        children: [
                          /* @__PURE__ */ jsx_runtime3.jsx("span", {
                            style: { display: "inline-flex", alignItems: "center", width: "12px", color: "#a1a1aa" },
                            children: isExpanded ? /* @__PURE__ */ jsx_runtime3.jsx(ChevronDown, {
                              size: 12
                            }) : /* @__PURE__ */ jsx_runtime3.jsx(ChevronRight, {
                              size: 12
                            })
                          }),
                          /* @__PURE__ */ jsx_runtime3.jsx("span", {
                            style: { display: "inline-flex", alignItems: "center", marginRight: "2px" },
                            children: isCompleted ? /* @__PURE__ */ jsx_runtime3.jsx(CircleCheck, {
                              size: 13,
                              style: { color: "#22c55e" }
                            }) : isInProgress ? /* @__PURE__ */ jsx_runtime3.jsx(Clock, {
                              size: 13,
                              style: { color: "#e4e4e7" }
                            }) : /* @__PURE__ */ jsx_runtime3.jsx(CircleAlert, {
                              size: 13,
                              style: { color: "#71717a" }
                            })
                          }),
                          /* @__PURE__ */ jsx_runtime3.jsx("span", {
                            style: { flex: 1, fontSize: "12px", fontWeight: 500, color: "#f4f4f5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                            children: task.subject
                          }),
                          /* @__PURE__ */ jsx_runtime3.jsx("span", {
                            className: `copis-team-status-chip ${isCompleted ? "copis-team-status--ready" : isInProgress ? "copis-team-status--running" : "copis-team-status--idle"}`,
                            style: { fontSize: "10px" },
                            children: isCompleted ? "已完成" : isInProgress ? "进行中" : task.ready ? "待领取" : "等待依赖"
                          })
                        ]
                      }),
                      isExpanded && /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                        className: "copis-team-task-details",
                        children: [
                          task.description && /* @__PURE__ */ jsx_runtime3.jsx("div", {
                            style: { marginBottom: "6px", color: "var(--dsw-alias-label-secondary, #d4d4d8)" },
                            children: task.description
                          }),
                          /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                            className: "copis-team-task-meta-grid",
                            children: [
                              /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                                className: "copis-team-meta-row",
                                children: [
                                  /* @__PURE__ */ jsx_runtime3.jsx("span", {
                                    className: "copis-team-meta-key",
                                    children: "负责人:"
                                  }),
                                  /* @__PURE__ */ jsx_runtime3.jsx("span", {
                                    className: "copis-team-meta-val",
                                    children: task.ownerName || "未分配"
                                  })
                                ]
                              }),
                              task.blockedBy && task.blockedBy.length > 0 && /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                                className: "copis-team-meta-row",
                                children: [
                                  /* @__PURE__ */ jsx_runtime3.jsx("span", {
                                    className: "copis-team-meta-key",
                                    children: "阻塞依赖:"
                                  }),
                                  /* @__PURE__ */ jsx_runtime3.jsxs("span", {
                                    className: "copis-team-meta-val",
                                    style: { color: "#fb923c" },
                                    children: [
                                      /* @__PURE__ */ jsx_runtime3.jsx(ShieldAlert, {
                                        size: 11,
                                        style: { display: "inline", marginRight: "4px" }
                                      }),
                                      task.blockedBy.join(", ")
                                    ]
                                  })
                                ]
                              }),
                              task.writeScopes && task.writeScopes.length > 0 && /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                                className: "copis-team-meta-row",
                                children: [
                                  /* @__PURE__ */ jsx_runtime3.jsx("span", {
                                    className: "copis-team-meta-key",
                                    children: "写入范围:"
                                  }),
                                  /* @__PURE__ */ jsx_runtime3.jsxs("span", {
                                    className: "copis-team-meta-val",
                                    style: { color: "#93c5fd" },
                                    children: [
                                      /* @__PURE__ */ jsx_runtime3.jsx(FileCheck, {
                                        size: 11,
                                        style: { display: "inline", marginRight: "4px" }
                                      }),
                                      task.writeScopes.join(", ")
                                    ]
                                  })
                                ]
                              })
                            ]
                          })
                        ]
                      })
                    ]
                  }, task.id);
                })
              })
            ]
          })
        ]
      })
    ]
  });
}

// dsh-plugins/copis-creation-web/src/inspector/CopisInspectorPanel.tsx
var jsx_runtime4 = require("react/jsx-runtime");
var DEFAULT_TABS = [
  {
    id: "tab-files",
    kind: "files",
    label: "工作区文件",
    closable: true
  },
  {
    id: "tab-side-chat",
    kind: "side-chat",
    label: "侧边聊天",
    closable: true
  },
  {
    id: "tab-team",
    kind: "team",
    label: "智能体团队",
    closable: true
  }
];
function resolveInspectorSessionCwd(ctx, explicitSessionId) {
  const sessions = ctx?.sessions;
  const listSnapshot = sessions?.list?.getSnapshot?.();
  const targetSessionId = explicitSessionId || listSnapshot?.current;
  if (targetSessionId && Array.isArray(listSnapshot?.items)) {
    const entry = listSnapshot.items.find((item) => (item.sessionId || item.id) === targetSessionId);
    if (entry?.cwd) {
      return { cwd: entry.cwd, sessionId: targetSessionId };
    }
  }
  if (targetSessionId && listSnapshot?.byId?.[targetSessionId]?.cwd) {
    return { cwd: listSnapshot.byId[targetSessionId].cwd, sessionId: targetSessionId };
  }
  const workspacesSnapshot = ctx?.workspaces?.getSnapshot?.();
  if (Array.isArray(workspacesSnapshot?.items) && workspacesSnapshot.items.length > 0) {
    if (targetSessionId) {
      const matchedWs = workspacesSnapshot.items.find((ws) => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(targetSessionId));
      if (matchedWs?.path) {
        return { cwd: matchedWs.path, sessionId: targetSessionId };
      }
    }
    if (workspacesSnapshot.items[0]?.path) {
      return { cwd: workspacesSnapshot.items[0].path, sessionId: targetSessionId };
    }
  }
  return { cwd: undefined, sessionId: targetSessionId };
}
function CopisInspectorPanel(props) {
  const [tabs, setTabs] = import_react6.useState(DEFAULT_TABS);
  const [activeTabId, setActiveTabId] = import_react6.useState("tab-files");
  const [isAddMenuOpen, setIsAddMenuOpen] = import_react6.useState(false);
  const addMenuRef = import_react6.useRef(null);
  const [sessionCwd, setSessionCwd] = import_react6.useState(() => {
    return resolveInspectorSessionCwd(props.ctx, props.sessionId).cwd;
  });
  const [effectiveSessionId, setEffectiveSessionId] = import_react6.useState(() => {
    return resolveInspectorSessionCwd(props.ctx, props.sessionId).sessionId;
  });
  import_react6.useEffect(() => {
    const syncState = () => {
      const resolved = resolveInspectorSessionCwd(props.ctx, props.sessionId);
      if (resolved.cwd) {
        setSessionCwd(resolved.cwd);
      }
      setEffectiveSessionId(resolved.sessionId);
    };
    syncState();
    const unsubs = [];
    if (typeof props.ctx?.sessions?.list?.subscribe === "function") {
      unsubs.push(props.ctx.sessions.list.subscribe(syncState));
    }
    if (typeof props.ctx?.workspaces?.subscribe === "function") {
      unsubs.push(props.ctx.workspaces.subscribe(syncState));
    }
    if (!sessionCwd && window.copisBridge?.getActiveWorkspacePath) {
      window.copisBridge.getActiveWorkspacePath().then((bridgePath) => {
        if (bridgePath) {
          setSessionCwd((prev) => prev || bridgePath);
        }
      }).catch(() => {});
    }
    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [props.ctx, props.sessionId, sessionCwd]);
  import_react6.useEffect(() => {
    const handleClickOutside = (e) => {
      if (isAddMenuOpen && addMenuRef.current && !addMenuRef.current.contains(e.target)) {
        setIsAddMenuOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        if (isAddMenuOpen) {
          setIsAddMenuOpen(false);
          e.stopPropagation();
        } else {
          handleCloseDrawer();
        }
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAddMenuOpen]);
  const activeTab = import_react6.useMemo(() => {
    return tabs.find((t) => t.id === activeTabId) || tabs[0];
  }, [tabs, activeTabId]);
  const handleCloseTab = (e, tabId) => {
    e.stopPropagation();
    if (tabs.length <= 1)
      return;
    const targetIdx = tabs.findIndex((t) => t.id === tabId);
    const nextTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(nextTabs);
    if (activeTabId === tabId) {
      const newActiveIdx = Math.max(0, targetIdx - 1);
      setActiveTabId(nextTabs[newActiveIdx].id);
    }
  };
  const handleAddTab = (kind) => {
    setIsAddMenuOpen(false);
    if (kind === "files") {
      const existing = tabs.find((t) => t.kind === "files");
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const newTab = {
        id: `tab-files-${Date.now()}`,
        kind: "files",
        label: "工作区文件",
        closable: true
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } else if (kind === "team") {
      const existing = tabs.find((t) => t.kind === "team");
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const newTab = {
        id: `tab-team-${Date.now()}`,
        kind: "team",
        label: "智能体团队",
        closable: true
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } else if (kind === "side-chat") {
      const chatCount = tabs.filter((t) => t.kind === "side-chat").length;
      const newTab = {
        id: `tab-side-chat-${Date.now()}`,
        kind: "side-chat",
        label: chatCount > 0 ? `侧边聊天 ${chatCount + 1}` : "侧边聊天",
        closable: true
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    }
  };
  const handleTitleChange = (tabId, newTitle) => {
    setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, label: newTitle, title: newTitle } : t));
  };
  const handleCloseDrawer = () => {
    if (props.closeDetails) {
      props.closeDetails();
    } else if (props.ctx?.layout?.closeDetails) {
      props.ctx.layout.closeDetails();
    }
  };
  const getTabIcon = (kind, isActive) => {
    const activePurple = "#a855f7";
    switch (kind) {
      case "files":
        return /* @__PURE__ */ jsx_runtime4.jsx(FolderCode, {
          size: 13,
          style: { color: isActive ? activePurple : "#94a3b8" }
        });
      case "side-chat":
        return /* @__PURE__ */ jsx_runtime4.jsx(MessageSquare, {
          size: 13,
          style: { color: isActive ? activePurple : "#94a3b8" }
        });
      case "team":
        return /* @__PURE__ */ jsx_runtime4.jsx(UsersRound, {
          size: 13,
          style: { color: isActive ? activePurple : "#cbd5e1" }
        });
    }
  };
  return /* @__PURE__ */ jsx_runtime4.jsxs("div", {
    className: "copis-inspector-root",
    "data-testid": "copis-inspector-panel",
    children: [
      /* @__PURE__ */ jsx_runtime4.jsxs("div", {
        className: "copis-inspector-tabbar",
        children: [
          /* @__PURE__ */ jsx_runtime4.jsx("div", {
            className: "copis-inspector-tab-list",
            role: "tablist",
            children: tabs.map((tab) => {
              const isActive = tab.id === activeTab?.id;
              return /* @__PURE__ */ jsx_runtime4.jsxs("button", {
                type: "button",
                role: "tab",
                "aria-selected": isActive,
                "data-active": isActive ? "true" : "false",
                className: "copis-inspector-tab-item",
                onClick: () => setActiveTabId(tab.id),
                title: tab.title || tab.label,
                children: [
                  /* @__PURE__ */ jsx_runtime4.jsx("span", {
                    className: "copis-inspector-tab-icon",
                    children: getTabIcon(tab.kind, isActive)
                  }),
                  /* @__PURE__ */ jsx_runtime4.jsx("span", {
                    className: "copis-inspector-tab-label",
                    children: tab.label
                  }),
                  tabs.length > 1 && tab.closable && /* @__PURE__ */ jsx_runtime4.jsx("span", {
                    className: "copis-inspector-tab-close",
                    onClick: (e) => handleCloseTab(e, tab.id),
                    title: "关闭页签",
                    role: "button",
                    "aria-label": `关闭 ${tab.label}`,
                    children: /* @__PURE__ */ jsx_runtime4.jsx(X, {
                      size: 11
                    })
                  })
                ]
              }, tab.id);
            })
          }),
          /* @__PURE__ */ jsx_runtime4.jsxs("div", {
            className: "copis-inspector-tabbar-actions",
            children: [
              /* @__PURE__ */ jsx_runtime4.jsxs("div", {
                className: "copis-inspector-add-wrapper",
                ref: addMenuRef,
                children: [
                  /* @__PURE__ */ jsx_runtime4.jsx("button", {
                    type: "button",
                    className: "copis-inspector-tool-icon-btn",
                    onClick: () => setIsAddMenuOpen((prev) => !prev),
                    title: "添加新页签",
                    "aria-label": "添加新页签",
                    children: /* @__PURE__ */ jsx_runtime4.jsx(Plus, {
                      size: 14
                    })
                  }),
                  isAddMenuOpen && /* @__PURE__ */ jsx_runtime4.jsxs("div", {
                    className: "copis-inspector-add-dropdown",
                    "data-testid": "copis-inspector-add-dropdown",
                    children: [
                      /* @__PURE__ */ jsx_runtime4.jsxs("button", {
                        type: "button",
                        className: "copis-inspector-dropdown-item",
                        onClick: () => handleAddTab("side-chat"),
                        children: [
                          /* @__PURE__ */ jsx_runtime4.jsx(MessageSquare, {
                            size: 13,
                            style: { color: "#94a3b8" }
                          }),
                          /* @__PURE__ */ jsx_runtime4.jsx("span", {
                            children: "新建侧边聊天"
                          })
                        ]
                      }),
                      /* @__PURE__ */ jsx_runtime4.jsxs("button", {
                        type: "button",
                        className: "copis-inspector-dropdown-item",
                        onClick: () => handleAddTab("files"),
                        children: [
                          /* @__PURE__ */ jsx_runtime4.jsx(FolderCode, {
                            size: 13,
                            style: { color: "#94a3b8" }
                          }),
                          /* @__PURE__ */ jsx_runtime4.jsx("span", {
                            children: "工作区文件"
                          })
                        ]
                      }),
                      /* @__PURE__ */ jsx_runtime4.jsxs("button", {
                        type: "button",
                        className: "copis-inspector-dropdown-item",
                        onClick: () => handleAddTab("team"),
                        children: [
                          /* @__PURE__ */ jsx_runtime4.jsx(UsersRound, {
                            size: 13,
                            style: { color: "#cbd5e1" }
                          }),
                          /* @__PURE__ */ jsx_runtime4.jsx("span", {
                            children: "智能体团队"
                          })
                        ]
                      })
                    ]
                  })
                ]
              }),
              /* @__PURE__ */ jsx_runtime4.jsx("button", {
                type: "button",
                className: "copis-inspector-tool-icon-btn",
                onClick: handleCloseDrawer,
                title: "关闭检查器抽屉",
                "aria-label": "关闭面板",
                children: /* @__PURE__ */ jsx_runtime4.jsx(X, {
                  size: 14
                })
              })
            ]
          })
        ]
      }),
      /* @__PURE__ */ jsx_runtime4.jsxs("div", {
        className: "copis-inspector-content",
        children: [
          activeTab?.kind === "files" && /* @__PURE__ */ jsx_runtime4.jsx(FilesInspectorTab, {
            sessionCwd,
            sessionId: effectiveSessionId || props.sessionId
          }),
          activeTab?.kind === "side-chat" && /* @__PURE__ */ jsx_runtime4.jsx(SideChatInspectorTab, {
            tabId: activeTab.id,
            sessionId: effectiveSessionId || props.sessionId,
            sessionCwd,
            onTitleChange: handleTitleChange
          }),
          activeTab?.kind === "team" && /* @__PURE__ */ jsx_runtime4.jsx(TeamInspectorTab, {
            sessionId: effectiveSessionId || props.sessionId,
            sessionCwd
          })
        ]
      })
    ]
  });
}

// dsh-plugins/copis-creation-web/src/client.tsx
var jsx_runtime5 = require("react/jsx-runtime");
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

  /* 当子视图激活时，彻底隐藏浮动工具栏（工作区、Agent模式），避免挤占/遮挡侧栏顶部 */
  body.copis-subview-active .copis-hero-utilities-overlay {
    display: none !important;
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

  /* 隐藏顶部右上角原生的 session-log-download 及任何 Agent 模式切换按钮 */
  button[class*="sessionLogButton"],
  button[title*="返回 Agent 模式"],
  button[title*="返回Agent 模式"],
  button[aria-label*="返回 Agent 模式"],
  button[aria-label*="返回Agent 模式"],
  .copis-header-btn-agent,
  [data-slot-id="session-log-download"] {
    display: none !important;
  }

  .copis-header-btn-agent {
    display: none !important;
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
    border: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08)) !important;
    background: var(--dsw-alias-button-elevated-fill, rgba(255, 255, 255, 0.04)) !important;
    color: var(--dsw-alias-label-secondary, #94a3b8) !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04) !important;
    backdrop-filter: blur(8px) !important;
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1) !important;
  }

  .copis-header-btn-workspace:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08)) !important;
    color: var(--dsw-alias-label-primary, #ffffff) !important;
    border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16)) !important;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.08) !important;
  }

  .copis-header-btn-workspace:active {
    transform: scale(0.95) !important;
  }

  .copis-header-btn-workspace[data-active="true"] {
    background: rgba(255, 255, 255, 0.14) !important;
    border: 1px solid rgba(255, 255, 255, 0.22) !important;
    color: #ffffff !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
  }

  .copis-header-btn-workspace[data-active="true"]:hover {
    background: rgba(255, 255, 255, 0.18) !important;
    border-color: rgba(255, 255, 255, 0.28) !important;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.15) !important;
  }

  /* 中部聊天区：支持与侧边抽屉并列推入的平滑宽度过渡（Push-in 挤压） */
  :root {
    --copis-inspector-width: 500px;
  }

  [class*="_centerCol"],
  [class*="centerCol"] {
    transition: margin-right 220ms cubic-bezier(0.16, 1, 0.3, 1) !important;
  }

  body.copis-details-drawer-open [class*="_centerCol"],
  body.copis-details-drawer-open [class*="centerCol"] {
    margin-right: var(--copis-inspector-width, 500px) !important;
  }

  /* 欢迎屏常驻右上角操作栏：跟随推入平滑左移，防止与抽屉重叠 */
  .copis-hero-utilities-overlay {
    transition: right 220ms cubic-bezier(0.16, 1, 0.3, 1) !important;
  }

  body.copis-details-drawer-open .copis-hero-utilities-overlay {
    right: calc(var(--copis-inspector-width, 500px) + 18px) !important;
  }

  /* 右侧工作区全功能 Inspector 抽屉样式（纯正灰色 WorkBuddy 浅灰/暗黑风格，推入式滑入抽屉，无遮罩，无紫色） */
  .copis-details-drawer-root {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--copis-inspector-width, 500px);
    max-width: calc(100vw - 320px);
    z-index: 85;
    background: #18181b;
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border-left: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.35);
    display: flex;
    flex-direction: column;
    color: #f4f4f5;
    transform: translateX(100%);
    visibility: hidden;
    pointer-events: none;
    transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1), visibility 220ms ease;
  }

  body:not([data-ds-dark-theme]) .copis-details-drawer-root {
    background: #f4f4f5;
    color: #18181b;
    border-left: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.08);
  }

  body.copis-details-drawer-open .copis-details-drawer-root {
    transform: translateX(0);
    visibility: visible;
    pointer-events: auto;
  }

  /* 拖拽调整抽屉宽度时的即时响应保护（禁用 transition 避免滞后延迟） */
  body.copis-inspector-resizing [class*="_centerCol"],
  body.copis-inspector-resizing [class*="centerCol"],
  body.copis-inspector-resizing .copis-details-drawer-root,
  body.copis-inspector-resizing .copis-hero-utilities-overlay {
    transition: none !important;
  }

  /* 抽屉左侧可拖拽调整尺寸边框 */
  .copis-inspector-resize-handle {
    position: absolute;
    top: 0;
    left: -3px;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    z-index: 100;
    touch-action: none;
    background: transparent;
    transition: background-color 150ms ease;
  }

  .copis-inspector-resize-handle:hover,
  .copis-inspector-resize-handle[data-resizing="true"] {
    background: rgba(255, 255, 255, 0.22);
  }

  body:not([data-ds-dark-theme]) .copis-inspector-resize-handle:hover,
  body:not([data-ds-dark-theme]) .copis-inspector-resize-handle[data-resizing="true"] {
    background: rgba(0, 0, 0, 0.2);
  }

  /* 子视图激活时强制隐藏抽屉，保证全屏子视图整洁 */
  body.copis-subview-active .copis-details-drawer-root {
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

  /* ========================================================
     Copis 创造模式 Inspector 多页签系统样式 (参考 cc-sandbox)
     ======================================================== */
  .copis-inspector-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
    font-family: var(--dsw-font-family, system-ui, sans-serif);
    color: #f4f4f5;
  }

  .copis-inspector-tabbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 38px;
    padding: 0 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.22);
    flex-shrink: 0;
    gap: 8px;
  }

  .copis-inspector-tab-list {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    flex: 1;
    min-width: 0;
    padding: 2px 0;
    scrollbar-width: none;
  }

  .copis-inspector-tab-list::-webkit-scrollbar {
    display: none;
  }

  /* WorkBuddy 风格浅灰微光 Tab 项 */
  .copis-inspector-tab-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    background: transparent;
    color: #a1a1aa;
    transition: all 120ms ease;
    user-select: none;
    white-space: nowrap;
  }

  .copis-inspector-tab-item:hover {
    background: rgba(255, 255, 255, 0.06);
    color: #e4e4e7;
  }

  .copis-inspector-tab-item[data-active="true"] {
    background: rgba(255, 255, 255, 0.14) !important;
    color: #ffffff !important;
    border-color: rgba(255, 255, 255, 0.18) !important;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.12) !important;
  }

  /* 侧栏上方 Tab 激活时，Icon 统一使用紫色高亮 */
  .copis-inspector-tab-item[data-active="true"] .copis-inspector-tab-icon,
  .copis-inspector-tab-item[data-active="true"] .copis-inspector-tab-icon svg {
    color: #a855f7 !important;
    stroke: #a855f7 !important;
  }

  body:not([data-ds-dark-theme]) .copis-inspector-tab-item[data-active="true"] .copis-inspector-tab-icon,
  body:not([data-ds-dark-theme]) .copis-inspector-tab-item[data-active="true"] .copis-inspector-tab-icon svg {
    color: #9333ea !important;
    stroke: #9333ea !important;
  }

  .copis-inspector-tab-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .copis-inspector-tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 140px;
  }

  .copis-inspector-tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    margin-left: 2px;
    color: #71717a;
    transition: all 100ms ease;
  }

  .copis-inspector-tab-close:hover {
    background: rgba(255, 255, 255, 0.15);
    color: #ffffff;
  }

  .copis-inspector-tabbar-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .copis-inspector-tool-icon-btn {
    appearance: none;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #a1a1aa;
    border-radius: 6px;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 120ms ease;
  }

  .copis-inspector-tool-icon-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #ffffff;
  }

  .copis-inspector-add-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .copis-inspector-add-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 150px;
    background: rgba(24, 24, 32, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    padding: 4px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 2px;
    backdrop-filter: blur(16px);
  }

  .copis-inspector-dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12px;
    color: #d4d4d8;
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: all 100ms ease;
  }

  .copis-inspector-dropdown-item:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #ffffff;
  }

  .copis-inspector-content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ------------------- 文件面板 (Files Tab) ------------------- */
  .copis-inspector-files-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  .copis-inspector-files-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.12);
    flex-shrink: 0;
    font-size: 11px;
    gap: 8px;
  }

  .copis-inspector-files-breadcrumb {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #a1a1aa;
    flex: 1;
    min-width: 0;
  }

  .copis-inspector-files-topbar-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .copis-inspector-files-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .copis-inspector-files-tree-col {
    width: 220px;
    flex-shrink: 0;
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: rgba(0, 0, 0, 0.08);
  }

  .copis-inspector-files-preview-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.04);
  }

  .copis-inspector-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 32px 16px;
    text-align: center;
  }

  .copis-inspector-code-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .copis-inspector-code-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    font-size: 11px;
    color: #a1a1aa;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.15);
    flex-shrink: 0;
  }

  /* ------------------- 侧边聊天面板 (Side Chat Tab) ------------------- */
  .copis-inspector-sidechat-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  .copis-inspector-sidechat-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.12);
    flex-shrink: 0;
  }

  .copis-inspector-sidechat-messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .copis-sidechat-message-row {
    display: flex;
    gap: 8px;
    max-width: 90%;
  }

  .copis-sidechat-message--user {
    align-self: flex-end;
    flex-direction: row-reverse;
  }

  .copis-sidechat-message--assistant {
    align-self: flex-start;
  }

  .copis-sidechat-avatar {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: #a1a1aa;
  }

  .copis-sidechat-bubble {
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.5;
    color: #f4f4f5;
  }

  .copis-sidechat-message--user .copis-sidechat-bubble {
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.15);
  }

  .copis-sidechat-message--assistant .copis-sidechat-bubble {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .copis-sidechat-time {
    font-size: 10px;
    color: #71717a;
    margin-top: 4px;
    text-align: right;
  }

  .copis-sidechat-thinking {
    color: #a1a1aa;
    font-style: italic;
  }

  .copis-sidechat-preset-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.1);
  }

  .copis-sidechat-chip-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 11px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: #d4d4d8;
    cursor: pointer;
    transition: all 120ms ease;
  }

  .copis-sidechat-chip-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.22);
    color: #ffffff;
  }

  .copis-inspector-sidechat-input-box {
    padding: 10px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.2);
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  }

  .copis-sidechat-textarea {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 12px;
    color: #f4f4f5;
    resize: none;
    outline: none;
    font-family: inherit;
  }

  .copis-sidechat-textarea:focus {
    border-color: rgba(255, 255, 255, 0.24);
  }

  .copis-sidechat-input-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .copis-sidechat-send-btn {
    background: #3f414a;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 5px;
    color: #ffffff;
    padding: 4px 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 120ms ease;
  }

  .copis-sidechat-send-btn:hover:not(:disabled) {
    background: #4d505a;
    border-color: rgba(255, 255, 255, 0.24);
  }

  .copis-sidechat-send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ------------------- 团队面板 (Team Tab) ------------------- */
  .copis-inspector-team-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  .copis-inspector-team-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.12);
    flex-shrink: 0;
  }

  .copis-team-stats-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: #a1a1aa;
  }

  .copis-team-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    font-weight: 600;
    color: #d4d4d8;
    margin-bottom: 8px;
  }

  .copis-team-member-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.07);
    cursor: pointer;
    transition: all 120ms ease;
  }

  .copis-team-member-item:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.14);
  }

  .copis-team-avatar-mini {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .copis-team-role-tag {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.08);
    color: #e4e4e7;
    border: 1px solid rgba(255, 255, 255, 0.12);
  }

  .copis-team-status-chip {
    font-size: 10px;
    font-weight: 500;
    padding: 2px 7px;
    border-radius: 10px;
    flex-shrink: 0;
  }

  .copis-team-status--running {
    background: rgba(255, 255, 255, 0.12);
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .copis-team-status--ready {
    background: rgba(34, 197, 94, 0.15);
    color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .copis-team-status--idle {
    background: rgba(255, 255, 255, 0.06);
    color: #a1a1aa;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .copis-team-task-item {
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.07);
    overflow: hidden;
  }

  .copis-team-task-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    cursor: pointer;
    transition: background 100ms ease;
  }

  .copis-team-task-header:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .copis-team-task-details {
    padding: 8px 10px 10px 28px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    font-size: 11px;
    color: #a1a1aa;
    background: rgba(0, 0, 0, 0.1);
  }

  .copis-team-task-meta-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }

  .copis-team-meta-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .copis-team-meta-key {
    color: #71717a;
    min-width: 54px;
  }

  .copis-team-meta-val {
    color: #e4e4e7;
    font-weight: 500;
  }

  .copis-team-back-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 5px;
    font-size: 11px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #f4f4f5;
    cursor: pointer;
  }

  .copis-team-member-card {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    padding: 14px;
  }

  .copis-team-avatar-box {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .copis-team-skill-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: #d4d4d8;
  }

  .copis-team-subagent-log-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    padding: 10px;
  }

  .copis-team-subagent-log-item {
    display: flex;
    gap: 8px;
    font-size: 11px;
    font-family: monospace;
  }

  .copis-team-log-time {
    color: #71717a;
  }

  .copis-team-log-text {
    color: #d4d4d8;
  }

  /* 兼容旧版单一面板类 */
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
    background: rgba(255, 255, 255, 0.12) !important;
    color: #ffffff !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
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
    background: rgba(255, 255, 255, 0.12) !important;
    color: #ffffff !important;
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
  /* 彻底屏蔽 DSH 原生旧版 DetailsPanel 遗留界面（旧的文件与改动 tab） */
  [class*="_2ctAZa_header"],
  [class*="_2ctAZa_root"] > div:first-child:not(.copis-inspector-tabbar) {
    display: none !important;
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
  const [activeView, setActiveView] = import_react7.useState("conversations");
  const [hiddenMenuIds, setHiddenMenuIds] = import_react7.useState(getInitialHiddenMenuIds);
  const rootRef = import_react7.useRef(null);
  const isSubviewActive = activeView !== "conversations";
  const effectiveCtx = props.ctx ?? cachedCordisContext;
  const wide = isSubviewActive || Boolean(props.wide) || !props.collapsed && (props.width === undefined || props.width >= 200);
  import_react7.useLayoutEffect(() => {
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
  import_react7.useEffect(() => {
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
  import_react7.useEffect(() => {
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
  import_react7.useEffect(() => {
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
  import_react7.useEffect(() => {
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
  import_react7.useEffect(() => {
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
  import_react7.useEffect(() => {
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
  import_react7.useEffect(() => {
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
    if (document.body?.classList.contains("copis-details-drawer-open")) {
      window.dispatchEvent(new CustomEvent("COPIS_TOGGLE_WORKSPACE_DRAWER"));
    }
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
    return /* @__PURE__ */ jsx_runtime5.jsx("div", {
      ref: rootRef,
      className: "copis-rail-menu-section",
      "data-copis-placement": "before-workspaces",
      children: visibleMenuItems.map((item) => {
        const Icon2 = item.icon;
        return /* @__PURE__ */ jsx_runtime5.jsx("button", {
          type: "button",
          className: "copis-rail-menu-item",
          "data-copis-menu-id": item.id,
          "data-active": item.view === activeView ? "true" : "false",
          "aria-label": item.label,
          title: item.label,
          onClick: () => selectItem(item),
          children: /* @__PURE__ */ jsx_runtime5.jsx(Icon2, {
            size: 18,
            strokeWidth: 1.8
          })
        }, item.id);
      })
    });
  }
  return /* @__PURE__ */ jsx_runtime5.jsx("div", {
    ref: rootRef,
    className: "copis-menu-section",
    "data-copis-placement": "before-workspaces",
    children: visibleMenuItems.map((item) => {
      const Icon2 = item.icon;
      return /* @__PURE__ */ jsx_runtime5.jsxs("button", {
        type: "button",
        className: "copis-menu-item",
        "data-copis-menu-id": item.id,
        "data-active": item.view === activeView ? "true" : "false",
        onClick: () => selectItem(item),
        children: [
          /* @__PURE__ */ jsx_runtime5.jsx(Icon2, {
            size: 16,
            strokeWidth: 1.8
          }),
          /* @__PURE__ */ jsx_runtime5.jsx("span", {
            children: item.label
          }),
          item.badge && /* @__PURE__ */ jsx_runtime5.jsx("span", {
            className: `copis-menu-badge ${item.badge === "BETA" ? "copis-menu-badge-beta" : "copis-menu-badge-flexible"}`,
            children: item.badge
          }),
          /* @__PURE__ */ jsx_runtime5.jsx("button", {
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
  const [detailsOpen, setDetailsOpen] = import_react7.useState(false);
  import_react7.useEffect(() => {
    const checkDetailsState = () => {
      if (typeof document === "undefined")
        return;
      const isDrawerOpen = Boolean(document.body?.classList.contains("copis-details-drawer-open"));
      setDetailsOpen(isDrawerOpen);
    };
    checkDetailsState();
    const observer = new MutationObserver(checkDetailsState);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"]
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
    const isDrawerOpen = Boolean(document.body?.classList.contains("copis-details-drawer-open"));
    const detailsCol = document.querySelector('[class*="detailsCol"], [class*="_detailsCol"]');
    const isCollapsed = Boolean(document.querySelector("[data-details-collapsed]"));
    if (detailsCol && !isCollapsed) {
      props.ctx.layout?.closeDetails();
    }
    window.dispatchEvent(new CustomEvent("COPIS_TOGGLE_WORKSPACE_DRAWER"));
    setDetailsOpen(!isDrawerOpen);
  };
  return /* @__PURE__ */ jsx_runtime5.jsx("div", {
    className: "copis-header-utilities-bar",
    children: /* @__PURE__ */ jsx_runtime5.jsx("button", {
      type: "button",
      className: "copis-header-action-btn copis-header-btn-workspace",
      "data-active": detailsOpen ? "true" : "false",
      onClick: handleToggleWorkspaceDetails,
      title: detailsOpen ? "折叠工作区文件面板" : "展开工作区文件面板",
      "aria-label": detailsOpen ? "折叠工作区文件面板" : "展开工作区文件面板",
      children: detailsOpen ? /* @__PURE__ */ jsx_runtime5.jsx(PanelRightClose, {
        size: 15,
        strokeWidth: 1.8
      }) : /* @__PURE__ */ jsx_runtime5.jsx(PanelRight, {
        size: 15,
        strokeWidth: 1.8
      })
    })
  });
}
function CopisDetailsPanel(props) {
  return /* @__PURE__ */ jsx_runtime5.jsx(CopisInspectorPanel, {
    ...props
  });
}
function HighlightSearchText({ text, query }) {
  if (!query || !query.trim())
    return /* @__PURE__ */ jsx_runtime5.jsx(jsx_runtime5.Fragment, {
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
      parts.push(/* @__PURE__ */ jsx_runtime5.jsx("span", {
        children: text.slice(lastIndex, idx)
      }, `t-${lastIndex}`));
    }
    parts.push(/* @__PURE__ */ jsx_runtime5.jsx("mark", {
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
    parts.push(/* @__PURE__ */ jsx_runtime5.jsx("span", {
      children: text.slice(lastIndex)
    }, `end-${lastIndex}`));
  }
  return /* @__PURE__ */ jsx_runtime5.jsx(jsx_runtime5.Fragment, {
    children: parts
  });
}
function CopisSearchModal(props) {
  const [query, setQuery] = import_react7.useState("");
  const [committedQuery, setCommittedQuery] = import_react7.useState("");
  const [loading, setLoading] = import_react7.useState(false);
  const [hasSearched, setHasSearched] = import_react7.useState(false);
  const [titleResults, setTitleResults] = import_react7.useState([]);
  const [contentResults, setContentResults] = import_react7.useState([]);
  const [selectedIndex, setSelectedIndex] = import_react7.useState(0);
  const inputRef = import_react7.useRef(null);
  const isComposingRef = import_react7.useRef(false);
  const searchTokenRef = import_react7.useRef(0);
  import_react7.useEffect(() => {
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
  const runSearch = import_react7.useCallback(async () => {
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
  const allResults = import_react7.useMemo(() => [...titleResults, ...contentResults], [titleResults, contentResults]);
  const navigateToResult = import_react7.useCallback((item) => {
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
  const handleKeyDown = import_react7.useCallback((e) => {
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
  return /* @__PURE__ */ jsx_runtime5.jsx("div", {
    className: "copis-search-modal-backdrop",
    onClick: (e) => {
      if (e.target === e.currentTarget) {
        props.onClose();
      }
    },
    children: /* @__PURE__ */ jsx_runtime5.jsxs("div", {
      className: "copis-search-modal-card",
      onKeyDown: handleKeyDown,
      children: [
        /* @__PURE__ */ jsx_runtime5.jsxs("div", {
          className: "copis-search-input-row",
          children: [
            /* @__PURE__ */ jsx_runtime5.jsx(Search, {
              size: 16,
              style: { color: "var(--dsw-alias-label-tertiary, #a1a1aa)", flexShrink: 0 }
            }),
            /* @__PURE__ */ jsx_runtime5.jsx("input", {
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
            query && /* @__PURE__ */ jsx_runtime5.jsx("button", {
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
              children: /* @__PURE__ */ jsx_runtime5.jsx(X, {
                size: 14
              })
            }),
            /* @__PURE__ */ jsx_runtime5.jsxs("button", {
              type: "button",
              className: "copis-search-submit-btn",
              disabled: !query.trim() || loading,
              onClick: () => void runSearch(),
              children: [
                loading ? /* @__PURE__ */ jsx_runtime5.jsx(LoaderCircle, {
                  size: 13,
                  className: "copis-spin"
                }) : /* @__PURE__ */ jsx_runtime5.jsx(Search, {
                  size: 13
                }),
                /* @__PURE__ */ jsx_runtime5.jsx("span", {
                  children: "搜索"
                })
              ]
            })
          ]
        }),
        /* @__PURE__ */ jsx_runtime5.jsxs("div", {
          className: "copis-search-results-list",
          children: [
            !hasSearched && /* @__PURE__ */ jsx_runtime5.jsx("div", {
              style: { padding: "36px 16px", textAlign: "center", fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
              children: "输入关键词后按 Enter 或点击搜索开始查找"
            }),
            hasSearched && loading && allResults.length === 0 && /* @__PURE__ */ jsx_runtime5.jsxs("div", {
              style: { padding: "36px 16px", textAlign: "center", fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" },
              children: [
                /* @__PURE__ */ jsx_runtime5.jsx(LoaderCircle, {
                  size: 14,
                  className: "copis-spin"
                }),
                /* @__PURE__ */ jsx_runtime5.jsx("span", {
                  children: "正在搜索..."
                })
              ]
            }),
            hasSearched && !loading && allResults.length === 0 && /* @__PURE__ */ jsx_runtime5.jsxs("div", {
              style: { padding: "36px 16px", textAlign: "center", fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
              children: [
                '未找到与 "',
                committedQuery,
                '" 匹配的会话内容'
              ]
            }),
            titleResults.length > 0 && /* @__PURE__ */ jsx_runtime5.jsxs("div", {
              children: [
                /* @__PURE__ */ jsx_runtime5.jsxs("div", {
                  style: { padding: "6px 14px 2px", fontSize: "11px", fontWeight: 600, color: "var(--dsw-alias-label-tertiary, #a1a1aa)", textTransform: "uppercase" },
                  children: [
                    "会话匹配 (",
                    titleResults.length,
                    ")"
                  ]
                }),
                titleResults.map((item, idx) => /* @__PURE__ */ jsx_runtime5.jsxs("button", {
                  type: "button",
                  className: "copis-search-item-row",
                  "data-selected": selectedIndex === idx ? "true" : "false",
                  onClick: () => navigateToResult(item),
                  onMouseEnter: () => setSelectedIndex(idx),
                  children: [
                    item.source === "creation" ? /* @__PURE__ */ jsx_runtime5.jsx("span", {
                      className: "copis-search-badge-creation",
                      children: "创造"
                    }) : /* @__PURE__ */ jsx_runtime5.jsx("span", {
                      className: "copis-search-badge-agent",
                      children: "Agent"
                    }),
                    /* @__PURE__ */ jsx_runtime5.jsx("span", {
                      style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px", fontWeight: 500 },
                      children: /* @__PURE__ */ jsx_runtime5.jsx(HighlightSearchText, {
                        text: item.title,
                        query: committedQuery
                      })
                    })
                  ]
                }, `title-${item.id}-${idx}`))
              ]
            }),
            contentResults.length > 0 && /* @__PURE__ */ jsx_runtime5.jsxs("div", {
              style: { borderTop: "0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08))", marginTop: "4px", paddingTop: "4px" },
              children: [
                /* @__PURE__ */ jsx_runtime5.jsxs("div", {
                  style: { padding: "6px 14px 2px", fontSize: "11px", fontWeight: 600, color: "var(--dsw-alias-label-tertiary, #a1a1aa)", textTransform: "uppercase" },
                  children: [
                    "消息内容匹配 (",
                    contentResults.length,
                    ")"
                  ]
                }),
                contentResults.map((item, idx) => {
                  const globalIdx = titleResults.length + idx;
                  return /* @__PURE__ */ jsx_runtime5.jsxs("button", {
                    type: "button",
                    className: "copis-search-item-row",
                    "data-selected": selectedIndex === globalIdx ? "true" : "false",
                    onClick: () => navigateToResult(item),
                    onMouseEnter: () => setSelectedIndex(globalIdx),
                    style: { flexDirection: "column", alignItems: "flex-start", gap: "3px" },
                    children: [
                      /* @__PURE__ */ jsx_runtime5.jsxs("div", {
                        style: { display: "flex", alignItems: "center", gap: "8px", width: "100%" },
                        children: [
                          /* @__PURE__ */ jsx_runtime5.jsx("span", {
                            className: "copis-search-badge-agent",
                            children: "Agent"
                          }),
                          /* @__PURE__ */ jsx_runtime5.jsx("span", {
                            style: { fontSize: "12px", fontWeight: 500, opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                            children: item.title
                          })
                        ]
                      }),
                      item.snippet && /* @__PURE__ */ jsx_runtime5.jsx("div", {
                        style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #71717a)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%", paddingLeft: "4px" },
                        children: /* @__PURE__ */ jsx_runtime5.jsx(HighlightSearchText, {
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
        /* @__PURE__ */ jsx_runtime5.jsxs("div", {
          className: "copis-search-footer",
          children: [
            /* @__PURE__ */ jsx_runtime5.jsxs("span", {
              children: [
                "↵ ",
                isQueryDirty || !hasSearched ? "搜索" : "打开"
              ]
            }),
            /* @__PURE__ */ jsx_runtime5.jsx("span", {
              children: "↑↓ 选择"
            }),
            /* @__PURE__ */ jsx_runtime5.jsx("span", {
              children: "Esc 关闭"
            })
          ]
        })
      ]
    })
  });
}
var DEFAULT_DRAWER_WIDTH = 500;
var MIN_DRAWER_WIDTH = 360;
var MAX_DRAWER_WIDTH = 840;
function getInitialDrawerWidth() {
  if (typeof window === "undefined")
    return DEFAULT_DRAWER_WIDTH;
  try {
    const saved = localStorage.getItem("copis_creation_inspector_width");
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= MIN_DRAWER_WIDTH && parsed <= MAX_DRAWER_WIDTH) {
        return parsed;
      }
    }
  } catch {}
  return DEFAULT_DRAWER_WIDTH;
}
function CopisShellOverlayManager(props) {
  const [drawerOpen, setDrawerOpen] = import_react7.useState(false);
  const [drawerWidth, setDrawerWidth] = import_react7.useState(getInitialDrawerWidth);
  const [isResizing, setIsResizing] = import_react7.useState(false);
  const [searchOpen, setSearchOpen] = import_react7.useState(false);
  const [hasSessionHeader, setHasSessionHeader] = import_react7.useState(false);
  const [isSubviewActive, setIsSubviewActive] = import_react7.useState(() => {
    if (typeof document === "undefined")
      return false;
    return document.body?.classList.contains("copis-subview-active") || document.documentElement?.classList.contains("copis-subview-active");
  });
  import_react7.useEffect(() => {
    const handleToggle = () => setDrawerOpen((prev) => !prev);
    window.addEventListener("COPIS_TOGGLE_WORKSPACE_DRAWER", handleToggle);
    return () => window.removeEventListener("COPIS_TOGGLE_WORKSPACE_DRAWER", handleToggle);
  }, []);
  import_react7.useEffect(() => {
    if (typeof document === "undefined")
      return;
    if (drawerOpen) {
      document.body.classList.add("copis-details-drawer-open");
      document.documentElement.classList.add("copis-details-drawer-open");
      document.documentElement.style.setProperty("--copis-inspector-width", `${drawerWidth}px`);
    } else {
      document.body.classList.remove("copis-details-drawer-open");
      document.documentElement.classList.remove("copis-details-drawer-open");
    }
  }, [drawerOpen, drawerWidth]);
  const handleResizeStart = import_react7.useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
    document.body.classList.add("copis-inspector-resizing");
    const startX = e.clientX;
    const startWidth = drawerWidth;
    const onPointerMove = (moveEvent) => {
      const deltaX = startX - moveEvent.clientX;
      const maxAllowed = Math.max(MIN_DRAWER_WIDTH, window.innerWidth - 360);
      const newWidth = Math.max(MIN_DRAWER_WIDTH, Math.min(maxAllowed, startWidth + deltaX));
      setDrawerWidth(newWidth);
      document.documentElement.style.setProperty("--copis-inspector-width", `${newWidth}px`);
    };
    const onPointerUp = () => {
      setIsResizing(false);
      document.body.classList.remove("copis-inspector-resizing");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      try {
        localStorage.setItem("copis_creation_inspector_width", String(drawerWidth));
      } catch {}
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }, [drawerWidth]);
  import_react7.useEffect(() => {
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
  import_react7.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && drawerOpen) {
        e.preventDefault();
        setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [drawerOpen]);
  import_react7.useEffect(() => {
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
  return /* @__PURE__ */ jsx_runtime5.jsxs(jsx_runtime5.Fragment, {
    children: [
      !hasSessionHeader && !isSubviewActive && /* @__PURE__ */ jsx_runtime5.jsx("div", {
        className: "copis-hero-utilities-overlay",
        children: /* @__PURE__ */ jsx_runtime5.jsx(CopisHeaderUtilities, {
          ctx: props.ctx
        })
      }),
      /* @__PURE__ */ jsx_runtime5.jsxs("div", {
        className: "copis-details-drawer-root",
        "data-state": drawerOpen ? "open" : "closed",
        "aria-hidden": !drawerOpen,
        children: [
          /* @__PURE__ */ jsx_runtime5.jsx("div", {
            className: "copis-inspector-resize-handle",
            onPointerDown: handleResizeStart,
            "data-resizing": isResizing ? "true" : "false",
            title: "按住拖拽调整侧边栏宽度"
          }),
          /* @__PURE__ */ jsx_runtime5.jsx(CopisInspectorPanel, {
            ctx: props.ctx,
            closeDetails: () => setDrawerOpen(false)
          })
        ]
      }),
      searchOpen && /* @__PURE__ */ jsx_runtime5.jsx(CopisSearchModal, {
        open: searchOpen,
        onClose: () => setSearchOpen(false),
        ctx: props.ctx
      })
    ]
  });
}
var inject = ["slots", "layout", "sessions", "workspaces"];
function apply(ctx) {
  cachedCordisContext = ctx;
  console.log("[Copis Creation Web] 客户端插件正在激活...", ctx);
  installCreationStyles();
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "copis-creation-sidebar", order: -100 }, (props) => /* @__PURE__ */ jsx_runtime5.jsx(CreationSidebarNavigation, {
    ...props,
    ctx
  })));
  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities",
    id: "copis-session-header-utilities",
    order: 100
  }, (props) => /* @__PURE__ */ jsx_runtime5.jsx(CopisHeaderUtilities, {
    ...props,
    ctx
  })));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "copis-shell-overlay-manager",
    order: 100
  }, () => /* @__PURE__ */ jsx_runtime5.jsx(CopisShellOverlayManager, {
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
