---
name: dsh-web-evolution
displayName: DSH Web 自进化与扩展
description: 用于在 Copis 创造模式（DSH Web / Cordis）下开发自定义插件、扩展 Web 界面、注册插槽（Slot）并利用 HMR 热重载实时生效。当用户要求自定义创造模式界面、添加快捷功能、扩展右侧详情面板、注入全局浮层或自迭代工作台时使用。
group: 系统内置
category: Copis 功能
version: "1.0.0"
---

# DSH Web 自进化与 Cordis 插件开发指南

本技能为 Agent 在 **Copis 创造模式**（基于 DeepSeek Harness / Cordis 微内核架构）下进行**自我迭代、Web 界面自定义与热重载更新**提供完整的技术指引。

---

## 一、核心架构与自进化原则

1. **Cordis 微内核与 Client Module 架构**：
   - DSH Web 客户端不是单体静态应用，而是基于 **Cordis 微内核**通过客户端模块图（`dsh-client-modules`）动态组合而成；
   - 界面整体由三栏布局（`AppFrame`：左侧 `sidebar`、中间 `conversation`、右侧 `details`）与浮层 `shell.overlay` 构成；
   - 业务逻辑与 UI 界面均以**树外插件（Out-of-tree Plugin）**的形式注入到各层级插槽（Slots）中。

2. **自进化与安全边界（严禁触碰）**：
   - **绝对不要直接修改已安装的官方包**（如 `node_modules/@deepseek-ai/*`）；
   - 所有 Agent 自定义的扩展，必须作为**独立的本地插件包**编写，存放在：
     - 当前工作区（如 `<workspace>/plugins/<plugin-name>`）；或
     - 用户 DSH Profile 目录（`$DSH_HOME/profiles/copis/plugins/<plugin-name>`）；
   - 通过 Profile 的 `cordis.patch.yml` 或 `package.json` 引用，利用 `patchReload: 'live'` 和 `dsh-client-hmr` 原地热重载生效。

---

## 二、DSH Web 核心可扩展插槽（Slot）目录

在客户端插件的 `apply(ctx)` 中，通过 `ctx.slots.inject(...)` 挂载组件：

| 插槽名称 (Slot ID) | 位置与展示形态 | 典型应用场景 |
| :--- | :--- | :--- |
| **`details`** | 右侧可缩放详情栏（默认折叠，激活时展开） | 自定义工具执行详情、数据图表看板、辅助文件视图、对比 Diff |
| **`conversation.composer.dock`** | 中间输入框底部的常驻停靠区 | 快捷控制按钮、系统状态指示器、电量/网络监测、微型指令面板 |
| **`conversation.chat.turnTail`** | 每轮对话末尾消息与其动作页脚之间 | 产出物文件行、自定义评级与反馈、代码分析胶囊 |
| **`shell.overlay`** | 覆盖整个视口的全局浮层容器 | 弹出式向导、悬浮快捷看板、全局通知提示、全屏编辑器 |
| **`sidebar.brand.name`** | 左侧栏顶部的品牌名称区域 | 自定义副标题、环境状态标识、模式副标签 |
| **`sidebar.settings`** | 左侧栏底部固定的设置席位 | 扩展设置入口、自定义面板切换触发项 |

---

## 三、标准客户端插件工程规范

一个标准的 DSH 客户端插件具有如下目录结构：

```
my-dsh-extension/
├── package.json         # 必须包含 dsh.client 元数据
├── tsconfig.json        # TypeScript 配置
├── build.mjs            # 快速打包编译脚本 (输出 lib/client.js)
└── src/
    ├── client.tsx       # 插件入口与 UI 组件
    └── style.module.css # 模块化样式 (可选)
```

### 1. `package.json` 声明规范
必须声明 `dsh.client` 与导出 `./client`：
```json
{
  "name": "@copis-ext/my-dsh-extension",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "react": "^18.2.0"
  }
}
```

### 2. 插件入口 `src/client.tsx`
插件入口需导出 `apply(ctx)` 函数：
```tsx
import React, { useState } from 'react'

export function apply(ctx: any) {
  // 示例：在输入框底部注入自定义工具栏控制
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'my-custom-dock-item',
      order: 10,
    }, MyDockComponent)
  )

  // 示例：在右侧详情栏注入信息面板
  ctx.slots.inject('details', () =>
    ctx.slots.register({
      name: 'details',
      id: 'my-details-panel',
    }, MyDetailsPanel)
  )
}

function MyDockComponent() {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '2px 8px',
      fontSize: '12px',
      borderRadius: '6px',
      backgroundColor: 'var(--creation-ui-primary-background, rgb(108 0 204 / 15%))',
      color: 'var(--creation-ui-primary, #6C00CC)',
    }}>
      <span>⚡ 创造模式扩展已就绪</span>
    </div>
  )
}

function MyDetailsPanel() {
  return (
    <div style={{ padding: '16px', color: 'var(--dsw-alias-label-primary, inherit)' }}>
      <h3>自定义分析面板</h3>
      <p>这是 Agent 自主扩展的面板内容。</p>
    </div>
  )
}
```

---

## 四、主题与色彩规范

在自定义组件中，应严格使用系统 CSS 变量，确保明暗主题自适应：
- `--creation-ui-primary`：创造模式专属强调色（浅色 `#6C00CC`，深色 `#a855f7`）；
- `--creation-ui-primary-background`：创造模式强调背景色；
- `--ui-primary`：常规强调橙金色（`#f09a43`）；
- `--dsw-alias-label-primary`：DSH 前景主文字色；
- `--dsw-alias-interactive-bg-hover`：悬浮互动背景色。

---

## 五、编译与热重载（HMR）工作流

### 1. 构建输出 `lib/client.js`
使用内置模板中的 `build.mjs`（基于 `bun build` 或 `esbuild`）：
```bash
bun run build.mjs
# 或 node build.mjs
```
构建脚本将源码打包为单一的 IIFE / CJS Bundle 输出至 `lib/client.js`。

### 2. 注册到 Profile 与热重载
将插件注册到 Profile 的 `cordis.patch.yml` 中：
```yaml
- insert:
    - id: my-custom-extension
      name: '/绝对路径/或相对包名/my-dsh-extension'
```
由于 Copis Profile 启用了 `patchReload: live`：
1. 保存 `cordis.patch.yml` 或触碰时间戳；
2. DSH 内部的 `dsh-client-hmr` 检测到插件 bundle 更新，通过 `/plugins/events` SSE 广播重载；
3. 浏览器窗口在**无需整页刷新**的情况下，自动原地卸载旧组件并挂载新组件！
