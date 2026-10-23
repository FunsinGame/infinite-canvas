# 无限画布 Windows 桌面版

把 `web/` 里的前端打包成 Windows 安装程序。桌面版内置同一套前端代码和一个只监听 `127.0.0.1` 的静态服务器，不需要浏览器，也不需要单独启动服务。

## 双击构建

在仓库根目录双击 `build-desktop.cmd`。脚本会检查 Bun / Node.js、自动安装缺少的依赖、构建前端并生成安装包，完成后显示 `desktop/release` 里的安装包路径。

国内网络可以直接双击 `build-desktop-mirror.cmd`：它在调用同一个构建脚本前，把 Electron、electron-builder、npm 和 Bun 的下载源都切到 npmmirror。

也可以在命令行里使用：

```bat
build-desktop.cmd              :: 生成安装包
build-desktop.cmd dir          :: 只生成 win-unpacked
build-desktop.cmd mirror       :: 使用 npmmirror 镜像构建
build-desktop-mirror.cmd dir   :: 国内镜像 + 只生成 win-unpacked
build-desktop.cmd --check      :: 只检查环境，不执行构建
```

## 运行方式

启动后桌面版内部会监听固定地址 `http://127.0.0.1:32123`，窗口加载的就是这个地址。端口和 `userData` 目录共同决定 Chromium 从哪里读取 IndexedDB、localStorage 等数据，发布后不要修改。

如果启动时提示端口被占用，先关闭占用 `32123` 的程序再打开；单实例锁保证同一用户只会运行一个窗口。

## 构建产物

```text
desktop/release/infinite-canvas-<version>-setup.exe
```

版本号自动取自仓库根目录的 `VERSION`，安装包文件名和程序版本保持一致。

## 环境要求

- Windows 10 / 11 x64
- [Bun](https://bun.sh/)（安装前端依赖、构建前端）
- Node.js 22 或更高版本（electron-builder 需要，自带 npm）
- 首次构建需要联网下载 Electron 运行时，安装包约 100 MB

网络访问 GitHub 较慢时，可以在构建前设置镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## 构建安装包

首次构建先安装前端依赖：

```bash
cd web
bun install
```

再安装桌面端依赖并生成安装包：

```bash
cd ../desktop
npm ci
bun run dist
```

`bun run dist` 会依次执行：

1. 读取 `../VERSION`，同步 `desktop/package.json` 的版本号；
2. 在 `web/` 执行 `bun run build`；
3. 把 `web/dist` 复制到 `desktop/dist`；
4. 检查 `node_modules/electron/dist`，缺失时运行 Electron 自带的 `install.js` 解压运行时；
5. 把解压好的 Electron 目录交给 electron-builder，直接复制到 `release/win-unpacked`，不再解压到 `.tmp` 后重命名；
6. 调用 electron-builder 生成 NSIS 安装包。

桌面端依赖使用 npm 安装：Bun 在 Windows 上偶尔会在“移动包到缓存目录”时被安全软件短暂占用而报 `EPERM`。`desktop/package-lock.json` 已提交，`npm ci` 会按锁定版本安装。

其他命令：

```bash
bun run dev       # 构建后直接以 Electron 运行，方便本地调试
bun run dist:dir  # 只生成 desktop/release/win-unpacked/，不生成安装包
```

如果刚刚已经构建过前端，可以跳过前端构建：

```bash
node scripts/build.mjs --skip-web
```

## 安装、覆盖升级与卸载

| 项目 | 位置 / 行为 |
| --- | --- |
| 程序安装目录 | `%LOCALAPPDATA%\Programs\infinite-canvas-desktop` |
| 主程序 | `Infinite Canvas.exe` |
| 用户数据目录 | `%LOCALAPPDATA%\infinite-canvas`（首次启动后创建） |
| 覆盖安装 | 先退出正在运行的无限画布，再运行新版本 `setup.exe`；安装器会替换程序文件并保留用户数据目录 |
| 卸载 | 默认保留用户数据；需要彻底清除时手动删除 `%LOCALAPPDATA%\infinite-canvas` |
| Canvas Agent 配置 | `%USERPROFILE%\.infinite-canvas`，与桌面版互不影响 |

用户数据目录里包含 Chromium 的 IndexedDB、Local Storage、Cookie 等，画布、素材、生成记录、AI API Key 和界面设置都在其中。数据放在 `LocalAppData` 而不是漫游的 `AppData`，避免大量画布素材被企业漫游配置同步。API Key 与网页版一样以明文保存在本地，不经过项目服务器，请自行保护 Windows 账户和磁盘。

### 安装时提示“无法关闭”或“不能打开要写入的文件”

electron-builder 26.15.3 的默认 NSIS 检查在 PowerShell 可用时，会按 `$INSTDIR` 路径前缀匹配进程；正在运行的卸载程序自己也在安装目录下，因此会被误判成 Infinite Canvas，出现“无法关闭”，并连带锁住卸载程序文件。新版安装器通过 `desktop/build/installer.nsh` 改成只按进程名 `Infinite Canvas.exe` 检查，旧安装包没有这个修复。

如果仍然遇到这个提示，先确认运行的是重新构建后的 `setup.exe`（看文件修改时间），并删除旧安装目录后再试：

1. 在弹窗上点“中止”或“取消”；
2. 打开任务管理器，结束所有 `Infinite Canvas.exe`、`electron.exe`、`Uninstall Infinite Canvas.exe` 进程；
3. 删除残留的 `%LOCALAPPDATA%\Programs\infinite-canvas-desktop`（只删程序文件，不要删数据目录）；
4. 重新运行新构建的 `setup.exe`。

不要删除 `%LOCALAPPDATA%\infinite-canvas`，那里面才是画布和配置数据。

### 为什么覆盖安装不会丢数据

- 程序只写入安装目录，数据只写入 `%LOCALAPPDATA%\infinite-canvas`，两者完全分离；
- `main.cjs` 用 `app.setPath("userData", ...)` 固定了数据目录，不使用可能随产品名变化而移动的默认路径；
- 渲染进程固定加载 `http://127.0.0.1:32123/`，IndexedDB 和 localStorage 按这个 origin 隔离。只要端口不变，新版本读到的就是同一份数据；使用 http 本地地址也能避免自定义协议在 CORS、混合内容和剪贴板上与网页版行为不一致；
- 升级和启动过程都不会调用 `session.clearStorageData()`，也不会清理站点数据；
- NSIS 配置为 `oneClick`、`perMachine: false`、`deleteAppDataOnUninstall: false`，升级只覆盖当前用户安装目录，卸载默认保留数据。

以下内容决定升级能否覆盖旧版本、以及新版本能否读到旧数据，**不要随意修改**：

- `electron-builder.yml` 里的 `appId`：安装器用它识别旧版本，改了会变成并行安装而不是覆盖升级；
- `electron-builder.yml` 里的 `productName`：决定安装目录和快捷方式名称；
- `main.cjs` 里的 `APP_PORT`、`USER_DATA_DIR`：决定 Chromium 的 origin 和数据目录，改了会读不到旧数据。

覆盖安装前建议先退出正在运行的无限画布；升级包含大版本时，先通过配置导出、画布导出或 WebDAV 做一份备份。安装器只保证覆盖安装不删除数据，如果新版本调整了本地存储结构，仍以该版本说明为准；不支持直接降级到旧版本，降级前也需要先备份。

### 从浏览器版迁移

桌面版是独立的 Chromium 配置，不会自动读取浏览器里已有的 IndexedDB。第一次从网页版切换到桌面版时，用任意一种方式迁移：

- 在网页版「配置」里导出配置 JSON，在桌面版里导入；
- 逐个导出画布工程，再在桌面版里导入；
- 在「我的素材」里导出素材包并在桌面版导入；
- 配置同一个 WebDAV，同步画布、素材和生成记录。

## 图标与签名

- 安装包和窗口图标来自 `desktop/build/icon.ico`，替换后重新构建即可。
- 当前安装包未做代码签名。Windows SmartScreen 可能提示“未知发布者”，需要选择“更多信息 → 仍要运行”。正式分发时请配置代码签名证书（electron-builder 的 `win.certificateFile` / `win.certificatePassword` 或 CI 中的签名服务）。

## 自动更新

暂未接入 `electron-updater`。当前升级方式是用户下载新版本 `setup.exe` 后覆盖安装，数据目录不受影响。
