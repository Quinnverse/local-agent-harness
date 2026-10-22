# 插件协议 1.0

每个插件是独立的本地目录，包含 manifest.json、package.json（type=module）和已构建 JavaScript 入口。宿主不针对插件 ID 实现业务分支。不执行安装脚本，不自动安装插件依赖；需要依赖的插件应事先打包为自包含产物。首版支持 Node.js 24。

## Manifest

必填字段：id、name、version、protocolVersion、entry、capabilities、configSchema、permissions。可选 description。未声明的顶层字段被拒绝。id 使用小写英文字母起始，由字母/数字及点/连字符组成，最大100字符。version 为三段数字版本，可带预发布后缀；不实现更新比较或自动迁移。protocolVersion 精确为 "1.0"，不支持版本直接拒绝。

entry 是包内相对 JavaScript 文件，支持 .js/.mjs/.cjs 扩展；不得绝对寻址或越界。安装包不允许符号链接和特殊文件，忽略 node_modules、.git、.DS_Store，最多256个目录/文件、16MiB。manifest最多64KiB。

capabilities 至少一项，最多32项，name不重复，每项包含 name、inputSchema、outputSchema，可附description。JSON Schema采用Ajv严格draft-07子集，不支持网络解析$ref；无效schema安装时拒绝。configSchema必须object。

permissions 当前只支持 "files.read"。声明表示可能需要的能力，绝不代表已经授权。用户授权 readRoots 单独保存在宿主状态。

完整例子见 ../plugins/text-transform/manifest.json 和 ../plugins/file-stats/manifest.json；示例都是实际插件，而不是宿主配置项。

## 入口

入口导出 execute(request, context)，同步和异步均可。request={capability,input,config}。input已按能力schema校验，config是应用默认值后的执行时快照。入口返回符合outputSchema的JSON数据；宿主包装结果。undefined、函数、symbol、BigInt、非有限数及超过1MiB的输出被拒绝。配置替换而非patch；在副本应用default，成功后原子保存，失败不修改旧值。不强制转换类型，不静默删除未知配置。

context.files.readText(absolutePath,maxBytes=1048576) 返回 Promise<{text,bytes}>。只有插件声明files.read且用户授予目录，broker才会读取。真实路径必须落在授权目录内，路径分隔边界检查避免相近前缀混淆；普通文件、有效UTF-8，最大1MiB。context.log(message)提供受限日志；每次执行最多128次broker调用和64KiB日志。日志不进入结果协议。

## 通信与结果

每次执行创建独立Node子进程，使用IPC而非stdout作为协议。消息：invoke、capability.request、capability.response、result、error、log。能力请求具备独立requestId关联。插件开发者通常不用处理底层IPC，runner提供context。

宿主返回 {executionId,pluginId,capability,ok,durationMs,runtime?,data?,error?}。runtime={pid,terminated}；只有实际启动过进程才出现。成功带data；失败带error={code,message}。错误默认不返回堆栈或原始插件异常信息。

常见错误码：INVALID_MANIFEST、DUPLICATE_PLUGIN_ID、ENTRY_NOT_FOUND、INVALID_ENTRY、PROTOCOL_UNSUPPORTED、INVALID_CONFIG、INVALID_INPUT、PLUGIN_DISABLED、CAPABILITY_NOT_FOUND、PERMISSION_DENIED、PLUGIN_START_FAILED、PLUGIN_EXECUTION_FAILED、PLUGIN_CRASHED、PLUGIN_TIMEOUT、INVALID_OUTPUT、FILE_TOO_LARGE、INVALID_ENCODING、STATE_CORRUPT。CLI执行失败返回非零退出码并保留JSON结果。

## 生命周期

安装只校验复制并注册，默认禁用、无文件授权；不会导入入口。配置保存、授权、启用分开。启用是持久化管理状态，不代表常驻进程，也不是完整入口健康检查。执行前重新校验状态、协议、配置、能力和入口，再启动runner。禁用后不再接收新执行，已经开始的执行按原配置/授权快照完成，仍受原超时限制。单次失败不会删除配置、卸载或自动禁用插件。

默认超时5000ms，允许50..30000ms，包含进程启动。超时发送SIGKILL并等待执行进程exit后返回。结果返回后执行进程同样回收；不承诺杀死恶意插件创建的全部后代进程。首版不提供激活钩子、卸载、更新、常驻任务和执行历史。

## 安全边界

插件为可信代码，普通进程不是OS沙箱。broker权限只约束宿主提供的读取能力，不能阻止插件直接使用Node或系统文件、网络、子进程API。详见 [安全说明](security.md)。未来AgentAdapter必须调用相同Harness.run接口，不能绕过管理和权限校验；目前无模型实现，也没有伪装推理。
