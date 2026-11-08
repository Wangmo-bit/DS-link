# 为什么做 DS-link / Why DS-link

[首页](../README.md) · [English home](../README_EN.md)

## 少传话，也少费力看懂

你不该一边用 AI 做事，一边忙着给每个 AI 搬运问题、解释别人的回答，再从一屏工具日志里找结论。

DS-link 有两条同等重要的主线：

1. **会话交流**：复用已有会话和上下文，传递请求、信息与明确回复。
2. **交互展示**：气泡与卡片各有适用场景，轻量消息入口、引用和 Agent 提示帮助人看懂并参与。

气泡不是“信息越少越好”；该看的正文、该处理的审批和真实失败不能消失。卡片不是低配或落后模式；检查过程时，它更合适。设置也不是越多越强：默认值先工作，重要的控制容易理解。

DeepSeek 发布的 [SuperAgent 研究原型理念](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)提出：“Take as little human attention as possible, and give as much value as possible.” 我们借鉴这个衡量方式，不宣称实现它的自动接单、GitHub/飞书来源系统或完整任务生命周期。

[DS-Bot](https://github.com/Fei2411/DS-Bot)展示了另一种 Bot 团队协作形态；我们选择在已有 DSH 会话之上增加通信与显示层。[dsh-go](https://github.com/ccch1mneyyy/dsh-go)的产品介绍和开源说明是文档参考。不同选择服务不同使用习惯，不作高低比较。

## Less relaying, less effort to understand

People should not have to relay every question, explain another session's answer and scan a screen of tool logs just to find the result.

DS-link has two equally important parts: **communication between existing sessions**, and **presentation that makes work easier to read and respond to**. Bubble mode is for low-noise reading; card mode is for inspecting process. Neither changes permissions or the underlying messages.

We draw on the SuperAgent prototype's attention principle, not its entire architecture. This plugin is not an official SuperAgent product and does not implement autonomous task intake or end-to-end task management. Quotes, small Agent hints and honest states are practical interactions—not a promise of perfect model judgment.
