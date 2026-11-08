# 0.8.16-pre.1 — 开放准备候选 / open-source preparation candidate

**未公开发布；2026-11-08 经所有者另行授权安装到日用环境。不是正式 Release。**

## 中文

- 中英首页围绕“会话交流 + 两种显示模式 + 顺手的交互 + 简单设置”重新组织，加入可重建、标注清楚的离线合成素材与流程动画。
- 气泡用户称呼从硬编码维护者姓名改为中性标签，可在当前浏览器自定义（不改变账号、发送者身份或权限）；已有用户可设置原称呼。
- 完整气泡桥接仍单独维护，不随 tgz 安装。工具改为显式安装前缀、默认只检查，从精确原始字节生成候选，不依赖维护机路径或被忽略的产物；应用仍需单独授权、私有备份和严格校验。
- 新增安全默认测试入口，纳入此前漏挂的 rc.1 桥接/安装器测试；CI 使用固定镜像、非 root 和独立可执行 tmpfs，运行阶段断网，并加载固定公开 Host SDK 夹具。
- 补齐公共使用/安装/设置/排障/安全/贡献说明、反馈模板、包元数据和第三方许可；历史 Git 提交未改写，公开前仍需所有者审阅历史身份信息。

通信数据格式、既有投递默认值、卡片路径与权限设计不变。公开时机、最终版本、远端设置、Release/npm 发布和日用升级需分别确认。验证结果以[准备验收](../open-source-readiness.md)为准，不用历史统计冒充本次结论。

## English

This is an unpublished preparation candidate, not a public release. It was separately authorized and installed for daily use on 2026-11-08; this does not authorize publication. It adds bilingual product documentation and labelled offline fixture assets, a browser-local neutral/custom bubble label, portable explicit-root Host bridge maintenance, isolated tests including previously omitted bridge suites, pinned public SDK fixtures and third-party attribution. Messaging data format, delivery defaults, card behavior and authorization design are unchanged. Git history is not rewritten. Publication, registry rights and production upgrade remain separate owner decisions; see the readiness record for actual verification.
