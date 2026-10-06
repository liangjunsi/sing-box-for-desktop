# kukuhou 开源许可与 Windows 卸载入口检查

检查日期：2026-10-06。范围：本地桌面客户端、主要界面、安装配置、随包声明。
这是基于代码和许可证的工程检查，不是完整法律意见或全依赖合规认证。

## 当前许可

桌面、dashboard、sing-box 核心的 LICENSE 均声明 GPL-3.0-or-later，
保留 nekohasekai 原始版权和无担保声明，并增加禁止未经同意使用原应用名称
或暗示关联的条款。GPL 第 7 条允许一定范围的署名及商标相关附加要求；
该条款的最终解释不在本次工程检查范围内。原文必须完整保留。

## 发现与修正

1. 简洁界面缺少便捷的法律声明入口：新增“关于与开源许可”，包含版权、
   GPL、无担保声明、修改日期、非官方身份及离线完整许可证。
   GPL 第 0、5(d) 条说明交互界面的法律声明及适用例外。
2. 去除安装许可页后，安装包配置没有明确携带原 LICENSE/GPL 全文：
   增加三个项目的原始声明、GPL 全文、修改说明及第三方声明文件。
   一键安装本身不违规，也不要求每次弹出“接受协议”向导。
3. 包作者和注册信息继续使用 SagerNet：改成 kukuhou contributors，
   增加“非官方修改版、无隶属/赞助/认可关系”说明。
   把产品改名、替换图标本身不是 GPL 违规；不能因此抹去版权和许可。
4. JavaScript、字体及 Electron/Chromium 声明分散在依赖目录：
   收集随包声明。此清单涵盖构建依赖，并不等同于最终运行时 SBOM。

## 仍需完成，不能宣称完全合规

- 对外提供二进制时，需要依 GPL 第 6 条提供该版本完整 Corresponding Source，
  包含本次修改、dashboard/核心的对应修改、构建和安装脚本。
  指向上游或仅存在的 fork 地址，不能证明修改已经发布。
  本次没有推送代码、发布源码或发布安装包到外部平台。
- Go 模块、Cronet、WinDivert、VirtualBox/USBIP 驱动及其修改/来源需独立核对。
  现有 Node 声明收集器不能覆盖这些二进制的所有许可义务。
- AI 生成图标没有使用某个现成无聊猿头像作为素材；这不构成对商标、
  著作权或最终图形近似程度的法律保证，应避免声称官方 BAYC 合作。
- 修改版应能按公开说明自行构建及使用自己的证书签名。自签名不是许可付费要求，
  不应把发行方私钥放入源码包。GPL 第 6 条 Installation Information 是否
  适用取决于具体分发情境，不宜一概认定必须公开发行方私钥。

## 卸载入口

原 NSIS 模板有 UninstallString 和 QuietUninstallString，未发现明确设置
NoRemove 或 SystemComponent 来禁止卸载。应用列表可卸载也符合这一结果。
仅凭源代码无法确认用户电脑搜索结果缺少原生“卸载”按钮的具体原因。

改进：使卸载显示名与快捷方式统一为 kukuhou，加入 AppUserModelID 关联信息，
清理隐藏/禁止卸载标记，并创建可搜索的“卸载 kukuhou”快捷方式。
卸载时移除该快捷方式。它提供直接卸载入口，但不保证 Windows Search
在所有系统版本和策略下显示原生右键“卸载”命令。
尚未在用户电脑进行安装/搜索/卸载全流程验证。

## 依据

- GNU GPLv3：https://www.gnu.org/licenses/gpl-3.0.html
- GNU FAQ：https://www.gnu.org/licenses/gpl-faq.html
- GPL 原文副本来源：SPDX 官方 license-list-data/text/GPL-3.0-or-later.txt
- Windows 应用标识：https://learn.microsoft.com/en-us/windows/win32/properties/props-system-appusermodel-id
- Windows 开始菜单策略：https://learn.microsoft.com/en-us/windows/configuration/start/policy-settings
