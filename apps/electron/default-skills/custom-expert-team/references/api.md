# 专家团队本地 Rust HTTP API 参考

Copis 本地 HTTP API 服务（默认地址 `http://127.0.0.1:28790`）管理专家团队的持久化存储、版本快照与工作区绑定。

---

## 1. 校验 Schema（Dry-Run）

校验团队阵容的参数完整性与有向无环图（DAG）拓扑结构，不落盘。

- **端点**：`POST /api/expert-teams/schemas/validate`
- **请求体**：
```json
{
  "name": "深度调研团队",
  "description": "全流程市场调研与审校",
  "nodes": [
    {
      "id": "researcher",
      "role": "researcher",
      "prompt": "收集资料",
      "dependsOn": [],
      "path": "notes/research.md"
    },
    {
      "id": "reviewer",
      "role": "reviewer",
      "prompt": "检验报告",
      "dependsOn": ["researcher"],
      "path": "reports/audit.md"
    }
  ]
}
```
- **成功响应（200 OK）**：
```json
{
  "valid": true,
  "nodeCount": 2,
  "edges": [
    { "from": "researcher", "to": "reviewer" }
  ]
}
```
- **失败响应（400 Bad Request）**：
```json
{
  "error": "node reviewer 的依赖 missing 不存在"
}
```

---

## 2. 发布 Schema（创建或升级团队）

向数据库写入新团队阵容或发布已有团队的新不可变版本。

- **端点**：`POST /api/expert-teams/schemas`
- **请求体**：与 validate 一致，若传入 `id` 且已存在，则新增 revision；不传 `id` 则自动生成 `schema-<timestamp>-<counter>`。
- **成功响应（201 Created）**：
```json
{
  "id": "schema-1725345678-1",
  "revision": 1,
  "schemaRevisionId": 42,
  "sha256": "3a7b...",
  "snapshot": { ... },
  "createdAt": 1725345678000
}
```

---

## 3. 列出与查询 Schema

- **列出所有团队**：`GET /api/expert-teams/schemas`
  - 返回：`{ "schemas": [ ... ] }`
- **获取指定团队详情及所有版本**：`GET /api/expert-teams/schemas/:schemaId`
  - 返回：`{ "id": "...", "name": "...", "revisions": [ ... ] }`

---

## 4. 删除自定义 Schema

删除用户/Agent 自定义的团队 Schema 及其历史版本。

- **端点**：`DELETE /api/expert-teams/schemas/:schemaId`
- **规则**：
  - 内置团队（`ai-education-research-writer-reviewer`）禁止删除（返回 400）。
  - 若存在 `queued` 或 `running` 状态的任务，拒绝删除（返回 409 Conflict）。
- **成功响应（200 OK）**：
```json
{
  "deleted": true,
  "schemaId": "custom-team-id"
}
```

---

## 5. 工作区绑定与解绑

- **绑定团队到工作区**：
  - `POST /api/expert-teams/workspaces/:workspaceSlug/binding`
  - 请求体：`{ "schemaId": "custom-team-id", "schemaRevision": 1 }`（`schemaRevision` 可选，缺省使用最新版本）。
- **查询工作区当前绑定**：
  - `GET /api/expert-teams/workspaces/:workspaceSlug/binding`
- **解除工作区绑定**：
  - `DELETE /api/expert-teams/workspaces/:workspaceSlug/binding`
  - 成功响应：`{ "unbound": true, "workspaceSlug": "..." }`
