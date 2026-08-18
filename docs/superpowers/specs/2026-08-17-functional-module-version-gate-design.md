# 功能模块版本门控设计

## 目标

默认功能模块部署只发布比 COS 当前版本更新的模块。适用模块为 `officecli`、`alipay-bot` 和 `playwright-core`。当构建版本不高于 COS 版本时，完全跳过对应模块的准备、构建、manifest 输入和上传。

显式传入 `--officecli`、`--alipay-bot` 或 `--playwright-core` 时，视为强制部署对应模块，跳过版本门控，保持现有单模块发布语义。

## 版本来源与比较

部署入口根据 `COS_PUBLIC_BASE_URL`、`OBJECT_PREFIX_PATH` 和 channel 构造公网 manifest 地址，并一次读取当前平台/架构的模块版本。

- `officecli`：优先使用显式构建版本；已有本地二进制时读取其版本；本地二进制尚未准备时使用 `OFFICECLI_RELEASE_TAG` 的稳定版本。
- `alipay-bot`：使用现有 `scripts/functional-module-versions.json` 中的锁定版本。
- `playwright-core`：使用现有 `scripts/functional-module-versions.json` 中的锁定版本。

版本只接受稳定三段式 semver，并使用数值比较：

```text
buildVersion > cosVersion  -> deploy
buildVersion <= cosVersion -> skip
COS 没有该模块             -> deploy
```

COS manifest 无法读取、JSON 无效、当前平台缺少合法版本时，部署失败并输出原因；不能在无法确认远端版本时回退到 GitHub 或本地构建。

## 执行流程

1. 默认部署开始时查询 COS manifest，并计算三个模块的部署决策。
2. 对被跳过的模块，不执行准备/打包命令，也不要求本地 artifact 存在。
3. manifest builder 和 publisher 接收明确的 `skip-*` 标记，不把被跳过模块加入本次 release。
4. publisher 使用现有 manifest 合并逻辑，保留 COS 中未出现在 incoming manifest 的模块 artifact。
5. 对构建版本更高或 COS 缺少模块的模块，执行现有构建、校验、不可变版本发布流程。
6. 显式模块参数绕过第 1 步对应模块的 skip 决策，强制执行其构建和 deploy；其他模块仍按默认规则处理。

## 修改边界

- 增加可复用的 COS 版本门控命令/逻辑，供 `deploy.sh` 和 `deploy.ps1` 使用。
- 扩展 manifest builder、publisher 和模块输入构建函数以支持跳过 `officecli`、`alipay-bot`、`playwright-core`。
- 不改变 COS 对象 key、manifest 合并规则、版本锁内容或其他模块的发布协议。
- 保留 OfficeCLI 的 GitHub 下载和校验逻辑，仅在模块实际需要 deploy 时调用。

## 测试

- 版本比较覆盖相同、低于、高于和 COS 缺少模块。
- COS manifest 查询失败、无效 JSON、缺少平台/模块版本时失败。
- 默认模式验证三个模块被跳过时不需要本地 artifact，且输出 manifest 保留远端 artifact。
- 默认模式验证构建版本更高时加入对应模块。
- 显式三个模块参数验证强制构建/发布，不被 skip 决策拦截。
- 保留现有 OfficeCLI GitHub/COS 错误诊断、文件校验和部署边界测试。
