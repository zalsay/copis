# Copis COS 功能模块分发设计

## 目标

Copis 的 Electron 主进程统一管理所有可独立安装的功能模块。第一批模块包括：

- `officecli`：Office 文档处理 CLI。
- `rust-http-api`：Copis 本地 Rust HTTP API 服务。

模块的版本元数据和平台二进制都存储在 COS。Skill 只描述调用方式，不参与二进制下载、安装、更新或启动；Rust API 也不自行更新。

## 范围

### 包含

- 统一 COS manifest 获取、平台架构解析、版本比较和下载校验。
- 统一模块缓存、版本目录、active 指针和失败恢复。
- Electron 启动已激活的 Rust API，并在更新时完成候选版本健康检查。
- OfficeCLI 与 Rust API 共用同一套模块存储和 IPC 状态展示。
- 生成并发布 COS manifest 和不可变二进制的发布脚本。
- focused BDD 测试、Electron 主进程构建和 Rust API 启动链路验证。

### 不包含

- 不在 Rust API 中加入自更新逻辑。
- 不让 Skill 安装或升级 OfficeCLI、Rust API 或其他二进制。
- 不把运行时模块放进 Git 子模块。
- 不引入本地数据库；模块状态继续使用 `~/.copis/modules/` 下的 JSON 和文件目录。
- 不修改 `AGENTS.md` 和 `README.md`，除非得到单独授权。

## 方案选择

### 统一 COS manifest，Electron 直接读取

这是本设计采用的方案。Copis 没有必须依赖的版本解析后端，Electron 直接读取配置的 HTTPS COS manifest，并在 manifest 的 `platforms` 中选择本机目标。OfficeCLI 和 Rust API 使用完全相同的下载、校验、缓存和激活流程。

优点是部署链路短、模块间行为一致、离线时可以继续使用已激活版本。缺点是 manifest 的平台选择和客户端版本兼容规则需要由 Electron 实现。

### 通过外部版本解析 API，再从 COS 下载

客户端先调用类似 `ai-education` 的 `/api/client/runtime-release`，由服务端返回平台对应的 manifest URL，再下载 COS 对象。该方案适合已有统一账号、灰度和客户端版本策略的产品，但会把 Copis 的模块启动依赖扩展到外部 API。

### 每个模块独立维护 manifest

OfficeCLI 和 Rust API 分别获取自己的版本信息。实现初期看似简单，但会重复网络、缓存、校验、回滚和 UI 状态逻辑，不符合统一功能模块边界，因此不采用。

## COS 发布布局

发布目录使用稳定的 channel 前缀，二进制使用带版本的不可变对象名，manifest 最后发布：

```text
copis/modules/stable/manifest.json
copis/modules/stable/darwin-arm64/officecli-1.2.3
copis/modules/stable/darwin-arm64/rust-http-api-0.2.0
copis/modules/stable/linux-x64/officecli-1.2.3
copis/modules/stable/linux-x64/rust-http-api-0.2.0
copis/modules/stable/win32-x64/officecli-1.2.3.exe
copis/modules/stable/win32-x64/rust-http-api-0.2.0.exe
```

二进制对象不可覆盖。发布时先上传所有二进制，确认上传完成后再上传 manifest；manifest 的替换采用 COS 对象的单次覆盖，客户端只读取完整 JSON。旧二进制默认保留，便于已安装版本回滚和多版本客户端兼容。

## Manifest 契约

manifest 使用与 `ai-education` runtime bundle 相同的核心字段，并允许一个 JSON 同时描述所有平台：

```json
{
  "schema": 1,
  "channel": "stable",
  "client": {
    "minVersion": "0.16.13"
  },
  "platforms": {
    "darwin-arm64": {
      "modules": {
        "officecli": {
          "version": "1.2.3",
          "url": "https://download.example.com/copis/modules/stable/darwin-arm64/officecli-1.2.3",
          "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "size": 12345678,
          "format": "binary",
          "entrypoint": "bin/officecli",
          "required": false
        },
        "rust-http-api": {
          "version": "0.2.0",
          "url": "https://download.example.com/copis/modules/stable/darwin-arm64/rust-http-api-0.2.0",
          "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          "size": 23456789,
          "format": "binary",
          "entrypoint": "bin/copis-http-api-server",
          "required": true
        }
      }
    }
  }
}
```

第一阶段的两个模块使用自包含的原始可执行文件，`format` 为 `binary`。模块存储层保留明确的 format 校验边界，未来需要多文件包时可以增加受控的 archive format，不把解压逻辑混入当前二进制安装流程。

Electron 必须校验：

- manifest 为合法 JSON，`schema` 为支持的版本。
- 当前平台架构存在，或明确没有可用模块。
- 模块名称、版本、entrypoint 和 URL 符合安全约束。
- URL 使用 HTTPS；开发测试允许 localhost HTTP。
- `sha256` 为 64 位十六进制字符串，`size` 为非负整数。
- manifest 的 `client.minVersion` 不高于当前 Copis 版本。

manifest URL 通过 `COPIS_FUNCTIONAL_MODULE_MANIFEST_URL` 配置。未配置时不发起隐式网络请求；已有 active 版本仍可读取，缺失 required 模块时返回可诊断错误。

## Electron 模块生命周期

### 存储

继续使用现有 `~/.copis/modules/`：

```text
~/.copis/modules/
├── cache/<module>/<sha256>/
│   ├── module.json
│   ├── payload/<entrypoint>
│   └── .complete
├── downloads/<sha256>.artifact
├── versions/<module>/<version>-<sha256>/
│   ├── <entrypoint>
│   ├── module-lock.json
│   └── .complete
└── active.json
```

下载使用 `<sha256>.partial` 临时文件。完成下载后先计算 SHA256，再原子提升为正式 artifact；缓存和版本目录都使用临时目录写入后 rename。`active.json` 只保存已完成版本的相对目录和 package 元数据。

### 更新流程

1. Electron 获取 manifest，并解析本机的 `darwin/linux/win32` 与 `arm64/x64`。
2. 读取当前 active 记录，比较 `version + sha256`。
3. 对有更新的模块下载到 partial 文件，校验 HTTP 状态、大小和 SHA256。
4. 写入 cache，组装独立版本目录。
5. OfficeCLI 直接原子切换 active 指针。
6. Rust API 先进入候选版本流程，健康检查通过后才切换 active 指针。
7. 发送统一进度和最终状态给 renderer；网络失败不删除当前可用版本。

同一模块同一根目录只允许一个安装操作并发执行。重复请求复用正在进行的 Promise；进程中断留下的 partial、临时目录和不完整 active 记录在下一次操作时被忽略或清理。

## Rust API 启动和回滚

`http-api-server.ts` 不再把 `resources/bin/copis-http-api-server` 作为正式默认来源，而是从 `readActiveFunctionalModule(..., 'rust-http-api')` 获取入口路径。`COPIS_HTTP_API_SERVER` 仍保留为开发和故障排查覆盖配置。

### 启动

- 已有 active Rust API 时，Electron 启动该版本。
- 没有 active 版本且 manifest 可用时，Electron 先安装 required 模块，再启动。
- manifest 不可用但已有 active 版本时，优先保证当前版本继续工作。
- required 模块既没有 active 版本、又无法下载时，Electron 保持 UI 可用，记录中文错误并通过模块状态提供重试入口。

### 更新候选

Rust API 支持通过 `COPIS_HTTP_API_PORT` 绑定端口。Electron 将新版本作为候选进程启动到临时端口，传入相同的 Pi RPC worker 和业务桥环境变量，并请求候选端口的 `GET /api/health`。候选版本必须在限定时间内返回 `ok: true`，否则立即终止候选进程，保留原 active 版本。

健康检查成功后：

1. 停止旧 Rust API。
2. 原子切换 `rust-http-api` 的 active 指针。
3. 用正式端口启动新版本。
4. 再做一次正式端口健康检查。
5. 正式启动失败时恢复旧 active 记录并重新启动旧版本。

更新过程中不覆盖正在运行的版本目录，也不删除旧版本；回滚只改变 active 指针和子进程，不重新下载旧二进制。

## Renderer 和 IPC

现有功能模块 IPC 扩展为返回 `officecli` 与 `rust-http-api` 两条记录：

- `list`：返回 installed、active version、path、required、error。
- `check`：获取 COS manifest 并返回 available version 与 updateAvailable。
- `install`：只允许 Electron 主进程执行实际安装；调用方只能传模块名和 force。
- `progress`：沿用 manifest、download、verify、install、activate、done、error 阶段。

设置页的功能模块卡片展示两个模块的状态。Rust API 标记为 required，OfficeCLI 标记为 optional；状态读取失败时显示可重试的中文错误，不暴露 COS URL、内部路径或堆栈。

## 发布工具

新增 Electron 侧发布工具，职责对应 `ai-education` 的 runtime bundle 和 COS 上传脚本：

1. 接收目标平台、架构、channel、模块版本和二进制路径。
2. 计算文件大小和 SHA256。
3. 生成统一 manifest。
4. 以不可变 key 上传二进制。
5. 上传并校验 manifest。

COS 客户端依赖在安装前先检索当前维护版本和 Electron/Bun 兼容性，不默认引入未经验证的 SDK。发布脚本不得读取或写入 Copis 用户目录，也不得把 COS secret 写入 manifest、日志或 Electron 产物。

## BDD 验收场景

```text
Given COS manifest 包含当前平台的 officecli 和 rust-http-api
When Electron 检查功能模块更新
Then 两个模块都返回可用版本，并按 version + sha256 判断更新

Given 下载返回内容与 manifest sha256 不一致
When Electron 安装模块
Then 安装失败、partial 文件被清理、旧 active 版本保持不变

Given 当前 Rust API 正在运行且 COS 有新版本
When Electron 执行 Rust API 更新
Then 新版本先在候选端口健康检查，失败时旧版本继续运行

Given 新 Rust API 候选版本健康检查通过
When Electron 完成更新
Then 旧进程停止、新版本切换到正式端口并再次通过健康检查

Given Copis 没有 active Rust API 且 COS 不可用
When Electron 启动
Then UI 仍可打开，模块状态显示可重试的中文错误，不启动构建目录中的旧隐式二进制

Given OfficeCLI 已安装旧版本
When COS 发布新版本且用户安装更新
Then 只有 active 指针切换，旧版本目录仍可用于回滚
```

## 验证

实现阶段至少执行：

```bash
bun test apps/electron/src/main/lib/functional-module-store.test.ts
bun test apps/electron/src/main/lib/functional-module-manager.test.ts
bun test apps/electron/src/main/lib/http-api-server.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
```

另外使用临时 COS fixture 或本地 HTTPS fixture 验证 manifest、二进制校验、Rust API 候选端口和正式端口回滚；最终在 Electron 实际窗口中确认 Rust API 健康检查和 OfficeCLI 状态展示。
