# DFY DSH Desktop

DeepSeek Harness 的轻量 Electron 桌面壳。Harness 仍是完整、未修改的官方 Web UI；桌面端只增加原生窗口、自定义标题栏、进程托管和独立的 Harness 运行时更新。

## 架构

- Electron 主进程只负责窗口、更新和 Harness 子进程，不承载 Agent 业务。
- Harness 使用 Electron 内置 Node 24 以独立进程运行：`dsh web --port 0`。
- 发布包把 Harness 与 pnpm 更新器作为独立运行时分发，不依赖 `app.asar` 的依赖裁剪结果。桌面壳会先显示启动窗口，再准备运行时；macOS 直接从 App Resources 使用运行时，避免首次启动解压数万个文件；Windows 在窗口内提示并完成首次原子解包，后续直接复用。
- 页面仅绑定 `127.0.0.1` 的随机端口，并嵌入沙箱化 iframe；主壳与 Harness DOM 隔离，Harness 不获得 Electron IPC。
- 桌面壳 renderer 使用 React 19 + TypeScript + Vite，开发模式支持 HMR；Harness 页面和进程生命周期仍由 Electron 主进程独立托管。
- 桌面端不覆盖 `DSH_HOME`：Harness 遵循官方解析顺序（显式配置、`$DSH_HOME`、`~/.dsh`）。因此外部 dsh 与桌面端自然共享配置、会话、Profile、凭据和扩展；项目工作区仍由 Harness 自己管理。
- 桌面壳自己的 Chromium 状态、运行时、更新缓存和开发设置统一位于 `~/.saltfish/dfy-dsh-desktop`，Windows、macOS 与 Linux 使用同一目录约定。首次启动会自动迁移旧版 `~/.saltfish/deepseek-harness-desktop`。
- Harness 核心安装在版本化目录。新版本先由 pnpm 安装到 staging，完成构建脚本白名单校验和 `dsh --version` 验证后才标记待更新；下次启动先试运行新版本，健康检查失败会自动回退。
- 桌面端为每个受管 Harness 运行时生成同源的 `dsh`、`pnpm` 和 `node` 启动器，并把它们注入 Harness 进程的 `PATH`。因此标题菜单里的开发操作、Harness 自己的终端和 Agent 启动的子进程使用的是同一套版本，不会出现“壳能用、dsh 自己不能用”的分叉。
- 桌面端通过内置 Host + Client 插件 `dsh-desktop-bridge` 提供受审批的 `desktop_restart_harness` 工具、回复/权限/提问系统通知，并监测当前 Web Profile 是否在进程启动后发生变化。模型可以请求由 Electron 主进程安全重启 Harness，从而加载新安装的插件；桥接层使用桌面私有 `--patch` 和专用模块解析器注入，不会改写用户共享的 `~/.dsh/profiles/web`。

官方仓库提到未来 Electron 可通过 `file:// + IPC bridge` 运行，但当前发布包尚未提供可直接使用的桥接适配器。本项目把载体封装在 `HarnessProcess` 与 `WindowController` 内，后续可以替换而不影响更新器和用户数据。

## 开发

要求 Node.js 24+ 与 pnpm 11。

```powershell
pnpm install
pnpm dev
```

`pnpm dev` 会先编译 Electron 主进程，再并行启动 Vite 与 Electron。修改 `src/renderer` 下的 React/CSS 会热更新桌面壳，不会重启 Harness；修改主进程代码后需重启开发命令。

发布版默认禁用 Chromium DevTools；`pnpm dev` 保留调试能力，方便开发桌面壳。

检查：

```powershell
pnpm typecheck
pnpm test
```

构建 Windows 安装包：

```powershell
pnpm package:win
```

仓库提供 `.github/workflows/build-windows.yml`，可在 GitHub Actions 中手动构建 Windows x64 NSIS 安装包；推送 `v*` 标签时也会自动构建。当前产物未签名，适合测试，首次运行可能触发 Windows SmartScreen 提示。

Windows 卸载程序会询问是否一并删除 `~/.saltfish/dfy-dsh-desktop`。该选项默认关闭；无论如何都不会删除官方 Harness 共用的 `~/.dsh`。

构建 macOS Intel 安装包（最低 macOS 12）：

```bash
pnpm package:mac:intel
```

Harness 运行时包含平台相关的原生依赖，因此 `prepare:runtime` 必须在目标平台和架构上执行，Windows 生成的 `harness-runtime.tgz` 不能用于 macOS。仓库提供 `.github/workflows/build-macos-intel.yml`，可以在 GitHub Actions 的 Intel macOS Runner 上手动构建 DMG 和 ZIP。当前产物未签名，适合测试；公开分发前还需要接入 Developer ID 签名和 Apple 公证。

macOS 使用原生红黄绿窗口按钮，并直接从 App Resources 启动随包运行时，不需要在首次启动时解压。桌面壳自己的状态仍位于 `~/.saltfish/dfy-dsh-desktop`，Harness 官方数据仍位于 `~/.dsh`。

桌面端会在后台检测 Harness 新版本并在菜单中提示，但不会自动下载或创建待安装版本。只有用户点击“下载 Harness 更新”后才会下载；下载完成后再次点击即可重启 Harness 子进程并应用，桌面窗口不会退出。桌面应用自身不执行静默自动更新。

## 插件管理

标题栏菜单中的“插件管理”按 Profile 汇总自定义插件，并区分 npm、Git、本地目录和 workspace 来源。列表显示插件版本、说明、启用状态与失效来源；Harness 随附的官方内置 bundle 不进入管理列表，也不能从桌面端移除。

添加和移除操作始终通过官方 `dsh plugin --profile <名称> ...` 执行，由 dsh 在 pnpm 成功后维护 Profile 的 `dsh.profile.bundles`。桌面端不会直接改写 Profile。操作完成后可从管理页重启 Harness 使变更生效；遇到安装问题可直接打开官方插件文档。

## Harness 开发能力

标题栏菜单中的“开发工具”提供官方开发流程的桌面入口：

- **Patch 配置**：选择 `yml`、`yaml` 或 `json`，重启后等价于额外添加一个 `dsh web --patch <配置文件>`。路径会保存，下次启动继续使用；未选择文件时按钮只执行普通 Harness 重启。
- **终端 dsh**：可将桌面端随附的 dsh 暴露为系统命令；关闭后移除桌面端创建的入口，不影响 Harness 内部运行。
- **创造模式**：继续使用 Harness 内置预设，桌面端不复制或修改 Harness 界面。

同样的命令也可以直接在 Harness 内部终端执行，例如：

```powershell
dsh --version
pnpm --version
dsh plugin --profile default add ./scratch-plugin
```

Patch 是 Harness Web 服务的启动参数，因此要通过桌面菜单应用；插件通过独立管理页或相同的官方 dsh 命令管理。

### 插件右键菜单贡献

桌面端的基础右键菜单由 Electron 直接从 Harness iframe 的 `context-menu` 事件生成，即使 `dsh-desktop-bridge` Client 插件未加载，撤销、剪切、复制、粘贴、全选和链接操作仍然可用。React 壳层只负责绘制菜单，Harness 页面不会获得 Electron IPC。

`dsh-desktop-bridge` Client 插件通过官方 Cordis 机制提供 `desktopContextMenu` Service。其他 Client 插件用 `inject` 声明依赖并追加菜单项；注册属于调用插件自己的 Fiber，插件卸载或热替换时会由 Cordis 自动撤销。Electron IPC 只是 Service Provider 内部的传输实现，不是插件 API。桌面壳只接收经过限长、命名空间和图标白名单处理的菜单描述，回调始终留在 Harness iframe 内执行。

```js
export const inject = ['desktopContextMenu']

export function apply(ctx) {
  ctx.desktopContextMenu.register({
    id: 'archive-manager.archive-session',
    label: '归档当前会话',
    icon: 'archive',
    group: 'session',
    order: 100,
    when: ({ target }) => Boolean(target.closest('[data-session-id]')),
    enabled: ({ target }) => target.getAttribute('aria-busy') !== 'true',
    onSelect: async ({ target }) => {
      const sessionId = target.closest('[data-session-id]')?.dataset.sessionId
      if (sessionId) await archiveSession(sessionId)
    },
  })
}
```

`label`、`enabled`、`checked`、`danger` 和 `when` 均可使用基于点击上下文的函数。上下文提供 `target`、`editableElement`、`editable`、`selectionText`、`linkUrl`、`x`、`y` 和原始 `event`。可用图标由 `ctx.desktopContextMenu.icons` 给出；未知图标会回退为 `plugin`。

仅把菜单当作可选桌面增强的跨平台插件，可以使用 `ctx.get('desktopContextMenu')?.register(...)`，不必声明硬依赖。动态 Cordis 插件可通过 `DesktopContextMenu.describe` Inspect Provider 获取准确的 Service 合约、图标列表和示例，不需要读取页面全局变量。

## 更新策略

桌面端启动 15 秒后检查 npm 的 `@deepseek-ai/dsh` `latest` 标签，此后每 6 小时检查一次。下载完成后标题栏显示“已就绪”；点击可只重启 Harness 子进程并应用，也可以在下次正常启动时自动应用。Harness 核心更新与未来桌面壳自身更新相互独立。

## 许可证

本项目的桌面壳代码基于 [MIT License](LICENSE) 开源。DeepSeek Harness 及其他第三方组件仍分别遵循其各自的许可证。
