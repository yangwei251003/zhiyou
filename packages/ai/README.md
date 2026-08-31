# `@bosshunter/ai`

BossHunter Next 的 Codex 连接只调用官方 Codex App Server，并复用用户在 Codex 中管理的
ChatGPT 登录状态与额度。

当前私测信任边界仅支持 Windows：程序会逐一解析 PATH 中的原生 `codex.exe`，转换为真实绝对
路径，排除当前项目目录，并从 Windows 内核 `GLOBALROOT\\SystemRoot` 命名空间定位系统
PowerShell（不信任调用方可修改的 `SystemRoot`/`windir` 环境变量），再通过无 Shell 的
PowerShell
`Get-AuthenticodeSignature` 读取签名状态与证书主体。只有签名状态为 `Valid`，且证书的
`CN` 与 `O` 都精确为 `OpenAI OpCo, LLC` 时才会启动。显式传入路径也执行同一验证，代码中
没有环境变量绕过开关。证书链还必须终止于内置 SHA-256 指纹的 Microsoft Identity
Verification Root；根轮换会安全停止，必须随版本显式更新，不能由用户证书库中的同名根放行。

启动不是“先验签、后按路径裸启动”：系统代理只接受本机固定卷，拒绝 UNC、ADS 和 reparse
组件，从卷根到安装目录逐层持有禁止删除/换绑的目录句柄，并以禁止写入/删除的叶文件句柄锁住
`codex.exe`。目录链、文件 ID、签名与证书链复验通过后，句柄锁持续到进程创建成功。代理先
进入匿名、不可继承、`KILL_ON_JOB_CLOSE` 的 Windows Job，并确认 Codex 子进程属于该 Job；
父管道关闭会直接终止整个 Job。控制握手不使用会预读的文本 Reader，业务三路流保持分离。

同一运行时的并发状态请求会合并为一个启动任务；初始化完成前不会暴露连接。停止操作会取消
进行中的验证或初始化、回收唯一子进程。若无法确认进程树已退出，本次应用会永久禁止再次启动
Codex，必须重启 BossHunter，绝不遗忘旧进程后创建第二棵进程树。

每次 AI 操作最多接收 128 个获准片段和 256 KiB 序列化上下文。JSONL 读取器在尚未收到换行时
就执行 2 MiB 单行硬上限，并严格校验响应、通知和服务端请求的运行时结构。请求写出后的响应超时
视为“结果未知”：连接立即失效，旧 App Server 进程树清理完成前不能重试。取消若发生在
`turn/start` 已发送但任务编号尚未确认的窗口，也使用同一整树终止路径，避免遗留继续消耗额度的
后台任务。

该边界防御 PATH 冒名、普通文件替换竞争、伪造同名用户根和父进程异常退出；它不声称能抵抗
已经控制当前 Windows 账户、同完整性级别进程注入或管理员权限的恶意程序。当前代理由系统
PowerShell 与内存编译的最小 C# Win32 句柄层组成；签名、可复现构建的原生 broker 仍是公开
发布门禁。

其他操作系统目前会安全停止并显示平台限制，不会退回到直接运行 PATH 中的 `codex`。

Windows 真机信任链与崩溃回收烟雾测试：

```text
pnpm test:windows-trust
```

该测试先经真实 SystemRoot PowerShell 对当前 broker 的业务数据泵发送至少 10 MiB 单行 JSONL，
要求 5 秒内完成且长度与 SHA-256 一致；再只读取账号和额度状态，显式记录
`generationRequested: false`，最后终止调用方并确认整棵受控进程树归零。
