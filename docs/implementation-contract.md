# 实施契约（P0）

所有路径均位于本项目。正式插件 id：demo.text-transform / demo.file-stats。协议版本 1.0，插件入口导出 async execute(request, context)。request={capability,input,config}。context.files.readText(path,maxBytes?) 返回 {text,bytes}；context.log(message) 为受限日志。插件只返回 data；宿主封装执行结果。

Manifest: {id,name,description?,version,protocolVersion,entry,capabilities:[{name,description?,inputSchema,outputSchema}],configSchema,permissions:[]|['files.read']}。schema draft-07，configSchema 必须 object。入口相对路径且在插件目录内部。安装包包含 package.json {type:'module'} 和已构建入口。拒绝 symlink、特殊文件、node_modules，不自动安装依赖。

src/core/harness.ts 导出 class Harness，constructor({dataDir?:string,timeoutMs?:number})。方法均 async：install(source:string)->PluginRecord；list()->PluginRecord[]；show(id)->PluginRecord；configure(id,config:Record<string,unknown>)->PluginRecord（完整替换，副本应用默认值）；enable(id)/disable(id)->PluginRecord；grant(id,root)/revoke(id,root)->PluginRecord；run(id,capability,input,{timeoutMs?}={})->ExecutionResult。

PluginRecord={manifest,enabled,config,grants:{readRoots:string[]},installedAt,packagePath}。新安装默认禁用、无授权，默认配置可用或待补充配置。run 永远返回 {executionId,pluginId,capability,ok,durationMs,runtime?:{pid,terminated},data? ,error?:{code,message}}。管理操作失败抛 HarnessError（code/message）。禁用后拒绝新执行，在途执行允许完成。配置与授权为执行时快照。timeout 限定 50..30000 ms，默认 5000 ms，必须终止执行子进程并在退出后返回。

文本插件 capability text.transform，input {text}，config {caseMode:'upper'|'lower'} default upper，output {text}。
文件插件 capability file.stats，input {path}，config {maxBytes: integer 1..1048576} default 1048576，permission files.read，output {bytes,lines,tokens}。空文件0行；LF/CRLF/CR分隔；末尾换行不增行；空白分隔非空片段为词元。fixture alpha beta\\n你好世界\\n = 24 bytes,2 lines,3 tokens。broker 文件授权由真实路径包含检查实施。

CLI：node dist/src/cli.js [--data-dir DIR] plugins install DIR|list|show ID|configure ID --config-json JSON|enable ID|disable ID|run ID --capability NAME --input-json JSON [--timeout-ms N]；permissions grant ID --read-root DIR|revoke ID --read-root DIR；serve --port 4317。输出 JSON，失败退出码非0。

P3 本地 HTTP src/web/server.ts：export async startServer(harness,{port?:number}) -> {server,url,token}，port=0 可测试，默认4317，host127.0.0.1。
GET /api/session -> {token,dataDir,protocolVersion:'1.0'}；GET /api/plugins -> PluginRecord[]；GET /api/plugins/:id -> PluginRecord。
POST /api/plugins {source} -> PluginRecord；PUT /api/plugins/:id/config {config} -> PluginRecord；POST /api/plugins/:id/enable 或 /disable {} -> PluginRecord；POST /api/plugins/:id/grants {root} -> PluginRecord；DELETE /api/plugins/:id/grants {root} -> PluginRecord；POST /api/plugins/:id/run {capability,input,timeoutMs?} -> ExecutionResult。
成功响应 {ok:true,data:...}，管理错误 {ok:false,error:{code,message}} + 4xx/5xx。run 的执行错误属于成功接收请求，其 data.ok=false。所有写请求 require Content-Type application/json 和 X-Harness-Token；Origin 若出现必须与 url 相同；Host 必须精确127.0.0.1:port。禁止CORS。GET /health -> {ok:true}。static / /app.js /style.css /manus-routes.json。仅一页。

本契约与 Phase1–5 用户指令冲突时以用户指令为准。所有自动化测试使用项目 .work 或临时测试目录。不得修改宿主以加入第三插件特判。
