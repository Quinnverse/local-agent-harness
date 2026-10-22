# Local Agent Harness

本地可扩展 Agent 工具宿主：TypeScript + Node.js，通用插件核心、CLI、本地 Web 管理、每次执行独立子进程。两个正式插件提供文本大小写转换和授权文件统计。没有接入LLM，没有用固定规则伪装模型推理；SDK保留未来AgentAdapter接口。

**仅安装可信本地插件。普通子进程不是完整安全沙箱，不能阻止恶意插件直接访问操作系统资源。** 文件权限只约束宿主提供的读取broker。

## 环境与启动

要求 Node.js 24.x 和 npm。当前真实验证环境为 macOS / Node 24.13.0。首次运行需要从npm registry下载锁定依赖，不需要模型API、数据库、全局CLI安装或外部CDN。

在项目根目录执行：

```sh
npm ci --ignore-scripts --cache .work/npm-cache
npm run check
npm run build
export HARNESS_DATA_DIR="$PWD/.work/user-data"
npm start
```

打开 http://127.0.0.1:4317 。服务只绑定127.0.0.1，不部署公网。首次数据目录为空，使用界面“安装本地插件”输入两个插件目录的绝对路径。安装不自动启用、不自动授予文件权限。

`npm start` 使用已经构建的产物；改源码后先重新 `npm run build`。停止服务按 Ctrl+C。端口占用会报错，不会自动改为公网监听或偷偷换端口：

```sh
npm start -- --port 4318
```

默认数据目录为 `~/.local-agent-harness`；`HARNESS_DATA_DIR` 或 CLI `--data-dir` 可覆盖。本任务测试和演示均使用项目 `.work/` 内隔离数据，没有写入用户默认数据目录。不要将本地端口通过代理、隧道公开。

## CLI 完整操作

以下可在另一个终端执行。环境变量需要在该终端重新设置；或每条命令明确使用 `--data-dir`。

```sh
export HARNESS_DATA_DIR="$PWD/.work/user-data"
npm run cli -- plugins install ./plugins/text-transform
npm run cli -- plugins install ./plugins/file-stats
npm run cli -- plugins list
npm run cli -- plugins show demo.text-transform
npm run cli -- plugins configure demo.text-transform --config-json '{"caseMode":"upper"}'
npm run cli -- plugins enable demo.text-transform
npm run cli -- plugins run demo.text-transform --capability text.transform --input-json '{"text":"Hello 世界"}'
npm run cli -- plugins configure demo.text-transform --config-json '{"caseMode":"lower"}'
npm run cli -- plugins run demo.text-transform --capability text.transform --input-json '{"text":"Hello 世界"}'
npm run cli -- plugins disable demo.text-transform
```

两次data.text分别是 `HELLO 世界` 和 `hello 世界`。禁用后再运行返回 `PLUGIN_DISABLED` 及非零退出码。若插件已经通过Web安装，CLI再次安装同ID会拒绝；这是预期行为，不需要重复安装。

文件插件使用自己的隔离演示文件：

```sh
mkdir -p .work/sample-files
printf 'alpha beta\n你好世界\n' > .work/sample-files/sample.txt
npm run cli -- plugins configure demo.file-stats --config-json '{"maxBytes":1048576}'
npm run cli -- plugins enable demo.file-stats
npm run cli -- plugins run demo.file-stats --capability file.stats --input-json "{\"path\":\"$PWD/.work/sample-files/sample.txt\"}"
# 上一步尚未授权，预期 PERMISSION_DENIED，不是成功。
npm run cli -- permissions grant demo.file-stats --read-root "$PWD/.work/sample-files"
npm run cli -- plugins run demo.file-stats --capability file.stats --input-json "{\"path\":\"$PWD/.work/sample-files/sample.txt\"}"
```

授权后的data为 `{"bytes":24,"lines":2,"tokens":3}`。词元指空白分隔片段，不是中文分词。支持LF/CRLF/CR；空文件0行，末尾换行不额外增行；UTF-8 BOM按解码器规则去除但bytes仍计原始字节。授权可用 `permissions revoke` 撤销。

需要纯JSON输出时直接运行 `node dist/src/cli.js ...`，避免npm自己的启动信息。CLI管理失败和执行失败退出码非0。

## Web 管理

界面使用相同Harness核心及持久化状态，支持插件安装、列表、详情、配置、启用/禁用、文件目录授权/撤销、选择能力、输入和执行结果/错误。不是静态演示。所有页面资源都来自本地服务。配置保存和执行均按插件schema校验；不能通过界面绕过禁用状态。

CLI和Web共享数据目录时管理状态一致；Web列表如受外部CLI修改可刷新。禁用拒绝新执行，在途执行按原配置/授权快照完成，仍受超时限制。

## 插件开发与架构

[插件协议](docs/plugin-protocol.md)定义manifest、能力、配置、权限和结果。[开发指南](docs/plugin-development.md)说明独立插件开发与安装。[安全说明](docs/security.md)列出真实保证及非保证。

```text
src/cli.ts                CLI
src/core/                 安装、注册表、配置、授权、通用执行器
src/protocol/             协议类型与JSON Schema校验
src/runtime/              独立执行进程的通用runner
src/sdk/                  插件类型及未来Agent适配器
src/web/                  本地HTTP服务和管理UI
plugins/text-transform/   正式文本插件，独立manifest及入口
plugins/file-stats/       正式文件插件，独立manifest及入口
tests/                    隔离核心、CLI、Web和故障测试
scripts/                  构建和可复现验证脚本
outputs/                  第三插件示例、脱敏基线与历史截图；复验时生成新证据
```

首版安装自包含、已构建本地包，不执行安装脚本，不为插件自动安装依赖。不支持插件市场、更新、卸载、强沙箱、常驻任务或多用户认证。

## 测试与扩展证据

```sh
npm test
node scripts/verify-extension.mjs
node scripts/verify-clean-install.mjs
```

`npm test` 先构建，再执行node:test；测试数据各自隔离在项目`.work/`，不会读取个人文件。故障插件由测试动态生成。超时测试验证执行进程PID已不存在，不仅检查错误文字。

第三插件包在 `outputs/third-plugin/`；验证脚本在安装运行前后对整个src计算SHA-256，确保扩展无需修改宿主，结果为文本反转。执行该脚本后才生成 `outputs/extension-verification.json`；清洁发行包不预存原机器的扩展运行证据。

干净安装脚本复制源码到新的`.work/clean-room-*`目录，不复制node_modules或构建产物，执行锁文件安装、类型检查、构建、测试及README中的CLI闭环；npm离线使用首次安装已缓存的依赖。此验证是同一操作系统上全新依赖/构建/状态，不声称是全新OS或多平台验证。

## 清洁发行与最终验收

运行 `node scripts/package-release.mjs`，以独立 staging 允许列表生成清洁发行包及 SHA-256，不删除开发数据、不覆盖原始对照包。详见 [发行打包政策](docs/release-packaging.md)。包不包含 node_modules、缓存、运行状态快照、原机器路径日志或预构建 dist；解压后先执行上面的安装和构建步骤，再安装正式插件。

包内 `outputs/acceptance-report.md` 是脱敏工程基线，历史结果截图不能代替新包验收。发行包旁的 `release-gate-report.md` 记录打包后全新解压的真实验收并绑定最终 SHA-256，避免在验证后修改压缩包。正式提交说明未取得时，必须分别标注 ENGINEERING_GATE 和 SUBMISSION_COMPLIANCE=UNKNOWN。
