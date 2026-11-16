# expo-build-doctor

A Node.js CLI (Node 20 or newer, no dependencies) that reads an Expo project's `app.json`, `eas.json` and `package.json` and reports configuration problems that tend to fail `eas build` or store submission. It is for Expo developers who want to catch these before waiting in the build queue. It does not run your project code and does not use the network.

```bash
npx expo-build-doctor
```

## Example

Run on [expo-upgrade-casebook](https://github.com/Tthanh2k6/expo-upgrade-casebook) (Expo SDK 58):

```text
expo-build-doctor v0.1.0 — ~/code/expo-upgrade-casebook
Files: app.config.js (unparsed), eas.json, package.json | Expo SDK: 58

[ERROR] EBD-EAS-003 (eas.json:development) — developmentClient enabled in "development" without expo-dev-client
        Profile "development" sets developmentClient: true, but `expo-dev-client` is missing from package.json.
        Fix: Install `expo-dev-client` (`npx expo install expo-dev-client`) or set `developmentClient: false`.
[WARN]  EBD-EAS-004 (eas.json:development) — channel has no effect with developmentClient: true in "development"
        Profile "development" sets channel "development" alongside developmentClient: true; development builds can load updates from any channel.
        Fix: Remove `channel` from the development client profile or separate preview/production profiles.
[WARN]  EBD-VER-001 (eas.json) — cli.appVersionSource is not set in eas.json
        eas.json omits cli.appVersionSource. EAS CLI warns this will be required in future versions and defaults to "local".
        Fix: Set `cli.appVersionSource` to "remote" (recommended since EAS CLI 12.0.0) or "local".
[INFO]  EBD-CFG-004 (app.config.js) — Dynamic app config not executed statically
        app.config.js is present without static app.json/app.config.json. JS/TS configs are not executed for security.
        Fix: Run `npx expo config --json > .expo-config.json` and pass `--app-config .expo-config.json` to audit resolved values.

Summary: 1 error(s), 2 warning(s), 1 info
```

## What it catches

`npx expo-doctor` checks project health and dependency versions. This tool looks at mismatches between the three config files, for example:

- A `production` profile with `"buildType": "apk"`, which Google Play does not accept in place of an `.aab`.
- An `internal` distribution profile with `"app-bundle"`, which cannot produce an installable build.
- No `ios.config.usesNonExemptEncryption` / `ITSAppUsesNonExemptEncryption`, which holds up TestFlight processing.
- No `cli.appVersionSource`, or `"remote"` combined with `runtimeVersion.policy: "nativeVersion"`.
- A missing file referenced by `icon`, `googleServicesFile` or `expo-splash-screen`.
- Options deprecated on newer SDKs (`newArchEnabled: false` on SDK 55+, `ios.deploymentTarget` in `expo-build-properties` on SDK 56+).

There are 21 rule IDs, listed below. They follow the [Expo app config](https://docs.expo.dev/versions/latest/config/app/) and [eas.json](https://docs.expo.dev/eas/json/) references.

## Usage

Check another folder and exit with `1` on warnings too:

```bash
npx expo-build-doctor ./apps/mobile --fail-on warnings
```

For a dynamic `app.config.js` or `app.config.ts`, export the resolved config first and pass it in:

```bash
npx expo config --json > .expo-config.json
npx expo-build-doctor --app-config .expo-config.json
```

## Options

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

## Rules

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

- `app.config.js` and `app.config.ts` are not executed, since that would run project code. Use `npx expo config --json` with `--app-config` instead.
- Only static config files and local asset paths are checked. Provisioning profiles, Android keystores, Google Play service account keys and settings on the Expo dashboard are not looked at.
- Dependency compatibility is out of scope; use `npx expo-doctor` for that.
- This is v0.1.0 with 26 offline tests (`npm test`), so expect gaps.

## License

MIT. See [LICENSE](LICENSE).
