# Copis 全面重命名设计

## 目标

将仓库中 Proma 的第一方产品标识统一迁移为 Copis：包作用域、源码标识符、CLI、Electron 资源、配置目录、环境变量、构建脚本和项目文档均使用 `copis`。旧用户的本地数据和已有脚本不能因为改名而直接丢失或无法读取。

## 命名契约

新的规范名称如下：

- 产品文案：`Copis`；命令、文件名和目录：`copis`
- workspace 包：`@copis/shared`、`@copis/core`、`@copis/session-core`、`@copis/ui`、`@copis/electron`、`@copis/cli`
- 环境变量：`COPIS_DEV`、`COPIS_CLI`、`COPIS_HOME`、`COPIS_WORKSPACE_DIR`、`COPIS_WORKSPACE_SLUG` 等
- 用户配置：正式环境 `~/.copis`，开发环境 `~/.copis-dev`
- Electron 品牌资源目录：`copis-logos`，资源文件前缀：`copis-`
- CLI：`copis` / `copis.exe`

外部服务 URL、Electron IPC 通道中与第三方协议绑定的字符串不因品牌改名而改变，除非它们是 Copis 自有的内部标识。这样可以避免把服务端接口域名或历史数据协议误改成不可用的地址。

## 兼容与迁移

### 本地配置目录

启动时按当前运行模式确定目标目录：

| 模式 | 新目录 | 旧目录 |
| --- | --- | --- |
| 正式 | `~/.copis` | `~/.proma` |
| 开发 | `~/.copis-dev` | `~/.proma-dev` |

若新目录不存在而旧目录存在，优先在同一文件系统内重命名；重命名失败时复制目录并保留旧目录。若新旧目录同时存在，新目录优先，旧目录不合并、不覆盖。迁移过程需要幂等，失败时保留旧目录并抛出可诊断的中文日志。

`COPIS_DEV` 优先级高于 `PROMA_DEV`。旧变量只用于兼容旧脚本，最终解析出的目录仍然是新的 `~/.copis*` 路径。CLI 的显式 `--config-dir` 继续拥有最高优先级。

### 环境变量与历史数据

新启动的子进程使用 `COPIS_*` 变量；对已有 Skill/MCP 脚本需要的旧变量，在过渡期同时注入同值别名。历史 JSONL、计划标记和事件 payload 只在读取/解析处接受旧 `PROMA_*`、`PROMA_SCHEDULED_RUN`、`proma_event` 等形式，新写入使用 Copis 形式。

### 默认 Skill

第一方默认 Skill 的品牌名和目录使用 `copis`。已有工作区中的旧 slug 在升级扫描时映射到新 slug，不删除用户已有内容；兼容映射本身可以保留旧字符串作为迁移常量。

## 实施范围

1. 替换 workspace 包 manifest、源码 import/export、类型/函数/常量名称及根脚本过滤器，并同步 lockfile。
2. 增加配置目录迁移逻辑和单元测试，更新 Electron 与 CLI 的路径解析。
3. 更新 CLI bin、编译输出、Electron builder、tray、Logo 资源和开发脚本。
4. 更新源码注释、用户可见文案、README、AGENTS 和方案文档；保留明确说明旧格式兼容的历史名称。
5. 递增所有受影响 workspace 包的 patch 版本。

## 验证标准

- `bun test` 通过，重点覆盖配置目录迁移、旧变量兼容、旧历史标记解析和 CLI 路径。
- `bun run typecheck` 通过。
- `bun run --filter='@copis/electron' build:main`、`build:preload`、`build:renderer` 通过。
- `git diff --check` 通过，且源码中除迁移/兼容说明外不再出现旧第一方品牌引用。
- 通过 Electron 手动 smoke：新建配置目录、从旧目录迁移、收藏夹读写、启动 Agent/Chat、托盘 Logo 和 CLI 路径均正常。
