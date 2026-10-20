import Foundation
import ImageIO
import Darwin

// 只读采集允许切换后端；窗口身份、几何、权限和取消失败必须直接向上传递。
final class WindowCaptureStrategy {
    private(set) var usesFallback = false

    func capture<Image>(primary: () throws -> Image, fallback: () throws -> Image) throws -> Image {
        if usesFallback { return try fallback() }
        do { return try primary() }
        catch let failure as HelperFailure where ["CAPTURE_TIMEOUT", "CAPTURE_FAILED", "CAPTURE_WINDOW_LIST_TIMEOUT", "CAPTURE_IMAGE_TIMEOUT"].contains(failure.code) {
            let image = try fallback()
            // 同一个 Helper 后续观察不再反复等待已失效的系统服务；重启后重新尝试。
            usesFallback = true
            return image
        }
    }
}

func withWindowCaptureProcess<Value>(_ process: Process, cancellation: InputCancellation,
                                     generation: UInt64, timeout: TimeInterval = 6,
                                     cleanup: @escaping () -> Void = {}, readOutput: () throws -> Value) throws -> Value {
    try cancellation.check(generation)
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    let lease = try cancellation.protectCapture(generation: generation) {
        // 先终止并回收子进程，再清理私有文件；ACK 后不能留下脱离 Helper 的截图任务。
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
            process.waitUntilExit()
        }
        cleanup()
    }
    defer { cancellation.finishCapture(lease) }
    do { try cancellation.effect(generation: generation) { try process.run() } }
    catch let failure as HelperFailure { throw failure }
    catch { throw HelperFailure(code: "CAPTURE_FALLBACK_FAILED", message: "无法启动系统窗口截图后端") }
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    while process.isRunning {
        try cancellation.check(generation)
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            throw HelperFailure(code: "CAPTURE_FALLBACK_TIMEOUT", message: "系统窗口截图后端响应超时")
        }
        Thread.sleep(forTimeInterval: 0.025)
    }
    try cancellation.check(generation)
    guard process.terminationReason == .exit, process.terminationStatus == 0 else {
        throw HelperFailure(code: "CAPTURE_FALLBACK_FAILED", message: "系统窗口截图后端未返回成功结果")
    }
    let value = try readOutput()
    try cancellation.check(generation)
    return value
}

func normalizeWindowCapture(url: URL, bounds: WindowBounds) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Double,
          let height = properties[kCGImagePropertyPixelHeight] as? Double,
          width.isFinite, height.isFinite, width > 0, height > 0 else {
        throw HelperFailure(code: "CAPTURE_FALLBACK_FAILED", message: "系统窗口截图后端未生成有效图像")
    }
    // 单窗口 -o 不带阴影；两轴必须使用同一个缩放比例，不允许把裁切图静默拉伸。
    let scale = width / bounds.width
    guard scale.isFinite, scale >= 1, height == bounds.height * scale else {
        throw HelperFailure(code: "IMAGE_GEOMETRY_CHANGED", message: "系统窗口截图区域与目标窗口不一致，请重新观察")
    }
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                  kCGImageSourceThumbnailMaxPixelSize: 1600,
                                  kCGImageSourceCreateThumbnailWithTransform: false]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
          image.width > 0, image.height > 0, max(image.width, image.height) <= 1600 else {
        throw HelperFailure(code: "CAPTURE_FALLBACK_FAILED", message: "无法缩放系统窗口截图")
    }
    return image
}

func captureSystemWindow(_ target: TargetWindow, bounds: WindowBounds, desktop: ChromeDesktop,
                         cancellation: InputCancellation, generation: UInt64) throws -> CGImage {
    try cancellation.check(generation)
    try desktop.requireScreenPermission()
    try desktop.verifyGeometry(target, expected: bounds)
    var template = Array((NSTemporaryDirectory() + "/copis-window-capture.XXXXXX").utf8CString)
    guard let directory = mkdtemp(&template) else {
        throw HelperFailure(code: "CAPTURE_FALLBACK_FAILED", message: "无法准备私有窗口截图目录")
    }
    let root = URL(fileURLWithPath: String(cString: directory), isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let output = root.appendingPathComponent("window.png")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    // 固定系统路径、独立 argv；只截精确窗口，不截图整屏、不启动交互选择器、不写剪贴板。
    process.arguments = ["-x", "-o", "-a", "-l", String(target.windowId), "-t", "png", output.path]
    return try withWindowCaptureProcess(process, cancellation: cancellation, generation: generation, cleanup: {
        try? FileManager.default.removeItem(at: root)
    }, readOutput: {
        try desktop.verifyGeometry(target, expected: bounds)
        return try normalizeWindowCapture(url: output, bounds: bounds)
    })
}
