# kukuhou macOS 构建交付记录

构建日期：2026-10-06（Asia/Shanghai）。应用版本：1.14.2。

## 源码与工具链

- 拉取并合并 `origin/codex/custom-main`：远端 `f3df08f`；保留原本地提交 `c61876a`。
- 桌面仓库合并后的基准 SHA：`f1665c0ef02630bd9b9296a78f34390c0ab027f0`。此次 Mac 适配为工作区修改，未提交或推送；对应源码快照与补丁随交付提供。
- dashboard：`f231354bc786dfcffcf09f6ec771bc5683050194`，工作区干净。
- 核心：`538d104c44764dcb1eadb0162349afab8768f045`，工作区干净。实际内核版本字符串 `1.14.1-538d104c4`；应用版本由桌面 `version.json` 定义。
- Node.js 26.7.0、pnpm 11.13.0、Go go1.26.8、Electron 43.4.1、electron-builder 26.15.3。
- Xcode 26.1 (17B55)，macOS 26.5.2 (25F84)，本机 Apple Silicon arm64。
- SOURCE_DATE_EPOCH：1791293110。最低声明 macOS：12.0。
- Intel Electron 从 npmmirror 下载，SHA256 与官方 GitHub release API digest 一致：`4fd0f1826660a94216a0633600a3c3e2cd87ee9e4bc6f0e1edf717ad8e30c10b`。

## 新增适配

- 双架构 Darwin 内核、Swift 系统代理辅助进程和内核监督进程随包携带。
- 用户级私有 Unix socket，客户端退出或被强制结束后，通过私有管道 EOF 停止后台内核；无需安装系统级 root daemon。
- macOS 网络代理使用 SystemConfiguration 与系统网络配置授权。保存各网络服务的原始 HTTP/HTTPS/PAC/自动发现设置，断开和客户端异常退出时恢复；下次启动也会处理恢复记录。外部改动过的代理配置不被覆盖。
- 旧 Mac 数据目录仅在确认由当前用户拥有且不是符号链接后迁移至 0700。
- 从 kukuhou PNG 生成 icns，沿用已有 template 托盘图标、钥匙串 safeStorage 和 macOS 登录项逻辑。
- 按 .app/Contents 布局核验 Info.plist 的 ASAR 摘要及 Electron Framework fuse wire，未关闭完整性保护。
- 冻结依赖、重新生成协议与第三方声明；Intel/arm64 Electron 的许可证文本一致。正式包保留 app.isPackaged 禁用开发登录的限制。

## 产物与签名

`release/` 中有 x64 和 arm64 各一套 DMG/ZIP，`SHA256SUMS.txt` 提供校验值。

这批是开发测试包：应用和辅助程序采用 ad-hoc 临时签名，未使用 Apple Developer 证书，未公证。文件名的 unsigned 表示没有开发者发行签名。Gatekeeper 可能要求使用系统“隐私与安全性”中的允许打开流程。测试包的 hardened runtime 使用 electron-builder 为 ad-hoc 发行提供的标准 JIT 与 library-validation 权限。

DMG 内将 kukuhou.app 拖至 Applications 完成安装。运行期间断开连接并正常退出后可移除 app；没有安装 launch daemon。保留的账号、缓存和配置在 `~/Library/Application Support/sing-box`，如需删除请先退出并确认没有待恢复代理记录。

## 实际验证

- `pnpm typecheck`：通过。
- 指定三组业务测试：31/31 通过。
- 两个最终 .app 的包内内核均通过：RPC 所有权、真实本地 HTTP 上游代理流量、节点切换改变路由、断开关闭监听、父管道 EOF 停止 daemon、私有 socket 目录。
- arm64 原生启动：主进程、sandbox 渲染进程、网络进程和后台内核启动，旧数据目录权限迁移成功。
- x64 完整应用在 Rosetta 上启动，sandbox 渲染进程和后台内核运行，RPC 可用；Intel 真机尚未验证。启动时 Chromium 网络服务报告一次退出并自动重启，随后应用及内核继续运行；不能据此宣称 Intel 原生稳定性已验收。
- 两套 .app：`codesign --verify --deep --strict` 通过，所有 fuse 与 ASAR metadata 核验通过。
- 两套 DMG：`hdiutil verify` 通过；两套 ZIP：`unzip -tq` 通过。
- 系统代理辅助程序的只读状态查询通过；需要人工完成网络授权弹窗、实际系统代理启用/原配置恢复及异常退出恢复验收。电脑控制工具没有授权，未进行视觉验收。

## 尚未验收及已知限制

1. 没有使用生产账号测试登录、生产订阅、远端节点、额度验证和单设备会话；未嵌入真实账号或 token。
2. 此版本完成的是普通用户的系统 HTTP/HTTPS 代理模式。VPN/TUN 需要管理员权限及独立安全的特权服务适配，尚未完成；精简界面拒绝 TUN 配置，不能把高级界面的 TUN 当作已支持功能。
3. 内核采用 build_boxdd 的 Darwin non-CGO 构建标签，无外部 Cronet 动态库；依赖 Cronet/特定 CGO 或特权能力的协议不能宣称已支持。常见协议能力以核心校验结果为准。
4. Intel 原生硬件、深浅主题托盘视觉、Dock/关闭/正常退出交互、登录项及钥匙串首次授权、卸载后的完整系统设置检查尚未人工验收。
5. 系统代理只作用于遵循 macOS 系统代理设置的应用，不等同于全局 VPN；构建成功不等同于生产发行验收通过。

## 重建

有 Git 工作区时：

```sh
pnpm install --frozen-lockfile
pnpm -C dashboard install --frozen-lockfile
pnpm typecheck
pnpm package:mac
```

核心必须位于 `../sing-box`，并检出上文 SHA；Go 需在 PATH 上。Mac 包装命令会生成协议、声明、前端、双架构内核、Swift helper、icns、DMG 与 ZIP。

如果官方 Electron 下载受阻，可设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。也可设置 `KUKUHOU_ELECTRON_DIST=/absolute/path/to/distributions`，其下 `x64/`、`arm64/` 各包含对应版本/架构的解压 Electron.app、LICENSE、LICENSES.chromium.html 和 version。必须自行核对官方 SHA256，不能将 ARM 运行时用于 Intel 包。

源码压缩包包含 desktop、dashboard 和固定核心的文件快照，不包含 Git 历史、依赖缓存、账号数据或签名私钥。重建时先在新的构建目录 `git clone https://github.com/SagerNet/sing-box.git sing-box` 并 `git -C sing-box checkout 538d104c44764dcb1eadb0162349afab8768f045`，再解压源码包覆盖同名源码目录以保留核心 Git tag 信息。进入 sing-box-for-desktop，设置 `SOURCE_DATE_EPOCH=1791293110`，按上述命令安装依赖并构建。修改版可自行临时签名或使用自己的开发者证书；不需要本次构建者的私钥。
