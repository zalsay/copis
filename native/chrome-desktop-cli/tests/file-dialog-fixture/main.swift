import AppKit
import ApplicationServices

setbuf(stdout, nil)

@_silgen_name("_AXUIElementGetWindow")
func axWindowID(_ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>) -> AXError
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func require(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--front-pid" {
    print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
    exit(0)
}
guard CommandLine.arguments.count == 4, let pid = Int32(CommandLine.arguments[1]),
      let windowID = UInt32(CommandLine.arguments[2]),
      let running = NSRunningApplication(processIdentifier: pid), running.bundleIdentifier == "com.google.Chrome" else { exit(2) }
if CommandLine.arguments[3].hasPrefix("background:") {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    require(windows.contains { ($0[kCGWindowNumber as String] as? UInt32) == windowID && ($0[kCGWindowOwnerPID as String] as? Int32) == pid },
            "隔离测试窗口不存在")
    guard let previousPID = Int32(CommandLine.arguments[3].dropFirst("background:".count)), previousPID != pid,
          let previous = NSRunningApplication(processIdentifier: previousPID), !previous.isTerminated else { exit(2) }
    // 只恢复测试启动前的应用焦点，不向该应用窗口发送输入，也不预热目标 AX。
    _ = NSApplication.shared.setActivationPolicy(.accessory)
    require(previous.activate(options: []), "无法恢复原前台应用")
    let focusDeadline = ProcessInfo.processInfo.systemUptime + 2
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != previousPID {
        require(ProcessInfo.processInfo.systemUptime < focusDeadline, "无法建立 Chrome 后台条件")
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
    }
    print("READY: FIXTURE_CHROME_IS_BACKGROUND")
    exit(0)
}
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 1)
let deadline = ProcessInfo.processInfo.systemUptime + 4
var root: AXUIElement?
repeat {
    root = (attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).first {
        var identifier: CGWindowID = 0
        return axWindowID($0, &identifier) == .success && identifier == windowID
    }
    if root != nil { break }
    Thread.sleep(forTimeInterval: 0.05)
} while ProcessInfo.processInfo.systemUptime < deadline
guard let root else { fputs("FAIL: 无法确认隔离测试窗口\n", stderr); exit(1) }
let title = attribute(root, kAXTitleAttribute) as? String ?? ""
require(title.contains("CopisFileChooserFixture") || title.contains("CopisFileChosen:"), "只能操作隔离文件选择测试页")
switch CommandLine.arguments[3] {
case "open":
    // 模拟真实点击上传按钮的前置条件：目标窗口处于前台。
    require(running.activate(options: []), "无法激活隔离 Chrome")
    let focusDeadline = ProcessInfo.processInfo.systemUptime + 2
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        require(ProcessInfo.processInfo.systemUptime < focusDeadline, "隔离 Chrome 未进入前台")
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
    }
    var queue = [root], index = 0
    while index < queue.count && index < 1000 {
        let node = queue[index]; index += 1
        let title = attribute(node, kAXTitleAttribute) as? String ?? ""
        let description = attribute(node, kAXDescriptionAttribute) as? String ?? ""
        if attribute(node, kAXRoleAttribute) as? String == kAXButtonRole,
           title == "Copis open test picker" || description == "Copis open test picker" {
            require(AXUIElementPerformAction(node, kAXPressAction as CFString) == .success, "打开测试文件选择框失败")
            print("PASS: 已打开隔离测试页的文件选择框")
            exit(0)
        }
        queue.append(contentsOf: attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? [])
    }
    require(false, "找不到隔离测试按钮")
case "selected":
    require(title.contains("CopisFileChosen:copis-test.txt"), "网页未收到预期的本地测试文件")
    let children = attribute(root, kAXChildrenAttribute) as? [AXUIElement] ?? []
    require(!children.contains { attribute($0, kAXIdentifierAttribute) as? String == "open-panel" }, "文件选择框仍打开")
    print("PASS: 原生对话框已关闭，网页收到预期文件；未上传")
default: exit(2)
}
