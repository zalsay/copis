import AppKit

// 显式 AppKit 状态回归：不截图、不进行 Chrome 导航、不发送输入。
setbuf(stdout, nil)
func require(_ value: Bool, _ message: String) {
    if !value { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
guard let primary = NSScreen.screens.first else { exit(2) }
guard let previousPID = NSWorkspace.shared.frontmostApplication?.processIdentifier else { exit(2) }
_ = NSApplication.shared.setActivationPolicy(.accessory)
let toast = ChromeControlToast()
let cancellation = InputCancellation()
let generation = cancellation.snapshot()
let bounds = WindowBounds(x: primary.frame.minX + 10, y: 100, width: 800, height: 600)
try toast.show(over: bounds, targetPID: previousPID, cancellation: cancellation, generation: cancellation.snapshot())
guard let panel = NSApplication.shared.windows.first(where: { $0.title == "AI正在操作Chrome窗口..." }) else {
    fputs("FAIL: 未创建原生提示窗口\n", stderr); exit(1)
}
require(panel.isVisible, "提示未显示")
require(!panel.canBecomeKey && !panel.canBecomeMain && panel.ignoresMouseEvents, "提示可能抢占键盘或鼠标")
let firstWindowNumber = panel.windowNumber
try toast.show(over: bounds, targetPID: previousPID, cancellation: cancellation, generation: cancellation.snapshot())
let matching = NSApplication.shared.windows.filter { $0.title == panel.title }
require(matching.count == 1 && matching[0].windowNumber == firstWindowNumber, "连续提示创建了重复窗口")
toast.dismissIfCovering(CGPoint(x: -10000, y: -10000))
require(panel.isVisible, "不相交的指针不应提前关闭提示")
let covered = CGPoint(x: panel.frame.midX, y: primary.frame.maxY - panel.frame.midY)
toast.dismissIfCovering(covered)
require(!panel.isVisible, "覆盖输入目标时未收起提示")
cancellation.cancel()
do {
    try toast.show(over: bounds, targetPID: previousPID, cancellation: cancellation, generation: generation)
    require(false, "取消 ACK 后仍允许旧操作展示提示")
} catch let failure as HelperFailure { require(failure.code == "CANCELLED", "取消未保留原错误") }
require(!panel.isVisible, "取消 ACK 后重新显示了提示")
try toast.show(over: bounds, targetPID: previousPID, cancellation: cancellation, generation: cancellation.snapshot())
DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
    require(NSWorkspace.shared.frontmostApplication?.processIdentifier == previousPID, "原生提示抢占了前台焦点")
    print("PASS: 提示可见、不抢焦点、鼠标穿透、复用窗口、避让输入目标")
}
DispatchQueue.main.asyncAfter(deadline: .now() + 3.3) {
    require(!panel.isVisible, "提示未在短暂展示后自动关闭")
    print("PASS: 提示自动关闭；未截图或发送输入")
    exit(0)
}
let keepAlive = Port()
RunLoop.main.add(keepAlive, forMode: .default)
RunLoop.main.run()
