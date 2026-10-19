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

private final class ChromeToastPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// 只由主线程调用；不激活 Helper、不参与鼠标事件，也不要求通知中心权限。
final class ChromeControlToast {
    private var panel: ChromeToastPanel?
    private var dismissTimer: Timer?
    private var activationObserver: NSObjectProtocol?

    func show(over window: WindowBounds, targetPID: pid_t,
              cancellation: InputCancellation, generation: UInt64) throws {
        try cancellation.check(generation)
        let screens = NSScreen.screens.map { ChromeToastScreen(frame: $0.frame, visibleFrame: $0.visibleFrame) }
        guard let frame = chromeToastFrame(window: window, screens: screens) else { return }
        // 首次创建和布局不占用取消提交锁；准备期间收到取消 ACK 也不会展示窗口。
        if panel == nil {
            let prepared = makePanel()
            prepared.setFrame(frame, display: false)
            prepared.contentView?.layoutSubtreeIfNeeded()
            panel = prepared
        }
        guard let toast = panel else { return }
        let presented = try cancellation.effect(generation: generation) {
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID else { return false }
            toast.setFrame(frame, display: true)
            toast.orderFrontRegardless()
            return true
        }
        guard presented else { return }
        stopWatching()
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            // 读取当前状态，避免延迟到达的旧激活通知误关刚显示的提示。
            if NSWorkspace.shared.frontmostApplication?.processIdentifier != targetPID { self?.dismiss() }
        }
        // 补上展示与注册观察器之间的窗口，避免漏掉刚发生的前台切换。
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID else {
            dismiss()
            return
        }
        let timer = Timer(timeInterval: 3, repeats: false) { [weak self] _ in self?.dismiss() }
        dismissTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func stopWatching() {
        dismissTimer?.invalidate()
        dismissTimer = nil
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        activationObserver = nil
    }

    func dismiss() {
        stopWatching()
        panel?.orderOut(nil)
    }

    deinit { stopWatching() }

    func dismissIfCovering(_ screenPoint: CGPoint) {
        guard let panel, panel.isVisible, let primary = NSScreen.screens.first else { return }
        let point = CGPoint(x: screenPoint.x, y: primary.frame.maxY - screenPoint.y)
        // 即使鼠标可穿透，CG/AX 遮挡查询仍可能看见浮层；收起自身提示后沿用完整检查。
        if panel.frame.contains(point) { dismiss() }
    }

    private func makePanel() -> ChromeToastPanel {
        let toast = ChromeToastPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                                     backing: .buffered, defer: false)
        toast.title = "AI正在操作Chrome窗口..."
        toast.isReleasedWhenClosed = false
        toast.isOpaque = false
        toast.backgroundColor = .clear
        toast.hasShadow = true
        toast.ignoresMouseEvents = true
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
        let label = NSTextField(labelWithString: toast.title)
        label.font = .systemFont(ofSize: 14, weight: .medium)
        label.textColor = .labelColor
        label.maximumNumberOfLines = 1
        let stack = NSStackView(views: [icon, label])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(stack)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 18), icon.heightAnchor.constraint(equalToConstant: 18),
            stack.centerXAnchor.constraint(equalTo: background.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: background.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: background.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: background.trailingAnchor, constant: -16),
        ])
        return toast
    }
}
