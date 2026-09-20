# Task 6：Read-Only Skill Snapshot

## RED / GREEN

- RED：先加入 Skill 快照隔离测试并运行
  bun test apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts，因
  chatroom-skill-snapshot 模块尚不存在而失败。
- GREEN：实现安全遍历、启用 Skill 复制、确定性摘要、只读权限、原子替换、
  回滚和 room 配置摘要持久化后，快照聚焦测试通过。

## 实现

- 新增 chatroom-skill-snapshot.ts：
  - 只读取来源工作区当前启用 Skill；
  - 目录链路、Skill slug、源树和快照树使用 lstat 校验，拒绝符号链接、
    非普通文件、硬链接和越界路径；
  - 使用受控文件描述符读取源文件，限制文件数、单文件大小和总字节数；
  - 摘要覆盖稳定化相对路径、目录/文件类型、空目录和文件内容；
  - 复制到唯一 .next-{uuid}，完成校验和权限设置后通过 .previous 原子替换；
  - 第二次 rename 或 room 配置写入失败时恢复旧快照；临时清理不跟随符号链接；
  - 快照目录/文件分别强制设置为 0500/0400，显式同步清理旧树时仅对受控树临时
    恢复 owner write；Windows 不跳过 chmod，资源加载/Agent 文件工具仍以该快照
    为只读边界。
- ChatRoomWorkspaceStore.updateAgentSkillSnapshot() 仅在受控快照目录存在后把
  digest 写入 room.json，不持久化绝对路径；共享关闭只改变配置，不删除已有快照。
  - 新增测试覆盖启用/禁用隔离、符号链接、源变更后快照不变、稳定 digest、重复同步、
    swap 后清理、配置持久化失败回滚、源 root 和 snapshot parent symlink。

## Fix Round 1：RED / GREEN

- RED：独立 review 指出 journal 只按配置摘要判断会误处理 `prepared`、`next_moved`
  和首次同步的空占位目录；源/目标父目录只有单点检查；只读枚举可能静默遗漏
  symlink；digest 排序和 frontmatter 扫描链路也有副作用风险。
- GREEN：加入严格校验的原子 `.snapshot-journal.json`，按
  `prepared/current_moved/next_moved/config_persisted/cleanup` 恢复；以配置摘要
  判定提交或回滚，并把首次同步预创建的空目录视为未提交状态。同步开始和 Agent
  使用快照前均可调用恢复入口。目录链路持续比较 dev/ino，叶文件使用 O_NOFOLLOW、
  inode/nlink/size 校验；目标写入前后同样验证目录链路。启用 Skill 改为无自愈、无
  路径日志的只读枚举，异常或 symlink 条目交由复制阶段 fail closed；digest 使用
  code-unit 稳定排序。

## 验证

- bun test apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts：8 pass。
- Fix Round 1 后 bun test apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts：18 pass。
- bun test apps/electron/src/main/lib/agent-workspace-manager.test.ts：33 pass，1 个
  既有失败（MCP 保留名测试仍收到 `copis_image`，与本任务 Skill 改动无关）。新增
  只读枚举回归通过。
- bun test apps/electron/src/main/lib/chatroom-workspace-store.test.ts：21 pass。
- bun test apps/electron/src/main/lib/config-paths.test.ts：6 pass。
- bun test apps/electron/src/main/lib/agent-rpc-runtime-context.test.ts：5 pass。
- bun test apps/electron/src/main/lib/agent-rpc-service.test.ts：34 pass。
- bun run --filter='@copis/electron' typecheck：pass。
- bun run --filter='@copis/electron' build:main：pass。
- git diff --check：pass。

## Rulings / 残余风险

- getWorkspaceSkills() 仍由现有工作区管理器负责 frontmatter 自愈；快照同步使用
  `getWorkspaceSkillsReadOnly()`，不全量扫描无关 Skill、不自愈且不输出绝对路径。
  返回的 symlink、特殊文件或 malformed 条目由复制阶段 fail closed。
- 配置持久化失败采用回滚快照并保留旧 digest，避免 room.json 与实际 snapshot 不一致。
- POSIX 权限已由测试验证；Windows 仍需真实 Windows 环境验证 chmod 的最终语义，
  但实现不再跳过 chmod，并将快照资源加载/Agent 文件工具作为第二道只读边界。
- 竞态期间若临时路径被外部替换成不安全类型，清理会停止并保留残留目录，避免递归
  跟随删除；下一次显式同步可在受控路径下继续恢复。

- 故障种子覆盖 journal 的 prepared、current_moved、next_moved（含首次同步无
  previous）和 config_persisted 提交保留路径；journal 写入失败或配置失败时保留
  可恢复状态而不静默删除旧快照。

## Fix Round 2：RED / GREEN

- RED：复审继续指出 journal phase 可能落后于文件系统操作、首次同步空占位目录会
  被误当作 committed previous，跨进程同步/恢复缺少 per-room-agent ownership，且
  文件、目录和 room.json 缺少完整的 fsync 持久化证据；Windows 不能只依赖 chmod。
  新增 phase 落后种子、活动/ownerless/dead lock、持久化后抛错和 source/target
  parent ABA 测试后，先观察到相应失败，再实现修复。
- GREEN：同步和恢复现在都在 O_EXCL/owner token/pid/inode 锁内执行，活动 owner 不
  窃取，ownerless/dead owner 仅在 inode 与 owner 再校验后回收，释放只接受自己的
  token/inode。journal 只在 prepared marker 原子落盘一次，之后以重新读取的
  config digest、current/previous/next 实际摘要做恢复判定，避免 Windows journal
  覆盖窗口；覆盖 marker 写入、两次 rename、room.json durable persist、cleanup
  之间的 phase 落后状态。首次同步的受控空占位目录不作为 previous。
- GREEN：源文件采用 fd 循环读取并在读取前后比较 dev/ino/nlink/size/mtime，目标文件
  采用 O_CREAT|O_EXCL|O_NOFOLLOW、循环写入、文件 fsync、fstat 与最终 lstat 比较；
  每级父目录持续比较 dev/ino/realpath containment。目录、journal、parent 和
  room.json 临时文件均执行可判定的 durable flush；room.json digest 只在成功 swap
  后通过 durable atomic persist 写入。
- GREEN：Windows 使用参数数组调用 `icacls` 设置 snapshot 树 ACL（不以 chmod 代替），
  使用带 `FILE_FLAG_BACKUP_SEMANTICS` 的 PowerShell `FlushFileBuffers` 适配器持久化
  目录；reparse 路径拒绝，ACL/flush 失败 fail closed。POSIX 仍验证目录 0500、文件
  0400，同步清理只在持锁阶段暂时恢复 owner write。

## Fix Round 2 验证

- bun test apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts：26 pass。
- bun test apps/electron/src/main/lib/chatroom-workspace-store.test.ts：22 pass。
- bun test apps/electron/src/main/lib/config-paths.test.ts：6 pass。
- bun test apps/electron/src/main/lib/chatroom-hidden-session-store.test.ts：13 pass。
- bun test apps/electron/src/main/lib/agent-rpc-runtime-context.test.ts：5 pass。
- bun test apps/electron/src/main/lib/agent-rpc-service.test.ts：34 pass。
- bun test apps/electron/src/main/lib/agent-workspace-manager.test.ts：33 pass，1 个
  既有失败（MCP 保留名测试期望 `['github']`，实际仍包含内置 `copis_image`，与
  Skill snapshot 改动无关）。
- bun run --filter='@copis/electron' typecheck：pass。
- bun run --filter='@copis/electron' build:main：pass。
- bun run --filter='@copis/electron' build:renderer：pass（仅既有 Vite chunk/browserslist
  warning）。
- git diff --check：pass。

## Fix Round 2 Rulings / 残余风险

- journal 不依赖落后于 FS 的 phase 字段；物理操作后、phase 写入前的崩溃由 config
  digest 与实际树摘要共同决定 commit/rollback。损坏 journal、异常树类型、ACL 或
  durable flush 失败均 fail closed 并保留可恢复残留。
- Node/Electron 当前没有 openat/handle-relative 全链路 API；dev/ino、父链、realpath
  containment、O_NOFOLLOW、nlink 和锁已最大化检测并缩小同 UID 恶意 ABA 窗口，但无法
  宣称等价于内核级 openat 事务。真实 Windows ACL、reparse、目录 flush 仍需 Windows
  runner 进行最终验证；本机验证的是安全命令参数、失败即拒绝和跨平台代码路径。
- Windows snapshot ACL 是文件工具/资源加载边界的第一层；运行时仍必须禁止 Agent
  将 snapshot 作为写入根。由于持久化同步需要父目录创建锁和临时树，父目录级 ACL
  的真实继承行为需要 Windows runner 复核，不把 POSIX mode 当作 Windows ACL 保证。

## Fix Round 3：RED / GREEN

- RED：控制端独立运行时发现首次同步偶发在目标文件写入后抛出“Skill 快照目标目录
  发生变化”。根因是 `copyRecords` 把新文件 open 后的 `opened.mtimeMs` 当作不变量，
  但正常写入本身会更新 mtime；因此在第一个 `fstat` 时被误判为目标竞态。先保留
  目标父目录替换测试，再加入 256 KiB 分块写入场景验证该类回归。
- GREEN：目标文件现在只把 open 后的 dev/ino 作为身份基线，写入并 fsync 后以最终
  `fstat` 的 size/dev/ino/nlink/mtime 作为提交前快照，close 后的 lstat 必须匹配该
  最终状态；不再比较写前 mtime。固定 64 KiB 写块使大文件路径实际覆盖多次 write，
  同时保留父目录身份、O_NOFOLLOW、nlink 和最终路径检查。

## Fix Round 3 验证

- `bun test apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts -t 'Given next 已成为 current'`：1 pass。
- `bun test apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts -t 'Given update 已写入 room.json'`：1 pass。
- snapshot 独立 Bun 进程连续 10 次：每次 27 pass / 0 fail。
- runtime context：5 pass；RPC：34 pass（更正此前误写的 runtime context 计数）。

## Fix Round 4：RED / GREEN

- RED：复审复现四类重要问题：锁在 hardlink 成功但父目录 flush 失败后可能残留；写入循环未统一拒绝非正数返回；同步只锚定 sourceRoot、且 target next 创建前缺少完整父链复核；durable room 配置仍使用固定 `.tmp`/直接 `copyFileSync(.bak)`。Windows 路径还会为每个 Skill 文件/目录启动 `icacls` 与 PowerShell。
- GREEN：锁创建记录 canonical 已创建状态，父 flush 失败时按 dev/ino/token 复核后清理，替换锁不会被删除，清理失败明确标记仍可能持锁。新增 `durable-fs.writeAllSync()`，锁元数据、目标文件、journal 与 durable 配置均复用并拒绝 `count <= 0`。Skill 同步捕获 configDir→sourceRoot 与 roomsRoot→agent parent 的完整 dev/ino 链（Windows 同步 realpath），在枚举、读取、next mkdir、复制、rename、配置写入前后持续复核；next mkdir 校验新目录 identity。durable 配置改用同父目录唯一 O_EXCL/O_NOFOLLOW 临时文件和唯一备份临时文件，不截断固定 `.tmp`、不直接复制写固定 `.bak`，并按拥有者 inode 受控清理随机残留。
- GREEN：Windows ACL 改为基于 `WindowsIdentity` SID 的单次递归 `icacls /T`，目录树 flush 改为单个递归 PowerShell 进程；POSIX 保持逐级 chmod/fsync。新增平台命令构造测试与固定 `.tmp/.bak` 普通文件/符号链接回归测试。

## Fix Round 4 验证

- `bun test apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts`：31 pass。
- `bun test apps/electron/src/main/lib/safe-file.test.ts`：3 pass。
- `bun test apps/electron/src/main/lib/durable-fs.test.ts`：3 pass。
- `bun test apps/electron/src/main/lib/chatroom-workspace-store.test.ts`：22 pass。
- `bun test apps/electron/src/main/lib/agent-rpc-runtime-context.test.ts`：5 pass。
- `bun test apps/electron/src/main/lib/agent-rpc-service.test.ts`：34 pass。
- `bun run --filter='@copis/electron' typecheck`：pass。
- `bun run --filter='@copis/electron' build:main`：pass。
- `bun run --filter='@copis/electron' build:renderer`：pass（仅既有 Vite chunk/browserslist warning）。
- `git diff --check`：pass。

## Fix Round 4 Rulings / 残余风险

- Node/Electron 没有 openat/handle-relative 的全链路 API；本轮补齐完整父链 dev/ino 与 Windows realpath 复核并覆盖可观察替换窗口，但同一 UID 的纳秒级 ABA 仍非内核事务，不能声称等价 openat。真实 Windows ACL、reparse、目录 flush 与 rename replace 语义仍需 Windows runner 验证。
- Windows 每次快照事务的 ACL 与目录树 flush 已批处理为少量子进程；单个文件仍使用 fd fsync。POSIX 仍按树节点执行权限/目录持久化操作。

## Fix Round 5：RED / GREEN

- RED：新增回归测试后，`safe-file.test.ts` 复现固定 `room.json.bak` 普通文件和符号链接
  会被 durable writer 替换（3 pass / 2 fail）；Skill 快照新增 workspace 根为外部符号链接的
  场景复现 anchor 校验前在外部目录创建 `.agents/skills`（0 pass / 1 fail）。
- GREEN：durable writer 现在仅在固定 `.bak` 不存在时通过 hard link 安装备份；若目标已存在或
  在检查后出现，则保留随机唯一备份并绝不替换固定路径，既有固定文件、符号链接及其外部目标
  内容保持不变。只读 Skill 枚举新增 `resolveWorkspaceSkillsDir()` 纯路径 helper，snapshot
  先校验 `configDir → agent-workspaces → workspace → .agents → skills` 完整 parent anchor 链，
  再调用不创建目录的枚举，外部 workspace 符号链接直接 fail closed。

## Fix Round 5 验证

- `bun test apps/electron/src/main/lib/safe-file.test.ts`：5 pass。
- `bun test apps/electron/src/main/lib/chatroom-skill-snapshot.test.ts`：32 pass。
