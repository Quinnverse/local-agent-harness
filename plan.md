# 题目 3 · Local Agent Harness

用户已批准 P0–P5 一次性实施。本项目采用纯本地开发，不使用 Manus 托管服务、不上传源码、不部署公网、不接付费 API。不需要 LLM；不得伪装模型推理。

## 架构
TypeScript + Node.js 24。CLI 与本地 HTTP 服务使用同一个 Harness 核心。插件 manifest 使用 JSON Schema draft-07，统一 execute(request, context) 入口，每次执行由独立 Node 子进程和 IPC 驱动。Ajv 对 manifest、配置、输入、输出校验；配置只在副本中应用默认值，成功后原子保存。安装复制已构建包，不运行安装脚本。用户数据采用注册表、安装目录及跨进程写锁。默认数据目录位于用户 home，验收使用项目 .work 内的隔离目录。

文件权限声明和授权分开；宿主 broker 校验真实路径、普通文件、UTF-8 与大小。子进程不是 OS 沙箱，可信插件可以直接访问系统资源，文档明确披露。

## 开发顺序
P0：协议、初始化、CLI。P1：管理和执行核心。P2：两个真实插件。核心测试和 CLI 操作通过后才进入 P3：Web 界面。P4：故障、超时、持久化、路径、兼容性。P5：第三插件、干净安装、文档和交付。

## 目录职责
src/protocol：协议、schema；src/core：安装、状态、配置、权限、执行；src/runtime：子进程 runner；src/sdk：可复用开发者类型和未来 Agent 适配契约；src/cli.ts：命令；src/web：本地 UI 和 HTTP 服务；plugins：两个独立正式插件；tests：隔离自动化验收；scripts：构建脚本；docs：协议与安全；outputs：最终测试证据、截图、验收矩阵；.work：调试和演示数据。

## Web 设计
遵循用户明确要求：清晰、克制、专业，采用轻量工作台而非仪表盘。浅暖灰背景，深墨文字，蓝绿色作为唯一主要强调色；左侧插件导航，右侧详情和配置/运行工作区，结果位于表单下方。系统无衬线字体配合等宽 JSON 展示。状态使用清楚的文字与低饱和标签，不只依赖颜色。按钮操作有进行中状态，反馈通过可访问 live region。无装饰图片、外部字体或 CDN 依赖。所有资源由本地服务提供。

服务仅绑定 127.0.0.1。Host/Origin 校验与进程随机 CSRF token 保护本地写 API；不开放 CORS。安装输入为本地插件目录，不上传个人文件。所有页面文字及插件数据使用安全 DOM API，禁止将插件字符串注入 innerHTML。
