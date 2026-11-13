import fs from 'node:fs';
import path from 'node:path';
import {
  ConfigReadError,
  hasDependency,
  resolveEasProfile,
} from './loader.js';

const SEVERITY_ORDER = {
  error: 0,
  warn: 1,
  info: 2,
};

const IOS_BUNDLE_ID_RE = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/;
const ANDROID_PACKAGE_RE = /^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)+$/;
const BUILD_NUMBER_RE = /^\d+(\.\d+){0,2}$/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;
const UPDATES_UUID_RE =
  /^https?:\/\/u\.expo\.dev\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function addFinding(findings, { id, severity, title, message, suggestion, source, profile = null }) {
  findings.push({
    id,
    severity,
    title,
    message,
    suggestion,
    source,
    ...(profile ? { profile } : {}),
  });
}

function supportsPlatform(appConfig, platform) {
  if (!Array.isArray(appConfig?.platforms)) {
    return true;
  }
  return appConfig.platforms.includes(platform);
}

function getPluginOptions(appConfig, targetName) {
  const plugins = appConfig?.plugins;
  if (!Array.isArray(plugins)) {
    return null;
  }
  for (const entry of plugins) {
    if (entry === targetName) {
      return {};
    }
    if (Array.isArray(entry) && entry[0] === targetName) {
      return isPlainObject(entry[1]) ? entry[1] : {};
    }
  }
  return null;
}

function checkDynamicConfig(findings, project) {
  const { dynamicConfigPath } = project.files;
  if (!dynamicConfigPath || project.explicitAppConfig) {
    return;
  }

  const base = path.basename(dynamicConfigPath);
  if (!project.appConfig) {
    addFinding(findings, {
      id: 'EBD-CFG-004',
      severity: 'info',
      source: base,
      title: 'Dynamic app config not executed statically',
      message: `${base} is present without static app.json/app.config.json. JS/TS configs are not executed for security.`,
      suggestion: 'Run `npx expo config --json > .expo-config.json` and pass `--app-config .expo-config.json` to audit resolved values.',
    });
    return;
  }

  addFinding(findings, {
    id: 'EBD-CFG-004',
    severity: 'info',
    source: base,
    title: 'Dynamic app config overrides static JSON at build time',
    message: `Both ${base} and static JSON exist; Expo reads ${base} instead of app.json during builds.`,
    suggestion: 'Export the resolved config with `npx expo config --json > .expo-config.json` and pass `--app-config .expo-config.json`.',
  });
}

function validateSchemes(findings, appConfig) {
  const targets = [
    ['scheme', appConfig?.scheme],
    ['ios.scheme', appConfig?.ios?.scheme],
    ['android.scheme', appConfig?.android?.scheme],
  ];

  for (const [fieldPath, rawValue] of targets) {
    if (rawValue === undefined) {
      continue;
    }
    const values = Array.isArray(rawValue) ? rawValue : typeof rawValue === 'string' ? [rawValue] : null;
    if (!values) {
      addFinding(findings, {
        id: 'EBD-CFG-003',
        severity: 'error',
        source: 'appConfig',
        title: `Invalid type for ${fieldPath}`,
        message: `${fieldPath} must be a lowercase URL scheme string or array of strings.`,
        suggestion: `Set ${fieldPath} to a string matching ^[a-z][a-z0-9+.-]*$ (for example, "myapp").`,
      });
      continue;
    }

    for (const scheme of values) {
      if (typeof scheme !== 'string' || !URL_SCHEME_RE.test(scheme)) {
        addFinding(findings, {
          id: 'EBD-CFG-003',
          severity: 'error',
          source: 'appConfig',
          title: `Invalid URL scheme in ${fieldPath}`,
          message: `URL scheme "${String(scheme)}" in ${fieldPath} violates Expo pattern ^[a-z][a-z0-9+.-]*$.`,
          suggestion: 'Start the scheme with a lowercase letter and use only lowercase letters, digits, "+", ".", or "-".',
        });
      }
    }
  }
}

function checkAppIdentityAndSchemes(findings, project) {
  const { appConfig } = project;
  if (!appConfig) {
    return;
  }

  if (supportsPlatform(appConfig, 'ios')) {
    const bundleId = appConfig.ios?.bundleIdentifier;
    if (typeof bundleId !== 'string' || !IOS_BUNDLE_ID_RE.test(bundleId.trim())) {
      addFinding(findings, {
        id: 'EBD-IOS-001',
        severity: 'error',
        source: 'appConfig',
        title: 'Missing or invalid iOS bundleIdentifier',
        message: bundleId
          ? `ios.bundleIdentifier "${String(bundleId)}" is not a valid reverse-DNS Apple bundle identifier.`
          : 'ios.bundleIdentifier is missing, which blocks standalone iOS builds and App Store submission.',
        suggestion: 'Set `ios.bundleIdentifier` to a unique reverse-DNS value such as "com.example.myapp" (no underscores or spaces).',
      });
    }
  }

  if (supportsPlatform(appConfig, 'android')) {
    const pkg = appConfig.android?.package;
    if (typeof pkg !== 'string' || !ANDROID_PACKAGE_RE.test(pkg.trim())) {
      addFinding(findings, {
        id: 'EBD-AND-001',
        severity: 'error',
        source: 'appConfig',
        title: 'Missing or invalid Android package',
        message: pkg
          ? `android.package "${String(pkg)}" violates Android Application ID syntax (dot-separated segments starting with a lowercase letter).`
          : 'android.package is missing, which blocks standalone Android builds and Google Play submission.',
        suggestion: 'Set `android.package` to a unique reverse-DNS Application ID such as "com.example.myapp".',
      });
    }
  }

  validateSchemes(findings, appConfig);
}

function checkVersioning(findings, project) {
  const { appConfig, easConfig } = project;

  if (easConfig) {
    const versionSource = easConfig.cli?.appVersionSource;
    if (versionSource !== 'local' && versionSource !== 'remote') {
      addFinding(findings, {
        id: 'EBD-VER-001',
        severity: 'warn',
        source: 'eas.json',
        title: 'cli.appVersionSource is not set in eas.json',
        message: versionSource
          ? `eas.json cli.appVersionSource has unexpected value "${String(versionSource)}"; expected "remote" or "local".`
          : 'eas.json omits cli.appVersionSource. EAS CLI warns this will be required in future versions and defaults to "local".',
        suggestion: 'Set `cli.appVersionSource` to "remote" (recommended since EAS CLI 12.0.0) or "local".',
      });
    }

    if (
      versionSource === 'remote' &&
      appConfig?.runtimeVersion?.policy === 'nativeVersion'
    ) {
      addFinding(findings, {
        id: 'EBD-VER-002',
        severity: 'error',
        source: 'eas.json',
        title: 'Remote appVersionSource is incompatible with nativeVersion runtime policy',
        message: 'EAS remote build versions cannot be used alongside `runtimeVersion.policy: "nativeVersion"`.',
        suggestion: 'Switch `runtimeVersion.policy` to "appVersion" or use `cli.appVersionSource: "local"`.',
      });
    }
  }

  if (!appConfig) {
    return;
  }

  if (supportsPlatform(appConfig, 'ios') && appConfig.ios?.buildNumber !== undefined) {
    const bn = appConfig.ios.buildNumber;
    if (typeof bn !== 'string' || !BUILD_NUMBER_RE.test(bn.trim())) {
      addFinding(findings, {
        id: 'EBD-IOS-003',
        severity: 'error',
        source: 'appConfig',
        title: 'Invalid iOS buildNumber format',
        message: `ios.buildNumber (${JSON.stringify(bn)}) must be a string with 1 to 3 dot-separated integers (Apple CFBundleVersion format).`,
        suggestion: 'Use a string such as "1" or "1.0.2" rather than a number or semver pre-release suffix.',
      });
    }
  }

  if (supportsPlatform(appConfig, 'android') && appConfig.android?.versionCode !== undefined) {
    const vc = appConfig.android.versionCode;
    if (!Number.isInteger(vc) || vc < 1) {
      addFinding(findings, {
        id: 'EBD-AND-002',
        severity: 'error',
        source: 'appConfig',
        title: 'Invalid Android versionCode',
        message: `android.versionCode (${JSON.stringify(vc)}) must be a positive integer (>= 1).`,
        suggestion: 'Set `android.versionCode` to a positive integer and increment it for every Play Store upload.',
      });
    }
  }
}

function checkIosSettings(findings, project) {
  const { appConfig } = project;
  if (!appConfig || !supportsPlatform(appConfig, 'ios')) {
    return;
  }

  const hasConfigFlag = appConfig.ios?.config?.usesNonExemptEncryption !== undefined;
  const hasInfoPlistFlag =
    appConfig.ios?.infoPlist?.ITSAppUsesNonExemptEncryption !== undefined;

  if (!hasConfigFlag && !hasInfoPlistFlag) {
    addFinding(findings, {
      id: 'EBD-IOS-002',
      severity: 'warn',
      source: 'appConfig',
      title: 'Missing iOS export compliance declaration',
      message: 'Neither `ios.config.usesNonExemptEncryption` nor `ios.infoPlist.ITSAppUsesNonExemptEncryption` is set; App Store / TestFlight builds may pause for manual compliance input.',
      suggestion: 'If your app only uses standard HTTPS/OS encryption, set `ios.config.usesNonExemptEncryption: false`.',
    });
  }

  const infoPlist = appConfig.ios?.infoPlist;
  if (isPlainObject(infoPlist)) {
    for (const [key, val] of Object.entries(infoPlist)) {
      if (/^NS.*UsageDescription$/.test(key) && (typeof val !== 'string' || !val.trim())) {
        addFinding(findings, {
          id: 'EBD-IOS-004',
          severity: 'error',
          source: 'appConfig',
          title: `Empty iOS permission purpose string (${key})`,
          message: `ios.infoPlist.${key} is blank or non-string, which triggers App Store rejection when requesting the permission.`,
          suggestion: `Provide a specific user-facing explanation string for ${key}.`,
        });
      }
    }
  }
}

function checkUpdatesAndNewArch(findings, project) {
  const { appConfig, packageJson, sdkMajor } = project;
  if (!appConfig) {
    return;
  }

  const updatesUrl = appConfig.updates?.url;
  const projectId = appConfig.extra?.eas?.projectId;
  if (typeof updatesUrl === 'string' && typeof projectId === 'string') {
    const match = UPDATES_UUID_RE.exec(updatesUrl.trim());
    if (match && match[1].toLowerCase() !== projectId.trim().toLowerCase()) {
      addFinding(findings, {
        id: 'EBD-CFG-001',
        severity: 'warn',
        source: 'appConfig',
        title: 'updates.url does not match extra.eas.projectId',
        message: `updates.url targets project "${match[1]}", while extra.eas.projectId is "${projectId}".`,
        suggestion: 'Keep both project UUIDs aligned so EAS Update serves manifests to the right project.',
      });
    }
  }

  if (
    hasDependency(packageJson, 'expo-updates') &&
    appConfig.updates?.enabled !== false &&
    appConfig.runtimeVersion === undefined
  ) {
    addFinding(findings, {
      id: 'EBD-CFG-002',
      severity: 'warn',
      source: 'appConfig',
      title: 'expo-updates installed without runtimeVersion',
      message: '`expo-updates` is installed and enabled, but `runtimeVersion` is unset.',
      suggestion: 'Configure `runtimeVersion: { "policy": "appVersion" }` (or a compatible policy) to guard OTA updates against native binary mismatches.',
    });
  }

  if (sdkMajor !== null && sdkMajor >= 55) {
    const disabledLocations = [];
    if (appConfig.newArchEnabled === false) disabledLocations.push('newArchEnabled');
    if (appConfig.ios?.newArchEnabled === false) disabledLocations.push('ios.newArchEnabled');
    if (appConfig.android?.newArchEnabled === false) disabledLocations.push('android.newArchEnabled');

    if (disabledLocations.length > 0) {
      addFinding(findings, {
        id: 'EBD-ARCH-001',
        severity: 'warn',
        source: 'appConfig',
        title: `newArchEnabled: false is ignored on Expo SDK ${sdkMajor}`,
        message: `Expo SDK 55 and later always run the New Architecture; ${disabledLocations.join(', ')} = false has no effect.`,
        suggestion: 'Remove `newArchEnabled: false` from app config to avoid misleading settings.',
      });
    }
  }
}

function checkBuildProperties(findings, project) {
  const { appConfig, sdkMajor } = project;
  if (!appConfig) {
    return;
  }

  const props = getPluginOptions(appConfig, 'expo-build-properties');
  if (!props) {
    return;
  }

  if (sdkMajor !== null && sdkMajor >= 56 && props.ios?.deploymentTarget !== undefined) {
    addFinding(findings, {
      id: 'EBD-PLUG-001',
      severity: 'warn',
      source: 'appConfig',
      title: 'Deprecated expo-build-properties ios.deploymentTarget',
      message: `In SDK 56+, \`plugins["expo-build-properties"].ios.deploymentTarget\` is deprecated on Expo SDK ${sdkMajor}.`,
      suggestion: 'Move the minimum iOS version to the built-in top-level `ios.deploymentTarget` property.',
    });
  }

  if (props.android?.buildFromSource !== undefined) {
    addFinding(findings, {
      id: 'EBD-PLUG-001',
      severity: 'warn',
      source: 'appConfig',
      title: 'Deprecated expo-build-properties android.buildFromSource',
      message: '`android.buildFromSource` in `expo-build-properties` is deprecated.',
      suggestion: 'Use `android.buildReactNativeFromSource` instead.',
    });
  }

  const minSdk = props.android?.minSdkVersion;
  const targetSdk = props.android?.targetSdkVersion;
  if (typeof minSdk === 'number' && typeof targetSdk === 'number' && minSdk > targetSdk) {
    addFinding(findings, {
      id: 'EBD-PLUG-001',
      severity: 'error',
      source: 'appConfig',
      title: 'Android minSdkVersion exceeds targetSdkVersion',
      message: `expo-build-properties sets minSdkVersion (${minSdk}) higher than targetSdkVersion (${targetSdk}).`,
      suggestion: 'Ensure `minSdkVersion <= targetSdkVersion`.',
    });
  }
}

function checkEasProfiles(findings, project, options) {
  const { easConfig, packageJson } = project;
  if (!easConfig || !isPlainObject(easConfig.build)) {
    return;
  }

  const profiles = easConfig.build;
  const profileNames = Object.keys(profiles);
  if (options.profile) {
    if (!isPlainObject(profiles[options.profile])) {
      throw new ConfigReadError(
        `Build profile "${options.profile}" was not found in eas.json. Available profiles: ${profileNames.join(', ') || '(none)'}`,
      );
    }
  }

  const targetNames = options.profile ? [options.profile] : profileNames;
  for (const name of targetNames) {
    const rawProfile = profiles[name];
    if (!isPlainObject(rawProfile)) {
      continue;
    }

    const { profile, error } = resolveEasProfile(profiles, name);
    if (error) {
      addFinding(findings, {
        id: 'EBD-EAS-006',
        severity: 'error',
        source: 'eas.json',
        profile: name,
        title: `Invalid profile inheritance in "${name}"`,
        message:
          error.kind === 'circular-extends'
            ? `Profile "${name}" has a circular \`extends\` chain: ${error.chain.join(' -> ')}.`
            : `Profile "${name}" extends missing build profile "${error.target}".`,
        suggestion: 'Fix the `extends` target name or break the cycle in `eas.json`.',
      });
      continue;
    }

    const isStoreProfile =
      profile.distribution === 'store' ||
      (name === 'production' && profile.distribution !== 'internal');

    if (isStoreProfile && profile.android?.buildType === 'apk') {
      addFinding(findings, {
        id: 'EBD-EAS-001',
        severity: 'error',
        source: 'eas.json',
        profile: name,
        title: `Store profile "${name}" builds an APK instead of an AAB`,
        message: `Profile "${name}" sets android.buildType to "apk", which Google Play rejects for store publishing.`,
        suggestion: 'Use `android.buildType: "app-bundle"` (or remove `buildType`, since AAB is the store default).',
      });
    }

    if (profile.distribution === 'internal' && profile.android?.buildType === 'app-bundle') {
      addFinding(findings, {
        id: 'EBD-EAS-002',
        severity: 'error',
        source: 'eas.json',
        profile: name,
        title: `Internal distribution profile "${name}" builds an AAB`,
        message: `Profile "${name}" uses distribution: "internal" with android.buildType: "app-bundle". Direct Expo install links require an .apk, not an .aab.`,
        suggestion: 'Set `android.buildType: "apk"` for internal distribution builds.',
      });
    }

    if (
      profile.developmentClient === true &&
      packageJson &&
      !hasDependency(packageJson, 'expo-dev-client')
    ) {
      addFinding(findings, {
        id: 'EBD-EAS-003',
        severity: 'error',
        source: 'eas.json',
        profile: name,
        title: `developmentClient enabled in "${name}" without expo-dev-client`,
        message: `Profile "${name}" sets developmentClient: true, but \`expo-dev-client\` is missing from package.json.`,
        suggestion: 'Install `expo-dev-client` (`npx expo install expo-dev-client`) or set `developmentClient: false`.',
      });
    }

    if (
      profile.developmentClient === true &&
      typeof profile.channel === 'string' &&
      profile.channel.trim().length > 0
    ) {
      addFinding(findings, {
        id: 'EBD-EAS-004',
        severity: 'warn',
        source: 'eas.json',
        profile: name,
        title: `channel has no effect with developmentClient: true in "${name}"`,
        message: `Profile "${name}" sets channel "${profile.channel}" alongside developmentClient: true; development builds can load updates from any channel.`,
        suggestion: 'Remove `channel` from the development client profile or separate preview/production profiles.',
      });
    }

    const deprecatedFields = ['releaseChannel', 'expoCli'].filter(
      (field) => rawProfile[field] !== undefined,
    );
    if (deprecatedFields.length > 0) {
      addFinding(findings, {
        id: 'EBD-EAS-005',
        severity: 'warn',
        source: 'eas.json',
        profile: name,
        title: `Deprecated EAS field(s) in "${name}"`,
        message: `Profile "${name}" uses deprecated property ${deprecatedFields.join(', ')}.`,
        suggestion: 'Use `channel` for EAS Update and remove legacy Classic Updates / `expoCli` keys.',
      });
    }
  }
}

function collectAssetRefs(appConfig) {
  const refs = [];
  const pushRef = (field, val) => {
    if (typeof val === 'string' && val.trim() && !/^https?:\/\//i.test(val.trim())) {
      refs.push({ field, relPath: val.trim() });
    }
  };

  pushRef('icon', appConfig.icon);
  if (typeof appConfig.ios?.icon === 'string') {
    pushRef('ios.icon', appConfig.ios.icon);
  } else if (isPlainObject(appConfig.ios?.icon)) {
    pushRef('ios.icon.light', appConfig.ios.icon.light);
    pushRef('ios.icon.dark', appConfig.ios.icon.dark);
    pushRef('ios.icon.tinted', appConfig.ios.icon.tinted);
  }

  pushRef('android.icon', appConfig.android?.icon);
  pushRef('android.adaptiveIcon.foregroundImage', appConfig.android?.adaptiveIcon?.foregroundImage);
  pushRef('android.adaptiveIcon.backgroundImage', appConfig.android?.adaptiveIcon?.backgroundImage);
  pushRef('android.adaptiveIcon.monochromeImage', appConfig.android?.adaptiveIcon?.monochromeImage);
  pushRef('ios.googleServicesFile', appConfig.ios?.googleServicesFile);
  pushRef('android.googleServicesFile', appConfig.android?.googleServicesFile);

  const splash = getPluginOptions(appConfig, 'expo-splash-screen');
  if (splash) {
    pushRef('plugins["expo-splash-screen"].image', splash.image);
    pushRef('plugins["expo-splash-screen"].ios.image', splash.ios?.image);
    pushRef('plugins["expo-splash-screen"].android.image', splash.android?.image);
    pushRef('plugins["expo-splash-screen"].dark.image', splash.dark?.image);
  }

  return refs;
}

function checkLocalAssetFiles(findings, project, options) {
  if (options.checkFiles === false || !project.appConfig) {
    return;
  }

  const existsFn = options.existsSync ?? fs.existsSync;
  const seen = new Set();

  for (const { field, relPath } of collectAssetRefs(project.appConfig)) {
    const resolved = path.resolve(project.projectDir, relPath);
    const dedupeKey = `${field}:${resolved}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    if (!existsFn(resolved)) {
      addFinding(findings, {
        id: 'EBD-ASSET-001',
        severity: 'error',
        source: 'appConfig',
        title: `Missing local file referenced by ${field}`,
        message: `${field} points to "${relPath}", which does not exist on disk (${resolved}).`,
        suggestion: 'Create the referenced asset/credentials file or update the path before running prebuild/EAS build.',
      });
    }
  }
}

/**
 * Evaluates all static Expo/EAS pre-flight rules against a loaded project.
 */
export function runChecks(project, options = {}) {
  const findings = [];

  checkDynamicConfig(findings, project);
  checkAppIdentityAndSchemes(findings, project);
  checkVersioning(findings, project);
  checkIosSettings(findings, project);
  checkUpdatesAndNewArch(findings, project);
  checkBuildProperties(findings, project);
  checkEasProfiles(findings, project, options);
  checkLocalAssetFiles(findings, project, options);

  findings.sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    if (sevDiff !== 0) return sevDiff;
    const idDiff = a.id.localeCompare(b.id);
    if (idDiff !== 0) return idDiff;
    return (a.profile ?? '').localeCompare(b.profile ?? '');
  });

  const summary = { error: 0, warn: 0, info: 0, total: findings.length };
  for (const item of findings) {
    if (summary[item.severity] !== undefined) {
      summary[item.severity] += 1;
    }
  }

  return {
    projectDir: project.projectDir,
    files: project.files,
    sdkMajor: project.sdkMajor,
    summary,
    findings,
  };
}
