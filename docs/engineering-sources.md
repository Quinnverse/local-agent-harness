# 实现资料

Node.js 24 官方 child_process 文档说明 fork 提供独立 Node 进程及 IPC，默认继承父进程环境；kill 发送信号不等于已经退出；杀父进程不保证杀所有后代。本项目采用最小环境、SIGKILL，并在 exit 事件后返回执行结果，不声称覆盖恶意进程树。

来源：https://nodejs.org/docs/latest-v24.x/api/child_process.html

Ajv 官方文档说明 useDefaults 修改传入对象，且是非标准行为。本项目仅在配置副本中应用默认值，校验成功才写入注册表，输入/输出校验不启用类型强制转换或自动删除字段。

来源：https://ajv.js.org/guide/modifying-data.html

以上资料已实际获取并阅读；不涉及调用付费API或上传用户文件。
