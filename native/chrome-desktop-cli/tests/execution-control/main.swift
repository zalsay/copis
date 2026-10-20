import Foundation

func require(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
func fails(_ code: String, _ operation: () throws -> Void) {
    do { try operation(); require(false, "应拒绝：\(code)") }
    catch let failure as HelperFailure { require(failure.code == code, "暂停与取消必须区分") }
    catch { require(false, "意外错误") }
}
let control = InputCancellation()
let generation = control.snapshot()
let lease = try control.beginExecution(generation: generation)
var permit = try control.beginInput(generation: generation)
try control.inputEffect(permit: permit) { }
// Given 用户接管鼠标，Then 已有输入中断，但只读观察不被取消。
require(control.pauseExecution(lease: lease), "有效控制可暂停")
require(control.executionPaused(lease: lease) == true, "暂停状态可读取")
fails("USER_PAUSED") { try control.checkInput(permit) }
fails("USER_PAUSED") { try control.inputEffect(permit: permit) { require(false, "暂停后不能输入") } }
fails("USER_PAUSED") { _ = try control.beginInput(generation: generation) }
try control.effect(generation: generation) { }
// Given 用户点击执行，Then 不自动恢复旧输入，仅允许新的串行操作。
require(control.resumeExecution(lease: lease), "有效控制可恢复")
fails("USER_PAUSED") { try control.checkInput(permit) }
permit = try control.beginInput(generation: generation)
try control.checkInput(permit)
let value = try control.inputEffect(permit: permit) { 42 }
require(value == 42, "新输入允许执行")
// Given 请求已排队尚未开始，When 用户暂停后执行，Then 旧请求不能获得新输入凭据。
let queuedEpoch = control.inputSnapshot()
require(control.pauseExecution(lease: lease), "排队期间暂停")
require(control.resumeExecution(lease: lease), "排队期间执行")
fails("USER_PAUSED") { _ = try control.beginInput(generation: generation, expectedEpoch: queuedEpoch) }
permit = try control.beginInput(generation: generation, expectedEpoch: control.inputSnapshot())
// Given 暂停期间收到的请求仍在队列中，When 用户点击执行，Then 该请求也必须作废。
require(control.pauseExecution(lease: lease), "等待期间暂停")
let pausedEpoch = control.inputSnapshot()
require(control.resumeExecution(lease: lease), "用户点击执行")
fails("USER_PAUSED") { _ = try control.beginInput(generation: generation, expectedEpoch: pausedEpoch) }
permit = try control.beginInput(generation: generation, expectedEpoch: control.inputSnapshot())
// Given 连续暂停/执行，Then 每次都使旧动作不可重放。
require(control.pauseExecution(lease: lease), "再次暂停")
require(control.resumeExecution(lease: lease), "再次执行")
fails("USER_PAUSED") { try control.inputEffect(permit: permit) { } }
permit = try control.beginInput(generation: generation)
// Given 取消，Then 关闭原 toast、旧回调无权操作新连接。
var ended = 0
require(control.onExecutionEnd(lease: lease, handler: { require(control.executionPaused(lease: lease) == nil, "结束回调必须在锁外执行"); ended += 1 }), "可注册结束清理")
control.cancel()
require(ended == 1 && control.executionPaused(lease: lease) == nil, "取消清理控制条")
fails("CANCELLED") { try control.checkInput(permit) }
let nextGeneration = control.snapshot()
let nextLease = try control.beginExecution(generation: nextGeneration)
require(nextLease != lease, "新连接必须使用新 lease")
require(!control.pauseExecution(lease: lease) && !control.resumeExecution(lease: lease), "迟到按钮不能修改新连接")
require(!control.onExecutionEnd(lease: lease, handler: { ended += 100 }), "迟到清理不能绑定新控制")
require(control.executionPaused(lease: nextLease) == false, "旧回调不影响新控制")
let nextPermit = try control.beginInput(generation: nextGeneration)
try control.checkInput(nextPermit)
// Given 输入副作用已经进入提交锁，When 用户暂停，Then 暂停返回前先结束该副作用，之后禁止旧输入。
let concurrent = InputCancellation()
let concurrentGeneration = concurrent.snapshot()
let concurrentLease = try concurrent.beginExecution(generation: concurrentGeneration)
let concurrentPermit = try concurrent.beginInput(generation: concurrentGeneration)
let entered = DispatchSemaphore(value: 0), finish = DispatchSemaphore(value: 0)
let paused = DispatchSemaphore(value: 0), completed = DispatchSemaphore(value: 0)
DispatchQueue.global().async {
    do {
        try concurrent.inputEffect(permit: concurrentPermit) {
            entered.signal()
            require(finish.wait(timeout: .now() + 3) == .success, "副作用未释放")
        }
        require(paused.wait(timeout: .now() + 3) == .success, "暂停未完成")
        fails("USER_PAUSED") { try concurrent.inputEffect(permit: concurrentPermit) { } }
        completed.signal()
    } catch { require(false, "副作用运行异常") }
}
require(entered.wait(timeout: .now() + 3) == .success, "副作用未进入")
DispatchQueue.global().async { _ = concurrent.pauseExecution(lease: concurrentLease); paused.signal(); paused.signal() }
require(paused.wait(timeout: .now() + 0.05) == .timedOut, "暂停过早返回")
finish.signal()
require(paused.wait(timeout: .now() + 3) == .success, "暂停锁未释放")
require(completed.wait(timeout: .now() + 3) == .success, "旧输入未结束")
print("PASS: 执行/暂停门禁、旧输入不可重放、只读观察、取消与迟到回调 BDD；未投递系统输入")
