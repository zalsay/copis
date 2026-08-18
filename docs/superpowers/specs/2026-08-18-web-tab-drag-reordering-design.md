# 网页 Tab 拖动实时交换设计

## 目标

让内嵌浏览器顶部的网页 Tab 具备 Chrome 风格的拖动排序行为：拖动 Tab 越过相邻 Tab 的中心点时，两个 Tab 立即交换视觉顺序；松开鼠标后提交最终顺序并激活被拖动的 Tab。

## 当前架构

- `WebTabBar` 在 renderer 中读取 `webTabsAtom`，通过 `window.electronAPI.webTabs` 调用主进程。
- `web-tab-manager` 按公开网页 Tab 的顺序维护主进程真实状态；工作流专用 Tab 不出现在公开快照中。
- `reorderWebTab({ tabId, targetIndex })` 已存在，`targetIndex` 是公开 Tab 数组中的最终索引，并会保存顺序、激活 Tab、广播完整快照。
- 当前拖动事件已使用文档级 `mousemove/mouseup`，避免拖动元素移动后丢失事件；拖动阈值为约 6px。

## 交互设计

### 拖动状态

renderer 在拖动期间维护临时视觉状态：

- 原始公开 Tab 顺序。
- 当前视觉顺序。
- 被拖动 Tab 的 ID、起始指针位置和当前落点。
- 当前 CSS 水平位移，用于让鼠标按下时的 Tab 内部抓取位置保持稳定。

未超过阈值时保持普通 Tab 点击行为。超过阈值后进入拖动状态，拖动 Tab 保持在鼠标下方并覆盖相邻 Tab。

### 中心点交换

每次鼠标移动都基于当前视觉顺序读取 Tab 的布局矩形，排除被拖动 Tab 后比较相邻 Tab 的中心点：

- 向右移动并越过下一个 Tab 的中心点：被拖动 Tab 与下一个 Tab 交换顺序。
- 向左移动并越过上一个 Tab 的中心点：被拖动 Tab 与上一个 Tab 交换顺序。
- 未越过中心点：视觉顺序不变。
- 一次移动跨过多个中心点时，按当前指针位置将 Tab 移到对应目标位置，避免漏交换。

视觉顺序变化只发生在 renderer 内，不在每个 `mousemove` 中调用 IPC。Tab 的布局位置变化后重新计算 CSS 位移，保证鼠标与 Tab 的抓取点连续，不出现跳跃。

### 松开与取消

- `mouseup` 时使用当前视觉顺序中被拖动 Tab 的最终索引调用现有 `webTabs.reorder` 一次。
- 即使最终索引未变化，也调用现有重排接口，以保持“拖动结束后激活该 Tab”的行为。
- 小于阈值的点击不调用重排，只执行普通激活。
- 拖动被取消或 Tab 被关闭时，清除临时视觉顺序，不提交重排。
- 关闭按钮继续阻止事件冒泡，不启动 Tab 拖动。

## 数据流

```text
pointerdown
  -> 记录原始顺序和抓取点
mousemove 超过阈值
  -> 比较相邻 Tab 中心点
  -> 更新临时视觉顺序和拖动位移
mouseup
  -> 计算最终索引
  -> webTabs.reorder 一次
  -> 应用主进程快照并激活 Tab
```

主进程仍是持久化顺序和激活状态的唯一真实来源；临时视觉顺序只在一次拖动生命周期内存在。

## 错误处理

- 无法读取 Tab 矩形或找不到拖动 Tab 时，不改变视觉顺序，保持当前拖动状态。
- `reorder` IPC 失败时记录中文错误，清除拖动状态；主进程顺序保持不变，下一次状态广播负责恢复 renderer。
- 拖动期间收到外部网页 Tab 快照时，拖动结束后以主进程快照为准，避免临时顺序污染持久化数据。

## BDD 验收场景

```text
Given 网页 Tab 顺序为 A、B、C
When 拖动 A 越过 B 的中心点
Then 视觉顺序立即变为 B、A、C，A 继续跟随鼠标

Given 网页 Tab 顺序为 B、A、C 且正在拖动 A
When A 向右越过 C 的中心点
Then 视觉顺序立即变为 B、C、A

Given 网页 Tab 顺序为 B、C、A 且正在拖动 A
When A 向左越过 C 的中心点
Then 视觉顺序立即变为 B、A、C

Given 拖动 A 越过多个 Tab 中心点
When 鼠标仍按住移动
Then A 直接移动到指针对应位置，不漏掉中间交换

Given 已完成视觉交换
When 松开鼠标
Then 只调用一次 reorder，持久化最终顺序并激活 A

Given 指针移动小于拖动阈值
When 松开当前 Tab
Then 不调用 reorder，只执行普通激活

Given 正在拖动网页 Tab
When 拖动被取消或点击关闭按钮
Then 清除临时顺序，不误关闭其他 Tab，也不提交重排

Given manager 中存在工作流专用 Tab
When 拖动公开网页 Tab
Then 工作流专用 Tab 不出现在视觉顺序和目标计算中
```

## 验证范围

- renderer：中心点交换、向左/向右回退、多中心点跨越、拖动状态和最终提交测试。
- 现有网页 Tab、主进程重排和会话恢复测试。
- `bun run typecheck`
- `bun run --filter='@copis/electron' build:main`
- `bun run --filter='@copis/electron' build:renderer`
- `git diff --check`

Electron 实际窗口中的拖动连续性、交换时机和视觉效果由用户最终确认；Agent 只执行代码、测试、构建和运行状态验证，不使用截图代替 UI 验收。

## 未包含内容

- Tab 跨窗口拖出。
- 固定 Copis 首页的拖动排序。
- 工作流专用 Tab 的公开化或手动排序。
- 修改 `AGENTS.md` 和 `README.md`；按仓库规则需要另行获得允许后同步。
