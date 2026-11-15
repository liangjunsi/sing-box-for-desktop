# Bundled routing data

The SagerNet sing-geosite `geosite-cn` and sing-geoip `geoip-cn` snapshots are pinned in `manifest.json` with their commit IDs, source URLs and SHA-256 hashes. The upstream copyright and license notices are included beside the data.

JSON files are lossless decompilations of the corresponding SRS snapshots using the sibling sing-box module's `srs.Read(input, true)`. Runtime configuration embeds these rules inline because Windows graphical-client security blocks rule files outside the daemon's working directory. No insecure-mode setting is required. Runtime verifies both JSON hashes before starting either mode.

To reproduce each JSON file from the repository root:

```powershell
go -C ../sing-box run ../sing-box-for-desktop/scripts/decompile-routing.go ../sing-box-for-desktop/resources/routing/geosite-cn.srs ../sing-box-for-desktop/resources/routing/geosite-cn.json
go -C ../sing-box run ../sing-box-for-desktop/scripts/decompile-routing.go ../sing-box-for-desktop/resources/routing/geoip-cn.srs ../sing-box-for-desktop/resources/routing/geoip-cn.json
```

Updates are explicit client releases: pin new source commits, verify upstream notices, regenerate JSON, update hashes, then run `scripts/verify-routing.ts`. That isolated native-core harness checks the unmodified generated configuration, then uses deterministic hosts DNS fixtures to verify actual outbound selections from connection logs. It never changes the system proxy and does not validate a real VPN account or remote DoH availability.
