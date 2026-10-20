import AppKit

struct ChromeToastScreen {
    let frame: CGRect
    let visibleFrame: CGRect
}

func chromeToastFrame(window: WindowBounds, screens: [ChromeToastScreen]) -> CGRect? {
    guard let primary = screens.first else { return nil }
    // CG 使用主屏左上原点，AppKit 使用主屏左下原点；全程使用逻辑点而非 Retina 像素。
    let rect = CGRect(x: window.x, y: primary.frame.maxY - window.y - window.height,
                      width: window.width, height: window.height)
    let intersections = screens.map { screen -> (ChromeToastScreen, CGFloat) in
        let overlap = screen.frame.intersection(rect)
        return (screen, overlap.isNull ? 0 : overlap.width * overlap.height)
    }
    guard let (screen, area) = intersections.max(by: { $0.1 < $1.1 }), area > 0 else { return nil }
    let visible = screen.visibleFrame
    let width = min(360, visible.width - 32)
    guard width > 0, visible.height >= 100 else { return nil }
    return CGRect(x: visible.midX - width / 2, y: visible.maxY - 76, width: width, height: 52)
}

func shouldPauseChromeForPointer(sourcePID: Int64?, helperPID: pid_t, insideControls: Bool) -> Bool {
    !insideControls && sourcePID != Int64(helperPID)
}

func chromeToastFrameAvoidingPointer(frame: CGRect, screenPoint: CGPoint, screens: [ChromeToastScreen]) -> CGRect {
    guard let primary = screens.first else { return frame }
    let point = CGPoint(x: screenPoint.x, y: primary.frame.maxY - screenPoint.y)
    guard frame.contains(point), let screen = screens.first(where: { $0.frame.contains(CGPoint(x: frame.midX, y: frame.midY)) }) else {
        return frame
    }
    var moved = frame
    moved.origin.y = frame.midY > screen.visibleFrame.midY
        ? screen.visibleFrame.minY + 24
        : screen.visibleFrame.maxY - frame.height - 24
    // 极窄/极矮屏幕无安全位置时保留控制条，交给后续完整指针 guard 拒绝输入。
    guard screen.visibleFrame.contains(moved), !moved.contains(point) else { return frame }
    return moved
}

private final class ChromeToastPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class ChromeToastButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var acceptsFirstResponder: Bool { false }
}

// 所有 UI 与观察器回调都在主线程处理；只监听鼠标，不申请键盘 Input Monitoring。
final class ChromeControlToast: NSObject {
    private struct Execution {
        let lease: UInt64
        let generation: UInt64
        let targetPID: pid_t
        let cancellation: InputCancellation
    }

    private var panel: ChromeToastPanel?
    private var execution: Execution?
    private var activationObserver: NSObjectProtocol?
    private var pointerMonitor: Any?
    private let stateLabel = NSTextField(labelWithString: "AI正在操作Chrome窗口...")
    private let executeButton = ChromeToastButton(title: "执行", target: nil, action: nil)
    private let pauseButton = ChromeToastButton(title: "暂停", target: nil, action: nil)

    func show(over window: WindowBounds, targetPID: pid_t,
              cancellation: InputCancellation, generation: UInt64) throws {
        let lease = try cancellation.beginExecution(generation: generation)
        let isNewExecution = execution?.lease != lease || execution?.cancellation !== cancellation
        if isNewExecution { stopWatching() }
        execution = Execution(lease: lease, generation: generation, targetPID: targetPID, cancellation: cancellation)
        if isNewExecution {
            guard cancellation.onExecutionEnd(lease: lease, handler: { [weak self, weak cancellation] in
                DispatchQueue.main.async { [weak self, weak cancellation] in
                    guard let self, let cancellation, self.isCurrent(lease: lease, cancellation: cancellation) else { return }
                    self.dismiss()
                }
            }) else {
                dismiss()
                throw HelperFailure.cancelled
            }
            watchExecution(lease: lease, cancellation: cancellation)
        }
        let screens = NSScreen.screens.map { ChromeToastScreen(frame: $0.frame, visibleFrame: $0.visibleFrame) }
        guard let frame = chromeToastFrame(window: window, screens: screens) else { return }
        if panel == nil { panel = makePanel() }
        try cancellation.effect(generation: generation) { panel?.setFrame(frame, display: false) }
        panel?.contentView?.layoutSubtreeIfNeeded()
        refresh(lease: lease)
        try cancellation.check(generation)
    }

    private func refresh(lease: UInt64) {
        guard let execution, execution.lease == lease else { return }
        guard let paused = execution.cancellation.executionPaused(lease: lease) else { dismiss(); return }
        stateLabel.stringValue = paused ? "已暂停，点击执行" : "AI正在操作Chrome窗口..."
        executeButton.isEnabled = paused
        pauseButton.isEnabled = !paused
        do {
            try execution.cancellation.effect(generation: execution.generation) {
                if paused || NSWorkspace.shared.frontmostApplication?.processIdentifier == execution.targetPID {
                    panel?.orderFrontRegardless()
                } else {
                    // 初次输入尚未激活目标时先保留 lease；切走应用的观察器会暂停并保留控制条。
                    panel?.orderOut(nil)
                }
            }
        } catch { dismiss() }
    }

    @objc private func executeClicked(_ sender: NSButton) {
        guard let execution else { return }
        _ = execution.cancellation.resumeExecution(lease: execution.lease)
        refresh(lease: execution.lease)
    }

    @objc private func pauseClicked(_ sender: NSButton) {
        guard let execution else { return }
        _ = execution.cancellation.pauseExecution(lease: execution.lease)
        refresh(lease: execution.lease)
    }

    private func isCurrent(lease: UInt64, cancellation: InputCancellation) -> Bool {
        execution?.lease == lease && execution?.cancellation === cancellation
    }

    private func watchExecution(lease: UInt64, cancellation: InputCancellation) {
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self, weak cancellation] _ in
            // activate 可在 core 提交锁内同步发布通知；延后取锁，且不信任迟到通知里的旧前台。
            DispatchQueue.main.async { [weak self, weak cancellation] in
                guard let self, let cancellation, self.isCurrent(lease: lease, cancellation: cancellation),
                      let execution = self.execution else { return }
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier != execution.targetPID,
                      cancellation.pauseExecution(lease: lease) else { return }
                self.refresh(lease: lease)
            }
        }
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
                                           .leftMouseDown, .rightMouseDown, .otherMouseDown,
                                           .leftMouseUp, .rightMouseUp, .otherMouseUp, .scrollWheel]
        pointerMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self, weak cancellation] event in
            guard let self, let cancellation, self.isCurrent(lease: lease, cancellation: cancellation) else { return }
            let cgEvent = event.cgEvent
            let sourcePID = cgEvent.map { $0.getIntegerValueField(.eventSourceUnixProcessID) }
            let location: CGPoint
            if let cgEvent, let primary = NSScreen.screens.first {
                location = CGPoint(x: cgEvent.location.x, y: primary.frame.maxY - cgEvent.location.y)
            } else {
                location = NSEvent.mouseLocation
            }
            let insideControls = self.panel.map { $0.isVisible && $0.frame.contains(location) } ?? false
            guard shouldPauseChromeForPointer(sourcePID: sourcePID, helperPID: ProcessInfo.processInfo.processIdentifier,
                                              insideControls: insideControls),
                  cancellation.pauseExecution(lease: lease) else { return }
            self.refresh(lease: lease)
        }
    }

    private func stopWatching() {
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        activationObserver = nil
        if let pointerMonitor { NSEvent.removeMonitor(pointerMonitor) }
        pointerMonitor = nil
    }

    func dismiss() {
        stopWatching()
        execution = nil
        panel?.orderOut(nil)
    }

    deinit { stopWatching() }

    func avoidPointer(_ screenPoint: CGPoint) {
        guard let execution, execution.cancellation.executionPaused(lease: execution.lease) != nil,
              let panel, panel.isVisible else { return }
        let screens = NSScreen.screens.map { ChromeToastScreen(frame: $0.frame, visibleFrame: $0.visibleFrame) }
        let moved = chromeToastFrameAvoidingPointer(frame: panel.frame, screenPoint: screenPoint, screens: screens)
        if moved != panel.frame {
            do {
                try execution.cancellation.effect(generation: execution.generation) { panel.setFrame(moved, display: true) }
            } catch { dismiss() }
        }
    }

    private func makePanel() -> ChromeToastPanel {
        let toast = ChromeToastPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                                     backing: .buffered, defer: false)
        toast.title = "AI正在操作Chrome窗口..."
        toast.isReleasedWhenClosed = false
        toast.isOpaque = false
        toast.backgroundColor = .clear
        toast.hasShadow = true
        toast.ignoresMouseEvents = false
        toast.hidesOnDeactivate = false
        toast.level = .statusBar
        toast.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        toast.animationBehavior = .none

        let background = NSVisualEffectView()
        background.material = .hudWindow
        background.blendingMode = .behindWindow
        background.state = .active
        background.appearance = NSAppearance(named: .vibrantDark)
        background.wantsLayer = true
        background.layer?.cornerRadius = 14
        background.layer?.masksToBounds = true
        toast.contentView = background

        let icon = NSImageView(image: NSImage(systemSymbolName: "sparkles", accessibilityDescription: nil) ?? NSImage())
        icon.contentTintColor = .controlAccentColor
        stateLabel.font = .systemFont(ofSize: 14, weight: .medium)
        stateLabel.textColor = .labelColor
        stateLabel.maximumNumberOfLines = 1
        stateLabel.lineBreakMode = .byTruncatingTail
        stateLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        executeButton.target = self
        executeButton.action = #selector(executeClicked(_:))
        executeButton.setAccessibilityIdentifier("copis-chrome-execute")
        pauseButton.target = self
        pauseButton.action = #selector(pauseClicked(_:))
        pauseButton.setAccessibilityIdentifier("copis-chrome-pause")
        for button in [executeButton, pauseButton] {
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.font = .systemFont(ofSize: 12, weight: .medium)
        }
        for view in [icon, stateLabel, executeButton, pauseButton] {
            view.translatesAutoresizingMaskIntoConstraints = false
            background.addSubview(view)
        }
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 12),
            icon.widthAnchor.constraint(equalToConstant: 18), icon.heightAnchor.constraint(equalToConstant: 18),
            icon.centerYAnchor.constraint(equalTo: background.centerYAnchor),
            stateLabel.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            stateLabel.trailingAnchor.constraint(equalTo: executeButton.leadingAnchor, constant: -8),
            stateLabel.centerYAnchor.constraint(equalTo: background.centerYAnchor),
            executeButton.widthAnchor.constraint(equalToConstant: 50), executeButton.heightAnchor.constraint(equalToConstant: 28),
            executeButton.centerYAnchor.constraint(equalTo: background.centerYAnchor),
            pauseButton.leadingAnchor.constraint(equalTo: executeButton.trailingAnchor, constant: 8),
            pauseButton.widthAnchor.constraint(equalToConstant: 50), pauseButton.heightAnchor.constraint(equalToConstant: 28),
            pauseButton.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -12),
            pauseButton.centerYAnchor.constraint(equalTo: background.centerYAnchor),
        ])
        return toast
    }
}
