import Foundation
import AppKit
import CoreGraphics
import ApplicationServices

// Disable stdout buffering so JSON responses are immediately delivered over pipes
setbuf(stdout, nil)

// MARK: - Logging (stderr only, no sensitive payload)
func logDiag(_ msg: String) {
    FileHandle.standardError.write(Data(("[chrome-desktop-helper] " + msg + "\n").utf8))
}

let stdoutLock = NSLock()

func sendResponse(id: String, ok: Bool, data: [String: Any]? = nil, error: String? = nil) {
    var dict: [String: Any] = [
        "id": id,
        "ok": ok
    ]
    if let data = data {
        for (k, v) in data {
            dict[k] = v
        }
    }
    if let error = error {
        dict["error"] = error
    }

    do {
        let jsonData = try JSONSerialization.data(withJSONObject: dict, options: [])
        if let jsonString = String(data: jsonData, encoding: .utf8) {
            stdoutLock.lock()
            defer { stdoutLock.unlock() }
            FileHandle.standardOutput.write(Data((jsonString + "\n").utf8))
            fflush(stdout)
        }
    } catch {
        logDiag("JSON serialization failed: \(error.localizedDescription)")
    }
}

// MARK: - State & Cancellation
var cancellationGeneration: UInt64 = 0
let stateLock = NSLock()

func currentCancellationGeneration() -> UInt64 {
    stateLock.lock()
    defer { stateLock.unlock() }
    return cancellationGeneration
}

func checkCancelled(since generation: UInt64) -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return cancellationGeneration != generation
}

func setCancelled() {
    stateLock.lock()
    cancellationGeneration &+= 1
    stateLock.unlock()

    // Release any lingering mouse / modifier keys immediately
    if let event = CGEvent(source: nil) {
        event.flags = []
        event.post(tap: .cghidEventTap)
    }
    let dummyPos = CGEvent(source: nil)?.location ?? .zero
    if let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: dummyPos, mouseButton: .left) {
        upEvent.post(tap: .cghidEventTap)
    }
}

// MARK: - Chrome Target Verification
let chromeBundleId = "com.google.Chrome"

// AppKit 应用状态依赖主 RunLoop，查询和激活统一回到主线程。
let desktopWorkspace = NSWorkspace.shared

func onMainThread<T>(_ operation: () -> T) -> T {
    if Thread.isMainThread { return operation() }
    return DispatchQueue.main.sync(execute: operation)
}

// 使用 NSWorkspace 跟踪的应用实例，避免临时 PID 对象的身份信息尚未就绪。
// 调用方均通过 onMainThread 访问 AppKit 状态。
func chromeApplication(pid: pid_t) -> NSRunningApplication? {
    return desktopWorkspace.runningApplications.first {
        $0.processIdentifier == pid && $0.bundleIdentifier == chromeBundleId && !$0.isTerminated
    }
}

func isChromeProcess(pid: pid_t) -> Bool {
    return onMainThread { chromeApplication(pid: pid) != nil }
}

func getFrontmostApplicationPid() -> pid_t? {
    return onMainThread { desktopWorkspace.frontmostApplication?.processIdentifier }
}

func getWindowInfo(windowId: CGWindowID, pid: pid_t) -> [String: Any]? {
    guard isChromeProcess(pid: pid) else { return nil }
    guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }

    for win in windowList {
        guard let winNumber = win[kCGWindowNumber as String] as? CGWindowID,
              let winOwnerPid = win[kCGWindowOwnerPID as String] as? pid_t,
              let winLayer = win[kCGWindowLayer as String] as? Int,
              let boundsDict = win[kCGWindowBounds as String] as? [String: Any] else {
            continue
        }

        if winNumber == windowId && winOwnerPid == pid && winLayer == 0 {
            guard let x = boundsDict["X"] as? Double,
                  let y = boundsDict["Y"] as? Double,
                  let w = boundsDict["Width"] as? Double,
                  let h = boundsDict["Height"] as? Double,
                  w >= 50 && h >= 50 else {
                continue
            }
            return [
                "x": x,
                "y": y,
                "width": w,
                "height": h
            ]
        }
    }
    return nil
}

func getFocusedWindowId(pid: pid_t) -> CGWindowID? {
    var focusedWindow: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute as CFString, &focusedWindow
    ) == .success,
          let window = focusedWindow,
          CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
    var windowId: CGWindowID = 0
    guard _AXUIElementGetWindow(window as! AXUIElement, &windowId) == .success, windowId > 0 else { return nil }
    return windowId
}

func logFocusDiagnostics(windowId: CGWindowID, pid: pid_t) {
    let focusedPid = getFrontmostApplicationPid() ?? -1
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let top = windows.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }.prefix(3)
        .map { "\($0[kCGWindowOwnerPID as String] ?? -1):\($0[kCGWindowNumber as String] ?? -1)" }.joined(separator: ",")
    let focusedWindowId = getFocusedWindowId(pid: pid) ?? 0
    logDiag("焦点诊断 target=\(pid):\(windowId) focusedPid=\(focusedPid) focusedWindow=\(focusedWindowId) topWindows=\(top)")
}

func verifyTargetInForeground(windowId: CGWindowID, pid: pid_t) -> (ok: Bool, bounds: [String: Any]?, error: String?) {
    guard isChromeProcess(pid: pid) else {
        return (false, nil, "CHROME_WINDOW_UNAVAILABLE")
    }

    guard let frontPid = getFrontmostApplicationPid(), frontPid == pid else {
        return (false, nil, "CHROME_FOCUS_LOST")
    }

    guard let bounds = getWindowInfo(windowId: windowId, pid: pid) else {
        return (false, nil, "CHROME_WINDOW_UNAVAILABLE")
    }

    // 显示层级不等于键盘焦点：共享指示条等非激活窗口可能排在页面上方。
    // 只接受前台 Chrome 进程中真正获得焦点的、用户已授权的窗口。
    guard getFocusedWindowId(pid: pid) == windowId else {
        return (false, nil, "CHROME_FOCUS_LOST")
    }

    return (true, bounds, nil)
}

func waitForTargetInForeground(windowId: CGWindowID, pid: pid_t, generation: UInt64, timeoutMs: useconds_t = 1_000_000) -> (ok: Bool, bounds: [String: Any]?, error: String?) {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000_000.0)
    var lastStatus = verifyTargetInForeground(windowId: windowId, pid: pid)
    while !lastStatus.ok && Date() < deadline {
        if checkCancelled(since: generation) {
            return (false, nil, "CHROME_CANCELLED")
        }
        usleep(50_000)
        lastStatus = verifyTargetInForeground(windowId: windowId, pid: pid)
    }
    return lastStatus
}

func listChromeWindows() -> [[String: Any]] {
    var result: [[String: Any]] = []
    guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return result
    }

    for win in windowList {
        guard let winNumber = win[kCGWindowNumber as String] as? CGWindowID,
              let winOwnerPid = win[kCGWindowOwnerPID as String] as? pid_t,
              let winLayer = win[kCGWindowLayer as String] as? Int,
              let boundsDict = win[kCGWindowBounds as String] as? [String: Any],
              winLayer == 0 else {
            continue
        }

        if !isChromeProcess(pid: winOwnerPid) {
            continue
        }

        guard let x = boundsDict["X"] as? Double,
              let y = boundsDict["Y"] as? Double,
              let w = boundsDict["Width"] as? Double,
              let h = boundsDict["Height"] as? Double,
              w >= 50 && h >= 50 else {
            continue
        }

        let title = (win[kCGWindowName as String] as? String) ?? ""

        result.append([
            "windowId": Int(winNumber),
            "pid": Int(winOwnerPid),
            "title": title,
            "bounds": [
                "x": x,
                "y": y,
                "width": w,
                "height": h
            ]
        ])
    }
    return result
}

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>) -> AXError

func activateWindow(windowId: CGWindowID, pid: pid_t) -> Bool {
    guard isChromeProcess(pid: pid) else { return false }
    let activated = onMainThread {
        chromeApplication(pid: pid)?.activate(options: [.activateIgnoringOtherApps]) ?? false
    }
    if !activated {
        return false
    }

    usleep(80_000)

    let axApp = AXUIElementCreateApplication(pid)
    var windowsRef: CFTypeRef?
    let copyResult = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef)

    if copyResult == .success, let axWindows = windowsRef as? [AXUIElement] {
        for axWin in axWindows {
            var idRef: CGWindowID = 0
            if _AXUIElementGetWindow(axWin, &idRef) == .success && idRef == windowId {
                // Chrome 同一进程可能有多个窗口；仅 raise 不一定改变 focused/main window。
                // 先设置应用焦点窗口和窗口 main 属性，再执行 raise，确保后续 CGEvent
                // 投递到用户实际选中的窗口。
                AXUIElementSetAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, axWin)
                AXUIElementSetAttributeValue(axWin, kAXMainAttribute as CFString, kCFBooleanTrue)
                AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
                usleep(100_000)
                return true
            }
        }
    }

    return true
}

// MARK: - Key Definition Mapping
let keyMapping: [String: (CGKeyCode, CGEventFlags)] = [
    "Enter": (36, []),
    "Tab": (48, []),
    "Shift+Tab": (48, [.maskShift]),
    "Escape": (53, []),
    "Backspace": (51, []),
    "Delete": (117, []),
    "ArrowUp": (126, []),
    "ArrowDown": (125, []),
    "ArrowLeft": (123, []),
    "ArrowRight": (124, []),
    "Home": (115, []),
    "End": (119, []),
    "PageUp": (116, []),
    "PageDown": (121, []),
    "Cmd+L": (37, [.maskCommand]),
    "Cmd+A": (0, [.maskCommand]),
    "Cmd+R": (15, [.maskCommand]),
    "Cmd+T": (17, [.maskCommand]),
    "Cmd+W": (13, [.maskCommand]),
    "Alt+ArrowLeft": (123, [.maskAlternate]),
    "Alt+ArrowRight": (124, [.maskAlternate])
]

func performPress(key: String, generation: UInt64) -> Bool {
    guard let (keyCode, flags) = keyMapping[key] else {
        return false
    }

    if checkCancelled(since: generation) { return false }

    let source = CGEventSource(stateID: .combinedSessionState)
    guard let downEvent = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
          let upEvent = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
        return false
    }

    downEvent.flags = flags
    upEvent.flags = flags

    downEvent.post(tap: .cghidEventTap)
    usleep(15_000)
    upEvent.post(tap: .cghidEventTap)
    return true
}

func performType(text: String, windowId: CGWindowID, pid: pid_t, generation: UInt64) -> Bool {
    let source = CGEventSource(stateID: .combinedSessionState)

    for char in text {
        if checkCancelled(since: generation) || !verifyTargetInForeground(windowId: windowId, pid: pid).ok { return false }

        var utf16Chars = Array(char.utf16)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            continue
        }

        // Pass full UTF-16 code units of the character together to preserve surrogate pairs (e.g. emoji)
        down.keyboardSetUnicodeString(stringLength: utf16Chars.count, unicodeString: &utf16Chars)
        up.keyboardSetUnicodeString(stringLength: utf16Chars.count, unicodeString: &utf16Chars)

        down.post(tap: .cghidEventTap)
        usleep(3_000)
        up.post(tap: .cghidEventTap)
        usleep(3_000)
    }
    return true
}

func targetReceivesPointer(windowId: CGWindowID, pid: pid_t, x: Double, y: Double) -> Bool {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit) == .success,
          let element = hit else { return false }
    var ownerPid: pid_t = 0
    guard AXUIElementGetPid(element, &ownerPid) == .success, ownerPid == pid else { return false }
    var windowValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &windowValue) == .success,
          let window = windowValue,
          CFGetTypeID(window) == AXUIElementGetTypeID() else { return false }
    var hitWindowId: CGWindowID = 0
    return _AXUIElementGetWindow(window as! AXUIElement, &hitWindowId) == .success && hitWindowId == windowId
}

func performClick(screenX: Double, screenY: Double, clickCount: Int, windowId: CGWindowID, pid: pid_t, generation: UInt64) -> Bool {
    if checkCancelled(since: generation) || !verifyTargetInForeground(windowId: windowId, pid: pid).ok { return false }

    let point = CGPoint(x: screenX, y: screenY)
    let source = CGEventSource(stateID: .combinedSessionState)

    // Move mouse
    guard let moveEvent = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
        return false
    }
    moveEvent.post(tap: .cghidEventTap)
    usleep(10_000)

    let count = max(1, min(clickCount, 2))
    for i in 1...count {
        if checkCancelled(since: generation) || !verifyTargetInForeground(windowId: windowId, pid: pid).ok { return false }

        guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            return false
        }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i))

        down.post(tap: .cghidEventTap)
        usleep(20_000)
        up.post(tap: .cghidEventTap)
        if i < count {
            usleep(20_000)
        }
    }
    return true
}

func performScroll(screenX: Double, screenY: Double, deltaY: Int, windowId: CGWindowID, pid: pid_t, generation: UInt64) -> Bool {
    if checkCancelled(since: generation) || !verifyTargetInForeground(windowId: windowId, pid: pid).ok { return false }

    let point = CGPoint(x: screenX, y: screenY)
    let source = CGEventSource(stateID: .combinedSessionState)

    if let moveEvent = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        moveEvent.post(tap: .cghidEventTap)
        usleep(5_000)
    }

    if checkCancelled(since: generation) || !verifyTargetInForeground(windowId: windowId, pid: pid).ok || !targetReceivesPointer(windowId: windowId, pid: pid, x: screenX, y: screenY) { return false }

    // Spec: deltaY > 0 scrolls down
    guard let scrollEvent = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(-deltaY), wheel2: 0, wheel3: 0) else {
        return false
    }
    scrollEvent.post(tap: .cghidEventTap)
    return true
}

// MARK: - Parent Process Watcher
DispatchQueue.global(qos: .background).async {
    while true {
        if getppid() == 1 {
            logDiag("Parent process terminated, helper exiting.")
            exit(0)
        }
        sleep(1)
    }
}

// MARK: - Action Execution Queue
// Commands are executed sequentially on a dedicated queue so cancel can be processed asynchronously on stdin
let actionQueue = DispatchQueue(label: "com.copis.chrome-desktop-helper.actions", qos: .userInitiated)

// MARK: - Main Loop (stdin processing)
logDiag("Started, awaiting JSON commands.")

// 读取管道不能阻塞 AppKit 主线程，否则常驻进程一直看到旧的前台应用。
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }

        guard let data = trimmed.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = json["id"] as? String,
              let action = json["action"] as? String else {
            logDiag("Invalid JSON format")
            continue
        }

        // Cancel and Exit are handled immediately on the main reading thread without waiting for actionQueue
        if action == "cancel" {
            setCancelled()
            sendResponse(id: id, ok: true, data: ["status": "cancelled"])
            continue
        }

        if action == "exit" {
            setCancelled()
            sendResponse(id: id, ok: true)
            exit(0)
        }

        // 每条操作绑定入队时的取消代次，取消前排队的命令不会在取消后复活。
        let generation = currentCancellationGeneration()
        actionQueue.async {
            if checkCancelled(since: generation) {
                sendResponse(id: id, ok: false, error: "CHROME_CANCELLED")
                return
            }
            switch action {
            case "check_permissions":
                let accessibilityGranted = AXIsProcessTrusted()
                var screenRecordingGranted = false
                if #available(macOS 10.15, *) {
                    screenRecordingGranted = CGPreflightScreenCaptureAccess()
                } else {
                    screenRecordingGranted = true
                }
                sendResponse(id: id, ok: true, data: [
                    "accessibility": accessibilityGranted,
                    "screenRecording": screenRecordingGranted,
                    "helperPath": CommandLine.arguments[0]
                ])

            case "list_windows":
                let windows = listChromeWindows()
                sendResponse(id: id, ok: true, data: ["windows": windows])

            case "activate_window":
                guard let windowIdNum = json["windowId"] as? Int,
                      let pidNum = json["pid"] as? Int else {
                    sendResponse(id: id, ok: false, error: "INVALID_PARAMETERS")
                    return
                }
                let winId = CGWindowID(windowIdNum)
                let pid = pid_t(pidNum)
                let activated = activateWindow(windowId: winId, pid: pid)
                if !activated {
                    sendResponse(id: id, ok: false, error: "CHROME_WINDOW_UNAVAILABLE")
                    return
                }
                let status = waitForTargetInForeground(windowId: winId, pid: pid, generation: generation)
                if !status.ok {
                    logFocusDiagnostics(windowId: winId, pid: pid)
                    sendResponse(id: id, ok: false, error: status.error ?? "CHROME_WINDOW_UNAVAILABLE")
                } else {
                    sendResponse(id: id, ok: true, data: ["bounds": status.bounds ?? [:]])
                }

            case "get_window_bounds":
            guard let windowIdNum = json["windowId"] as? Int,
                  let pidNum = json["pid"] as? Int else {
                sendResponse(id: id, ok: false, error: "INVALID_PARAMETERS")
                return
            }
            let winId = CGWindowID(windowIdNum)
            let pid = pid_t(pidNum)
            if let bounds = getWindowInfo(windowId: winId, pid: pid) {
                sendResponse(id: id, ok: true, data: ["bounds": bounds])
            } else {
                sendResponse(id: id, ok: false, error: "CHROME_WINDOW_UNAVAILABLE")
            }

        case "check_target":
                guard let windowIdNum = json["windowId"] as? Int,
                      let pidNum = json["pid"] as? Int else {
                    sendResponse(id: id, ok: false, error: "INVALID_PARAMETERS")
                    return
                }
                let winId = CGWindowID(windowIdNum)
                let pid = pid_t(pidNum)
                let status = verifyTargetInForeground(windowId: winId, pid: pid)
                if status.ok {
                    sendResponse(id: id, ok: true, data: ["bounds": status.bounds ?? [:]])
                } else {
                    logFocusDiagnostics(windowId: winId, pid: pid)
                    sendResponse(id: id, ok: false, error: status.error ?? "CHROME_FOCUS_LOST")
                }

            case "click":
                guard let windowIdNum = json["windowId"] as? Int,
                      let pidNum = json["pid"] as? Int,
                      let screenX = json["screenX"] as? Double,
                      let screenY = json["screenY"] as? Double else {
                    sendResponse(id: id, ok: false, error: "INVALID_PARAMETERS")
                    return
                }
                let clickCount = (json["clickCount"] as? Int) ?? 1
                let winId = CGWindowID(windowIdNum)
                let pid = pid_t(pidNum)
                let status = verifyTargetInForeground(windowId: winId, pid: pid)
                guard status.ok else {
                    sendResponse(id: id, ok: false, error: status.error ?? "CHROME_FOCUS_LOST")
                    return
                }
                let success = performClick(screenX: screenX, screenY: screenY, clickCount: clickCount, windowId: winId, pid: pid, generation: generation)
                if success {
                    sendResponse(id: id, ok: true)
                } else {
                    sendResponse(id: id, ok: false, error: checkCancelled(since: generation) ? "CHROME_CANCELLED" : "CHROME_HELPER_FAILED")
                }

            case "scroll":
                guard let windowIdNum = json["windowId"] as? Int,
                      let pidNum = json["pid"] as? Int,
                      let screenX = json["screenX"] as? Double,
                      let screenY = json["screenY"] as? Double,
                      let deltaY = json["deltaY"] as? Int else {
                    sendResponse(id: id, ok: false, error: "INVALID_PARAMETERS")
                    return
                }
                let winId = CGWindowID(windowIdNum)
                let pid = pid_t(pidNum)
                let status = verifyTargetInForeground(windowId: winId, pid: pid)
                guard status.ok else {
                    sendResponse(id: id, ok: false, error: status.error ?? "CHROME_FOCUS_LOST")
                    return
                }
                let success = performScroll(screenX: screenX, screenY: screenY, deltaY: deltaY, windowId: winId, pid: pid, generation: generation)
                if success {
                    sendResponse(id: id, ok: true)
                } else {
                    sendResponse(id: id, ok: false, error: checkCancelled(since: generation) ? "CHROME_CANCELLED" : "CHROME_HELPER_FAILED")
                }

            case "type":
                guard let windowIdNum = json["windowId"] as? Int,
                      let pidNum = json["pid"] as? Int,
                      let text = json["text"] as? String else {
                    sendResponse(id: id, ok: false, error: "INVALID_PARAMETERS")
                    return
                }
                let winId = CGWindowID(windowIdNum)
                let pid = pid_t(pidNum)
                let status = verifyTargetInForeground(windowId: winId, pid: pid)
                guard status.ok else {
                    sendResponse(id: id, ok: false, error: status.error ?? "CHROME_FOCUS_LOST")
                    return
                }
                let success = performType(text: text, windowId: winId, pid: pid, generation: generation)
                if success {
                    sendResponse(id: id, ok: true)
                } else {
                    sendResponse(id: id, ok: false, error: "CHROME_CANCELLED")
                }

            case "press":
                guard let windowIdNum = json["windowId"] as? Int,
                      let pidNum = json["pid"] as? Int,
                      let key = json["key"] as? String else {
                    sendResponse(id: id, ok: false, error: "INVALID_PARAMETERS")
                    return
                }
                let winId = CGWindowID(windowIdNum)
                let pid = pid_t(pidNum)
                let status = verifyTargetInForeground(windowId: winId, pid: pid)
                guard status.ok else {
                    sendResponse(id: id, ok: false, error: status.error ?? "CHROME_FOCUS_LOST")
                    return
                }
                let success = performPress(key: key, generation: generation)
                if success {
                    sendResponse(id: id, ok: true)
                } else {
                    sendResponse(id: id, ok: false, error: checkCancelled(since: generation) ? "CHROME_CANCELLED" : "INVALID_KEY")
                }

            default:
                sendResponse(id: id, ok: false, error: "UNKNOWN_ACTION")
            }
        }
    }

    logDiag("stdin EOF reached, helper exiting.")
    exit(0)
}

RunLoop.main.add(Port(), forMode: .default)
RunLoop.main.run()
