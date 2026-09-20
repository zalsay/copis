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
