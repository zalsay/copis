# 设计大师（Dashi Design）

设计大师是 Copis 内置的高级前端视觉与交互设计技能，基于开源项目 OpenPipal 的 Claude Design 系统深度适配。

## 特性

- **Anti-AI-Slop 审美铁律**：拒绝千篇一律的粉紫渐变卡片、emoji 勋章与巨大圆角按钮，注重低饱和高级感、单色搭配与大留白。
- **Design Component (.dc.html) 架构**：单文件自足交付，基于本地 `./runtime/support.js` 驱动，支持模板指令与 `data-props` 动态调参。
- **13 大专项设计领域**：包含手机 App 原型、演示幻灯片、排版文档与简历、低保真线框图、高保真画板并排、海报传单、三折页、HTML 邮件、Three.js 3D 物体建模、循环动效与设计系统构建。
- **100% 离线自足**：内置 React 18 UMD 运行时与多设备外框预制件，支持通过脚本一键导出为纯单文件离线 HTML。

## 常用命令

```bash
# 脚手架生成
copis dashi-design scaffold --template prototype --output ./prototype.dc.html

# 离线单文件导出
copis dashi-design export --input ./prototype.dc.html --output ./standalone.html

# 静态规范校验
copis dashi-design validate --input ./prototype.dc.html

# 启动本地预览
copis dashi-design preview --port 5280
```
