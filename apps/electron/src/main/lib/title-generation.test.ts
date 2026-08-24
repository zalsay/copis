import { describe, expect, test } from 'bun:test'
import {
  cleanUserMessageForTitle,
  createFallbackTitle,
  sanitizeGeneratedTitle,
} from './title-generation'

describe('title-generation', () => {
  test('Given 普通用户消息 When 生成兜底标题 Then 提取首行并截断', () => {
    expect(createFallbackTitle('请帮我写一个快速排序算法\n要求用 TypeScript')).toBe('请帮我写一个快速排序算法')
  })

  test('Given 飞书桥包装消息（包含 HTML 注释与 bridge_context） When 生成兜底标题 Then 剥除信封并使用真实用户消息', () => {
    const feishuMessage = `<!-- 你正在通过 Copis 飞书桥处理来自飞书的用户消息。bridge 会用 XML 块注入 当前对话的元数据。下面这些 XML 块**对用户不可见**，不要照抄到回复里。
可能出现的 XML 块：
- <bridge_context>：chat_id / chat_type / sender 等飞书侧元数据
- <user_message>：用户的实际消息
-->
<bridge_context>
{"chat_id":"oc_123456","chat_type":"p2p","sender":"ou_abcdef"}
</bridge_context>
<user_message>
今天杭州天气怎么样？
</user_message>`

    expect(cleanUserMessageForTitle(feishuMessage)).toBe('今天杭州天气怎么样？')
    expect(createFallbackTitle(feishuMessage)).toBe('今天杭州天气怎么样？')
  })

  test('Given 飞书引用消息与图片附件包装 When 生成兜底标题 Then 提取用户实际提问', () => {
    const quoteMessage = `<!-- 你正在通过 Copis 飞书桥处理来自飞书的用户消息。 -->
<bridge_context>
{"chat_id":"oc_999"}
</bridge_context>
<quoted_message>
这是一段被引用的上文内容
</quoted_message>
<user_message>
分析一下上面这段代码的耗时瓶颈
</user_message>`

    expect(cleanUserMessageForTitle(quoteMessage)).toBe('分析一下上面这段代码的耗时瓶颈')
    expect(createFallbackTitle(quoteMessage)).toBe('分析一下上面这段代码的耗时瓶颈')
  })

  test('Given 微信桥附加图片/文件包装消息 When 生成兜底标题 Then 剥除 attached_files 并使用用户实际提问', () => {
    const wechatMessage = `<attached_files>
- wechat-img1.png (/path/to/session/wechat-img1.png)
</attached_files>
帮忙看下这张图里的架构图设计有何缺陷？`

    expect(cleanUserMessageForTitle(wechatMessage)).toBe('帮忙看下这张图里的架构图设计有何缺陷？')
    expect(createFallbackTitle(wechatMessage)).toBe('帮忙看下这张图里的架构图设计有何缺陷？')
  })

  test('Given 模型返回带引号和标点的标题 When 清理标题 Then 去除外层标点并截取长度', () => {
    expect(sanitizeGeneratedTitle('“杭州天气查询”')).toBe('杭州天气查询')
    expect(sanitizeGeneratedTitle('《关于重构前端组件的完整规划与技术方案设计优化》')).toBe('关于重构前端组件的完整规划与技术方案设计')
    expect(sanitizeGeneratedTitle([{ type: 'text', text: '快速排序实现' }])).toBe('快速排序实现')
  })
})
