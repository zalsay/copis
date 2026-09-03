# 专家团队典型阵容模板

以下是经过验证的专家团队拓扑结构与岗位分工示例，供快速搭建与参考。

---

## 模板 1：软件研发与代码审查团队（4 节点流水线）

适用于针对复杂功能进行需求架构分析、编码实现、单元测试与代码审查。

```json
{
  "name": "软件研发与代码审查团队",
  "description": "架构设计 -> 代码实现 -> 单元测试编写 -> 综合代码审查",
  "nodes": [
    {
      "id": "architect",
      "role": "researcher",
      "prompt": "分析用户目标与现有项目代码库架构，输出模块设计方案、接口契约与文件修改规划清单。",
      "dependsOn": [],
      "path": "docs/architecture-design.md"
    },
    {
      "id": "developer",
      "role": "implement",
      "prompt": "严格根据 docs/architecture-design.md 编写高质量业务逻辑代码，保持类型安全与清晰注释。",
      "dependsOn": ["architect"],
      "path": "docs/implementation-notes.md"
    },
    {
      "id": "tester",
      "role": "executor",
      "prompt": "阅读 docs/implementation-notes.md，为实现的代码编写覆盖核心用例与边界异常的自动化单元测试，并验证测试运行结果。",
      "dependsOn": ["developer"],
      "path": "docs/test-results.md"
    },
    {
      "id": "reviewer",
      "role": "reviewer",
      "prompt": "综合审查架构方案、实现代码与测试报告，检查代码规范、边界安全隐患及文档完整性，输出终审决议。",
      "dependsOn": ["developer", "tester"],
      "path": "docs/code-review.md"
    }
  ]
}
```

---

## 模板 2：全流程内容创作与事实核查团队（3 节点）

适用于撰写技术博文、行业深度报告、用户指南等。

```json
{
  "name": "深度文案创作团队",
  "description": "资料搜集与大纲 -> 正文撰写 -> 事实核查与排版润色",
  "nodes": [
    {
      "id": "researcher",
      "role": "researcher",
      "prompt": "搜集关于任务主题的背景知识、行业案例和关键数据，整理为结构化的资料速查清单与写作大纲。",
      "dependsOn": [],
      "path": "notes/research-outline.md"
    },
    {
      "id": "writer",
      "role": "writer",
      "prompt": "依据 notes/research-outline.md 撰写全文初稿，要求逻辑紧凑、重点突出，段落层级分明。",
      "dependsOn": ["researcher"],
      "path": "drafts/article-draft.md"
    },
    {
      "id": "reviewer",
      "role": "reviewer",
      "prompt": "审阅 drafts/article-draft.md，校验事实数据的准确性与语句流畅度，输出润色修改后的定稿及说明。",
      "dependsOn": ["writer"],
      "path": "drafts/final-article.md"
    }
  ]
}
```

---

## 模板 3：商业竞品与市场调研团队（3 节点）

适用于竞品对标分析与市场洞察。

```json
{
  "name": "商业竞品调研团队",
  "description": "多维数据搜集 -> 竞品对比矩阵 -> 商业决策洞察",
  "nodes": [
    {
      "id": "data-gatherer",
      "role": "researcher",
      "prompt": "检索核心竞品的产品功能、定价模式、市场定位和用户评价，整理原始调研信息。",
      "dependsOn": [],
      "path": "research/raw-market-data.md"
    },
    {
      "id": "matrix-analyst",
      "role": "writer",
      "prompt": "阅读 research/raw-market-data.md，构建横向对比矩阵表（包含优势、劣势、价格、核心壁垒）。",
      "dependsOn": ["data-gatherer"],
      "path": "analysis/competitor-matrix.md"
    },
    {
      "id": "strategist",
      "role": "reviewer",
      "prompt": "基于对比矩阵，提炼市场机会点与潜在风险，输出针对本次任务的可执行战略建议。",
      "dependsOn": ["matrix-analyst"],
      "path": "analysis/strategic-recommendation.md"
    }
  ]
}
```
