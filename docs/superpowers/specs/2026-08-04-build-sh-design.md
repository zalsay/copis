# Copis build.sh 设计

## 目标

在仓库根目录提供 `build.sh`，从任意当前工作目录启动后，构建当前机器架构的 Copis macOS `.dmg` 安装包。

## 当前事实

- 根 `package.json` 的 `@copis/electron` workspace 已提供 Electron 构建入口。
- `apps/electron/package.json` 的 `build` 会完成主进程、Preload、RPC worker、渲染进程、CLI、原生组件和资源构建。
- `sync:runtime-deps` 会把打包所需的 external 运行时依赖同步到 Electron 应用目录。
- `apps/electron/electron-builder.yml` 已将 `productName` 配置为 `Copis`，并定义 macOS DMG 输出。
- 现有 `dist:fast` 是简化的自定义流程，不作为新脚本的唯一构建入口。

## 实现方案

新增根目录 `build.sh`：

1. 使用脚本自身路径解析仓库根目录，因此不依赖调用者当前所在目录。
2. 初始化 Bun 默认安装路径并检查 `bun` 是否可执行。
3. 进入 `apps/electron`，依次执行 `bun run build` 和 `bun run sync:runtime-deps`。
4. 使用 `bunx electron-builder --mac --config.mac.target=dmg` 构建当前机器架构的 DMG。
5. `CSC_IDENTITY_AUTO_DISCOVERY` 默认设为 `false`，保留调用者显式传入的值，以便本地无签名构建和正式签名构建共用脚本。
6. 使用 `set -euo pipefail`，任一步失败立即返回非零状态。

## 验证

- 使用 `bash -n build.sh` 验证 shell 语法。
- 使用 `git diff --check` 验证新增文件无空白错误。
- 在依赖和 macOS 打包环境可用时执行 `./build.sh`，确认 Electron Builder 成功生成 `apps/electron/out` 下的 Copis DMG。

## 范围

- 创建：根目录 `build.sh`。
- 不修改：现有源码、依赖、`README.md` 和 `AGENTS.md`。
