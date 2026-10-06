# Customization and upstream upgrades

## Windows packaging

On an x64 Windows build machine, run `pnpm package:win:unsigned` to build
both x64 and ARM64 installers from the current sources. Output files are
`release/SFW-<version>-x64-unsigned.exe` and
`release/SFW-<version>-arm64-unsigned.exe`. They are not signed; Windows may
show an unknown-publisher prompt. Build artifacts and tool caches stay ignored.

To build just one architecture, use `pnpm package:win --unsigned x64` or
`pnpm package:win --unsigned arm64`. The original `pnpm package:win` command
still requires `signing.local.json` and produces signed packages.

Prerequisites: the pinned Node/pnpm, Go and Rust versions, initialized dashboard
submodule, matching sibling sing-box backend sources, and Visual C++ build tools
for native x64 builds. On an x64 host, ARM64 modules use Rust's bundled linker
and xwin 0.9.0. The script downloads the checksum-verified xwin archive and
Windows SDK 10.0.26100 / CRT 14.44.17.14 into
`bin/windows-share-toolchain/`, accepting the SDK license as part of the build.
The first build needs network access; later builds reuse the SDK cache.
Existing PE architecture checks validate daemons, modules, libraries and drivers;
Electron fuse and ASAR integrity checks also run for unsigned packages.
ARM64 runtime acceptance still requires an ARM64 Windows device.

The customization branch is `codex/custom-main`. Keep custom feature code in
`src/custom/`; keep edits to upstream modules limited to integration calls.

## Subscription integration

`src/main/profiles.ts` calls `normalizeSubscription()` after downloading a remote
profile. Native sing-box JSON/JSONC passes through unchanged. URI lists and their
Base64 variants are converted into a complete config with a `PROXY` selector,
a localhost mixed listener on port 10808, and local DNS for server resolution.
The existing sing-box validation still runs before a profile is saved.

Supported protocols: VLESS (including Reality), VMess JSON links, Hysteria2/Hy2,
TUIC, AnyTLS and Trojan. Transports: TCP, WebSocket, HTTP/H2, gRPC and HTTPUpgrade.
Certificate fingerprints (`pinSHA256`) cannot be represented as sing-box
public-key fingerprints. The strict parser rejects them; the remote import adapter
skips unsupported nodes and shows a warning. Repeated identical warnings are
suppressed during the current app session. If no usable nodes remain, import fails.
No TLS security parameters are silently discarded. YAML/Clash and Shadowsocks
subscriptions are outside the current supported formats.

`customization.versions.json` records the baseline desktop, dashboard and backend
commits. Update it after a verified upgrade; pnpm lockfiles pin package versions.

Tests use synthetic credentials. Do not commit subscription URLs, live nodes,
generated profiles or user data.

## Upgrade procedure

1. Keep the official repository as an upstream remote; configure your own fork
   as the push remote when available.
2. Create `codex/upgrade-<version>` from `codex/custom-main` and merge the chosen
   upstream commit or release there.
3. Update submodules to the commits selected by that upstream version. If a
   submodule must be customized, commit in its own fork before updating its pointer.
4. Use matching sing-box backend source and regenerate protocol bindings.
5. Run `pnpm exec tsx --test src/custom/subscription/subscription.test.ts`,
   `pnpm typecheck`, `pnpm build`, and verify import/update using the actual daemon.
6. Merge the verified upgrade branch back into `codex/custom-main`.

Preserve pnpm lockfiles and Git submodule pointers. The Windows development Go
overlay in `scripts/development-windows.ps1` is an upstream compatibility patch;
review it on each backend upgrade and remove it when upstream fixes TCP identity.

## Compact desktop and account integration

All new feature code lives in `src/custom/desktop/`. The renderer selects the
compact UI only when the main window adds `?compact=1`; other windows retain the
upstream dashboard. Dashboard/native submodules, generated RPC types, dependency
versions and lockfiles are not changed by this feature.

Integration seams:

- Main entry: register the custom account adapter, apply compact window options,
  and forward profile/deep-link/tool notifications to the advanced window.
- Renderer entry: choose CompactApp or the original App. Preload/shared bridge:
  add `desktop.custom` with state/login/logout/refresh/connect/disconnect/select/
  advanced operations and state notifications.
- Windows tray: one optional menu hook uses the same account controller for
  managed profiles, preserving login checks and proxy recovery on tray actions.
  Ordinary profiles retain the original tray menu.
- Profiles: expose the existing downloader, service starter and an internal
  operation adapter. Original profile IPC and remote auto-update behavior remain
  unchanged. Account subscriptions use managed local profiles and their own
  hourly refresh, so updating does not reload a running service.
- TypeScript includes: keep custom renderer TSX out of the Node project.
- Vite CSP hashing: normalize CRLF to LF before hashing inline scripts, matching
  browser HTML newline normalization on Windows checkouts.

The compact window stores content dimensions in `custom_compact_window_state`.
The advanced window uses the existing `main_window_state`, preserving legacy
positions and dimensions. Closing the compact window hides it when a tray is
available. If tray visibility is disabled, existing application exit behavior
applies. The menu includes the full manager, logs, startup preference and exit.

### Login service contract

On Windows, `pnpm dev:win` starts the local development login adapter (configure
its subscription URL below). `pnpm prod:win` starts the same local desktop and
daemon against `https://chat.kukuhou.com`, explicitly disabling the development
login even when the local config enables it. Sign in with a real production
account. These commands use separate `bin/development-user-data` and
`bin/production-user-data` directories, and separate daemon data directories.

Production also trusts `https://sub.kukuhou.com` for authenticated subscription
downloads via `KUKUHOU_SUBSCRIPTION_ORIGIN`. Other launch methods may set this
variable to their trusted HTTPS subscription origin when it differs from the API.
Redirects remain disabled so credentials cannot follow a redirect to another host.
Stop the current client before switching environments; both use port 19431.
`prod:win` runs from source; it does not build an installer or deploy the server.

For local development only, opt in with ignored `bin/development-account.json`:
`{ "enabled": true, "subscriptionUrl": "<your HTTPS subscription>" }`.
Alternatively set `KUKUHOU_DEV_LOGIN=1` and `KUKUHOU_DEV_SUBSCRIPTION_URL`.
The default account is `dev` / `dev123456`; the login form prefills these values,
defaults to not remembering this test login, and visibly labels development mode.
This explicitly requested local adapter permits viewing real subscription nodes
before a backend exists. Packaged builds unconditionally ignore the local adapter,
its config file and flags, and still require the real API. Never commit the local
subscription config. Existing development startup scripts automatically pick it up.

Set `KUKUHOU_API_BASE_URL` in the environment used to launch the app (for example
`https://account.example.invalid`). An optional base path is preserved. No live
subscription endpoint is embedded in source. The Windows production launch script
sets the production API domain. Without this setting, login
is disabled with an explanation; the advanced manager remains usable.

- `POST <base>/api/client/login`, JSON `{ account, password }`.
- Success: `{ accessToken, expiresAt, user: { id, displayName }, subscriptionUrl }`.
  `expiresAt` is a future ISO-8601 date string, and IDs/tokens are nonempty strings.
- `GET <base>/api/client/session`, `Authorization: Bearer <accessToken>`.
  Success: `{ expiresAt, user: { id, displayName }, subscriptionUrl }`.
  The returned user ID must match the existing session.
- HTTP 401 means invalid credentials/session, 403 means disabled account, 429
  means rate limited; other non-success statuses are service errors. Error bodies
  are never shown or logged. Requests time out after 15 seconds, reject redirects,
  and limit JSON responses to 64 KiB. API and subscription URLs must use HTTPS.

Login loads and validates the subscription without connecting. Login persists
independently of subscription success; failed downloads expose retry and keep the
last valid nodes. Session restoration validates the account; temporary outages
can use unexpired account-specific cache. Explicit invalidation clears that
account. Connect/refresh revalidate the session. There is no invented refresh-token
endpoint: expired sessions require signing in again.

Password is never saved. A remembered session, subscription address, node choice,
profile ID and update timestamp are encrypted in `custom-account.enc` using
Electron safeStorage, outside the preferences snapshot shared with renderers.
Linux `basic_text` encryption is rejected. With no reliable encryption, login is
memory-only. Only managed account profile IDs are listed in the database; ordinary
user profiles are not removed. Orphaned managed profiles are cleaned on restart.
Logout stops owned service/cleans proxy first, then removes account files/cache.

### System proxy and supported configurations

Windows uses an independent WinINet current-user LAN adapter, because this
upstream daemon exposes its proxy RPC only for `tun.platform.http_proxy` and its
Disable implementation clears rather than restores old settings. Before starting
the compact service, capture proxy flags, server, bypass and PAC URL. Encrypt a
recovery snapshot in `custom-proxy-recovery.enc`, disable inbound automatic proxy
changes, start sing-box, and apply/verify the loopback HTTP proxy. Disconnect,
connection failure and exit restore the snapshot. On restart, restore a leftover
snapshot before loading the account, and stop the associated leftover service
after the normal ownership handshake. A different externally configured proxy
or selected ordinary profile is preserved. Cleanup failure leaves the app available
for retry rather than silently exiting.

The Windows compact connect path requires a mixed/HTTP inbound listening on
127.0.0.1 or ::1 with a valid port, and rejects TUN configs with guidance to use
advanced management. Converted URI subscriptions already provide this listener.
Native JSON/JSONC is formatted and validated by the existing native APIs before
node extraction. Use the route-final selector, then PROXY, then the first
selector; configurations with multiple standalone nodes and no selector require
advanced management. No TLS credential/security fields are rewritten.

Windows compact mode is the primary acceptance target. Linux retains the existing
daemon platform proxy path and requires a compatible platform proxy configuration;
arbitrary prior Linux desktop proxy settings are not captured by the Windows adapter.

### Verification

Run:

```powershell
node --import tsx --test src/custom/desktop/desktop.test.ts src/custom/subscription/subscription.test.ts
node node_modules/typescript/bin/tsc -b
node node_modules/electron-vite/bin/electron-vite.js build
```

`scripts/verify-custom-ui.cjs` is a development-only hidden Electron harness using
synthetic bridge responses. Run with scale arguments 1, 1.25 and 1.5 after building;
screenshots/reports go to ignored `bin/custom-ui-verify/`. It never accesses a real
account/subscription or changes the system proxy. Check the generated `passed-*.json`
markers, because GUI executables can detach from a shell before tests finish.

`node --import tsx scripts/verify-custom-daemon.ts` starts an isolated local daemon
with ephemeral RPC/listener ports, validates a synthetic subscription, starts it,
switches a selector and stops it. `--proxy-roundtrip` additionally verifies the
real Windows proxy apply/restore path; its `finally` restores settings on failure.
`--subscription-url <URL>` optionally validates a real subscription in memory;
credentials/content are never printed or written to the repository. The test's
synthetic daemon data stays under ignored `bin/custom-daemon-verify/`.

Before release, additionally verify actual login against the provided service,
the real subscription format, daemon operation, and proxy/PAC restoration. Keep
all test credentials synthetic. After upstream upgrades, review the small seams
above, especially profiles operation signatures and daemon state subscriptions.
