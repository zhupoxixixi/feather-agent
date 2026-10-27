# Feather 桌面版

轻量 Agent 的 Windows 图形界面预览版，版本 0.2.0。提供任务输入、工作目录选择、模型设置、执行进度、会话和取消操作。

## 下载

每次推送 main，GitHub Actions 会测试并在 Windows x64 构建：

- Feather-Setup-0.2.0-x64.exe：安装版，可选择安装位置。
- Feather-Portable-0.2.0-x64.exe：免安装版。

在本仓库 Actions 的成功 Desktop Build 运行中下载 Feather-Windows-0.2.0-x64 artifact。只有构建成功后才有安装程序，源码 ZIP 不是安装包。最终用户无需安装 Node.js。目前没有代码签名证书，Windows 可能显示未知发布者。

## 使用

1. 先点“模拟演示”：在新建示例目录读取 CSV 并生成 report.md，无需密钥；这是确定性模拟模型，不代表真实模型质量。
2. 在模型设置中选择 OpenAI 兼容或 Anthropic，填写支持工具调用的模型名、API 地址和自己的 API Key。
3. 选择项目文件夹，输入任务并执行。默认只读，勾选允许写入后才提供文件修改工具。
4. 可以查看执行进度、取消任务、查看和继续历史会话。

API Key 默认仅留在当前进程内存。“记住密钥”使用 Electron safeStorage 的系统加密；加密不可用时拒绝持久保存。renderer 不接收已保存密钥，不使用 localStorage 存密钥。任务和文件结果会发给所配置的模型服务。

首个桌面版本只提供列目录、读文件、搜索和受控写文件，不含命令执行、浏览器、后台调度或多 Agent 团队。路径与 symlink 检查不替代 OS 沙箱。工具输出、轮次和时长有预算；中断工具不自动重放。

## 开发

Node.js 24+：

~~~sh
npm install
npm test
npm run demo
npm start
~~~

Windows 验证和打包：

~~~sh
npm run smoke:gui
npm run build:win
~~~

core/ 仅依赖 Node.js 标准库。GUI 外壳包含 Electron，所以应用体积不等同早期 CLI 源码体积。当前目标是 Windows 10/11 x64，其他平台未做同等桌面验收。

## 来源和验证边界

0.1.1 CLI 曾在旧云工作区通过 40 项测试；该工作区当前不可读取。本仓库 0.2.0 是按已确认设计重新整理的桌面实现，须重新运行本仓库 CI，不能沿用旧测试结果。

研究过 Gemini CLI、OpenClaw、Qwen Code、Codex、OpenCode 的代表性发布代码和开源文件，以及 Claude Code 的公开文档和发行制品。没有取得或复制未公开的专有源码。见 docs/PROVENANCE.md。

MIT License。
