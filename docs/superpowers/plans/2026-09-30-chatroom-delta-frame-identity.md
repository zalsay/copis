# Chatroom Delta Frame Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Each task has a fresh Luna Worker, scoped review and root verification. No commits in this run.

**Goal:** 对新协商客户端按稳定源端 frameId 去重 delta，legacy wire 不变且不丢合法重复文本。

**Architecture:** E 在已授权 delta 广播时生成一次公开 ID，按 Hub recipient selected capability 选择新/旧 payload；Native 协商与校验后保留 ID到SSE；Renderer 用当前账号/房间/调用的有界集合去重并在边界暂停预览，最终回复不受影响。

**Tech Stack:** Existing Go/Gin/Hub + crypto/rand；Rust websocket/gateway；TypeScript/Jotai/Bun，不安装新依赖。

**Spec:** `docs/superpowers/specs/2026-09-30-chatroom-delta-frame-identity-design.md`

## Global Constraints

- 能力精确名称：`agent-delta-frame-id-v1`；frameId 为 32 位小写十六进制。
- 默认新能力关闭，不编辑实际 `.env`/flags，不提交、推送、合并或部署；不改 README/AGENTS。
- 只控制接收格式，不授予 ready/ACK/SDK/设备/权限；默认最多3Agent、depth0/1/2执行、depth3保留回复、同trace同Agent最多一次、离线不排队。
- 只沿现有授权成功的 delta 广播生成 ID；每次广播一次，新 recipients相同 ID，legacy payload精确不变。
- private user/device/executor/requestACK/上下文/路径/摘要不进入帧；不按内容去重。
- C `/Volumes/RC500/codex-home/worktrees/chatrooms-merge-preflight/copis`，E `/Volumes/RC500/dev/ai-education/.worktrees/chatrooms-v2/backend/modules/edu-api`；所有 exec 明确workdir。
- 用户已选择按任务Luna实现、root review；controller仅spec/plan/ledger/review/testcapture，不写production；保留所有前序未提交diff。
- 全部测试隔离，PG仅独立32768容器/唯一schema，Bun逐file+trapattempts0，无真实用户Native/Memory/COS/模型；UI用户真实窗口确认。
- 本补充由父 repair ledger 跟踪Task6c1/6c2/6c3，sourcebaseline6b1；不新建互不关联的完成记录。

### Task 1: E 源端 ID 与按接收者兼容投影（父Task6c1）

**Files:** `handlers/chatroom_v2_readiness.go` / tests；`handlers/chatroom_v2_ws.go` / tests；`handlers/chatroom_v2_hub.go` / tests；`handlers/chatroom_v2_wire.go` / tests；可新建单职责 `handlers/chatroom_v2_delta_frame.go` / test。

**Consumes:** 既有 connection `negotiated`、`subscribe()` snapshot 回显、`ChatRoomV2Client` Hub投递、已授权 `agent.delta` branch。

**Produces:** `ChatRoomV2ProtocolFeatures.DeltaFrameID bool`、selected capability写入client（只写服务端协商结果）、专用delta broadcast/projector，frameId为受限public可选字段；默认false、legacy输出无frameId。

接口冻结：新helper `createChatRoomV2DeltaFrameID() (string, error)`；Hub client `SetDeltaFrameIDSelected(bool)` / `DeltaFrameIDSelected() bool`；Hub `BroadcastAgentDelta(roomID, invocationID, delta string) error`。实现沿已有client锁/Hub投递，不新通用projection框架。

```go
func createChatRoomV2DeltaFrameID() (string, error) {
    var value [16]byte
    if _, err := rand.Read(value[:]); err != nil { return "", err }
    return hex.EncodeToString(value[:]), nil
}
// 两个 wire 事件在同一次 BroadcastAgentDelta 构造；legacy 不含可选字段。
legacy := map[string]any{"invocationId": invocationID, "delta": delta}
identified := map[string]any{"invocationId": invocationID, "delta": delta, "frameId": frameID}
```

行为测试核心（沿现Hub/WS fixture创建新旧接收者，不伪造能力选择结果）：

```go
if _, ok := legacyPayload["frameId"]; ok { t.Fatal("legacy frame shape changed") }
if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(newPayload["frameId"].(string)) { t.Fatal("missing public frame identity") }
if firstNewPayload["frameId"] == secondNewPayload["frameId"] { t.Fatal("two legitimate equal chunks reused identity") }
```

- [ ] RED真实两客户端WS/Hub fixture：显式选中者frameId匹配`^[0-9a-f]{32}$`，legacy没有额外字段；广播前已验证owner/executor。两个相同delta必须得到不同ID；重分发同一已构造event的ID不变。
- [ ] 实现最小 capability support/echo 与client selected flag；专用投影只作用agent.delta，保持queue/backpressure及其它event原逻辑。
- [ ] `crypto/rand.Read([16]byte)`一次→hex；entropy错误不广播；带/不带frameId事件都经严格wire校验。
- [ ] GREEN选中/未选中/未知能力、两文本相同、私有字段拒绝、默认关闭、断开替换，聚焦normal/race与diffcheck；不运行仍未隔离的全Go。
- [ ] 报告父ledger `task-6c1-report.md`，冻结source，review+rootverify；不commit。

### Task 2: Native 协商、严格解析与公开SSE（父Task6c2）

**Files:** `native/http-api-server/src/chatroom_protocol.rs` / tests、`chatroom_client.rs` / tests、`chatroom_gateway.rs` / tests，必要Main tests；`packages/shared/src/types/chatroom.ts`能力集合与对应wire tests。

**Consumes:** 已验收Task6c1 newcap/可选publicframeId；现requested/advertised/initial-snapshot same-generation交集。

**Produces:** `ChatroomCapability`新枚举值；严格可选frameId及cap模式校验；公开SSE保留合法frameId，不改MainDelta命令或SDK授权；默认opt-in仍关闭。

冻结枚举 `ChatroomCapability::AgentDeltaFrameIdV1`，字符串同Global Constraints；格式validator采用现strict transient parser单元（可新命名 `valid_delta_frame_id(&str) -> bool`）。

```rust
fn valid_delta_frame_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
// 在当前 socket negotiated 集合检查；不能用 capability HTTP advertisement 代替。
let id_selected = selected.contains(&ChatroomCapability::AgentDeltaFrameIdV1);
// 允许 legacy 无ID；已选中新格式缺ID或wrongID，以及未选中而带ID，都拒绝。
```

定向断言同时证明第三能力没有替代SDK双能力门：

```rust
assert!(valid_delta_frame_id("0123456789abcdef0123456789abcdef"));
assert!(!valid_delta_frame_id("0123456789ABCDEF0123456789ABCDEF"));
assert!(!selected_only_delta.contains(&ChatroomCapability::AgentReadyV1));
assert!(!selected_only_delta.contains(&ChatroomCapability::InvocationAckV1));
```

- [ ] RED新cap解析/多room选择与delta带ID目前拒绝；新能力未选中有ID、已选中错ID均拒，legacyinvID+delta仍合法。
- [ ] 最小新增枚举/known lists/回显交集；所有初始snapshot一致前仍无selected；新cap本身不触发Ready/ACK模式。
- [ ] 32lowerhex格式校验；只当前selectedsocket能携带ID到SSE，不公开其它内部字段；重连保持原origin/generation fence。
- [ ] GREENprotocol/client/gateway聚焦、完整Rust/fmt/build、shared独立Bun+type/diff，默认生产选项仍off（7e接正式入口）。
- [ ] 报告父ledger `task-6c2-report.md`，冻结source，review+rootverify；不commit。

### Task 3: Renderer 有界无损身份去重（父Task6c3）

**Files:** Renderer `atoms/chatroom-atoms.ts` / tests、`lib/chatroom-sse.ts` / tests、`ChatroomAgentActivity.tsx` / tests、`ChatroomSseInitializer` / tests、必要shared Renderer localtype。

**Consumes:** 可选frameId；既有auth epoch/room lifecycle/socket fence与terminal guard。Legacy无ID不猜测。

**Produces:** 每活跃invocation frameId→delta集合，8192per/32768global上限；同IDsame忽略、不同ID同文本保留、冲突/满额暂停preview明确提示；完成/删除/重置清理，最终message内容不丢。

新建单职责纯helper `renderer/lib/chatroom-delta-frames.ts` 与test：`createChatRoomDeltaFrameState()`；`applyChatRoomDeltaFrame(state, {roomId, invocationId, frameId, delta}, limits?) -> {state, decision}`，decision 为 `append | duplicate | conflict | capacity | invalid`；`clearChatRoomDeltaFrames(state, {roomId, invocationId?})`。新state与map不可原地修改，不用跨Jotai store共享可变实例；legacy没有frameId不经过该helper。

```ts
const a = { roomId: 'r', invocationId: 'i', frameId: 'a'.repeat(32), delta: '哈' }
const one = applyChatRoomDeltaFrame(createChatRoomDeltaFrameState(), a)
expect(one.decision).toBe('append')
expect(applyChatRoomDeltaFrame(one.state, a).decision).toBe('duplicate')
expect(applyChatRoomDeltaFrame(one.state, { ...a, frameId: 'b'.repeat(32) }).decision).toBe('append')
expect(applyChatRoomDeltaFrame(one.state, { ...a, delta: '改内容' }).decision).toBe('conflict')
expect(applyChatRoomDeltaFrame(one.state, { ...a, frameId: 'b'.repeat(32) }, { maxPerInvocation: 1, maxTotal: 1 }).decision).toBe('capacity')
```

Jotai调用只有append分支追加delta，其它分支保留真实status/startedAt；conflict/capacity给Renderer local preview字段。终态message内容展示仍来自现完整消息，并清理helper的专属调用集合。

- [ ] RED `agent.delta`同ID重发一次预览目前加两次；ID不同两段`哈`必须保留`哈哈`；同ID变内容不得追加；旧账号/room/terminal不复活。
- [ ] 写独立最小deduphelper/atom，避免扩展global persistent cursor；保留sameinv重连seen IDs及计时，终态清理。
- [ ] 本地previewpause字段与中文提示，绝不把pause变serverfailed或SDK限制；fixture小预算可注入，生产限制精确8192/32768。
- [ ] GREEN各受改Bunfile独立+强trapattempts0、全type/Main/preload/renderer/diff；最终完整reply覆盖previewpause，MetaTarget关联仍正确。
- [ ] 报告父ledger `task-6c3-report.md`，source冻结review/rootverify；仅三任务全部验收后才能关闭Task6b delta缺口/Task6，随后继续Task7a-f及总review。

## 自审与接口交接检查

| 任务/接口 | 生产/消费对应 | 结果 |
|---|---|---|
| 1 | 独立cap + public32hex ID，legacy无字段 | schema默认关闭与recipient投影一致；无权限升级 |
| 2 | 同名cap、32hex验证、只selected当前socket保留 | 不复用ACK语义；samegeneration旧guard保留 |
| 3 | frameId稳定去重key，legacy顺序追加 | 不丢同文本合法帧；边界暂停仅preview不丢完整回复 |
| 1→2 | E能力echo/wire与Native同格式 | 任务1报告为Task2唯一exact交接；额外字段严格拒绝 |
| 2→3 | 当前socketSSE传publicID，localauth/roomfence | 任务2不做Renderer去重；任务3不猜wire授权 |
| 3→7e/7f | 新cap正式typedopt-in与兼容集成 | 7e扩广告/配置，不实际开启；7f补混合接收者与重复frame |

Ruling: 不将此规范的工程限额当输出/模型限额；pause仅UI，最终reply仍完整 — 防无界ID内存，同时保留数据 — 代价极长preview暂停，必须清楚提示并测试。用户确认的是协议扩展，不是生产发布授权。
