---
name: custom-expert-team
displayName: 自定义专家团队
description: 当用户提出创建、自定义、配置、修改、设计或管理专家团队（Expert Team / Agent Team / 专家阵容 / 多 Agent 协同流水线）时使用本技能。指导如何根据业务目标设计专业角色分工、任务描述、交付物路径与 DAG 依赖拓扑，并通过 Copis 专家团队内置工具及 Rust HTTP API 校验、发布自定义团队阵容，绑定到工作区并进行验证调度。
group: 系统内置
version: "1.0.0"
license: AGPL-3.0-only
---

# 自定义专家团队（Custom Expert Team）

Copis 专家团队（Expert Team）支持由多个专业角色（如调研员、架构师、撰写师、审校师、测试员等）组成具有明确拓扑依赖（DAG）的协同流水线，由主 Agent（主理人）负责理解用户目标并调度内部团队，各成员依次完成任务并交付结构化文件产物。

本技能指导你在与用户对话中，如何协助用户从 0 到 1 组建、校验、发布、绑定并运行专属自定义专家团队。

---

## 触发场景

当用户意图包含以下场景时立即使用本技能：
- “帮我建一个专家团队 / Agent 团队 / 专属团队”
- “我想自定义一个多 Agent 协同流水线”
- “组建一个代码审查、市场调研、文案撰写或方案设计的团队”
- “配置专家团队的岗位、依赖顺序或输出文件”
- “修改或管理当前工作区的专家团队阵容”

---

## 核心设计规范

每个专家团队阵容（Schema）在 Copis 中具有不可篡改的版本快照与 SHA-256 签名，设计时必须遵循以下规范：

### 1. 节点属性要求
- **`id`**：英文字母、数字、下划线或短横线（如 `researcher`、`code-reviewer`、`writer`）。同一团队内唯一，1~32 个字符。
- **`role`**：专业岗位角色，支持 `researcher`、`writer`、`reviewer`、`executor`、`explore`、`research`、`implement`、`review`、`custom`。
- **`prompt`**：该节点的专项服务职责提示词。要求清晰说明**该角色负责做什么、基于前序哪些产物、交付质量要求与限制**。
- **`dependsOn`**：依赖的前置节点 ID 列表（数组）。前置节点成功交付后，后续节点才会执行，且前置节点的输出文档将自动注入为后序节点的上下文资料。
- **`path`**：相对工作区路径的 Markdown/文本输出文件（如 `research/materials.md`、`review/audit-report.md`）。禁止使用绝对路径、反斜杠或包含 `..`。
- **数量限制**：全队节点数量在 1 到 32 个之间。

### 2. 拓扑与 DAG 规则
- 节点依赖必须构成**有向无环图（DAG）**，严禁循环依赖（例如 A 依赖 B，B 依赖 A）。
- 必须有至少一个无依赖的根节点（输入源），后续节点以此为基础推进。

---

## 交互与创建工作流（五步法）

### Step 1 · 场景拆解与需求对齐
开场先向用户了解本次专家团队的服务目标与预期交付物。
- **一次只问一个关键问题**，其余采用合理默认。不要一次抛出多个复杂问题压垮用户。
- 引导用户明确：需要几个环节？核心产物是什么？

### Step 2 · 规划节点与 DAG 拓扑
根据用户需求梳理出节点清单。例如构建一个“全流程内容创作团队”：
1. `researcher`（资料调研员）：搜集竞品与事实资料，输出 `notes/research.md`。
2. `writer`（主笔撰稿师）：依赖 `researcher`，根据调研资料撰写全文，输出 `drafts/article.md`。
3. `reviewer`（事实核查与质量审校师）：依赖 `writer`，检查准确性与语句润色，输出 `reviews/audit.md`。

### Step 3 · 发布 Schema（写入 Rust 存储）
通过 Copis 提供的内置工具 `expert_team_publish_schema` 直接创建并发布团队（该操作会自动向 Rust 本地数据库提交不可变快照，并向前端工作台广播热更新事件）：

```json
{
  "name": "全流程内容创作团队",
  "description": "资料搜集、文章草拟与审校校验三阶段闭环创作",
  "nodes": [
    {
      "id": "researcher",
      "role": "researcher",
      "prompt": "搜集任务主题相关的权威参考资料和核心论点，整理为 Markdown 报告。",
      "dependsOn": [],
      "path": "notes/research.md"
    },
    {
      "id": "writer",
      "role": "writer",
      "prompt": "阅读 notes/research.md，撰写结构严谨、生动流畅的初稿。",
      "dependsOn": ["researcher"],
      "path": "drafts/article.md"
    },
    {
      "id": "reviewer",
      "role": "reviewer",
      "prompt": "检验 drafts/article.md 是否准确、论据是否充分，输出修改意见与最终审校稿。",
      "dependsOn": ["writer"],
      "path": "reviews/audit.md"
    }
  ],
  "bindToCurrentWorkspace": true
}
```

*注：若用户处于非 Agent Tool 环境，也可通过 curl 直接调用本地 API（详见 [references/api.md](references/api.md)）。*

### Step 4 · 确认绑定与 AGENTS.md 生效
- 发布并绑定后，主进程会自动在当前工作区的 `AGENTS.md` 中生成或更新受管控区块（`<!-- copis-expert-team:start --> ... <!-- copis-expert-team:end -->`）。
- 前端“专家团队工作台”会通过 IPC 自动感知并直接热更新，呈现新团队阵容与节点关系。

### Step 5 · 试运行与交付整合
- 询问用户是否立即启动一次试运行任务。
- 调用 `expert_team_run` 启动团队。
- 团队各节点依次完成后，主理人必须阅读各成员的交付文档，提取关键结论与产物链接，向用户进行统一汇报与交付。

---

## 更多参考
- 本地 REST API 接口与命令行调用示例见 [references/api.md](references/api.md)。
- 预置经典行业团队模板参考见 [references/templates.md](references/templates.md)。
