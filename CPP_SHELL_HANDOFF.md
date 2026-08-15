# Oh My Pi C++ Windows 外壳开发交接

> 用途：把本文件交给另一台电脑上的 Codex/开发者，使其在不了解当前对话的情况下开始开发 C++ 外壳。
>
> 目标不是重写 OMP agent，而是为现有 `omp --mode core` 提供一个 Windows 原生宿主。

## 1. 仓库与远程关系

- 用户自己的 GitHub Fork：`https://github.com/ErikHua2008/oh-my-pi.git`
- Hanrui 的上游仓库：`https://github.com/LambdaExpress/oh-my-pi.git`
- 主要开发基线：`reset`
- C++ 外壳建议分支：`codex/cpp-win32-shell`

在另一台电脑上执行：

```powershell
git clone https://github.com/ErikHua2008/oh-my-pi.git
cd oh-my-pi
git remote add upstream https://github.com/LambdaExpress/oh-my-pi.git
git fetch --all --prune
git switch -c codex/cpp-win32-shell origin/reset
git remote -v
```

正常情况下应看到：

```text
origin   https://github.com/ErikHua2008/oh-my-pi.git
upstream https://github.com/LambdaExpress/oh-my-pi.git
```

只有用户明确要求提交或推送时，才执行：

```powershell
git add packages/cpp-shell
git commit -m "feat: add native Windows C++ shell"
git push -u origin codex/cpp-win32-shell
```

不要直接向 `upstream` 推送。不要把功能直接写在 `reset` 上。

如果 GitHub 连接不稳定，可以使用本机 Clash 的实际 HTTP 代理端口：

```powershell
git config --local http.proxy http://127.0.0.1:<Clash端口>
git config --local https.proxy http://127.0.0.1:<Clash端口>
```

网络恢复后可清除仓库级代理：

```powershell
git config --local --unset http.proxy
git config --local --unset https.proxy
```

## 2. 开始前必须读取

先完整阅读仓库根目录的 `AGENTS.md`，它包含项目结构、构建命令、代码规范和测试要求。

重要限制：

- 不要修改或提交与 C++ 外壳无关的现有工作。
- 不要运行 `tsc`/`npx tsc`；TypeScript 检查使用仓库的 Bun/`tsgo` 脚本。
- 不要自行创建 GitHub Issue、PR 或评论。
- 未经用户明确要求，不要提交和推送。
- C++ 外壳应放在新的 `packages/cpp-shell/`，不要覆盖现有 `packages/tauri-shell/`。

## 3. 这个项目是什么

Oh My Pi 是一个以 Bun/TypeScript 为主的 coding-agent monorepo，命令行程序名为 `omp`。

核心包：

| 路径 | 作用 |
|---|---|
| `packages/coding-agent/` | `omp` CLI、会话、工具、Core/RPC/ACP/TUI 模式 |
| `packages/agent/` | 与具体 provider 无关的 agent loop |
| `packages/ai/` | OpenAI 兼容及其他 provider、流式请求、鉴权 |
| `packages/wire/` | 浏览器/宿主与 OMP 的通信协议类型 |
| `packages/collab-web/` | 当前会话管理和聊天 Web UI |
| `packages/tauri-shell/` | 已有 Rust + Tauri Windows 外壳，可作为行为参考 |
| `packages/natives/`、`crates/pi-natives/` | Rust/N-API 原生能力 |

OMP 会话本身是 JSONL 日志，通常保存在：

```text
%USERPROFILE%\.omp\agent\sessions\...
```

外壳不应自行解析或改写会话文件。会话创建、恢复、重命名、provider 调用和 JSONL 持久化都应交给 OMP Core。

## 4. 现有外壳如何工作

现有 Rust/Tauri 外壳最值得参考的文件：

| 文件 | 参考内容 |
|---|---|
| `packages/tauri-shell/src/core_engine.rs` | 启动/停止 Core、读取 stdout、错误和超时处理 |
| `packages/tauri-shell/src/project.rs` | 项目选择、项目切换、菜单、托盘、窗口状态 |
| `packages/tauri-shell/src/config.rs` | 配置文件、OMP 命令解析、最近项目 |
| `packages/tauri-shell/src/main.rs` | 单实例、窗口和 Tauri 命令注册 |
| `packages/coding-agent/src/modes/core-mode.ts` | OMP Core 的启动与本地 Web/Relay 服务 |
| `packages/coding-agent/src/collab/control-host.ts` | 多会话控制房协议 |
| `packages/collab-web/src/lib/control-client.ts` | Web 端控制协议客户端 |

外壳启动 Core 的等价命令：

```powershell
omp --mode core --no-open --cwd <项目目录>
```

开发源码模式的等价命令：

```powershell
bun --cwd=<仓库>\packages\coding-agent src/cli.ts --mode core --no-open --cwd <项目目录>
```

Core 启动后会在 stdout 输出两行：

```text
ctrl: http://127.0.0.1:<port>/#ws://127.0.0.1:<port>/r/ctrl-...
session: http://127.0.0.1:<port>/#ws://127.0.0.1:<port>/r/...
```

C++ 外壳应解析 `ctrl:` URL，并让 WebView2 导航到它。这个页面提供项目侧栏、多个会话和聊天界面。

注意：URL 中包含房间密钥/写令牌，不得写入普通日志、崩溃报告或遥测。

## 5. 推荐的 C++ 技术方案

第一版建议使用：

- C++20
- 原生 Win32 窗口和消息循环
- Microsoft WebView2
- CMake
- WebView2 SDK 通过 NuGet 或 CMake 可重复获取
- JSON 库优先选择仓库内可固定版本的小型依赖，例如 `nlohmann/json`

不建议第一版就用 C++ 重写聊天渲染、Markdown、工具调用卡片和控制协议。先用 WebView2 承载现有 `collab-web`，把进程管理、窗口、菜单、托盘和项目切换做成原生 C++。

这样能先验证：

- Win32 外壳启动和切换是否足够快。
- 长时间运行时，外壳自身内存和消息循环是否稳定。
- 卡顿究竟来自宿主外壳、WebView 页面，还是超长会话渲染。

如果目标是完全原生的微信式聊天列表，可在第二阶段逐步替换 WebView 中的侧栏/消息列表；不要在 MVP 阶段复制整个 OMP agent 和会话实现。

## 6. 建议目录结构

```text
packages/cpp-shell/
├─ CMakeLists.txt
├─ README.md
├─ cmake/
├─ include/omp_shell/
│  ├─ app.h
│  ├─ config.h
│  ├─ core_process.h
│  ├─ project_manager.h
│  └─ webview_host.h
├─ src/
│  ├─ main.cpp
│  ├─ app.cpp
│  ├─ config.cpp
│  ├─ core_process.cpp
│  ├─ project_manager.cpp
│  └─ webview_host.cpp
├─ resources/
│  ├─ app.ico
│  └─ app.rc
└─ tests/
   ├─ config_test.cpp
   ├─ core_output_parser_test.cpp
   └─ path_normalization_test.cpp
```

C++ 外壳配置建议独立存储，避免实验版本破坏现有 Tauri 外壳配置：

```text
%APPDATA%\io.omp.cpp-shell\config.json
```

不要在外壳配置中保存 provider API Key。OMP 继续读取当前用户环境变量和 `~/.omp` 中已有的鉴权配置。

## 7. MVP 功能清单

按以下顺序开发：

1. 创建 Win32 主窗口并嵌入 WebView2。
2. 用 `CreateProcessW` 启动 OMP Core，隐藏控制台窗口。
3. 为 stdout/stderr 建立匿名管道，异步读取，避免子进程阻塞。
4. 在 90 秒超时内严格解析 `ctrl:` 和 `session:` 两行。
5. 导航 WebView2 到 `ctrl:` URL。
6. 使用 `IFileOpenDialog` 的文件夹选择模式打开项目。
7. 切换项目前先终止并回收旧 Core，再启动新 Core；确保同一 JSONL 不出现两个 writer。
8. 保存最近项目、最后项目和窗口位置。
9. 增加单实例保护、关闭到托盘、真正退出时清理 Core 子进程。
10. 增加清晰的启动失败、超时、Core 提前退出和 stderr 尾部提示。

Windows 进程创建建议：

- 使用 Unicode API（`CreateProcessW`）。
- 参数必须使用可靠的 Windows 命令行转义函数，不要简单拼接带空格路径。
- 使用 `CREATE_NO_WINDOW` 或等价策略隐藏 Core 控制台。
- 使用 Job Object，并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，避免外壳崩溃后遗留 Core。
- 不要同步阻塞 UI 线程等待 stdout；使用工作线程或线程池，再通过窗口消息回到 UI 线程。
- 正确处理 `\\?\C:\...` 与普通 Windows 路径的比较和传参。

## 8. 验收标准

最低验收：

- 双击 EXE 后能选择项目并打开 OMP 会话管理页面。
- 不弹出额外命令行窗口。
- 能看到已有会话、创建新会话、打开已有会话。
- 切换项目不会遗留旧的 `omp` 进程。
- 关闭/退出后没有孤儿 Core 进程。
- 路径中包含中文和空格时仍可工作。
- API Key 不写入 C++ 外壳配置或日志。
- Core 启动失败时用户能看到 stderr 尾部，而不是只看到空白窗口。

建议测试：

- `ctrl:`/`session:` 行解析，包含分块读取和额外日志。
- 90 秒超时和 Core 提前退出。
- Windows 参数转义和中文路径。
- `\\?\` 路径与普通路径的等价比较。
- 配置文件损坏时备份并回退默认值。
- 连续切换项目后只有一个 Core 子进程。

## 9. 与当前开发工作的关系

当前这台电脑本地还有分支：

```text
codex/desktop-rename-project-session
```

该分支正在增加“项目显示名称重命名”和“会话标题重命名”。截至本交接文档创建时，这些修改尚未提交和推送，因此另一台电脑从 GitHub 克隆后看不到它们。

C++ 外壳开发不要等待这个分支，可直接从 `origin/reset` 开始。等重命名分支提交并推送后，再由用户决定 merge、rebase 或 cherry-pick。不要手工复制尚未推送的协议代码。

## 10. 为什么先放在当前仓库

结论：第一阶段在当前 monorepo 的独立分支和 `packages/cpp-shell/` 中开发更合适。

原因：

- 外壳与 `omp --mode core`、`packages/wire`、`collab-web` 有直接接口依赖。
- 可以随时对照现有 Tauri 外壳，减少进程生命周期和路径处理错误。
- 一次变更可以同时更新协议、Core、Web UI 和 C++ 宿主，并做集成测试。
- 用户 Fork 与 Hanrui upstream 的同步、cherry-pick 和 PR 都更简单。
- MVP 仍在快速确定边界，过早拆库会增加版本兼容和联调成本。

满足以下条件后再考虑拆成独立仓库：

- Core 启动/控制协议已经版本化且稳定。
- C++ 外壳有独立的发布、安装器和版本周期。
- 外壳团队不需要频繁同时修改 OMP Core/Web UI。
- 可以用发布版 OMP SDK/协议包，而不是源码相对路径。

即使以后拆库，也可以保留本目录作为原型或集成测试宿主，再把成熟代码迁移出去。

## 11. 给接手 Codex 的第一条指令

可以把下面这段连同本文件一起交给另一台电脑的 Codex：

```text
请完整阅读仓库根目录 AGENTS.md 和 CPP_SHELL_HANDOFF.md。先只做只读架构检查，确认 origin/upstream/当前分支，然后在 codex/cpp-win32-shell 分支下的 packages/cpp-shell/ 实现 C++20 + Win32 + WebView2 的最小外壳。复用 omp --mode core，不要重写 agent、provider 或 JSONL 会话层，不要修改现有 Tauri 外壳。先提交实施计划和拟新增文件清单，再开始编码。未经我明确要求不要 commit、push、建 PR 或改 GitHub Issue。
```
