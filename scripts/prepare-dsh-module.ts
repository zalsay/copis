#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import type { FunctionalModuleArchitecture, FunctionalModulePlatform } from '@copis/shared'
import { patchDshComposerHistoryRuntime } from '../apps/electron/src/main/lib/dsh-composer-history-patch'
export { patchDshSidebarRuntime, patchDshSidebarSource } from '../apps/electron/src/main/lib/dsh-sidebar-patch'

export const DSH_PACKAGE = '@deepseek-ai/dsh'
export const DSH_PACKAGE_VERSION = '0.1.2-rc.1'
export const DSH_VERSION = '0.1.2'
export const DSH_INTEGRITY = 'sha512-RPq48TzxvwpdT9/7W1tbhZDBMmeK+bxDrX9cqQC27Wx/LqtgJF8PSa3b3xriU8oxtvhwYmk21w2cej3uMQrnVA=='
export const DSH_ENTRYPOINT = 'bin/dsh'
const DSH_RUNTIME_ENTRYPOINT = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const DSH_MODEL_SELECTION_CLIENT_ENTRYPOINT = 'node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js'
export const DSH_CHAT_CLIENT_ENTRYPOINT = 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'
export const DSH_CORDIS_CLIENT_ENTRYPOINT = 'node_modules/@deepseek-ai/dsh-client-ui-cordis/lib/client.js'

const DSH_MODEL_SELECT_MODEL_LABEL_PATTERN = /^([\t ]*)const modelLabel = waiting \? t\("trigger\.loading"\) : currentChoice\?\.model\.name \?\? \(state\.current === null \? t\("trigger\.fallback"\) : `\$\{state\.current\.provider\}\/\$\{state\.current\.model\}`\);$/gm
const DSH_MODEL_SELECT_TRIGGER_LABEL_PATTERN = /^([\t ]*)const triggerLabel = effortLabel === void 0 \? modelLabel : `\$\{modelLabel\} · \$\{effortLabel\}`;$/gm
const DSH_MODEL_SELECT_TRIGGER_MODEL_LABEL = `const triggerModelLabel = currentChoice === void 0 ? modelLabel : \`${'${currentChoice.group.name} · ${currentChoice.model.name.replace(/\\s*[（(][^（）()]*[）)]\\s*$/u, "")}'}\`;`
const DSH_MODEL_SELECT_TRIGGER_LABEL_REPLACEMENT = 'const triggerLabel = triggerModelLabel;'

const DSH_MODEL_SELECT_TRIGGER_CHILD_PATTERN = /(className: ModelSelect_module_css_default\.triggerLabel,\s+children:\s*)(?:modelLabel|triggerModelLabel)/g
const DSH_MODEL_SELECT_TRIGGER_EFFORT_PATTERN = /\s*effortLabel !== void 0 && \(0, react_jsx_runtime\.jsx\)\("span", \{\s*className: ModelSelect_module_css_default\.triggerEffort,\s*children: effortLabel\s*\}\),/g

interface PreparedDshModuleMetadata {
  version: string
  packageVersion: string
  package: string
  path: string
}

if (import.meta.main) main()

export function main(): void {
  const platform = parsePlatform(option('--platform') ?? process.platform)
  const arch = parseArchitecture(option('--arch') ?? process.arch)
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('dsh 运行环境只能在当前本机平台和架构准备')
  }

  const output = resolve(option('--output') ?? `apps/electron/resources/dsh/${platform}-${arch}.tar.gz`)
  const metadataOutput = option('--metadata')
  const staging = mkdtempSync(join(tmpdir(), 'copis-dsh-module-'))
  try {
    const moduleRoot = join(staging, 'module')
    const runtimeRoot = join(moduleRoot, 'runtime')
    installOfficialCli(runtimeRoot, join(staging, 'package-cache'))
    patchDshComposerModelSelectionRuntime(runtimeRoot)
    patchDshDetailsPanelFilePreviewRuntime(runtimeRoot)
    patchDshCordisPanelRuntime(runtimeRoot)
    patchDshSidebarRuntime(runtimeRoot)
    if (!patchDshComposerHistoryRuntime(runtimeRoot)) throw new Error('官方 dsh 缺少 Composer 输入组件')
    if (!isFile(join(runtimeRoot, DSH_RUNTIME_ENTRYPOINT))) {
      throw new Error(`官方 dsh 缺少入口文件: ${DSH_RUNTIME_ENTRYPOINT}`)
    }
    writeLaunchers(moduleRoot, platform)
    normalizeTimestamps(moduleRoot)
    createArchive(moduleRoot, output)

    if (metadataOutput) {
      const metadata: PreparedDshModuleMetadata = {
        version: DSH_VERSION,
        packageVersion: DSH_PACKAGE_VERSION,
        package: DSH_PACKAGE,
        path: output,
      }
      const path = resolve(metadataOutput)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    }
    console.log(`[prepare:dsh-module] 已生成 ${output}（dsh v${DSH_VERSION}，官方包 v${DSH_PACKAGE_VERSION}）`)
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/**
 * Composer 的模型触发器需要与菜单区分展示：菜单保留完整说明，触发器仅展示 Provider 与基础模型名。
 * 该补丁锚定在固定的官方 DSH 版本；上游构建结构变化时直接失败，避免静默产出错误模块。
 */
export function patchDshComposerModelSelectionRuntime(runtimeRoot: string): void {
  const entrypoint = join(runtimeRoot, DSH_MODEL_SELECTION_CLIENT_ENTRYPOINT)
  if (!isFile(entrypoint)) {
    throw new Error(`官方 dsh 缺少 Composer 模型选择组件: ${entrypoint}`)
  }
  const source = readFileSync(entrypoint, 'utf8')
  writeFileSync(entrypoint, patchDshComposerModelSelectionSource(source), 'utf8')
}

/** 导出纯文本变换，供构建期测试验证官方 bundle 的结构锚点。 */
export function patchDshComposerModelSelectionSource(source: string): string {
  const triggerChildMatches = source.match(DSH_MODEL_SELECT_TRIGGER_CHILD_PATTERN)
  const triggerEffortMatches = source.match(DSH_MODEL_SELECT_TRIGGER_EFFORT_PATTERN)
  const originalModelLabelMatches = source.match(DSH_MODEL_SELECT_MODEL_LABEL_PATTERN)
  const originalTriggerLabelMatches = source.match(DSH_MODEL_SELECT_TRIGGER_LABEL_PATTERN)
  const isPatched = source.includes(DSH_MODEL_SELECT_TRIGGER_MODEL_LABEL)
  if (
    originalModelLabelMatches?.length !== 1
    || (isPatched ? originalTriggerLabelMatches !== null : originalTriggerLabelMatches?.length !== 1)
    || triggerChildMatches?.length !== 1
    || (triggerEffortMatches !== null && triggerEffortMatches.length !== 1)
  ) {
    throw new Error('DSH Composer 模型选择组件结构与受支持版本不匹配')
  }
  const withLabels = isPatched
    ? source
    : source
      .replace(DSH_MODEL_SELECT_MODEL_LABEL_PATTERN, (line, indent: string) => `${line}\n${indent}${DSH_MODEL_SELECT_TRIGGER_MODEL_LABEL}`)
      .replace(DSH_MODEL_SELECT_TRIGGER_LABEL_PATTERN, (_line, indent: string) => `${indent}${DSH_MODEL_SELECT_TRIGGER_LABEL_REPLACEMENT}`)
  return withLabels
    .replace(DSH_MODEL_SELECT_TRIGGER_CHILD_PATTERN, '$1triggerModelLabel')
    .replace(DSH_MODEL_SELECT_TRIGGER_EFFORT_PATTERN, '')
}

/**
 * 为 DSH 详情面板（DetailsPanel）增加文件点击预览能力。
 * 点击工作区文件或已变更文件时，原地展开代码语法高亮或图片预览，并支持返回与系统定位。
 */
export function patchDshDetailsPanelFilePreviewRuntime(runtimeRoot: string): void {
  const entrypoint = join(runtimeRoot, DSH_CHAT_CLIENT_ENTRYPOINT)
  if (!isFile(entrypoint)) {
    throw new Error(`官方 dsh 缺少 Chat 详情面板组件: ${entrypoint}`)
  }
  const source = readFileSync(entrypoint, 'utf8')
  writeFileSync(entrypoint, patchDshDetailsPanelFilePreviewSource(source), 'utf8')
}

export function patchDshDetailsPanelFilePreviewSource(source: string): string {
  if (source.includes('const [expandedDirs, setExpandedDirs] =')) {
    let upgraded = source
    const brokenParen = '\t\t\t\t\t\t)\n\t\t\t\t\t\t) : activeTab === "changes" ? ('
    const fixedParen = '\t\t\t\t\t\t)\n\t\t\t\t\t\t: activeTab === "changes" ? ('
    if (upgraded.includes(brokenParen)) {
      upgraded = upgraded.replace(brokenParen, fixedParen)
    }
    if (upgraded.includes('stroke: "#f59e0b",')) {
      upgraded = upgraded.replace('stroke: "#f59e0b",', 'stroke: "var(--creation-ui-primary, #6C00CC)",')
    }
    return upgraded
  }

  const DECLARATIONS_CHUNK = `const [activeTab, setActiveTab] = (0, react.useState)("files");
			const [previewingFile, setPreviewingFile] = (0, react.useState)(null);
			const [previewState, setPreviewState] = (0, react.useState)({ loading: false, content: "", error: null, isImage: false, imageUrl: "" });
			const [filterText, setFilterText] = (0, react.useState)("");
			const [rootEntries, setRootEntries] = (0, react.useState)([]);
			const [expandedDirs, setExpandedDirs] = (0, react.useState)(() => new Set());
			const [childrenMap, setChildrenMap] = (0, react.useState)(() => new Map());
			const [loadingMap, setLoadingMap] = (0, react.useState)(() => new Map());
			const [isRootLoading, setIsRootLoading] = (0, react.useState)(false);
			const [refreshCount, setRefreshCount] = (0, react.useState)(0);

			(0, react.useEffect)(() => {
				if (!sessionCwd) return;
				let cancelled = false;
				setIsRootLoading(true);
				if (typeof window !== "undefined" && window.copisBridge?.listDirectory) {
					window.copisBridge.listDirectory(undefined, sessionCwd).then((entries) => {
						if (!cancelled) {
							setRootEntries(Array.isArray(entries) ? entries : []);
							setIsRootLoading(false);
						}
					}).catch(() => {
						if (!cancelled) {
							setRootEntries([]);
							setIsRootLoading(false);
						}
					});
				} else {
					setIsRootLoading(false);
				}
				return () => { cancelled = true; };
			}, [sessionCwd, refreshCount]);

			const toggleFolder = (folderPath) => {
				setExpandedDirs((prev) => {
					const next = new Set(prev);
					if (next.has(folderPath)) {
						next.delete(folderPath);
					} else {
						next.add(folderPath);
						if (!childrenMap.has(folderPath)) {
							setLoadingMap((lm) => new Map(lm).set(folderPath, true));
							if (typeof window !== "undefined" && window.copisBridge?.listDirectory) {
								window.copisBridge.listDirectory(folderPath, sessionCwd).then((kids) => {
									setChildrenMap((cm) => new Map(cm).set(folderPath, Array.isArray(kids) ? kids : []));
									setLoadingMap((lm) => { const n = new Map(lm); n.delete(folderPath); return n; });
								}).catch(() => {
									setChildrenMap((cm) => new Map(cm).set(folderPath, []));
									setLoadingMap((lm) => { const n = new Map(lm); n.delete(folderPath); return n; });
								});
							} else {
								setLoadingMap((lm) => { const n = new Map(lm); n.delete(folderPath); return n; });
							}
						}
					}
					return next;
				});
			};

			const handleRefresh = () => {
				setChildrenMap(new Map());
				setExpandedDirs(new Set());
				setRefreshCount((c) => c + 1);
			};

			const getFileIconColor = (name) => {
				const ext = (name || "").split(".").pop()?.toLowerCase();
				switch (ext) {
					case "ts": case "tsx": return "#3178c6";
					case "js": case "jsx": case "mjs": case "cjs": return "#f59e0b";
					case "vue": return "#42b883";
					case "html": case "htm": return "#e44d26";
					case "css": case "scss": case "less": return "#06b6d4";
					case "json": return "#eab308";
					case "md": case "markdown": return "#3b82f6";
					case "py": return "#38bdf8";
					case "rs": return "#f97316";
					case "sh": case "bash": case "zsh": return "#22c55e";
					case "yaml": case "yml": return "#a855f7";
					case "png": case "jpg": case "jpeg": case "gif": case "svg": case "webp": case "ico": return "#ec4899";
					default: return "var(--dsw-alias-label-tertiary)";
				}
			};

			const formatSize = (bytes) => {
				if (bytes === void 0 || bytes === null) return "";
				if (bytes < 1024) return bytes + " B";
				if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
				return (bytes / (1024 * 1024)).toFixed(1) + " MB";
			};

			const allLoadedFiles = (0, react.useMemo)(() => {
				const list = [];
				const scan = (items) => {
					for (const item of items) {
						if (item.isDirectory) {
							const kids = childrenMap.get(item.path);
							if (kids) scan(kids);
						} else {
							list.push(item);
						}
					}
				};
				scan(rootEntries);
				return list;
			}, [rootEntries, childrenMap]);

			const filteredFiles = (0, react.useMemo)(() => {
				const q = filterText.trim().toLowerCase();
				if (!q) return [];
				return allLoadedFiles.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
			}, [filterText, allLoadedFiles]);

			const renderTreeNodes = (items, depth = 0) => {
				return items.map((item) => {
					const isDir = item.isDirectory;
					const isExpanded = isDir && expandedDirs.has(item.path);
					const isLoadingChild = isDir && loadingMap.get(item.path);
					const children = isDir ? (childrenMap.get(item.path) || []) : [];
					const isSelected = previewingFile?.path === item.path && activeTab === "preview";

					return (0, react_jsx_runtime.jsxs)("div", {
						key: item.path,
						style: { display: "flex", flexDirection: "column" },
						children: [
							(0, react_jsx_runtime.jsxs)("div", {
								onClick: () => {
									if (isDir) {
										toggleFolder(item.path);
									} else {
										openPreview(item);
									}
								},
								style: {
									display: "flex",
									alignItems: "center",
									gap: "6px",
									padding: "4px 8px 4px " + (depth * 14 + 6) + "px",
									borderRadius: "4px",
									background: isSelected ? "var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.18))" : "transparent",
									cursor: "pointer",
									fontSize: "12px",
									color: "var(--dsw-alias-label-primary)",
									transition: "background 0.12s ease",
									position: "relative"
								},
								onMouseEnter: (e) => { if (!isSelected) e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.08))"; },
								onMouseLeave: (e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; },
								title: item.path,
								children: [
									isDir ? (
										(0, react_jsx_runtime.jsx)("svg", {
											width: "10",
											height: "10",
											viewBox: "0 0 24 24",
											fill: "none",
											stroke: "currentColor",
											strokeWidth: "2.5",
											strokeLinecap: "round",
											strokeLinejoin: "round",
											style: {
												flexShrink: 0,
												transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
												transition: "transform 0.15s ease",
												color: "var(--dsw-alias-label-tertiary)"
											},
											children: (0, react_jsx_runtime.jsx)("polyline", { points: "9 18 15 12 9 6" })
										})
									) : (
										(0, react_jsx_runtime.jsx)("span", { style: { width: "10px", flexShrink: 0 } })
									),
									isDir ? (
										(0, react_jsx_runtime.jsx)("svg", {
											width: "14",
											height: "14",
											viewBox: "0 0 24 24",
											fill: "none",
											stroke: "var(--creation-ui-primary, #6C00CC)",
											strokeWidth: "1.8",
											style: { flexShrink: 0 },
											children: (0, react_jsx_runtime.jsx)("path", { d: isExpanded ? "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" : "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 8 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" })
										})
									) : (
										(0, react_jsx_runtime.jsx)("svg", {
											width: "14",
											height: "14",
											viewBox: "0 0 24 24",
											fill: "none",
											stroke: getFileIconColor(item.name),
											strokeWidth: "1.8",
											style: { flexShrink: 0 },
											children: (0, react_jsx_runtime.jsx)("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" })
										})
									),
									(0, react_jsx_runtime.jsx)("span", {
										style: {
											flex: 1,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
											fontWeight: isDir ? 500 : 400
										},
										children: item.name
									}),
									!isDir && item.size !== void 0 && (0, react_jsx_runtime.jsx)("span", {
										style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary)", flexShrink: 0 },
										children: formatSize(item.size)
									})
								]
							}),
							isDir && isExpanded && (
								isLoadingChild ? (
									(0, react_jsx_runtime.jsx)("div", {
										style: { padding: "4px 8px 4px " + ((depth + 1) * 14 + 20) + "px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
										children: "加载中..."
									})
								) : children.length === 0 ? (
									(0, react_jsx_runtime.jsx)("div", {
										style: { padding: "4px 8px 4px " + ((depth + 1) * 14 + 20) + "px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", fontStyle: "italic" },
										children: "(空目录)"
									})
								) : (
									renderTreeNodes(children, depth + 1)
								)
							)
						]
					});
				});
			};

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
			};`

  const PREVIEW_CHUNK = `							previewingFile ? (
								(0, react_jsx_runtime.jsxs)("div", {
									style: { display: "flex", flexDirection: "column", height: "100%", gap: "8px" },
									children: [
										(0, react_jsx_runtime.jsxs)("div", {
											style: {
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												padding: "6px 8px",
												borderRadius: "6px",
												background: "var(--dsw-alias-input-bg, rgba(120, 120, 128, 0.08))",
												border: "0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.06))",
												fontSize: "11px",
												color: "var(--dsw-alias-label-secondary)"
											},
											children: [
												(0, react_jsx_runtime.jsxs)("div", {
													style: { display: "flex", alignItems: "center", gap: "6px", overflow: "hidden", minWidth: 0 },
													children: [
														(0, react_jsx_runtime.jsxs)("button", {
															type: "button",
															style: {
																background: "transparent",
																border: "none",
																cursor: "pointer",
																display: "flex",
																alignItems: "center",
																gap: "2px",
																color: "var(--dsw-alias-label-secondary)",
																padding: "2px 4px",
																borderRadius: "4px"
															},
															onClick: () => setActiveTab("files"),
															children: [
																(0, react_jsx_runtime.jsx)("svg", {
																	width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2",
																	children: (0, react_jsx_runtime.jsx)("polyline", { points: "15 18 9 12 15 6" })
																}),
																(0, react_jsx_runtime.jsx)("span", { children: "返回" })
															]
														}),
														(0, react_jsx_runtime.jsx)("span", {
															style: { fontWeight: 600, color: "var(--dsw-alias-label-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
															title: previewingFile.path,
															children: previewingFile.name
														})
													]
												}),
												(0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													style: {
														background: "transparent",
														border: "none",
														cursor: "pointer",
														color: "var(--dsw-alias-label-secondary)",
														padding: "2px 4px",
														borderRadius: "4px",
														fontSize: "11px",
														display: "flex",
														alignItems: "center",
														gap: "3px"
													},
													onClick: () => {
														if (typeof window !== "undefined" && window.copisBridge?.showItemInFolder) {
															window.copisBridge.showItemInFolder(previewingFile.path, sessionCwd);
														}
													},
													title: "在系统文件管理器中显示",
													children: [
														(0, react_jsx_runtime.jsx)("svg", {
															width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8",
															children: (0, react_jsx_runtime.jsx)("path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" })
														}),
														(0, react_jsx_runtime.jsx)("span", { children: "定位" })
													]
												})
											]
										}),
										previewState.loading ? (
											(0, react_jsx_runtime.jsx)("div", {
												style: { textAlign: "center", padding: "40px 10px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
												children: (0, react_jsx_runtime.jsx)("p", { children: "正在读取文件内容..." })
											})
										) : previewState.error ? (
											(0, react_jsx_runtime.jsxs)("div", {
												style: {
													padding: "16px",
													borderRadius: "8px",
													background: "rgba(239, 68, 68, 0.08)",
													border: "0.5px solid rgba(239, 68, 68, 0.2)",
													color: "var(--dsw-alias-label-secondary)",
													fontSize: "12px",
													textAlign: "center"
												},
												children: [
													(0, react_jsx_runtime.jsx)("p", { style: { color: "#ef4444", fontWeight: 600, marginBottom: "4px" }, children: "预览失败" }),
													(0, react_jsx_runtime.jsx)("p", { children: previewState.error }),
													(0, react_jsx_runtime.jsx)("button", {
														type: "button",
														style: {
															marginTop: "10px",
															padding: "4px 10px",
															borderRadius: "6px",
															border: "none",
															background: "var(--dsw-alias-button-elevated-fill, rgba(120, 120, 128, 0.15))",
															cursor: "pointer",
															fontSize: "11px",
															color: "var(--dsw-alias-label-primary)"
														},
														onClick: () => openPreview(previewingFile),
														children: "重试"
													})
												]
											})
										) : previewState.isImage ? (
											(0, react_jsx_runtime.jsx)("div", {
												style: { display: "flex", alignItems: "center", justifyContent: "center", flex: 1, padding: "10px", overflow: "auto" },
												children: (0, react_jsx_runtime.jsx)("img", {
													src: previewState.imageUrl,
													alt: previewingFile.name,
													style: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: "6px" }
												})
											})
										) : (
											(0, react_jsx_runtime.jsx)("div", {
												style: { flex: 1, overflow: "auto", borderRadius: "6px" },
												children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.CodeBlock, {
													code: previewState.content || "// 空文件",
													lang: ((fn) => {
														const ext = (fn || "").split(".").pop()?.toLowerCase();
														switch (ext) {
															case "ts": return "typescript";
															case "tsx": return "tsx";
															case "js": case "mjs": case "cjs": return "javascript";
															case "jsx": return "jsx";
															case "json": return "json";
															case "html": case "htm": return "html";
															case "css": case "scss": case "less": return "css";
															case "md": case "markdown": return "markdown";
															case "py": return "python";
															case "rs": return "rust";
															case "sh": case "bash": case "zsh": return "bash";
															case "yaml": case "yml": return "yaml";
															case "toml": return "toml";
															case "sql": return "sql";
															default: return "text";
														}
													})(previewingFile.name),
													copyLabel: t("copy") || "复制",
													copiedLabel: t("copied") || "已复制"
												})
											})
										)
									]
								})
							) : (
								(0, react_jsx_runtime.jsx)("div", {
									style: { textAlign: "center", padding: "30px 10px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
									children: (0, react_jsx_runtime.jsx)("p", { children: "请从文件列表选择要预览的文件" })
								})
							)`

  const WORKSPACE_TREE_BODY_CONTENT = `activeTab === "files" ? (
							(0, react_jsx_runtime.jsxs)("div", {
								style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
								children: [
									(0, react_jsx_runtime.jsxs)("div", {
										style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px", flexShrink: 0 },
										children: [
											(0, react_jsx_runtime.jsxs)("div", {
												style: {
													display: "flex",
													alignItems: "center",
													flex: 1,
													padding: "3px 8px",
													borderRadius: "6px",
													background: "var(--dsw-alias-input-bg, rgba(120, 120, 128, 0.08))",
													border: "0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08))",
													gap: "6px"
												},
												children: [
													(0, react_jsx_runtime.jsxs)("svg", {
														width: "12",
														height: "12",
														viewBox: "0 0 24 24",
														fill: "none",
														stroke: "currentColor",
														strokeWidth: "2",
														style: { color: "var(--dsw-alias-label-tertiary)", flexShrink: 0 },
														children: [
															(0, react_jsx_runtime.jsx)("circle", { cx: "11", cy: "11", r: "8" }),
															(0, react_jsx_runtime.jsx)("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" })
														]
													}),
													(0, react_jsx_runtime.jsx)("input", {
														type: "text",
														placeholder: "搜索文件...",
														value: filterText,
														onChange: (e) => setFilterText(e.target.value),
														style: {
															background: "transparent",
															border: "none",
															outline: "none",
															fontSize: "12px",
															color: "var(--dsw-alias-label-primary)",
															width: "100%",
															padding: 0
														}
													}),
													filterText ? (
														(0, react_jsx_runtime.jsx)("button", {
															type: "button",
															onClick: () => setFilterText(""),
															style: {
																background: "transparent",
																border: "none",
																cursor: "pointer",
																padding: "0 2px",
																display: "flex",
																alignItems: "center",
																color: "var(--dsw-alias-label-tertiary)"
															},
															children: (0, react_jsx_runtime.jsx)("svg", {
																width: "10",
																height: "10",
																viewBox: "0 0 16 16",
																fill: "none",
																stroke: "currentColor",
																strokeWidth: "2",
																children: (0, react_jsx_runtime.jsx)("path", { d: "M4 4l8 8M12 4l-8 8" })
															})
														})
													) : null
												]
											}),
											(0, react_jsx_runtime.jsx)("button", {
												type: "button",
												onClick: handleRefresh,
												title: "刷新工作区文件树",
												style: {
													background: "var(--dsw-alias-button-elevated-fill, rgba(120, 120, 128, 0.08))",
													border: "0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08))",
													borderRadius: "6px",
													padding: "5px 7px",
													cursor: "pointer",
													display: "flex",
													alignItems: "center",
													color: "var(--dsw-alias-label-secondary)"
												},
												children: (0, react_jsx_runtime.jsxs)("svg", {
													width: "12",
													height: "12",
													viewBox: "0 0 24 24",
													fill: "none",
													stroke: "currentColor",
													strokeWidth: "2",
													children: [
														(0, react_jsx_runtime.jsx)("polyline", { points: "23 4 23 10 17 10" }),
														(0, react_jsx_runtime.jsx)("path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10" })
													]
												})
											})
										]
									}),
									sessionCwd ? (
										(0, react_jsx_runtime.jsxs)("div", {
											style: {
												padding: "4px 8px",
												borderRadius: "4px",
												background: "var(--dsw-alias-input-bg, rgba(120, 120, 128, 0.04))",
												fontSize: "11px",
												color: "var(--dsw-alias-label-tertiary)",
												marginBottom: "6px",
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
												flexShrink: 0
											},
											title: sessionCwd,
											children: [
												(0, react_jsx_runtime.jsx)("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-secondary)", marginRight: "4px" }, children: "根目录:" }),
												sessionCwd.split("/").pop() || sessionCwd
											]
										})
									) : null,
									(0, react_jsx_runtime.jsx)("div", {
										style: { flex: 1, minHeight: 0, overflowY: "auto" },
										children: filterText.trim() ? (
											filteredFiles.length > 0 ? (
												(0, react_jsx_runtime.jsxs)("div", {
													style: { display: "flex", flexDirection: "column", gap: "2px" },
													children: [
														(0, react_jsx_runtime.jsx)("div", {
															style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", marginBottom: "4px" },
															children: \`匹配结果 (\${filteredFiles.length})\`
														}),
														filteredFiles.map((file) => (0, react_jsx_runtime.jsxs)("div", {
															key: file.path,
															onClick: () => openPreview(file),
															style: {
																display: "flex",
																alignItems: "center",
																gap: "6px",
																padding: "4px 8px",
																borderRadius: "4px",
																cursor: "pointer",
																fontSize: "12px",
																color: "var(--dsw-alias-label-primary)",
																background: previewingFile?.path === file.path && activeTab === "preview" ? "var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.18))" : "transparent"
															},
															onMouseEnter: (e) => { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.08))"; },
															onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
															title: file.path,
															children: [
																(0, react_jsx_runtime.jsx)("svg", {
																	width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: getFileIconColor(file.name), strokeWidth: "1.8",
																	children: (0, react_jsx_runtime.jsx)("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" })
																}),
																(0, react_jsx_runtime.jsx)("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: file.name }),
																file.size !== void 0 && (0, react_jsx_runtime.jsx)("span", {
																	style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary)", flexShrink: 0 },
																	children: formatSize(file.size)
																})
															]
														}))
													]
												})
											) : (
												(0, react_jsx_runtime.jsx)("div", {
													style: { textAlign: "center", padding: "30px 10px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
													children: "未找到匹配的文件"
												})
											)
										) : isRootLoading ? (
											(0, react_jsx_runtime.jsx)("div", {
												style: { textAlign: "center", padding: "30px 10px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
												children: "正在加载工作区文件..."
											})
										) : rootEntries.length > 0 ? (
											(0, react_jsx_runtime.jsx)("div", {
												style: { display: "flex", flexDirection: "column" },
												children: renderTreeNodes(rootEntries, 0)
											})
										) : (
											(0, react_jsx_runtime.jsxs)("div", {
												style: { textAlign: "center", padding: "30px 10px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
												children: [
													(0, react_jsx_runtime.jsx)("p", { children: "工作区为空" }),
													(0, react_jsx_runtime.jsx)("p", { style: { fontSize: "11px", marginTop: "4px" }, children: sessionCwd ? "当前目录未包含可展示的文件" : "等待会话初始化..." })
												]
											})
										)
									})
								]
							})
						)`

  // 1. 如果包含第一代纯文件预览补丁（v1），进行就地升级
  if (source.includes('const [previewingFile, setPreviewingFile] =')) {
    const declStart = 'const [activeTab, setActiveTab] = (0, react.useState)("files");'
    const declEnd = 'setPreviewState({ loading: false, content: "", error: "未连接到 Copis 文件桥接服务", isImage: false, imageUrl: "" });\n\t\t\t\t}\n\t\t\t};'
    const declStartIdx = source.indexOf(declStart)
    const declEndIdx = source.indexOf(declEnd)
    if (declStartIdx === -1 || declEndIdx === -1) {
      throw new Error('DSH Chat DetailsPanel v1 补丁声明块未找到')
    }
    source = source.slice(0, declStartIdx) + DECLARATIONS_CHUNK + source.slice(declEndIdx + declEnd.length)

    source = source.replace(
      '(0, react_jsx_runtime.jsx)("span", { children: "文件" })',
      '(0, react_jsx_runtime.jsx)("span", { children: "工作区" })'
    )
    source = source.replace(
      '(0, react_jsx_runtime.jsx)("path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 8 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" })',
      '(0, react_jsx_runtime.jsx)("path", { d: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" })'
    )

    const startMarker = ') : activeTab === "files" ? ('
    const endMarker = ') : activeTab === "changes" ? ('
    const startIdx = source.indexOf(startMarker)
    const endIdx = source.indexOf(endMarker)
    if (startIdx !== -1 && endIdx !== -1) {
      source = source.slice(0, startIdx) + ') : ' + WORKSPACE_TREE_BODY_CONTENT + '\n\t\t\t\t\t\t: activeTab === "changes" ? (' + source.slice(endIdx + endMarker.length)
    } else {
      source = source.replace('children: activeTab === "files" ? (', 'children: activeTab === "preview" ? (\n' + PREVIEW_CHUNK + '\n) : ' + WORKSPACE_TREE_BODY_CONTENT)
    }

    return source
  }

  // 2. 原生未打补丁源码
  const target1 = 'const [activeTab, setActiveTab] = (0, react.useState)("files");'
  const target2 = `(0, react_jsx_runtime.jsx)("span", { children: material?.name ?? "工具详情" })\n										]\n									})\n								]\n							}),\n							(0, react_jsx_runtime.jsx)("button", {\n								type: "button",\n								className: DetailsPanel_module_css_default.close,`
  const repl2 = `(0, react_jsx_runtime.jsx)("span", { children: material?.name ?? "工具详情" })
										]
									}),
									previewingFile !== null && (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "inline-flex",
											alignItems: "center",
											borderRadius: "6px",
											background: activeTab === "preview" ? "var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.16))" : "transparent"
										},
										children: [
											(0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												onClick: () => setActiveTab("preview"),
												style: {
													padding: "4px 4px 4px 8px",
													fontSize: "12px",
													border: "none",
													background: "transparent",
													cursor: "pointer",
													display: "flex",
													alignItems: "center",
													gap: "4px",
													color: activeTab === "preview" ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
													fontWeight: activeTab === "preview" ? 600 : 400,
													maxWidth: "100px"
												},
												title: previewingFile.path,
												children: [
													(0, react_jsx_runtime.jsx)("svg", {
														width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2",
														children: (0, react_jsx_runtime.jsx)("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" })
													}),
													(0, react_jsx_runtime.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: previewingFile.name })
												]
											}),
											(0, react_jsx_runtime.jsx)("button", {
												type: "button",
												onClick: (e) => {
													e.stopPropagation();
													setPreviewingFile(null);
													if (activeTab === "preview") setActiveTab("files");
												},
												style: {
													border: "none",
													background: "transparent",
													cursor: "pointer",
													padding: "4px 6px 4px 2px",
													display: "flex",
													alignItems: "center",
													color: "var(--dsw-alias-label-tertiary)"
												},
												title: "关闭预览",
												children: (0, react_jsx_runtime.jsx)("svg", {
													width: "10", height: "10", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round",
													children: (0, react_jsx_runtime.jsx)("path", { d: "M4 4l8 8M12 4l-8 8" })
												})
											})
										]
									})
								]
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: DetailsPanel_module_css_default.close,`

  const target4 = `modifiedFiles.map((file) => (0, react_jsx_runtime.jsxs)("div", {
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
										}))`

  const repl4 = `modifiedFiles.map((file) => (0, react_jsx_runtime.jsxs)("div", {
											key: file.path,
											style: {
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												gap: "6px",
												padding: "6px 8px",
												borderRadius: "6px",
												background: previewingFile?.path === file.path && activeTab === "preview" ? "var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.18))" : "var(--dsw-alias-button-elevated-fill, rgba(120, 120, 128, 0.05))",
												fontSize: "12px",
												cursor: "pointer",
												transition: "background 0.15s ease"
											},
											onClick: () => openPreview(file),
											title: \`点击预览: \${file.path}\`,
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
												(0, react_jsx_runtime.jsxs)("div", {
													style: { display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 },
													children: [
														file.callId && (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															style: {
																fontSize: "10px",
																padding: "1px 5px",
																borderRadius: "4px",
																border: "0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))",
																background: "transparent",
																color: "var(--dsw-alias-label-secondary)",
																cursor: "pointer"
															},
															onClick: (e) => {
																e.stopPropagation();
																useStore.getState?.()?.setSelection?.({ callId: file.callId });
																setActiveTab("tool");
															},
															title: "查看工具调用",
															children: "工具"
														}),
														(0, react_jsx_runtime.jsx)("span", {
															style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary)" },
															children: file.type === "add" ? "新增" : "修改"
														})
													]
												})
											]
										}))`

  const target5 = 'children: activeTab === "files" ? ('
  const repl5 = `children: activeTab === "preview" ? (\n${PREVIEW_CHUNK}\n\t\t\t\t\t\t) : ${WORKSPACE_TREE_BODY_CONTENT}`

  if (!source.includes(target1) || !source.includes(target2) || !source.includes(target5)) {
    throw new Error('DSH Chat DetailsPanel 组件结构与受支持版本不匹配')
  }

  let res = source.replace(target1, DECLARATIONS_CHUNK).replace(target2, repl2)
  if (res.includes(target4)) res = res.replace(target4, repl4)

  if (res.includes('(0, react_jsx_runtime.jsx)("span", { children: "文件" })')) {
    res = res.replace(
      '(0, react_jsx_runtime.jsx)("span", { children: "文件" })',
      '(0, react_jsx_runtime.jsx)("span", { children: "工作区" })'
    )
    res = res.replace(
      '(0, react_jsx_runtime.jsx)("path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 8 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" })',
      '(0, react_jsx_runtime.jsx)("path", { d: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" })'
    )
  }

  const startMarker = 'children: activeTab === "files" ? ('
  const endMarker = ') : activeTab === "changes" ? ('
  const startIdx = res.indexOf(startMarker)
  const endIdx = res.indexOf(endMarker)
  if (startIdx !== -1 && endIdx !== -1) {
    res = res.slice(0, startIdx) + `children: activeTab === "preview" ? (\n${PREVIEW_CHUNK}\n\t\t\t\t\t\t) : ${WORKSPACE_TREE_BODY_CONTENT}\n\t\t\t\t\t\t: activeTab === "changes" ? (` + res.slice(endIdx + endMarker.length)
  } else {
    res = res.replace(target5, repl5)
  }

  return res
}

/**
 * 修改 DSH Cordis 插件审批与面板标题：
 * 将弹窗标题「Cordis 插件」替换为「Copis 请您确认」。
 */
export function patchDshCordisPanelRuntime(runtimeRoot: string): void {
  const entrypoint = join(runtimeRoot, DSH_CORDIS_CLIENT_ENTRYPOINT)
  if (!isFile(entrypoint)) {
    throw new Error(`官方 dsh 缺少 Cordis Panel 组件: ${entrypoint}`)
  }
  const source = readFileSync(entrypoint, 'utf8')
  writeFileSync(entrypoint, patchDshCordisPanelSource(source), 'utf8')
}

export function patchDshCordisPanelSource(source: string): string {
  if (source.includes('"panel.title": "Copis 请您确认"')) {
    return source
  }

  const targetTitle = '"panel.title": "Cordis 插件"'
  const replTitle = '"panel.title": "Copis 请您确认"'
  const targetAria = '"panel.plugins.aria": "Cordis 插件"'
  const replAria = '"panel.plugins.aria": "Copis 请您确认"'

  if (!source.includes(targetTitle)) {
    throw new Error('DSH Cordis Panel 组件未找到 panel.title 结构')
  }

  let res = source.replace(targetTitle, replTitle)
  if (res.includes(targetAria)) {
    res = res.replace(targetAria, replAria)
  }
  return res
}


function installOfficialCli(runtimeRoot: string, packageCache: string): void {
  mkdirSync(runtimeRoot, { recursive: true })
  mkdirSync(packageCache, { recursive: true })
  const npmPath = resolveNpmPath()
  const packageTarball = downloadOfficialPackage(npmPath, packageCache)
  verifyOfficialPackage(packageTarball)
  execFileSync(npmPath, [
    'install',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--no-save',
    packageTarball,
  ], { cwd: runtimeRoot, stdio: 'inherit' })
}

function downloadOfficialPackage(npmPath: string, packageCache: string): string {
  const output = execFileSync(npmPath, [
    'pack',
    '--silent',
    `${DSH_PACKAGE}@${DSH_PACKAGE_VERSION}`,
  ], { cwd: packageCache, encoding: 'utf8' }).trim()
  const packageName = output.split(/\r?\n/).at(-1)?.trim()
  if (!packageName) throw new Error('下载官方 dsh 失败')
  const packageTarball = join(packageCache, packageName)
  if (!isFile(packageTarball)) throw new Error('官方 dsh 归档不存在')
  return packageTarball
}

function verifyOfficialPackage(packageTarball: string): void {
  const actualIntegrity = `sha512-${createHash('sha512').update(readFileSync(packageTarball)).digest('base64')}`
  if (actualIntegrity !== DSH_INTEGRITY) {
    throw new Error('官方 dsh 完整性校验失败')
  }
}

function writeLaunchers(moduleRoot: string, platform: FunctionalModulePlatform): void {
  const bin = join(moduleRoot, 'bin')
  mkdirSync(bin, { recursive: true })
  if (platform === 'win32') {
    writeFileSync(
      join(bin, 'dsh.cmd'),
      '@echo off\r\nset "NODE_BIN=%COPIS_DSH_NODE%"\r\nif "%NODE_BIN%"=="" set "NODE_BIN=%COPIS_NODE%"\r\nif "%NODE_BIN%"=="" where node >nul 2>nul && set "NODE_BIN=node"\r\nif "%NODE_BIN%"=="" (echo 未配置 Copis Node.js runtime >&2 & exit /b 1)\r\n"%NODE_BIN%" "%~dp0..\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
      'utf8',
    )
    return
  }

  const launcher = join(bin, 'dsh')
  writeFileSync(
    launcher,
    '#!/bin/sh\nNODE_BIN="${COPIS_DSH_NODE:-${COPIS_NODE:-}}"\nif [ -z "$NODE_BIN" ]; then\n  if command -v node >/dev/null 2>&1; then\n    NODE_BIN="node"\n  else\n    echo "未配置 Copis Node.js runtime" >&2\n    exit 1\n  fi\nfi\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$NODE_BIN" "$SCRIPT_DIR/../runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n',
    { encoding: 'utf8', mode: 0o755 },
  )
  chmodSync(launcher, 0o755)
}

function createArchive(moduleRoot: string, output: string): void {
  const archiveTar = join(dirname(moduleRoot), 'dsh.tar')
  const temporaryOutput = `${output}.${process.pid}.tmp`
  mkdirSync(dirname(output), { recursive: true })
  try {
    execFileSync('tar', ['--format=pax', '-cf', archiveTar, '-C', moduleRoot, '.'], {
      stdio: 'inherit',
      env: { ...process.env, LC_ALL: 'C' },
    })
    writeFileSync(temporaryOutput, gzipSync(readFileSync(archiveTar), { mtime: 0 }), { mode: 0o644 })
    renameSync(temporaryOutput, output)
  } finally {
    if (existsSync(temporaryOutput)) rmSync(temporaryOutput, { force: true })
  }
}

function normalizeTimestamps(path: string): void {
  for (const entry of readdirSync(path).sort()) {
    const entryPath = join(path, entry)
    if (statSync(entryPath).isDirectory()) normalizeTimestamps(entryPath)
    utimesSync(entryPath, new Date(0), new Date(0))
  }
  utimesSync(path, new Date(0), new Date(0))
}

function resolveNpmPath(): string {
  const nodePath = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
  const npmPath = process.platform === 'win32' ? join(dirname(nodePath), 'npm.cmd') : join(dirname(nodePath), 'npm')
  if (!isFile(npmPath)) throw new Error('未找到与 Node.js 配套的 npm')
  return npmPath
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value?.trim() || undefined
}

function parsePlatform(value: string): FunctionalModulePlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`当前平台不支持 dsh 模块: ${value}`)
}

function parseArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持 dsh 模块: ${value}`)
}
