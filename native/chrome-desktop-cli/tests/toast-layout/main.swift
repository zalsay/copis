import Foundation

private func require(_ value: Bool, _ message: String) {
    if !value { fputs("FAIL: \(message)\n", stderr); exit(1) }
}

let primary = ChromeToastScreen(frame: CGRect(x: 0, y: 0, width: 1440, height: 900),
                                visibleFrame: CGRect(x: 0, y: 0, width: 1440, height: 875))
let right = ChromeToastScreen(frame: CGRect(x: 1440, y: 0, width: 1920, height: 1080),
                              visibleFrame: CGRect(x: 1440, y: 0, width: 1920, height: 1055))
let above = ChromeToastScreen(frame: CGRect(x: 0, y: 900, width: 1440, height: 900),
                              visibleFrame: CGRect(x: 0, y: 900, width: 1440, height: 875))
let left = ChromeToastScreen(frame: CGRect(x: -1280, y: 0, width: 1280, height: 800),
                             visibleFrame: CGRect(x: -1280, y: 0, width: 1280, height: 775))

// Given 主屏幕普通窗口，Then 提示在可见区域顶部居中并避让菜单栏。
let mainFrame = chromeToastFrame(window: WindowBounds(x: 100, y: 100, width: 800, height: 600), screens: [primary])
require(mainFrame == CGRect(x: 540, y: 799, width: 360, height: 52), "主屏幕 toast 位置错误")

// Given 跨屏窗口，Then 使用覆盖面积最大的屏幕，而非鼠标所在屏幕。
let spanning = chromeToastFrame(window: WindowBounds(x: 1300, y: 100, width: 800, height: 600), screens: [primary, right])
require(spanning == CGRect(x: 2220, y: 979, width: 360, height: 52), "跨屏 toast 没有落在目标窗口主屏幕")

// Given 副屏在主屏上方/左侧，Then 正确转换 CG 顶部原点和 AppKit 底部原点。
let upperFrame = chromeToastFrame(window: WindowBounds(x: 100, y: -800, width: 800, height: 600), screens: [primary, above])
require(upperFrame == CGRect(x: 540, y: 1699, width: 360, height: 52), "上方副屏坐标转换错误")
let leftFrame = chromeToastFrame(window: WindowBounds(x: -1100, y: 200, width: 800, height: 500), screens: [primary, left])
require(leftFrame == CGRect(x: -820, y: 699, width: 360, height: 52), "负坐标副屏位置错误")

// Given 很窄的屏幕，Then 提示仍位于可见区域内。
let narrow = ChromeToastScreen(frame: CGRect(x: 0, y: 0, width: 320, height: 700),
                               visibleFrame: CGRect(x: 0, y: 0, width: 320, height: 675))
let narrowFrame = chromeToastFrame(window: WindowBounds(x: 0, y: 0, width: 320, height: 700), screens: [narrow])
require(narrowFrame == CGRect(x: 16, y: 599, width: 288, height: 52), "窄屏 toast 超出可见区域")

// Given 无可用屏幕或目标在全部屏幕外，Then 不猜测显示位置。
require(chromeToastFrame(window: WindowBounds(x: 0, y: 0, width: 800, height: 600), screens: []) == nil, "无屏幕时应跳过 toast")
require(chromeToastFrame(window: WindowBounds(x: 5000, y: 0, width: 800, height: 600), screens: [primary]) == nil, "离屏目标不应在其他屏幕弹 toast")
print("PASS: 7 项 toast 布局 BDD 回归；未创建窗口或发送输入")
