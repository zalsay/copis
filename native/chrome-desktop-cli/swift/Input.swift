import Foundation
import CoreGraphics

let allowedKeys: [String: (CGKeyCode, CGEventFlags)] = [
    "Enter": (36, []), "Tab": (48, []), "Shift+Tab": (48, [.maskShift]),
    "Escape": (53, []), "Backspace": (51, []), "Delete": (117, []),
    "ArrowUp": (126, []), "ArrowDown": (125, []), "ArrowLeft": (123, []), "ArrowRight": (124, []),
    "Home": (115, []), "End": (119, []), "PageUp": (116, []), "PageDown": (121, []),
    "Cmd+L": (37, [.maskCommand]), "Cmd+A": (0, [.maskCommand]), "Cmd+R": (15, [.maskCommand]),
    "Cmd+T": (17, [.maskCommand]), "Cmd+W": (13, [.maskCommand]),
    "Alt+ArrowLeft": (123, [.maskAlternate]), "Alt+ArrowRight": (124, [.maskAlternate]),
]

final class InputCancellation {
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var held: (id: UUID, release: CGEvent)?

    func snapshot() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        return generation
    }

    func check(_ expected: UInt64) throws {
        lock.lock(); defer { lock.unlock() }
        guard generation == expected else { throw HelperFailure.cancelled }
    }

    // 与 cancel 共用提交锁：已进入的单次副作用结束后才能 ACK，ACK 后旧代次不能再提交。
    // 闭包必须同步、有界，禁止重入 check/cancel/effect 等取锁方法，也不能持锁 DispatchQueue.sync 切换线程。
    func effect<Value>(generation expected: UInt64, _ operation: () throws -> Value) throws -> Value {
        lock.lock(); defer { lock.unlock() }
        guard generation == expected else { throw HelperFailure.cancelled }
        return try operation()
    }

    func cancel() {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1
        // 不发虚拟 modifier reset 或无主 mouse-up，绝不释放用户自己按住的键/鼠标。
        held?.release.post(tap: .cghidEventTap)
        held = nil
    }

    func post(_ event: CGEvent, generation expected: UInt64) throws {
        lock.lock(); defer { lock.unlock() }
        guard generation == expected else { throw HelperFailure.cancelled }
        event.post(tap: .cghidEventTap)
    }

    func keyDown(_ down: CGEvent, release: CGEvent, generation expected: UInt64) throws -> UUID {
        lock.lock(); defer { lock.unlock() }
        guard generation == expected else { throw HelperFailure.cancelled }
        let id = UUID()
        held = (id, release)
        down.post(tap: .cghidEventTap)
        return id
    }

    func release(_ id: UUID) {
        lock.lock(); defer { lock.unlock() }
        guard held?.id == id else { return }
        held?.release.post(tap: .cghidEventTap)
        held = nil
    }
}

final class ChromeInput {
    private let desktop: ChromeDesktop
    private let cancellation: InputCancellation

    init(desktop: ChromeDesktop, cancellation: InputCancellation) {
        self.desktop = desktop; self.cancellation = cancellation
    }

    func send(_ request: NativeRequest, generation: UInt64) throws -> [String: Any] {
        guard let target = request.target, let bounds = request.expectedBounds else { throw HelperFailure.invalidArgument }
        try desktop.activate(target, expected: bounds, cancellation: cancellation, generation: generation)
        guard let source = CGEventSource(stateID: .privateState) else { throw eventFailure() }
        func verify(pointer: CGPoint? = nil) throws {
            try cancellation.check(generation)
            try desktop.verifyFocus(target, expected: bounds)
            if let point = pointer {
                try desktop.verifyPointer(point, target: target, expected: bounds)
                try desktop.verifyGeometry(target, expected: bounds)
            }
            try cancellation.check(generation)
        }
        func pair(_ down: CGEvent?, _ up: CGEvent?, pointer: CGPoint? = nil) throws {
            guard let down, let up else { throw eventFailure() }
            try verify(pointer: pointer)
            let token = try cancellation.keyDown(down, release: up, generation: generation)
            defer { cancellation.release(token) }
            Thread.sleep(forTimeInterval: 0.008)
            try cancellation.check(generation)
        }
        switch request.action {
        case "click", "scroll":
            guard let point = request.point else { throw HelperFailure.invalidArgument }
            try verify(pointer: point)
            guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
                throw eventFailure()
            }
            move.flags = []
            try cancellation.post(move, generation: generation)
            Thread.sleep(forTimeInterval: 0.01)
            if request.action == "click" {
                for index in 1...request.clickCount {
                    let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
                    let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
                    down?.flags = []; up?.flags = []
                    down?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
                    up?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
                    try pair(down, up, pointer: point)
                    if index < request.clickCount { Thread.sleep(forTimeInterval: 0.03) }
                }
            } else {
                try verify(pointer: point)
                guard let scroll = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1,
                                           wheel1: Int32(-request.deltaY), wheel2: 0, wheel3: 0) else { throw eventFailure() }
                scroll.location = point
                scroll.flags = []
                try cancellation.post(scroll, generation: generation)
            }
        case "type":
            // 每段最多 16 个 UTF-16 单元，不拆开代理对；每段重新确认焦点、几何、取消。
            var chunk: [UniChar] = []
            func sendChunk() throws {
                guard !chunk.isEmpty else { return }
                let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
                let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
                down?.flags = []; up?.flags = []
                chunk.withUnsafeBufferPointer { units in
                    down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units.baseAddress!)
                    up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units.baseAddress!)
                }
                try pair(down, up)
                chunk.removeAll(keepingCapacity: true)
            }
            for scalar in request.text.unicodeScalars {
                let units = Array(String(scalar).utf16)
                if chunk.count + units.count > 16 { try sendChunk() }
                chunk.append(contentsOf: units)
            }
            try sendChunk()
        case "press":
            guard let (code, flags) = allowedKeys[request.key] else { throw HelperFailure.invalidArgument }
            let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
            let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
            down?.flags = flags; up?.flags = flags
            try pair(down, up)
        default: throw HelperFailure.invalidArgument
        }
        return ["sent": true]
    }

    private func eventFailure() -> HelperFailure {
        HelperFailure(code: "INPUT_FAILED", message: "系统未能创建输入事件，未完成输入")
    }
}
