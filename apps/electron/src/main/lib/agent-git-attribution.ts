/**
 * Copis Git / PR 推广标识
 *
 * 目标：当 Agent 代用户创建 commit / PR 时，附带可搜索、可关闭的 Copis 标识，
 * 用于产品曝光；同时避免 Co-Authored-By 假冒作者、污染 GitHub contributors。
 *
 * 当前通过 system prompt 引导 Agent 在 git commit / gh pr 时附加标识。
 */

/** 默认开启 */
export const DEFAULT_GIT_ATTRIBUTION_ENABLED = true

/** 官方站点（商业版 / 产品主页） */
export const COPIS_OFFICIAL_URL = 'https://copis.cool'

/** 开源仓库完整地址 */
export const COPIS_GITHUB_URL = 'https://github.com/copis-ai/Copis'

/** Commit trailer（标准 git trailer，不进入 GitHub co-author 列表） */
export const COPIS_COMMIT_TRAILER = 'Made-with: Copis'

/**
 * PR / MR 描述底部标识。
 * 含官方站 + 开源仓库完整链接，便于推广与引流。
 */
export const COPIS_PR_ATTRIBUTION =
  `Made with [Copis](${COPIS_OFFICIAL_URL}) · [GitHub](${COPIS_GITHUB_URL})`

export interface GitAttributionConfig {
  /** 是否启用；undefined 视为默认开启 */
  enabled?: boolean
}

/** 解析最终是否启用（缺省 = 默认开启） */
export function isGitAttributionEnabled(config?: GitAttributionConfig | boolean | null): boolean {
  if (typeof config === 'boolean') return config
  if (config && typeof config === 'object' && typeof config.enabled === 'boolean') {
    return config.enabled
  }
  return DEFAULT_GIT_ATTRIBUTION_ENABLED
}

/** 注入到 buildSystemPrompt 的 Git/PR 标识规范 */
export function buildGitAttributionPromptSection(enabled: boolean): string {
  if (!enabled) {
    return `## Git / PR 标识

用户已在 Copis 设置中关闭「Git/PR 标识」。当你创建 git commit 或 Pull Request / Merge Request 时：
- **不要**添加任何 Copis 相关归因（包括 \`${COPIS_COMMIT_TRAILER}\`、\`${COPIS_PR_ATTRIBUTION}\`、\`Co-Authored-By: Copis\`、\`Generated with Copis\` 等）
- 也不要主动建议用户打开该标识；仅当用户明确要求时再添加`
  }

  return `## Git / PR 标识（推广归因，默认开启）

当**你**通过 Bash 等工具代用户创建 git commit 或 Pull Request / Merge Request 时，必须附加 Copis 标识（用户当次明确说「不要带标识 / 不要 Made-with」除外）。

### Commit
在 commit message **末尾**追加标准 git trailer（与正文之间空一行）：

\`\`\`text
${COPIS_COMMIT_TRAILER}
\`\`\`

规则：
- **只用** \`${COPIS_COMMIT_TRAILER}\` trailer，**不要**使用 \`Co-Authored-By: ...\`（避免假冒作者、污染 GitHub contributors）
- 若 message 已含 \`Made-with: Copis\`（大小写不敏感），不要重复
- 推荐：\`git commit --trailer "${COPIS_COMMIT_TRAILER}" -m "subject"\`；或多段 \`-m\`，确保 trailer 单独处于最后一段且格式为 \`Key: Value\`
- 不要改 author / committer 身份；标识只出现在 message trailer

### Pull Request / Merge Request
在 PR/MR 描述 **末尾**追加（与正文空一行）：

\`\`\`text
${COPIS_PR_ATTRIBUTION}
\`\`\`

- 官方站：\`${COPIS_OFFICIAL_URL}\`；开源仓库：\`${COPIS_GITHUB_URL}\`（不要写成 copis.ai 或其他错误域名）
- 若 body 已含 \`copis.cool\` 或 \`github.com/copis-ai/Copis\` 的 Made with / Generated with 行，不要重复
- \`gh pr create\` 时把上述行放进 \`--body\` 末尾；若用 body 文件，同样追加在文件末尾

### 关闭方式
用户可在 **设置 → 通用 → Git/PR 标识** 关闭。关闭后本段指令会被替换为「禁止添加标识」。`
}
