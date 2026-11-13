# YEU_CAU — expo-build-doctor (v0.1.0)

## Mục tiêu
CLI Node.js (`Node >= 20`, ESM, **0 dependency ngoài**) kiểm tra tĩnh cấu hình build/submit Expo (`app.json` / `app.config.json`, `eas.json`, `package.json`) trước khi chạy `eas build` hoặc nộp App Store / Google Play.

Mọi rule trong v0.1.0 chỉ bám các hành vi/ràng buộc đã đối chiếu trực tiếp từ tài liệu chính thức `docs.expo.dev/*.md` (SDK 58 reference, `eas/json.md`, `build-reference/app-versions.md`, `versions/latest/sdk/build-properties.md`, `guides/new-architecture.md`, `guides/permissions.md`, `submit/ios.md`, `submit/android.md`).

## Giao diện CLI
```text
expo-build-doctor [project-dir] [--app-config <path>] [--eas-config <path>] [--package-json <path>] [--profile <name>] [--json] [--fail-on <errors|warnings|all|none>] [--check-files | --no-check-files] [-h|--help] [-v|--version]
```

- `[project-dir]`: mặc định `.` (thư mục hiện tại). Nếu truyền file `.json`, suy ra thư mục cha hoặc file đích tương ứng.
- `--app-config <path>`: đọc file JSON cấu hình Expo (ví dụ file xuất từ `npx expo config --json > expo-config.json` với dự án dùng `app.config.js` / `app.config.ts`). Hỗ trợ cả `{ "expo": { ... } }` lẫn object phẳng `{ "name": ..., "slug": ... }`.
- `--eas-config <path>`: đường dẫn tuỳ chọn tới `eas.json`.
- `--package-json <path>`: đường dẫn tuỳ chọn tới `package.json`.
- `--profile <name>`: chỉ kiểm tra profile build chỉ định trong `eas.json` (mặc định kiểm tra mọi profile dưới `build`).
- `--json`: xuất JSON (`{ projectDir, files, sdkMajor, summary, findings }`) cho CI.
- `--fail-on <mode>`:
  - `errors` (mặc định): exit code `1` nếu có ít nhất 1 `error`; `0` nếu chỉ có `warn`/`info` hoặc sạch.
  - `warnings`: exit code `1` nếu có `error` hoặc `warn`.
  - `all`: exit code `1` nếu có bất kỳ finding nào (`error`, `warn`, `info`).
  - `none`: luôn exit `0` khi đọc được dự án (chỉ exit `2` khi lỗi tham số/JSON hỏng).
- `--no-check-files`: bỏ qua kiểm tra tồn tại file tài nguyên cục bộ (`icon`, splash, `googleServicesFile`) khi test JSON độc lập.
- Exit code: `0` đạt, `1` có finding khớp `--fail-on`, `2` lỗi dùng CLI / JSON lỗi cú pháp / không tìm thấy file nào để kiểm tra.

## Bảo mật & Giới hạn phạm vi (bắt buộc nêu rõ trong README)
- Không thực thi (`import`/`require`) file `app.config.js` hoặc `app.config.ts` để tránh chạy mã tuỳ ý hay đọc `.env`; nếu chỉ có config động, báo finding `EBD-CFG-003` (`info`) hướng dẫn chạy `npx expo config --json > expo-config.json` rồi truyền `--app-config`.
- Không kiểm tra credentials trên Expo Dashboard (provisioning profile, keystore, Google Service Account key), không gọi mạng, không thay `npx expo-doctor` cho việc kiểm tra dependency tree/React Native Directory.

## Danh sách rule v0.1.0

| Mã | Mức | Điều kiện kích hoạt | Nguồn đối chiếu |
| --- | --- | --- | --- |
| `EBD-VER-001` | `warn` | Có `eas.json` nhưng thiếu `cli.appVersionSource` (`"local"` hoặc `"remote"`), hoặc đặt `autoIncrement` mà chưa chọn nguồn | `eas/json.md`, `app-versions.md` |
| `EBD-VER-002` | `error` | `cli.appVersionSource === "remote"` đồng thời `runtimeVersion.policy === "nativeVersion"` | `app-versions.md` (Limitations) |
| `EBD-IOS-001` | `error` | Hỗ trợ iOS nhưng thiếu `ios.bundleIdentifier` hoặc sai định dạng reverse-DNS | `config/app.md`, `submit/ios.md` |
| `EBD-IOS-002` | `warn` | Hỗ trợ iOS nhưng thiếu cả `ios.config.usesNonExemptEncryption` và `ios.infoPlist.ITSAppUsesNonExemptEncryption` | `config/app.md#usesnonexemptencryption` |
| `EBD-IOS-003` | `error` | Có `ios.buildNumber` nhưng không phải chuỗi dạng `N`, `N.N`, hoặc `N.N.N` (hoặc đặt kiểu number) | `config/app.md#buildnumber` |
| `EBD-IOS-004` | `error` | Key `ios.infoPlist.NS*UsageDescription` khai báo chuỗi rỗng hoặc chỉ toàn khoảng trắng | `guides/permissions.md` |
| `EBD-AND-001` | `error` | Hỗ trợ Android nhưng thiếu `android.package` hoặc sai định dạng Java package (`[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)+`) | `config/app.md#package`, `submit/android.md` |
| `EBD-AND-002` | `error` | Có `android.versionCode` nhưng không phải số nguyên dương (`integer >= 1`) | `config/app.md#versioncode` |
| `EBD-EAS-001` | `error` | Profile build `production` (không phải `distribution: "internal"`) hoặc `distribution: "store"` đặt `android.buildType: "apk"` | `submit/android.md`, `eas/json.md` |
| `EBD-EAS-002` | `error` | Profile build đặt `distribution: "internal"` nhưng `android.buildType: "app-bundle"` | `eas/json.md#distribution` |
| `EBD-EAS-003` | `error` | Profile build đặt `developmentClient: true` nhưng `package.json` không có `expo-dev-client` | `eas/json.md#developmentclient` |
| `EBD-EAS-004` | `warn` | Profile build đặt cả `developmentClient: true` và `channel` (`channel` vô tác dụng với dev client) | `eas/json.md#channel` |
| `EBD-EAS-005` | `warn` | Profile build dùng field lỗi thời (`releaseChannel` hoặc `expoCli`) | `eas/json.md` |
| `EBD-EAS-006` | `error` | Profile build `extends` trỏ tới profile không tồn tại hoặc tạo vòng lặp vô hạn | `eas/json.md#extends` |
| `EBD-ARCH-001` | `warn` | `expo` SDK `>= 55` nhưng cấu hình vẫn đặt `newArchEnabled: false` (bị bỏ qua từ SDK 55+) | `guides/new-architecture.md` |
| `EBD-PLUG-001` | `warn` | Plugin `expo-build-properties` dùng `ios.deploymentTarget` khi SDK `>= 56` (deprecated, chuyển sang `ios.deploymentTarget`), hoặc `android.buildFromSource` (thay bằng `buildReactNativeFromSource`), hoặc `android.minSdkVersion > targetSdkVersion` | `sdk/build-properties.md` |
| `EBD-CFG-001` | `warn` | `updates.url` (`https://u.expo.dev/<uuid>`) khác với `extra.eas.projectId` | `config/app.md#updates` |
| `EBD-CFG-002` | `warn` | Có `expo-updates` (`updates.enabled !== false`) trong `package.json` nhưng thiếu `runtimeVersion` | `config/app.md#runtimeversion` |
| `EBD-CFG-003` | `error` | `scheme`, `ios.scheme` hoặc `android.scheme` sai mẫu `^[a-z][a-z0-9+.-]*$` | `config/app.md#scheme` |
| `EBD-CFG-004` | `info` | Chỉ tìm thấy `app.config.js` / `app.config.ts` (không thực thi mã JS/TS để đảm bảo an toàn; gợi ý xuất JSON qua `npx expo config --json`) | `workflow/configuration.md` |
| `EBD-ASSET-001` | `error` | Đường dẫn file cục bộ trong `icon`, `android.icon`, `android.adaptiveIcon.foregroundImage`, `ios.googleServicesFile`, `android.googleServicesFile`, hoặc `expo-splash-screen` không tồn tại trên đĩa | Kiểm tra tồn tại tệp trước prebuild |

## Kiểm thử & CI
- `node --test test/*.test.mjs` — tối thiểu 25 test offline (không gọi mạng), kiểm tra đủ mọi rule, case `--profile`, `--fail-on`, `--json`, hỗ trợ JSON phẳng lẫn `{ expo: ... }`, đọc project có `app.config.js`, và kiểm đường dẫn tệp cục bộ với thư mục tạm.
- `.github/workflows/ci.yml`: matrix Node `20`, `22` chạy `npm test`.
