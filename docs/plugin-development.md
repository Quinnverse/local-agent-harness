# 插件开发指南

目标：新增能力时只编写一个插件包，不修改宿主核心代码。先阅读 [协议](plugin-protocol.md) 和 [安全边界](security.md)。正式 TypeScript 示例位于 plugins/text-transform/src/index.ts 和 plugins/file-stats/src/index.ts，SDK类型在 src/sdk/index.ts。

## 最小包

创建一个属于你自己开发目录的插件文件夹，包含 manifest.json、package.json 和 index.mjs。package.json 内容为 {"type":"module"}。manifest 的 entry 指向 index.mjs；使用唯一id、protocolVersion="1.0"，声明能力及输入/输出/config schema。可直接复制正式插件 manifest 再替换id和能力定义，不能沿用相同id。

入口例子：

```js
export async function execute(request) {
  return { text: Array.from(request.input.text).reverse().join('') };
}
```

对应能力可以是 text.reverse，输入/输出都是 {text:string}，configSchema 为 {type:"object",additionalProperties:false}，permissions为空。这里按Unicode code point反转，不承诺按字素簇反转。实际可安装第三插件包在 outputs/third-plugin/。

## TypeScript 插件

你可以使用 src/sdk/index.ts 的 PluginRequest、PluginContext、PluginExecute 类型。类型导入不会进入最终JavaScript运行时。首版不为插件安装npm依赖；请先编译并将入口及依赖打包进包内。项目 npm run build 会编译两个正式插件，并生成各自 dist/index.js。

## 安装与运行

在宿主项目根目录构建后运行：

```sh
node dist/src/cli.js --data-dir .work/developer-data plugins install outputs/third-plugin
node dist/src/cli.js --data-dir .work/developer-data plugins configure demo.reverse --config-json '{}'
node dist/src/cli.js --data-dir .work/developer-data plugins enable demo.reverse
node dist/src/cli.js --data-dir .work/developer-data plugins run demo.reverse --capability text.reverse --input-json '{"text":"agent"}'
```

预期data为 {"text":"tnega"}。宿主按manifest能力调度，不需要增加id分支。scripts/verify-extension.mjs 自动对宿主源码计算SHA-256，安装并运行第三插件，再次校验源码没有变化，证据输出到 outputs/extension-verification.json。

## 文件能力

需要读取文件时声明 permissions:["files.read"]，用 context.files.readText(绝对路径,maxBytes)；不要直接用fs冒充宿主权限控制。用户还必须通过CLI permissions grant或Web授权目录。未授权、真实路径越界、文件过大、编码无效都会拒绝。

授权只约束broker；宿主信任插件代码，不能阻止恶意插件绕过broker使用系统API。SDK类型和约定不构成沙箱。

## 调试与兼容

先验证manifest能安装，再校验配置、输入和输出schema。错误码可区分启动失败、执行失败、崩溃和超时。stdout/stderr是受限日志，不要输出原始敏感配置。每次执行结束进程回收，不能依赖进程内缓存跨执行保留。共享状态由插件自管且不能宣称具有宿主权限保护。

首版协议严格支持1.0；新增字段或生命周期需先明确兼容策略，不能偷偷改变已有能力输入含义。安装同ID会拒绝；更新和卸载尚未提供。
