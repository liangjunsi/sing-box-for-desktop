import type { Transport } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { ManagedService } from "../shared/gen/daemon/managed_service_pb";
import { DesktopService } from "../shared/gen/experimental/boxdd/desktop_service_pb";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as net from "node:net";
import { daemonBinaryPath } from "./repair";
import { localeInterceptor } from "./locale";

let connection: Promise<Transport> | null = null;
let supervisor: ChildProcess | null = null;
async function connect(): Promise<Transport> {
  const directory = await mkdtemp("/tmp/kukuhou-daemon-");
  await chmod(directory, 0o700);
  const socket = join(directory, "daemon.sock");
  const data = join(app.getPath("userData"), "daemon");
  await mkdir(data, { recursive: true, mode: 0o700 });
  await chmod(data, 0o700);
  const helper = app.isPackaged ? join(process.resourcesPath, "daemon", "daemon-supervisor") : join(app.getAppPath(), "bin", "darwin", process.arch, "daemon-supervisor");
  const child = spawn(helper, [daemonBinaryPath(), data, socket], { stdio: ["pipe", "ignore", "pipe"] });
  supervisor = child;
  let failure: Error | null = null;
  child.on("error", error => { failure = error; });
  child.stderr?.on("data", data => process.stderr.write(data));
  child.once("exit", () => {
    failure ??= new Error("macOS daemon exited");
    connection = null;
    if (supervisor === child) supervisor = null;
    void rm(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    if (existsSync(socket)) {
      const transport = createGrpcTransport({ baseUrl: "http://sing-box", interceptors: [localeInterceptor], nodeOptions: { createConnection: () => net.connect({ path: socket }) } });
      // Each supervisor starts a private user daemon. Clear a crash-leftover
      // running configuration before the account UI attempts a fresh connection.
      try {
        await createClient(DesktopService, transport).claimService({}, { timeoutMs: 5000 });
        await createClient(ManagedService, transport).stopService({}, { timeoutMs: 5000 });
      } catch (error) { child.stdin?.end(); throw error; }
      return transport;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.stdin?.end();
  throw new Error("macOS daemon startup timed out");
}
function transport() { return connection ??= connect().catch(error => { connection = null; throw error; }); }
app.on("will-quit", () => supervisor?.stdin?.end());
export const macosDaemonTransport: Transport = {
  unary: async (...args) => (await transport()).unary(...args),
  stream: async (...args) => (await transport()).stream(...args),
};
