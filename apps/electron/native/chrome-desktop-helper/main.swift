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
            FileHandle.standardOutput.write(Data((jsonString + "\n").utf8))
            fflush(stdout)
        }
    } catch {
        logDiag("JSON serialization failed: \(error.localizedDescription)")
    }
}

// MARK: - State & Cancellation
var isCancelled = false
let stateLock = NSLock()

func checkAndResetCancel() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    let val = isCancelled
    isCancelled = false
    return val
}

func setCancelled() {
    stateLock.lock()
    isCancelled = true
    stateLock.unlock()
    
    // Release any lingering mouse / modifier keys
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

func isChromeProcess(pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
    return app.bundleIdentifier == chromeBundleId
}

func getFrontmostApplicationPid() -> pid_t? {
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
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
            let title = (win[kCGWindowName as String] as? String) ?? ""
            return [
                "windowId": Int(winNumber),
                "pid": Int(winOwnerPid),
                "title": title,
                "bounds": [
                    "x": x,
                    "y": y,
                    "width": w,
                    "height": h
                ]
            ]
        }
    }
    return nil
}

func verifyTargetInForeground(windowId: CGWindowID, pid: pid_t) -> (ok: Bool, bounds: [String: Any]?, error: String?) {
    guard isChromeProcess(pid: pid) else {
        return (false, nil, "CHROME_WINDOW_UNAVAILABLE")
    }
    guard let frontPid = getFrontmostApplicationPid(), frontPid == pid else {
        return (false, nil, "CHROME_FOCUS_LOST")
    }
    guard let win = getWindowInfo(windowId: windowId, pid: pid) else {
        return (false, nil, "CHROME_WINDOW_UNAVAILABLE")
    }
    guard let bounds = win["bounds"] as? [String: Any] else {
        return (false, nil, "CHROME_GEOMETRY_CHANGED")
    }
    return (true, bounds, nil)
}

// MARK: - Actions
func listChromeWindows() -> [[String: Any]] {
    guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    
    var results: [[String: Any]] = []
    for win in windowList {
        guard let winOwnerPid = win[kCGWindowOwnerPID as String] as? pid_t,
              let winNumber = win[kCGWindowNumber as String] as? CGWindowID,
              let winLayer = win[kCGWindowLayer as String] as? Int,
              winLayer == 0,
              isChromeProcess(pid: winOwnerPid),
              let boundsDict = win[kCGWindowBounds as String] as? [String: Any] else {
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
        results.append([
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
    return results
}

func activateWindow(windowId: CGWindowID, pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid),
          app.bundleIdentifier == chromeBundleId else {
        return false
    }
    
    app.activate(options: [.activateIgnoringOtherApps])
    
    let appElement = AXUIElementCreateApplication(pid)
    var windowListRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowListRef) == .success,
       let windowElements = windowListRef as? [AXUIElement] {
        for windowElement in windowElements {
            var idRef: CGWindowID = 0
            if _AXUIElementGetWindow(windowElement, &idRef) == .success && idRef == windowId {
                AXUIElementSetAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, windowElement)
                AXUIElementSetAttributeValue(windowElement, kAXMainAttribute as CFString, kCFBooleanTrue)
                break
            }
        }
    }
    
    // Give macOS window server a brief moment to update frontmost application
    usleep(50_000)
    return true
}

// Private helper to get CGWindowID from AXUIElement
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>) -> AXError

// MARK: - Key Mappings
let allowedKeyCodes: [String: (CGKeyCode, CGEventFlags)] = [
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
    "Alt+ArrowRight": (124, [.maskAlternate]),
]

func performPress(key: String) -> Bool {
    guard let (keyCode, flags) = allowedKeyCodes[key] else {
        return false
    }
    
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

func performType(text: String) -> Bool {
    let source = CGEventSource(stateID: .combinedSessionState)
    let chars = Array(text.utf16)
    
    for char in chars {
        stateLock.lock()
        let cancelled = isCancelled
        stateLock.unlock()
        if cancelled { return false }
        
        var uniChar = char
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            continue
        }
        
        down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &uniChar)
        up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &uniChar)
        
        down.post(tap: .cghidEventTap)
        usleep(5_000)
        up.post(tap: .cghidEventTap)
        usleep(5_000)
    }
    return true
}

func performClick(screenX: Double, screenY: Double, clickCount: Int) -> Bool {
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

func performScroll(screenX: Double, screenY: Double, deltaY: Int) -> Bool {
    let point = CGPoint(x: screenX, y: screenY)
    let source = CGEventSource(stateID: .combinedSessionState)
    
    if let moveEvent = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        moveEvent.post(tap: .cghidEventTap)
        usleep(5_000)
    }
    
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

// MARK: - Main Loop (stdin processing)
logDiag("Started, awaiting JSON commands.")

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
    
    _ = checkAndResetCancel()
    
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
                break
            }
            let winId = CGWindowID(windowIdNum)
            let pid = pid_t(pidNum)
            let activated = activateWindow(windowId: winId, pid: pid)
            if !activated {
                sendResponse(id: id, ok: false, error: "CHROME_WINDOW_UNAVAILABLE")
                break
            }
            let status = verifyTargetInForeground(windowId: winId, pid: pid)
            if !status.ok {
                sendResponse(id: id, ok: false, error: status.error ?? "CHROME_WINDOW_UNAVAILABLE")
            } else {
                sendResponse(id: id, ok: true, data: ["bounds": status.bounds ?? [:]])
            }
            
        case "check_target":
            guard let windowIdNum = json["windowId"] as? Int,
                  let pidNum = json["pid"] as? Int else {
                sendResponse(id: id, ok: false, error: "INVALID_PARAMETERS")
                break
            }
            let winId = CGWindowID(windowIdNum)
            let pid = pid_t(pidNum)
            let status = verifyTargetInForeground(windowId: winId, pid: pid)
            if status.ok {
                sendResponse(id: id, ok: true, data: ["bounds": status.bounds ?? [:]])
            } else {
                sendResponse(id: id, ok: false, error: status.error ?? "CHROME_FOCUS_LOST")
            }
            
        case "click":
            guard let windowIdNum = json["windowId"] as? Int,
                  let pidNum = json["pid"] as? Int,
                  let screenX = json["screenX"] as? Double,
                  let screenY = json["screenY"] as? Double else {
                sendResponse(id: id, ok: false, error: "INVALID_PARAMETERS")
                break
            }
            let clickCount = (json["clickCount"] as? Int) ?? 1
            let winId = CGWindowID(windowIdNum)
            let pid = pid_t(pidNum)
            let status = verifyTargetInForeground(windowId: winId, pid: pid)
            guard status.ok else {
                sendResponse(id: id, ok: false, error: status.error ?? "CHROME_FOCUS_LOST")
                break
            }
            let success = performClick(screenX: screenX, screenY: screenY, clickCount: clickCount)
            if success {
                sendResponse(id: id, ok: true)
            } else {
                sendResponse(id: id, ok: false, error: "CHROME_HELPER_FAILED")
            }
            
        case "scroll":
            guard let windowIdNum = json["windowId"] as? Int,
                  let pidNum = json["pid"] as? Int,
                  let screenX = json["screenX"] as? Double,
                  let screenY = json["screenY"] as? Double,
                  let deltaY = json["deltaY"] as? Int else {
                sendResponse(id: id, ok: false, error: "INVALID_PARAMETERS")
                break
            }
            let winId = CGWindowID(windowIdNum)
            let pid = pid_t(pidNum)
            let status = verifyTargetInForeground(windowId: winId, pid: pid)
            guard status.ok else {
                sendResponse(id: id, ok: false, error: status.error ?? "CHROME_FOCUS_LOST")
                break
            }
            let success = performScroll(screenX: screenX, screenY: screenY, deltaY: deltaY)
            if success {
                sendResponse(id: id, ok: true)
            } else {
                sendResponse(id: id, ok: false, error: "CHROME_HELPER_FAILED")
            }
            
        case "type":
            guard let windowIdNum = json["windowId"] as? Int,
                  let pidNum = json["pid"] as? Int,
                  let text = json["text"] as? String else {
                sendResponse(id: id, ok: false, error: "INVALID_PARAMETERS")
                break
            }
            let winId = CGWindowID(windowIdNum)
            let pid = pid_t(pidNum)
            let status = verifyTargetInForeground(windowId: winId, pid: pid)
            guard status.ok else {
                sendResponse(id: id, ok: false, error: status.error ?? "CHROME_FOCUS_LOST")
                break
            }
            let success = performType(text: text)
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
                break
            }
            let winId = CGWindowID(windowIdNum)
            let pid = pid_t(pidNum)
            let status = verifyTargetInForeground(windowId: winId, pid: pid)
            guard status.ok else {
                sendResponse(id: id, ok: false, error: status.error ?? "CHROME_FOCUS_LOST")
                break
            }
            let success = performPress(key: key)
            if success {
                sendResponse(id: id, ok: true)
            } else {
                sendResponse(id: id, ok: false, error: "INVALID_KEY")
            }
            
        case "cancel":
            setCancelled()
            sendResponse(id: id, ok: true)
            
        case "exit":
            sendResponse(id: id, ok: true)
            exit(0)
            
        default:
            sendResponse(id: id, ok: false, error: "UNKNOWN_ACTION")
        }
}

logDiag("stdin EOF reached, helper exiting.")
exit(0)
