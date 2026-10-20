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

// 每次原生输入独立签发；暂停后旧输入即使遇到“执行”也不能重新生效。
struct ChromeInputPermit {
    let generation: UInt64
    let lease: UInt64
    let epoch: UInt64
}

final class InputCancellation {
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var held: (id: UUID, release: CGEvent)?
    private var captureCleanup: (id: UUID, operation: () -> Void)?
    private var leaseCounter: UInt64 = 0
    private var executionLease: UInt64?
    private var paused = false
    private var inputEpoch: UInt64 = 0
    private var executionEnd: (() -> Void)?

    func beginExecution(generation expected: UInt64) throws -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        guard generation == expected else { throw HelperFailure.cancelled }
        if let lease = executionLease { return lease }
        leaseCounter &+= 1
        executionLease = leaseCounter
        return leaseCounter
    }

    func executionPaused(lease: UInt64) -> Bool? {
        lock.lock(); defer { lock.unlock() }
        return executionLease == lease ? paused : nil
    }

    func onExecutionEnd(lease: UInt64, handler: @escaping () -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard executionLease == lease else { return false }
        executionEnd = handler
        return true
    }

    func pauseExecution(lease: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard executionLease == lease, !paused else { return false }
        paused = true
        inputEpoch &+= 1
        // 在暂停返回前释放本 helper 按住的键/鼠标；不影响读截图，也不释放用户自己的按键。
        held?.release.post(tap: .cghidEventTap)
        held = nil
        return true
    }

    func resumeExecution(lease: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard executionLease == lease else { return false }
        // 暂停期间收到的请求也必须作废；重复点击执行不改变正在运行的代次。
        if paused { inputEpoch &+= 1 }
        paused = false
        return true
    }

    func inputSnapshot() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        return inputEpoch
    }

    func beginInput(generation expected: UInt64, expectedEpoch: UInt64? = nil) throws -> ChromeInputPermit {
        lock.lock(); defer { lock.unlock() }
        guard generation == expected, let lease = executionLease else { throw HelperFailure.cancelled }
        guard !paused, expectedEpoch == nil || expectedEpoch == inputEpoch else { throw HelperFailure.userPaused }
        return ChromeInputPermit(generation: expected, lease: lease, epoch: inputEpoch)
    }

    private func validateInput(_ permit: ChromeInputPermit) throws {
        guard generation == permit.generation, executionLease == permit.lease else { throw HelperFailure.cancelled }
        guard !paused, inputEpoch == permit.epoch else { throw HelperFailure.userPaused }
    }

    func checkInput(_ permit: ChromeInputPermit) throws {
        lock.lock(); defer { lock.unlock() }
        try validateInput(permit)
    }

    func inputEffect<Value>(permit: ChromeInputPermit, _ operation: () throws -> Value) throws -> Value {
        lock.lock(); defer { lock.unlock() }
        try validateInput(permit)
        return try operation()
    }

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

    // 回退采集的子进程和私有文件一起注册；取消 ACK 必须发生在清理完成之后。
    func protectCapture(generation expected: UInt64, cleanup: @escaping () -> Void) throws -> UUID {
        try effect(generation: expected) {
            guard captureCleanup == nil else { throw HelperFailure(code: "BUSY", message: "已有窗口采集正在执行") }
            let id = UUID()
            captureCleanup = (id, cleanup)
            return id
        }
    }

    func finishCapture(_ id: UUID) {
        lock.lock(); defer { lock.unlock() }
        guard captureCleanup?.id == id else { return }
        captureCleanup?.operation()
        captureCleanup = nil
    }

    func cancel() {
        lock.lock()
        generation &+= 1
        executionLease = nil
        paused = false
        inputEpoch &+= 1
        let onEnd = executionEnd
        executionEnd = nil
        // 不发虚拟 modifier reset 或无主 mouse-up，绝不释放用户自己按住的键/鼠标。
        held?.release.post(tap: .cghidEventTap)
        held = nil
        captureCleanup?.operation()
        captureCleanup = nil
        lock.unlock()
        // UI 清理回调在锁外运行，不能与主线程布局互相等待。
        onEnd?()
    }

    func post(_ event: CGEvent, permit: ChromeInputPermit) throws {
        lock.lock(); defer { lock.unlock() }
        try validateInput(permit)
        event.post(tap: .cghidEventTap)
    }

    func keyDown(_ down: CGEvent, release: CGEvent, permit: ChromeInputPermit) throws -> UUID {
        lock.lock(); defer { lock.unlock() }
        try validateInput(permit)
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
        let permit = try desktop.prepareInput(target, cancellation: cancellation, generation: generation, expectedEpoch: request.inputEpoch)
        try desktop.activate(target, expected: bounds, cancellation: cancellation, generation: generation, permit: permit)
        guard let source = CGEventSource(stateID: .privateState) else { throw eventFailure() }
        func verify(pointer: CGPoint? = nil) throws {
            try cancellation.checkInput(permit)
            if let point = pointer {
                try desktop.verifyPointer(point, target: target, expected: bounds)
                try desktop.verifyGeometry(target, expected: bounds)
            }
            // 可能耗时的遮挡/几何查询完成后，最后复核精确窗口焦点再提交输入。
            try desktop.verifyFocus(target, expected: bounds)
            try cancellation.checkInput(permit)
        }
        func pair(_ down: CGEvent?, _ up: CGEvent?, pointer: CGPoint? = nil) throws {
            guard let down, let up else { throw eventFailure() }
            try verify(pointer: pointer)
            let token = try cancellation.keyDown(down, release: up, permit: permit)
            defer { cancellation.release(token) }
            Thread.sleep(forTimeInterval: 0.008)
            try cancellation.checkInput(permit)
        }
        switch request.action {
        case "click", "scroll":
            guard let point = request.point else { throw HelperFailure.invalidArgument }
            try verify(pointer: point)
            guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
                throw eventFailure()
            }
            move.flags = []
            try cancellation.post(move, permit: permit)
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
                try cancellation.post(scroll, permit: permit)
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
