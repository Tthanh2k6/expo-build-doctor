# expo-build-doctor

Zero-dependency Node.js CLI (`Node >= 20`) that runs static pre-flight checks on an Expo project's `app.json`, `eas.json`, and `package.json` before you wait on an `eas build` queue or hit App Store / Google Play rejections.

## Why It Exists

`npx expo-doctor` checks your project health and dependency directory status, while many cloud build or store submission failures come from configuration mismatches across `app.json`, `eas.json`, and `package.json`:

- A `production` EAS profile set to `"buildType": "apk"`, which Google Play rejects instead of an `.aab`.
- An `"internal"` distribution profile set to `"app-bundle"`, which fails to produce an installable Expo link.
- Missing `ios.config.usesNonExemptEncryption` / `ITSAppUsesNonExemptEncryption`, stalling TestFlight and App Store Connect processing.
- Missing `cli.appVersionSource`, or pairing `"appVersionSource": "remote"` with `"runtimeVersion": { "policy": "nativeVersion" }`.
- Missing local files referenced in `icon`, `googleServicesFile`, or `expo-splash-screen`.
- Deprecated config options on newer SDKs (`newArchEnabled: false` on SDK 55+, `expo-build-properties` `ios.deploymentTarget` on SDK 56+).

Every rule in `expo-build-doctor` checks directly against documented behavior in the official [Expo configuration](https://docs.expo.dev/versions/latest/config/app/) and [EAS JSON](https://docs.expo.dev/eas/json/) references.

## Quick Start

Run inside any Expo project directory:

```bash
npx expo-build-doctor
```

Point it at another folder or fail CI on warnings as well:

```bash
npx expo-build-doctor ./apps/mobile --fail-on warnings
```

For projects using a dynamic `app.config.js` or `app.config.ts`, export the resolved JSON with Expo CLI first and pass it explicitly:

```bash
npx expo config --json > .expo-config.json
npx expo-build-doctor --app-config .expo-config.json
```

## Example Output

Real run on [expo-upgrade-casebook](https://github.com/Tthanh2k6/expo-upgrade-casebook) (Expo SDK 58):

```text
expo-build-doctor v0.1.0 — D:\Project\1-dang-ban\expo-upgrade-casebook
Files: app.config.js (unparsed), eas.json, package.json | Expo SDK: 58

[ERROR] EBD-EAS-003 (eas.json:development) — developmentClient enabled in "development" without expo-dev-client
        Profile "development" sets developmentClient: true, but `expo-dev-client` is missing from package.json.
        Fix: Install `expo-dev-client` (`npx expo install expo-dev-client`) or set `developmentClient: false`.
[WARN]  EBD-VER-001 (eas.json) — cli.appVersionSource is not set in eas.json
        eas.json omits cli.appVersionSource. EAS CLI warns this will be required in future versions and defaults to "local".
        Fix: Set `cli.appVersionSource` to "remote" (recommended since EAS CLI 12.0.0) or "local".
[WARN]  EBD-EAS-004 (eas.json:development) — channel has no effect with developmentClient: true in "development"
        Profile "development" sets channel "development" alongside developmentClient: true; development builds can load updates from any channel.
        Fix: Remove `channel` from the development client profile or separate preview/production profiles.
[INFO]  EBD-CFG-004 (app.config.js) — Dynamic app config not executed statically
        app.config.js is present without static app.json/app.config.json. JS/TS configs are not executed for security.
        Fix: Run `npx expo config --json > .expo-config.json` and pass `--app-config .expo-config.json` to audit resolved values.

Summary: 1 error(s), 2 warning(s), 1 info
```

## CLI Usage

```text
expo-build-doctor [project-dir] [options]
```

| Argument / Flag | Default | Description |
| :--- | :--- | :--- |
| `[project-dir]` | `.` | Project directory, or path to `app.json` / `eas.json` / `package.json`. |
| `--app-config <path>` | Auto (`app.config.json`, `app.json`) | Explicit JSON file (supports `{ "expo": ... }` or flat `expo config --json`). |
| `--eas-config <path>` | Auto (`eas.json`) | Explicit `eas.json` path. |
| `--package-json <path>` | Auto (`package.json`) | Explicit `package.json` path. |
| `--profile <name>` | All profiles | Audit a single `eas.json` build profile (with `extends` inheritance resolved). |
| `--fail-on <mode>` | `errors` | Exit `1` threshold: `errors`, `warnings`, `all`, or `none`. |
| `--no-check-files` | `false` | Skip checking whether local icon, splash, and Firebase files exist on disk. |
| `--json` | `false` | Print machine-readable JSON `{ projectDir, files, sdkMajor, summary, findings }`. |
| `-h, --help` | - | Show help text and exit `0`. |
| `-v, --version` | - | Print version number and exit `0`. |

### Exit Codes

- `0`: No findings met or exceeded the `--fail-on` threshold.
- `1`: One or more findings matched `--fail-on`.
- `2`: Invalid CLI flag, missing target path, or invalid JSON config.

## Rules Checked

| Code | Severity | What It Checks |
| :--- | :--- | :--- |
| `EBD-VER-001` | `warn` | `eas.json` omits `cli.appVersionSource` (`"remote"` or `"local"`). |
| `EBD-VER-002` | `error` | `cli.appVersionSource: "remote"` combined with `runtimeVersion.policy: "nativeVersion"`. |
| `EBD-IOS-001` | `error` | Missing or malformed reverse-DNS `ios.bundleIdentifier`. |
| `EBD-IOS-002` | `warn` | Missing `ios.config.usesNonExemptEncryption` and `ios.infoPlist.ITSAppUsesNonExemptEncryption`. |
| `EBD-IOS-003` | `error` | Non-string or invalid Apple `CFBundleVersion` format in `ios.buildNumber`. |
| `EBD-IOS-004` | `error` | Empty or whitespace-only `ios.infoPlist.NS*UsageDescription` purpose string. |
| `EBD-AND-001` | `error` | Missing or malformed `android.package` Application ID. |
| `EBD-AND-002` | `error` | `android.versionCode` is not a positive integer (`>= 1`). |
| `EBD-EAS-001` | `error` | Store/`production` profile sets `android.buildType: "apk"` instead of `"app-bundle"`. |
| `EBD-EAS-002` | `error` | `distribution: "internal"` profile sets `android.buildType: "app-bundle"`. |
| `EBD-EAS-003` | `error` | Profile sets `developmentClient: true` while `expo-dev-client` is absent from `package.json`. |
| `EBD-EAS-004` | `warn` | Profile sets both `developmentClient: true` and `channel` (ignored by dev clients). |
| `EBD-EAS-005` | `warn` | Profile still uses deprecated `releaseChannel` or `expoCli` fields. |
| `EBD-EAS-006` | `error` | `eas.json` profile `extends` points to a missing profile or forms a cycle. |
| `EBD-ARCH-001` | `warn` | `newArchEnabled: false` on Expo SDK 55+, where the New Architecture is mandatory. |
| `EBD-PLUG-001` | `warn`/`error` | `expo-build-properties` deprecated keys (`ios.deploymentTarget` on SDK 56+, `android.buildFromSource`) or `minSdkVersion > targetSdkVersion`. |
| `EBD-CFG-001` | `warn` | `updates.url` UUID differs from `extra.eas.projectId`. |
| `EBD-CFG-002` | `warn` | `expo-updates` is installed and enabled without `runtimeVersion`. |
| `EBD-CFG-003` | `error` | `scheme`, `ios.scheme`, or `android.scheme` violates `^[a-z][a-z0-9+.-]*$`. |
| `EBD-CFG-004` | `info` | Dynamic `app.config.js` / `app.config.ts` present without `--app-config`. |
| `EBD-ASSET-001` | `error` | Local `icon`, adaptive icon, `googleServicesFile`, or `expo-splash-screen` image does not exist on disk. |

## Limitations

- Dynamic JavaScript/TypeScript configs (`app.config.js`, `app.config.ts`) are not executed directly because running untrusted project code could read environment files or trigger side effects. Pass the output of `npx expo config --json` via `--app-config` when auditing dynamic configs.
- Only static configuration files and local asset paths are checked. Provisioning profiles, Android keystores, Google Play service account keys, and remote Expo dashboard settings are out of scope.
- Use alongside `npx expo-doctor` and `rn-upgrade-check`, which handle package directory and native dependency compatibility checks.

## License

MIT License (2026, Trung Thanh Tran). See [LICENSE](LICENSE).
