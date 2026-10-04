# sing-box-for-desktop

Experimental Windows client for sing-box, the universal proxy platform.

Linux support is on the way.

## Windows development

Use Node.js 26.7.0 and pnpm 11.13.0. Initialize the submodules and install dependencies:

```powershell
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm -C dashboard install --frozen-lockfile
```

Keep the matching sing-box source checkout in `../sing-box`, then run:

```powershell
pnpm dev:win
```

The Windows development launcher builds the daemon if needed, generates resources,
and starts Electron with a daemon listening on `127.0.0.1:19431`. Development data
and daemon logs are stored under `bin/`. Closing the development command stops the
daemon. This uses the daemon's local development mode; packaged builds use the
Windows service and authenticated named pipe.
The launcher uses a Go build overlay to supply the current Windows user identity
for TCP development connections without modifying the sibling sing-box checkout.

Windows file sharing also requires the native module built by `scripts/windowsShare.ts`.

## Custom subscriptions

Remote profiles accept native sing-box JSON/JSONC and Base64 or plain URI node
lists. Create a remote profile in the application and enter its subscription URL;
manual and automatic updates use the same converter. VLESS/Reality, VMess,
Hysteria2, TUIC, AnyTLS and Trojan links are supported within the formats described
in [CUSTOMIZATION.md](CUSTOMIZATION.md).

Converted profiles contain a `PROXY` node selector and a localhost HTTP/SOCKS
listener at `127.0.0.1:10808`. DNS uses the local resolver. Importing a profile does
not enable proxying automatically. Unsupported nodes are skipped with a visible
warning; an entirely unsupported subscription fails. In particular, Hysteria2
certificate fingerprint pinning (`pinSHA256`) is never silently removed.

## License

```
Copyright (C) 2022 by nekohasekai <contact-sagernet@sekai.icu>

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <http://www.gnu.org/licenses/>.
```
