import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ProxySnapshot { Flags: number; Server: string; Bypass: string; AutoConfig: string }
const execute = promisify(execFile);
// WinINet per-connection options, matching sing-box's current-user/LAN proxy scope.
// Capture all flags (including PAC and auto-detection), not just ProxyEnable.
const helper = `
using System;
using System.Runtime.InteropServices;
public static class KukuhouProxy {
  [StructLayout(LayoutKind.Explicit, Size=16)] public struct Option {
    [FieldOffset(0)] public uint Key;
    [FieldOffset(8)] public IntPtr Text;
    [FieldOffset(8)] public uint Number;
  }
  [StructLayout(LayoutKind.Sequential)] public struct List {
    public uint Size; public IntPtr Connection; public uint Count; public uint Error; public IntPtr Options;
  }
  public class Snapshot { public uint Flags; public string Server; public string Bypass; public string AutoConfig; }
  [DllImport("wininet.dll", EntryPoint="InternetQueryOptionW", SetLastError=true)]
  static extern bool Query(IntPtr handle, uint option, ref List value, ref uint size);
  [DllImport("wininet.dll", EntryPoint="InternetSetOptionW", SetLastError=true)]
  static extern bool Set(IntPtr handle, uint option, ref List value, uint size);
  [DllImport("wininet.dll", EntryPoint="InternetSetOptionW", SetLastError=true)]
  static extern bool Notify(IntPtr handle, uint option, IntPtr value, uint size);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr value);
  static void Check(bool result) { if (!result) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  public static Snapshot Read() {
    int stride = Marshal.SizeOf(typeof(Option));
    IntPtr buffer = Marshal.AllocHGlobal(stride * 4);
    bool queried = false;
    try {
      for (int i=0; i<4; i++) Marshal.StructureToPtr(new Option { Key=(uint)(i+1) }, IntPtr.Add(buffer, stride*i), false);
      List list = new List { Size=(uint)Marshal.SizeOf(typeof(List)), Count=4, Options=buffer };
      uint size = list.Size; Check(Query(IntPtr.Zero, 75, ref list, ref size)); queried=true;
      Option flags=(Option)Marshal.PtrToStructure(buffer, typeof(Option));
      string[] values=new string[3];
      for (int i=1; i<4; i++) {
        Option item=(Option)Marshal.PtrToStructure(IntPtr.Add(buffer,stride*i), typeof(Option));
        values[i-1]=item.Text == IntPtr.Zero ? "" : Marshal.PtrToStringUni(item.Text);
      }
      return new Snapshot { Flags=flags.Number, Server=values[0], Bypass=values[1], AutoConfig=values[2] };
    } finally {
      if (queried) for (int i=1; i<4; i++) {
        Option item=(Option)Marshal.PtrToStructure(IntPtr.Add(buffer,stride*i),typeof(Option));
        if (item.Text != IntPtr.Zero) GlobalFree(item.Text);
      }
      Marshal.FreeHGlobal(buffer);
    }
  }
  public static void Write(uint flags, string server, string bypass, string autoConfig) {
    int stride=Marshal.SizeOf(typeof(Option));
    IntPtr buffer=Marshal.AllocHGlobal(stride*4); IntPtr[] strings=new IntPtr[3];
    try {
      string[] values=new string[] { server, bypass, autoConfig };
      Marshal.StructureToPtr(new Option { Key=1, Number=flags },buffer,false);
      for(int i=1;i<4;i++) {
        strings[i-1]=Marshal.StringToHGlobalUni(values[i-1] ?? "");
        Marshal.StructureToPtr(new Option { Key=(uint)(i+1), Text=strings[i-1] },IntPtr.Add(buffer,stride*i),false);
      }
      List list=new List { Size=(uint)Marshal.SizeOf(typeof(List)), Count=4, Options=buffer };
      Check(Set(IntPtr.Zero,75,ref list,list.Size));
      Check(Notify(IntPtr.Zero,39,IntPtr.Zero,0)); Check(Notify(IntPtr.Zero,37,IntPtr.Zero,0));
      Check(Notify(IntPtr.Zero,95,IntPtr.Zero,0));
    } finally { foreach(IntPtr text in strings) if(text != IntPtr.Zero) Marshal.FreeHGlobal(text); Marshal.FreeHGlobal(buffer); }
  }
}
`;

export function parseProxySnapshot(value: unknown): ProxySnapshot {
  const snapshot = value as ProxySnapshot;
  if (!snapshot || !Number.isInteger(snapshot.Flags) || snapshot.Flags < 0 || snapshot.Flags > 0xffffffff ||
    typeof snapshot.Server !== "string" || typeof snapshot.Bypass !== "string" || typeof snapshot.AutoConfig !== "string") throw new Error("invalid proxy snapshot");
  return snapshot;
}

async function run(action: "read" | "write", snapshot?: ProxySnapshot): Promise<ProxySnapshot> {
  if (process.platform !== "win32") throw new Error("Windows proxy adapter unavailable");
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${helper}\n'@\n${action === "write" ? "$proxyData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:KUKUHOU_PROXY_INPUT)) | ConvertFrom-Json\n[KukuhouProxy]::Write($proxyData.Flags,$proxyData.Server,$proxyData.Bypass,$proxyData.AutoConfig)\n" : ""}[KukuhouProxy]::Read() | ConvertTo-Json -Compress`;
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
    env: { ...process.env, KUKUHOU_PROXY_INPUT: snapshot ? Buffer.from(JSON.stringify(snapshot)).toString("base64") : "" },
  });
  return parseProxySnapshot(JSON.parse(stdout.trim().replace(/^\uFEFF/, "")));
}
export function readWindowsProxy() { return run("read"); }
export async function writeWindowsProxy(snapshot: ProxySnapshot): Promise<void> {
  await run("write", parseProxySnapshot(snapshot));
  // WinINet caches query results per process; verify in a fresh helper process.
  const result = await readWindowsProxy();
  const differences = (Object.keys(snapshot) as (keyof ProxySnapshot)[]).filter((key) => result[key] !== snapshot[key]);
  if (differences.length) throw new Error(`proxy verification failed: ${differences.join(", ")}`);
}

export function systemProxyConfig(content: string): { content: string; server: string } {
  const config = JSON.parse(content) as { inbounds?: { type: string; tag?: string; listen?: string; listen_port?: number; set_system_proxy?: boolean }[] };
  if (config.inbounds?.some((inbound) => inbound.type === "tun")) throw new Error("TUN 配置请在高级管理中使用");
  const inbound = config.inbounds?.find((item) => ["mixed", "http"].includes(item.type) && ["127.0.0.1", "::1"].includes(item.listen ?? ""));
  if (!inbound || !Number.isInteger(inbound.listen_port) || inbound.listen_port! < 1 || inbound.listen_port! > 65535) throw new Error("订阅缺少本地 HTTP 代理入口，请在高级管理中检查");
  for (const item of config.inbounds ?? []) {
    if (["mixed", "http", "socks"].includes(item.type)) item.set_system_proxy = false;
  }
  const host = inbound.listen === "::1" ? "[::1]" : "127.0.0.1";
  return { content: JSON.stringify(config, null, 2), server: `${host}:${inbound.listen_port}` };
}
