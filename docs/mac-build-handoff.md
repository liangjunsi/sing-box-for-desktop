# Mac AI 构建交接

日期：2026-10-06。桌面仓库： https://github.com/liangjunsi/sing-box-for-desktop ，分支 `codex/custom-main`。

## 先理解当前状态

这是 kukuhou 定制 Electron 客户端。已有 Windows/Linux 构建流程，**尚无 macOS 打包及完整运行适配**。`scripts/package.ts` 只接受 win/linux；不要把现有命令宣称为 Mac 打包命令，也不要只生成能打开但内核无法连接的 DMG 后就结束。

当前提交包含定制 UI、账号与订阅逻辑、图标、法律声明、安装及打包脚本。Windows 生成的 bin/out/release/node_modules、签名私钥、signing.local.json 和本机账号数据不提交，Mac 必须本机重新安装和构建。

## 拉取与准备

```sh
git clone --branch codex/custom-main --recurse-submodules https://github.com/liangjunsi/sing-box-for-desktop.git
git clone https://github.com/SagerNet/sing-box.git
git -C sing-box checkout 538d104c44764dcb1eadb0162349afab8768f045
cd sing-box-for-desktop
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm -C dashboard install --frozen-lockfile
pnpm -C dashboard generate
pnpm generate
node scripts/third-party-notices.cjs
pnpm typecheck
pnpm build
```

使用 Node.js 26.7.0、pnpm 11.13.0；Go 版本由 version.json 指定，目前 go1.26.8。上面两个 clone 在同一父目录执行，核心必须位于 ../sing-box。记录桌面、dashboard、核心的实际 SHA。核心检查时工作区干净；dashboard 本地仅换行变化，未改变子模块提交，固定 SHA 为 f231354bc786dfcffcf09f6ec771bc5683050194。

这些命令只准备并构建前端，不是完整 Mac 打包步骤。安装工具链前检查本机现状，按目标 Apple Silicon arm64 或 Intel x64 构建，不复制 Windows 原生模块。补充 Rust/Xcode 等工具仅在确实需要对应本机代码时进行。

## 必须完成的 Mac 适配

1. 在 package.json / scripts/package.ts 添加 Mac 流程，在 electron-builder.yml 添加 mac 与 dmg/zip 配置；为目标架构构建并随包携带 Darwin 内核及所需动态库。先检查该核心版本的 cmd/internal/build_boxdd 和 Darwin 实现是否可用，不能假设 Windows daemon 构建方式适用于 Mac。
2. src/main/daemon.ts 在 Darwin 没有默认 socket：必须实现可用的连接、后台进程启动/停止、权限和安装机制。Windows 命名管道认证、服务安装、管理员进程身份不能直接照搬；检查 src/main/worker.ts、daemon 和系统集成的所有平台分支。
3. src/custom/desktop/runtime.ts 的系统代理设置仅有 Windows 路径。适配 Mac 系统代理、原始配置恢复、异常退出恢复；验证 VPN/TUN 所需权限、路由和 DNS，以及关闭连接后的清理。避免界面显示连接成功但流量没有经过代理。
4. 检查 Dock/托盘、窗口关闭/退出行为、启动项、钥匙串 safeStorage、网络权限、路径和可执行权限。以 resources/kukuhou-icon.png 生成 icns；Mac 托盘使用 template 图标并验证深浅主题。pnpm icons 还依赖相邻 sing-box-for-apple 仓库和 ImageMagick；现有 PNG 已提交，普通前端构建无需重跑该命令。
5. scripts/afterSign.cjs 使用平面 resources/app.asar 和可执行文件路径，不适合 .app/Contents 布局。为 Mac 调整路径和完整性验证方式，保留合理的 Electron fuse/ASAR 保护；不要用绕过全部检查作为最终方案。
6. 签名和公证在 Mac 使用自己的 Apple Developer 凭据，通过本机安全配置提供，禁止提交证书、密码、Apple API 私钥。开发测试包与签名公证发行包分开说明，并验证签名后的内核仍能正常运行。
7. 保留法律入口和 LICENSE，重新生成随包第三方声明。resources/licenses 的 Electron/Chromium 声明应与 Mac 实际依赖匹配，避免沿用与产物不一致的 Windows 缓存。完整对应源码包含固定核心与子模块版本和后续修改。

## 业务与验收

产品名 kukuhou；生产账号接口 https://chat.kukuhou.com，订阅来源 https://sub.kukuhou.com。正式包必须禁用开发登录，保留 configuredAccountApi 的 app.isPackaged 限制；dev/dev123456 仅为本地模拟账号。禁止嵌入真实订阅 token 或账号密码。

运行自定义测试：

```sh
node --import tsx --test src/custom/desktop/desktop.test.ts src/custom/subscription/subscription.test.ts src/custom/subscription/accountDownload.test.ts
```

验收应覆盖安装/首次启动、生产登录、订阅转换及更新、节点切换、真实网络代理、断开恢复、重启、退出和卸载。Apple Silicon 与 Intel 逐个记录实际验证结果；未验证的架构不要声称通过。交付 DMG/ZIP、校验值、工具链与源码 SHA、签名/公证状态及已知限制。
