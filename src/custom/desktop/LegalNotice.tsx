import { useEffect, useRef } from "react";
import originalNotice from "../../../LICENSE?raw";
import gpl from "../../../resources/licenses/GPL-3.0.txt?raw";

export function LegalNotice({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="kc-legal" onClose={onClose} aria-labelledby="kc-legal-title">
    <header><h2 id="kc-legal-title">关于与开源许可</h2><button onClick={() => dialog.current?.close()} aria-label="关闭关于与开源许可">×</button></header>
    <h3>kukuhou</h3>
    <p>基于 sing-box、sing-box-for-desktop 和 sing-box-dashboard 的非官方修改版，与 SagerNet / nekohasekai 无隶属、赞助或认可关系。</p>
    <p>原项目版权：Copyright © 2022 nekohasekai。原作者及其他贡献者的版权保留。</p>
    <p>本软件遵循 GNU GPL v3 或更新版本；你可以依据协议修改和再分发。本软件不提供任何担保，包括适销性或特定用途适用性的担保。</p>
    <p>修改日期：2026-10-06。主要修改：账号登录、订阅集成、简洁界面、系统代理控制、图标和 Windows 安装流程。</p>
    <p><a href="https://github.com/liangjunsi/sing-box-for-desktop" target="_blank" rel="noreferrer">项目仓库</a> · <a href="https://github.com/SagerNet/sing-box-for-desktop" target="_blank" rel="noreferrer">原始项目</a></p>
    <button className="kc-primary" onClick={() => void window.desktop.custom.licenses()}>打开许可证文件夹</button>
    <details><summary>原始版权与附加条款</summary><pre>{originalNotice}</pre></details>
    <details><summary>GNU GPL v3 完整原文</summary><pre>{gpl}</pre></details>
  </dialog>;
}
