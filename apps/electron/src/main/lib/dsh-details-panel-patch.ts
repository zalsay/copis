import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DSH_CHAT_CLIENT_ENTRYPOINT = 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'

/**
 * 为 DSH 详情面板（DetailsPanel）增加工作区文件树与文件点击预览能力。
 * 点击工作区文件或已变更文件时，原地展开代码语法高亮或图片预览，并支持返回与系统定位。
 */
export function patchDshDetailsPanelFilePreviewRuntime(runtimeRoot: string): boolean {
  const entrypoint = join(runtimeRoot, DSH_CHAT_CLIENT_ENTRYPOINT)
  if (!existsSync(entrypoint)) return false
  const source = readFileSync(entrypoint, 'utf8')
  try {
    const patched = patchDshDetailsPanelFilePreviewSource(source)
    if (source !== patched) writeFileSync(entrypoint, patched, 'utf8')
    return true
  } catch (error) {
    console.warn('[DSH Cordis Web] 详情面板补丁应用跳过:', error instanceof Error ? error.message : error)
    return false
  }
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
										style: { padding: "4px 8px 4px " + (depth * 14 + 34) + "px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
										children: "正在加载目录..."
									})
								) : children.length > 0 ? (
									renderTreeNodes(children, depth + 1)
								) : (
									(0, react_jsx_runtime.jsx)("div", {
										style: { padding: "4px 8px 4px " + (depth * 14 + 34) + "px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
										children: "(空目录)"
									})
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
															children: "匹配结果 (" + filteredFiles.length + ")"
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

  // 当前官方 bundle 的 DetailsPanel 只展示工具详情，需要在其外层补回 Web+ 工作区与预览页签。
  if (source.includes('function DetailsPanel({ useChat, useSessions, sessionId, useStore, renderSlot, closeDetails, t })')) {
    const materialDeclaration = 'const material = useChat((s) => callId === void 0 ? null : materialFor(s, callId), (a, b) => (0, _deepseek_ai_dsh_client_store.shallowEqual)(a, b));'
    const title = 'children: selection === null ? t("details.title") : material?.name ?? selection.toolName ?? t("details.title")'
    const bodyExpression = 'selection === null || callId === void 0 ?'
    const body = `children: ${bodyExpression}`
    if (!source.includes(materialDeclaration) || !source.includes(title) || !source.includes(body)) {
      throw new Error('DSH Chat DetailsPanel 当前版本结构与 Web+ 补丁不匹配')
    }

    const tabs = `(0, react_jsx_runtime.jsxs)("div", {
						style: { display: "flex", alignItems: "center", gap: "4px", marginLeft: "auto" },
						children: [
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => setActiveTab("files"),
								style: { border: "none", borderRadius: "6px", padding: "4px 8px", cursor: "pointer", fontSize: "12px", background: activeTab === "files" || activeTab === "preview" ? "var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.16))" : "transparent", color: "var(--dsw-alias-label-primary)" },
								children: "工作区"
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: selection === null,
								onClick: () => setActiveTab("tool"),
								style: { border: "none", borderRadius: "6px", padding: "4px 8px", cursor: selection === null ? "default" : "pointer", fontSize: "12px", opacity: selection === null ? 0.45 : 1, background: activeTab === "tool" ? "var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.16))" : "transparent", color: "var(--dsw-alias-label-primary)" },
								children: "工具"
							})
						]
					}), `

    let patched = source
      .replace(materialDeclaration, `${materialDeclaration}\n\t\t\t${DECLARATIONS_CHUNK}\n\t\t\t(0, react.useEffect)(() => { if (selection !== null) setActiveTab("tool"); }, [selection?.callId]);`)
      .replace(title, 'children: activeTab === "files" ? "工作区" : activeTab === "preview" ? previewingFile?.name ?? "文件预览" : selection === null ? t("details.title") : material?.name ?? selection.toolName ?? t("details.title")')
      .replace(body, `children: activeTab === "preview" ? (\n${PREVIEW_CHUNK}\n\t\t\t\t\t) : ${WORKSPACE_TREE_BODY_CONTENT}\n\t\t\t\t\t: ${bodyExpression}`)

    const closeClassIndex = patched.indexOf('className: DetailsPanel_module_css_default.close,')
    const closeButtonIndex = patched.lastIndexOf('(0, react_jsx_runtime.jsx)("button", {', closeClassIndex)
    if (closeClassIndex === -1 || closeButtonIndex === -1) {
      throw new Error('DSH Chat DetailsPanel 当前版本缺少关闭按钮锚点')
    }
    patched = `${patched.slice(0, closeButtonIndex)}${tabs}${patched.slice(closeButtonIndex)}`
    return patched
  }

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
											padding: "2px 6px",
											marginRight: "6px",
											background: "var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.15))",
											fontSize: "11px",
											maxWidth: "140px",
											color: "var(--dsw-alias-label-primary)"
										},
										title: previewingFile.path,
										children: [
											(0, react_jsx_runtime.jsxs)("span", {
												onClick: () => setActiveTab("preview"),
												style: {
													cursor: "pointer",
													display: "flex",
													alignItems: "center",
													gap: "4px",
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap"
												},
												children: [
													(0, react_jsx_runtime.jsx)("svg", {
														width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2",
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
