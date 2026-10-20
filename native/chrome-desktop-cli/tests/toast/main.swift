import AppKit

// AppKit 对象回归：只点击本进程 NSButton，不截图、不移动鼠标、不激活 Chrome 或发送输入。
setbuf(stdout, nil)
func require(_ value: Bool, _ message: String) {
    if !value { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
func pumpMain() { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.03)) }
guard let primary = NSScreen.screens.first,
      let previousPID = NSWorkspace.shared.frontmostApplication?.processIdentifier else { exit(2) }
_ = NSApplication.shared.setActivationPolicy(.accessory)
let toast = ChromeControlToast()
let cancellation = InputCancellation()
let bounds = WindowBounds(x: primary.frame.minX + 10, y: 100, width: 800, height: 600)
try toast.show(over: bounds, targetPID: previousPID, cancellation: cancellation, generation: cancellation.snapshot())
let firstLease = try cancellation.beginExecution(generation: cancellation.snapshot())
guard let panel = NSApplication.shared.windows.first(where: { $0.title == "AI正在操作Chrome窗口..." }),
      let content = panel.contentView else {
    fputs("FAIL: 未创建原生控制窗口\n", stderr); exit(1)
}
let views = descendants(content)
guard let execute = views.compactMap({ $0 as? NSButton }).first(where: { $0.accessibilityIdentifier() == "copis-chrome-execute" }),
      let pause = views.compactMap({ $0 as? NSButton }).first(where: { $0.accessibilityIdentifier() == "copis-chrome-pause" }),
      let label = views.compactMap({ $0 as? NSTextField }).first else {
    fputs("FAIL: 控制条缺少可访问的执行/暂停按钮或状态文字\n", stderr); exit(1)
}
require(panel.isVisible && panel.frame.size == CGSize(width: 360, height: 52), "控制条应按旧尺寸显示")
require(!panel.canBecomeKey && !panel.canBecomeMain && !panel.ignoresMouseEvents, "控制条必须可点击且不抢键盘焦点")
require(execute.acceptsFirstMouse(for: nil) && pause.acceptsFirstMouse(for: nil), "非激活控制条按钮必须支持 firstMouse")
require(!execute.isEnabled && pause.isEnabled && label.stringValue == "AI正在操作Chrome窗口...", "首次显示应自动执行而不是重复授权")
let firstWindowNumber = panel.windowNumber
pause.performClick(nil)
require(cancellation.executionPaused(lease: firstLease) == true, "暂停按钮未关闭 core 输入门禁")
require(execute.isEnabled && !pause.isEnabled && label.stringValue == "已暂停，点击执行", "暂停按钮状态未更新")
try toast.show(over: bounds, targetPID: previousPID, cancellation: cancellation, generation: cancellation.snapshot())
require(try cancellation.beginExecution(generation: cancellation.snapshot()) == firstLease, "同一控制应复用 lease")
require(cancellation.executionPaused(lease: firstLease) == true && execute.isEnabled, "重复 show 不得自动清除暂停")
require(panel.windowNumber == firstWindowNumber && NSApplication.shared.windows.filter { $0.title == panel.title }.count == 1,
        "重复 show 创建了多余窗口")
execute.performClick(nil)
require(cancellation.executionPaused(lease: firstLease) == false && !execute.isEnabled && pause.isEnabled,
        "执行按钮未恢复 core 门禁或状态未同步")
require(NSWorkspace.shared.frontmostApplication?.processIdentifier == previousPID, "点击控制条抢占了前台焦点")

// 模拟 inputEffect 锁内同步发布激活通知；回调必须异步暂停，不能重入同一把 core 锁。
try cancellation.effect(generation: cancellation.snapshot()) {
    NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didActivateApplicationNotification, object: nil,
        userInfo: [NSWorkspace.applicationUserInfoKey: NSRunningApplication.current])
}
pumpMain()
require(cancellation.executionPaused(lease: firstLease) == false && !execute.isEnabled && panel.isVisible,
        "迟到通知应重读真实前台，不应仅根据旧通知暂停")

// 窄屏布局只缩短文字，不裁掉两个固定按钮。
panel.setContentSize(NSSize(width: 288, height: 52))
content.layoutSubtreeIfNeeded()
for button in [execute, pause] {
    let rect = button.convert(button.bounds, to: content)
    require(content.bounds.contains(rect) && rect.width >= 50 && rect.height >= 28, "窄屏下按钮被压缩或裁切")
}
try toast.show(over: bounds, targetPID: previousPID, cancellation: cancellation, generation: cancellation.snapshot())
let initialFrame = panel.frame
toast.avoidPointer(CGPoint(x: -10000, y: -10000))
require(panel.frame == initialFrame && panel.isVisible, "不覆盖目标时不应移动或关闭控制条")
let covered = CGPoint(x: panel.frame.midX, y: primary.frame.maxY - panel.frame.midY)
toast.avoidPointer(covered)
require(panel.isVisible && panel.frame != initialFrame && panel.frame.size == initialFrame.size,
        "AI 点覆盖 HUD 时应同屏避让而不是隐藏")
let appKitPoint = CGPoint(x: covered.x, y: primary.frame.maxY - covered.y)
require(!panel.frame.contains(appKitPoint), "避让后仍会点到控制按钮")

// 初始前台不属于目标时不展示未暂停 UI，但仍建立 lease；模拟通知，不激活任何其他应用。
cancellation.cancel()
try toast.show(over: bounds, targetPID: -1, cancellation: cancellation, generation: cancellation.snapshot())
let backgroundLease = try cancellation.beginExecution(generation: cancellation.snapshot())
require(!panel.isVisible && cancellation.executionPaused(lease: backgroundLease) == false, "后台首次 show 不应抢占前台")
try cancellation.effect(generation: cancellation.snapshot()) {
    NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didActivateApplicationNotification, object: nil)
}
require(cancellation.executionPaused(lease: backgroundLease) == false, "激活通知不能在 core 锁内同步暂停")
pumpMain()
require(cancellation.executionPaused(lease: backgroundLease) == true && panel.isVisible && execute.isEnabled,
        "切走应用应暂停并保留可点击控制条")
// 正常 show 与该执行共用暂停状态，不会自动恢复。
try toast.show(over: bounds, targetPID: previousPID, cancellation: cancellation, generation: cancellation.snapshot())
require(execute.isEnabled && panel.isVisible, "暂停后 show 必须保留暂停状态")

// 取消 ACK 后即使主线程清理尚未调度，也不能移动旧控制条。
let cancelledGeneration = cancellation.snapshot()
let beforeCancel = panel.frame
cancellation.cancel()
toast.avoidPointer(CGPoint(x: beforeCancel.midX, y: primary.frame.maxY - beforeCancel.midY))
require(panel.frame == beforeCancel, "取消 ACK 后旧控制仍在避让移动")
pause.performClick(nil)
require(cancellation.executionPaused(lease: backgroundLease) == nil, "过期按钮不能创建或恢复执行状态")
do {
    try toast.show(over: bounds, targetPID: previousPID, cancellation: cancellation, generation: cancelledGeneration)
    require(false, "取消后旧代次仍能 show")
} catch let failure as HelperFailure { require(failure.code == "CANCELLED", "旧代次未保留取消错误") }
try toast.show(over: bounds, targetPID: previousPID, cancellation: cancellation, generation: cancellation.snapshot())
let newLease = try cancellation.beginExecution(generation: cancellation.snapshot())
pumpMain()
require(newLease != backgroundLease && panel.isVisible && cancellation.executionPaused(lease: newLease) == false,
        "旧 onEnd 回调隐藏或暂停了新 lease 控制条")
require(!execute.isEnabled && pause.isEnabled, "旧按钮状态泄漏到新 lease")

// 不同 core 实例可能使用相同 lease 数字；旧 owner 的结束回调不能关闭新 owner。
cancellation.cancel()
pumpMain()
let oldOwner = InputCancellation()
let newOwner = InputCancellation()
try toast.show(over: bounds, targetPID: previousPID, cancellation: oldOwner, generation: oldOwner.snapshot())
oldOwner.cancel()
try toast.show(over: bounds, targetPID: previousPID, cancellation: newOwner, generation: newOwner.snapshot())
pumpMain()
require(panel.isVisible, "不同 core 的相同 lease 让旧回调关闭了新控制条")

// 超过旧 3 秒时限仍常驻；仅结束 lease 才收起，不截图或制造真实输入。
DispatchQueue.main.asyncAfter(deadline: .now() + 3.3) {
    require(panel.isVisible, "控制条仍在 3 秒后自动消失")
    require(NSWorkspace.shared.frontmostApplication?.processIdentifier == previousPID, "控制条抢占了前台焦点")
    newOwner.cancel()
    DispatchQueue.main.async {
        require(!panel.isVisible, "结束执行后未清理控制条")
        print("PASS: 执行/暂停门禁、firstMouse、不抢焦点、按钮窄屏布局、常驻、同屏避让、后台暂停与 lease 清理 BDD；未截图或发送真实输入")
        exit(0)
    }
}
NSApplication.shared.run()
