import { describe, expect, test } from 'bun:test'
import {
  patchDshComposerModelSelectionSource,
  patchDshDetailsPanelFilePreviewSource,
  patchDshCordisPanelSource,
  patchDshSidebarSource,
  DSH_PACKAGE,
  DSH_PACKAGE_VERSION,
  DSH_VERSION,
  DSH_INTEGRITY,
  DSH_ENTRYPOINT,
} from './prepare-dsh-module'

const MODEL_SELECT_SOURCE = `
const waiting = state.current === null && state.status === "loading";
const modelLabel = waiting ? t("trigger.loading") : currentChoice?.model.name ?? (state.current === null ? t("trigger.fallback") : \`${'${state.current.provider}/${state.current.model}'}\`);
const triggerLabel = effortLabel === void 0 ? modelLabel : \`${'${modelLabel} · ${effortLabel}'}\`;
const triggerAria = waiting ? t("trigger.loading") : state.current === null ? t("trigger.selectAria") : effortLabel === void 0 ? t("trigger.aria", { model: modelLabel }) : t("trigger.ariaEffort", {
  model: modelLabel,
  effort: effortLabel
});
(0, react_jsx_runtime.jsx)("span", {
  className: ModelSelect_module_css_default.triggerLabel,
  children: modelLabel
});
effortLabel !== void 0 && (0, react_jsx_runtime.jsx)("span", {
  className: ModelSelect_module_css_default.triggerEffort,
  children: effortLabel
}),
(0, react_jsx_runtime.jsx)("span", {
  className: ModelSelect_module_css_default.cellValue,
  children: modelLabel
});
`

describe('dsh 运行环境功能模块准备', () => {
  test('使用官方 npm 包并固定版本与入口', () => {
    expect(DSH_PACKAGE).toBe('@deepseek-ai/dsh')
    expect(DSH_PACKAGE_VERSION).toBe('0.1.2-rc.1')
    expect(DSH_VERSION).toBe('0.1.2')
    expect(DSH_ENTRYPOINT).toBe('bin/dsh')
    expect(DSH_INTEGRITY).toMatch(/^sha512-/)
  })

  test('Composer 触发器显示 Provider 与不含括号说明的模型名', () => {
    const patched = patchDshComposerModelSelectionSource(MODEL_SELECT_SOURCE)

    expect(patched).toContain('const triggerModelLabel = currentChoice === void 0 ? modelLabel : `${currentChoice.group.name} · ${currentChoice.model.name.replace(/\\s*[（(][^（）()]*[）)]\\s*$/u, "")}`')
    expect(patched).toContain('const triggerLabel = triggerModelLabel;')
    expect(patched).toContain('children: triggerModelLabel')
    expect(patched).toContain('className: ModelSelect_module_css_default.cellValue,\n  children: modelLabel')
    expect(patched).not.toContain('className: ModelSelect_module_css_default.triggerEffort')
  })

  test('Composer 补丁拒绝不匹配的官方 bundle', () => {
    expect(() => patchDshComposerModelSelectionSource('const modelLabel = "missing anchor";')).toThrow(
      'DSH Composer 模型选择组件结构与受支持版本不匹配',
    )
  })

  test('Composer 补丁可升级已写入模型标签的运行时', () => {
    const firstPass = patchDshComposerModelSelectionSource(MODEL_SELECT_SOURCE)
    const upgraded = patchDshComposerModelSelectionSource(firstPass)

    expect(upgraded).toBe(firstPass)
  })

  test('DetailsPanel 补丁拒绝不匹配的官方 bundle', () => {
    expect(() => patchDshDetailsPanelFilePreviewSource('const [activeTab, setActiveTab] = "unsupported";')).toThrow(
      'DSH Chat DetailsPanel 组件结构与受支持版本不匹配',
    )
  })

  test('DetailsPanel 补丁为详情面板注入文件点击预览、Tab 与高亮组件', () => {
    const SAMPLE_DETAILS_PANEL = `
const [activeTab, setActiveTab] = (0, react.useState)("files");
(0, react_jsx_runtime.jsx)("span", { children: material?.name ?? "工具详情" })
										]
									})
								]
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: DetailsPanel_module_css_default.close,
allFiles.map((file) => (0, react_jsx_runtime.jsxs)("div", {
													key: file.path,
													style: {
														display: "flex",
														alignItems: "center",
														gap: "6px",
														padding: "6px 8px",
														borderRadius: "6px",
														background: "var(--dsw-alias-button-elevated-fill, rgba(120, 120, 128, 0.05))",
														fontSize: "12px",
														color: "var(--dsw-alias-label-primary)"
													},
													children: [
														(0, react_jsx_runtime.jsx)("svg", {
															width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8",
															children: (0, react_jsx_runtime.jsx)("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" })
														}),
														(0, react_jsx_runtime.jsx)("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: file.name })
													]
												}))
modifiedFiles.map((file) => (0, react_jsx_runtime.jsxs)("div", {
											key: file.path,
											style: {
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												gap: "6px",
												padding: "6px 8px",
												borderRadius: "6px",
												background: "var(--dsw-alias-button-elevated-fill, rgba(120, 120, 128, 0.05))",
												fontSize: "12px",
												cursor: file.callId ? "pointer" : "default"
											},
											onClick: () => {
												if (file.callId) {
													useStore.getState?.()?.setSelection?.({ callId: file.callId });
													setActiveTab("tool");
												}
											},
											children: [
												(0, react_jsx_runtime.jsxs)("div", {
													style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0, flex: 1 },
													children: [
														(0, react_jsx_runtime.jsx)("span", {
															style: {
																padding: "1px 4px",
																borderRadius: "4px",
																fontSize: "10px",
																fontWeight: 700,
																background: file.type === "add" ? "rgba(34, 197, 94, 0.15)" : "rgba(245, 158, 11, 0.15)",
																color: file.type === "add" ? "#22c55e" : "#f59e0b"
															},
															children: file.type === "add" ? "A" : "M"
														}),
														(0, react_jsx_runtime.jsx)("span", {
															style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary)" },
															children: file.name
														})
													]
												}),
												(0, react_jsx_runtime.jsx)("span", {
													style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary)", flexShrink: 0 },
													children: file.type === "add" ? "新增" : "修改"
												})
											]
										}))
children: activeTab === "files" ? (
`
    const patched = patchDshDetailsPanelFilePreviewSource(SAMPLE_DETAILS_PANEL)

    expect(patched).toContain('const [previewingFile, setPreviewingFile]')
    expect(patched).toContain('const [expandedDirs, setExpandedDirs]')
    expect(patched).toContain('window.copisBridge?.listDirectory')
    expect(patched).toContain('placeholder: "搜索文件..."')
    expect(patched).toContain('renderTreeNodes')
    expect(patched).toContain('openPreview(file)')
    expect(patched).toContain('onClick: () => openPreview(file)')
    expect(patched).toContain('activeTab === "preview"')
    expect(patched).toContain('window.copisBridge?.readFile')
    expect(patched).toContain('window.copisBridge?.showItemInFolder')
    expect(patched).toContain('CodeBlock')
    expect(patched).toContain('stroke: "var(--creation-ui-primary, #6C00CC)"')
    expect(patched).not.toContain('stroke: "#f59e0b"')

    // 幂等性校验
    const secondPass = patchDshDetailsPanelFilePreviewSource(patched)
    expect(secondPass).toBe(patched)
  })

  test('DetailsPanel 补丁可将已打第一代补丁的源码无缝升级为工作区树与预览', () => {
    const V1_SOURCE = `
const [activeTab, setActiveTab] = (0, react.useState)("files");
			const [previewingFile, setPreviewingFile] = (0, react.useState)(null);
			const [previewState, setPreviewState] = (0, react.useState)({ loading: false, content: "", error: null, isImage: false, imageUrl: "" });
			const openPreview = (file) => {
				setPreviewingFile(file);
				setActiveTab("preview");
				setPreviewState({ loading: true, content: "", error: null, isImage: false, imageUrl: "" });
				if (typeof window !== "undefined" && window.copisBridge?.readFile) {
					window.copisBridge.readFile(file.path, sessionCwd).then((res) => {
						if (!res) {
							setPreviewState({ loading: false, content: "", error: "无法读取文件", isImage: false, imageUrl: "" });
						} else if (!res.success) {
							setPreviewState({ loading: false, content: "", error: res.error || "读取失败", isImage: false, imageUrl: "" });
						} else if (res.isImage) {
							setPreviewState({ loading: false, content: "", error: null, isImage: true, imageUrl: res.content });
						} else {
							setPreviewState({ loading: false, content: res.content || "", error: null, isImage: false, imageUrl: "" });
						}
					}).catch((err) => {
						setPreviewState({ loading: false, content: "", error: String(err?.message || err), isImage: false, imageUrl: "" });
					});
				} else {
					setPreviewState({ loading: false, content: "", error: "未连接到 Copis 文件桥接服务", isImage: false, imageUrl: "" });
				}
			};
(0, react_jsx_runtime.jsx)("path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 8 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" })
(0, react_jsx_runtime.jsx)("span", { children: "文件" })
) : activeTab === "files" ? (
(0, react_jsx_runtime.jsxs)("div", {
style: { display: "flex", flexDirection: "column", gap: "10px" },
children: "old files body"
})
) : activeTab === "changes" ? (
`
    const upgraded = patchDshDetailsPanelFilePreviewSource(V1_SOURCE)
    expect(upgraded).toContain('const [expandedDirs, setExpandedDirs]')
    expect(upgraded).toContain('(0, react_jsx_runtime.jsx)("span", { children: "工作区" })')
    expect(upgraded).toContain('window.copisBridge?.listDirectory')
    expect(upgraded).toContain('placeholder: "搜索文件..."')
    expect(upgraded).not.toContain('(0, react_jsx_runtime.jsx)("span", { children: "文件" })')
    expect(upgraded).not.toContain('children: "old files body"')

    // 幂等性校验
    const secondPass = patchDshDetailsPanelFilePreviewSource(upgraded)
    expect(secondPass).toBe(upgraded)
    expect(upgraded).not.toContain('\t\t\t\t\t\t)\n\t\t\t\t\t\t) : activeTab === "changes" ? (')
  })

  test('DetailsPanel 补丁可自愈修复已存在的多余右括号语法错误并升级文件夹图标主题色', () => {
    const BROKEN_SOURCE = `
const [expandedDirs, setExpandedDirs] = (0, react.useState)(() => new Set());
\t\t\t\t\t\t)
\t\t\t\t\t\t) : activeTab === "changes" ? (
stroke: "#f59e0b",
`
    const healed = patchDshDetailsPanelFilePreviewSource(BROKEN_SOURCE)
    expect(healed).not.toContain('\t\t\t\t\t\t)\n\t\t\t\t\t\t) : activeTab === "changes" ? (')
    expect(healed).toContain('\t\t\t\t\t\t)\n\t\t\t\t\t\t: activeTab === "changes" ? (')
    expect(healed).not.toContain('stroke: "#f59e0b"')
    expect(healed).toContain('stroke: "var(--creation-ui-primary, #6C00CC)"')
  })

  test('CordisPanel 补丁拒绝不匹配的官方 bundle', () => {
    expect(() => patchDshCordisPanelSource('export const foo = 1;')).toThrow(
      'DSH Cordis Panel 组件未找到 panel.title 结构'
    )
  })

  test('CordisPanel 补丁将「Cordis 插件」替换为「Copis 请您确认」', () => {
    const SAMPLE_SOURCE = `
const zh = {
  "panel.plugins.aria": "Cordis 插件",
  "panel.title": "Cordis 插件",
  "panel.trigger": "Cordis Plugin",
};
`
    const patched = patchDshCordisPanelSource(SAMPLE_SOURCE)
    expect(patched).toContain('"panel.title": "Copis 请您确认"')
    expect(patched).toContain('"panel.plugins.aria": "Copis 请您确认"')
    expect(patched).not.toContain('"panel.title": "Cordis 插件"')
    expect(patched).not.toContain('"panel.plugins.aria": "Cordis 插件"')

    // 幂等性校验
    const secondPass = patchDshCordisPanelSource(patched)
    expect(secondPass).toBe(patched)
  })

  test('Sidebar 补丁将侧边栏菜单项激活态背景与颜色设置为 creation-ui-primary 体系并移除边框', () => {
    const SAMPLE_SIDEBAR = `
const CopisMenuItem = (props) => {
  const isActive = activeCopisNav === props.view;
  return (0, react_jsx_runtime.jsxs)("button", {
    type: "button",
    style: {
      border: isActive ? "0.5px solid rgba(245, 158, 11, 0.35)" : "none",
      background: isActive ? "var(--dsw-alias-button-elevated-fill, rgba(245, 158, 11, 0.14))" : "transparent",
      color: isActive ? "#f59e0b" : "var(--dsw-alias-label-secondary)",
    }
  });
};
`
    const patched = patchDshSidebarSource(SAMPLE_SIDEBAR)
    expect(patched).toContain('border: "none"')
    expect(patched).toContain('background: isActive ? "var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15))" : "transparent"')
    expect(patched).toContain('color: isActive ? "var(--creation-ui-primary, #6C00CC)" : "var(--dsw-alias-label-secondary)"')
    expect(patched).not.toContain('rgba(245, 158, 11')
    expect(patched).not.toContain('#f59e0b')

    // 幂等性校验
    const secondPass = patchDshSidebarSource(patched)
    expect(secondPass).toBe(patched)
  })
})

