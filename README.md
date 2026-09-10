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
- Harness 核心安装在版本化目录。新版本先由 pnpm 安装到 staging，经桌面启动器运行 `dsh --version` 并核对输出后才标记待更新；兼容旧版自动执行入口与 `0.1.5-alpha.1` 的显式 `runCli()` 入口。下次启动先试运行新版本，失败会显示原因；回退和手动切换前检查已落盘的会话日志格式，阻止旧运行时读取升级后的会话。
- 当前桌面端与内置 DSH 均为 `0.1.5-rc.2`。对 `0.1.5-alpha.1`、`0.1.5-alpha.2`、`0.1.5-rc.1` 和 `0.1.5-rc.2` 的旧日志迁移，启动器仅为已审计的 `dfy-media` 图片块和 `dfy-session-image` 生成图片块补充结构校验及准入，保留原内容和资源引用。事件转换、原日志保留和新版日志发布仍由 DSH 执行；未知块及未知字段继续拒绝迁移。侧栏点击不存在的会话时会显示错误提示。
- 桌面端为每个受管 Harness 运行时生成同源的 `dsh`、`pnpm` 和 `node` 启动器，并把它们注入 Harness 进程的 `PATH`。因此标题菜单里的开发操作、Harness 自己的终端和 Agent 启动的子进程使用的是同一套版本，不会出现“壳能用、dsh 自己不能用”的分叉。
- 桌面端通过内置 Host + Client 插件 `dsh-desktop-bridge` 提供受审批的 `desktop_restart_harness` 工具、回复/权限/提问系统通知，并监测当前 Web Profile 是否在进程启动后发生变化。模型可以请求由 Electron 主进程安全重启 Harness，从而加载新安装的插件；桥接层使用桌面私有 `--patch` 和专用模块解析器注入。桌面端还会在当前 Web Profile 的 `node_modules` 中维护 `dsh-desktop-bridge`、`dsh-desktop-browser` 的目录链接，供官方插件清单检查读取包名和版本。启动与插件命令结束时会修复缺失、失效的链接；同名普通文件或目录会报错并保留。此过程不改写 Profile 的依赖声明或 bundle 配置。

官方仓库提到未来 Electron 可通过 `file:// + IPC bridge` 运行，但当前发布包尚未提供可直接使用的桥接适配器。本项目把载体封装在 `HarnessProcess` 与 `WindowController` 内，后续可以替换而不影响更新器和用户数据。

## 开发

要求 Node.js 24+ 与 pnpm 11。

```powershell
pnpm install
pnpm dev
```

`pnpm dev` 会先编译 Electron 主进程，再并行启动 Vite 与 Electron。修改 `src/renderer` 下的 React/CSS 会热更新桌面壳，不会重启 Harness；修改主进程代码后需重启开发命令。

发布版默认禁用桌面壳的 Chromium DevTools；`pnpm dev` 保留桌面壳调试能力。内置浏览器的网页可通过右键“检查”打开独立 DevTools 并定位元素，窗口图标、网址标题及明暗主题与桌面端保持一致。

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

构建 macOS Apple Silicon 安装包（M 系列芯片，最低 macOS 12）：

```bash
pnpm package:mac:arm64
```

Harness 运行时包含平台相关的原生依赖，因此 `prepare:runtime` 必须在目标平台和架构上执行。仓库提供 `.github/workflows/build-macos-intel.yml` 和 `.github/workflows/build-macos-arm64.yml`，分别使用 Intel 和 ARM64 macOS Runner 准备运行时、构建 DMG/ZIP，并检查打包后的 Electron、原生依赖和 Harness 启动入口。推送 `v*` 标签会构建 Windows x64、macOS Intel、macOS Apple Silicon 三个平台，统一发布安装包与 SHA-256 校验文件。客户端更新会选择对应架构的安装包。

暂定版本规则：桌面端默认与内置 DSH 使用相同版本号；同一 DSH 版本下再次更新桌面端时，追加 `-1`、`-2` 等递增修订号。例如 DSH 为 `0.1.5-alpha.1` 时，桌面端依次发布 `0.1.5-alpha.1`、`0.1.5-alpha.1-1`、`0.1.5-alpha.1-2`；升级 DSH 后重新从其原版本号开始。Git 标签使用 `v` 前缀，发布说明保存在 `.github/release-notes/<标签>.md`。

桌面更新先比较 DSH 基础版本，再按数值比较桌面修订号；正式版或预发布版的渠道也以 DSH 基础版本为准。

当前 macOS 产物使用本地 ad-hoc 签名，未接入 Developer ID 签名和 Apple 公证，适合测试。

macOS 使用原生红黄绿窗口按钮，并直接从 App Resources 启动随包运行时，不需要在首次启动时解压。桌面壳自己的状态仍位于 `~/.saltfish/dfy-dsh-desktop`，Harness 官方数据仍位于 `~/.dsh`。

Windows 提供系统托盘，macOS 提供菜单栏图标。菜单只有“打开”、“关闭窗口时退出”勾选项和“退出”。默认关闭主窗口会隐藏并保留当前会话和后台任务；勾选后关闭主窗口会退出整个应用。偏好保存在桌面数据目录的 `tray-settings.json`，重启后生效。菜单“退出”和 macOS 的 Cmd+Q 始终退出应用。Windows 左键点击托盘可恢复窗口、右键打开菜单；macOS 点击单色模板图标打开菜单，自动适配系统明暗背景，包含 Retina 资源。图标加载失败时保留原来的窗口关闭行为。

桌面端会在后台检测 Harness 新版本并在菜单中提示，但不会自动下载或创建待安装版本。只有用户点击“下载 Harness 更新”后才会下载；下载完成后再次点击即可重启 Harness 子进程并应用，桌面窗口不会退出。桌面应用自身不执行静默自动更新。

## 插件管理

标题栏菜单中的“插件管理”按 Profile 汇总自定义插件，并区分 npm、Git、本地目录和 workspace 来源。列表显示插件版本、说明、启用状态与失效来源；Harness 随附的官方内置 bundle 不进入管理列表，也不能从桌面端移除。

“DFY 插件”页提供 DFY 插件的中文介绍、npm 最新版本和当前 Profile 的安装状态。支持搜索、单独安装、勾选后批量安装，以及一键更新已通过 npm 安装的 DFY 插件；公共依赖自动安装。本地目录、Git 和 workspace 来源保留原有来源，可从卡片上的“管理”返回已安装列表。版本查询失败时仍可浏览目录、重试查询或安装插件。

DFY 插件名单从插件仓库主分支的 [catalog.json](https://github.com/xiaoxiao44443/dfy-dsh-plugins/blob/main/catalog.json) 读取，版本信息从 npm 读取。新增插件只需发布 npm 包并更新目录，无需发布桌面端。首次打开时查询，成功结果缓存 5 分钟，查询失败缓存 30 秒；缓存有效时切换页签、Profile 或重新打开管理窗口不会重复查询。DFY 页的顶部刷新按钮会同时重新读取本地安装状态、GitHub 目录和 npm 版本，错误提示中的“重试”也会跳过缓存；进行中的目录请求由各入口共享。GitHub 读取失败或目录格式无效时，保留本次运行中上次成功读取的列表；尚无缓存时使用内置备用列表。

开发模式可用 `DFY_PLUGIN_CATALOG_FILE=/绝对路径/catalog.json pnpm dev` 预览尚未推送的目录文件；安装版始终读取 GitHub。目录只接受 `@dfy-plugins/` 下的包名，不从文件读取命令或安装地址。

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

普通 HTML/HTM/XHTML 文件通过 appearance 插件提供“在内置浏览器中打开”和“在默认浏览器中打开”，使用原文件的 `file:` 地址并保留相对图片、样式和脚本的目录关系。文件单击仍由 DSH 打开侧栏预览，可视化产物继续使用自身的发布地址。

内置浏览器的地址栏显示可读的中文等字符，平时隐藏本地文件与 HTTP/HTTPS 协议；首次点击全选，再次点击显示协议并放置光标。全选复制始终包含协议和 URL 编码，部分选择时复制显示的文字。右键菜单会在异步追加条目或尺寸变化时重新定位，避免超出窗口边缘。

图片菜单提供“复制”和“下载副本”。下载通过系统保存对话框选择位置，默认文件名为 `DFY DSH 图像 2026年9月9日 19_23_54.png` 这样的本地时间格式，扩展名随原始图片编码变化。能定位到已有原图时，Windows 额外显示“在资源管理器中打开”，macOS 显示“在访达中显示”；纯内存图片不会为此自动生成文件。

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
