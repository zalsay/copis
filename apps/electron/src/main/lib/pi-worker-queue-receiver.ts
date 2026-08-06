/**
 * Pi Worker 运行中 queue 接收器。
 *
 * 在异步发送前登记 UUID，避免同一个 Worker 因 HTTP 重试重复接收同一条消息。
 */

export interface ActiveWorkerQueueState {
  acceptedQueueUuids: Set<string>
}

/**
 * 尝试向运行中的 Worker 投递一条 queue 消息。
 *
 * @returns true 表示本次首次接收并已发送；false 表示 UUID 已由当前 run 接收。
 */
export async function receiveActiveWorkerQueue(
  state: ActiveWorkerQueueState,
  uuid: string,
  send: () => Promise<void>,
): Promise<boolean> {
  if (state.acceptedQueueUuids.has(uuid)) return false

  // 必须在 await 前登记，才能阻止连续到达的两个相同命令并发进入 Adapter。
  state.acceptedQueueUuids.add(uuid)
  try {
    await send()
    return true
  } catch (error) {
    // 未被 Adapter 接受的消息允许调用方使用同一 UUID 重试。
    state.acceptedQueueUuids.delete(uuid)
    throw error
  }
}
