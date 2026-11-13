import fs from 'node:fs';
import path from 'node:path';

/**
 * Error thrown when CLI inputs, file paths, or JSON configs cannot be read cleanly.
 */
export class ConfigReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigReadError';
  }
}

const DYNAMIC_APP_CONFIG_NAMES = [
  'app.config.ts',
  'app.config.js',
  'app.config.mts',
  'app.config.mjs',
  'app.config.cjs',
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads and parses a JSON object from disk, wrapping read or syntax issues cleanly.
 */
export function parseJsonFile(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigReadError(`Cannot read ${label} at "${filePath}": ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigReadError(`Invalid JSON in ${label} (${filePath}): ${err.message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigReadError(`${label} (${filePath}) must contain a top-level JSON object.`);
  }
  return parsed;
}

/**
 * Accepts either Expo's `{ expo: { ... } }` envelope or the unwrapped flat config object
 * output by `npx expo config --json`.
 */
export function unwrapExpoConfig(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (isPlainObject(raw.expo)) {
    return raw.expo;
  }
  return raw;
}

/**
 * Extracts the Expo SDK major version number from package.json `expo` range or app config.
 */
export function extractSdkMajor(packageJson, appConfig) {
  const rawRange =
    packageJson?.dependencies?.expo ??
    packageJson?.devDependencies?.expo ??
    appConfig?.sdkVersion;

  if (typeof rawRange !== 'string') {
    return null;
  }

  const trimmed = rawRange.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'latest') {
    return null;
  }

  const match = /^[\^~>=<v\s]*(\d+)(?:\.\d+(?:\.\d+)?)?$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const major = Number.parseInt(match[1], 10);
  return Number.isInteger(major) && major > 0 ? major : null;
}

/**
 * Checks whether a package appears in dependencies or devDependencies.
 */
export function hasDependency(packageJson, pkgName) {
  return Boolean(
    packageJson?.dependencies?.[pkgName] || packageJson?.devDependencies?.[pkgName],
  );
}

/**
 * Resolves `build.<profile>.extends` inheritance with cycle and missing-target guards.
 */
export function resolveEasProfile(buildProfiles, profileName, chain = []) {
  if (!isPlainObject(buildProfiles?.[profileName])) {
    return {
      profile: null,
      error: {
        kind: 'missing-profile',
        target: profileName,
        chain,
      },
    };
  }

  if (chain.includes(profileName)) {
    return {
      profile: null,
      error: {
        kind: 'circular-extends',
        chain: [...chain, profileName],
      },
    };
  }

  const own = buildProfiles[profileName];
  if (typeof own.extends !== 'string' || !own.extends.trim()) {
    return { profile: { ...own }, error: null };
  }

  const parentName = own.extends.trim();
  if (!isPlainObject(buildProfiles[parentName])) {
    return {
      profile: null,
      error: {
        kind: 'missing-extends',
        target: parentName,
        chain: [...chain, profileName],
      },
    };
  }

  const parentResult = resolveEasProfile(buildProfiles, parentName, [...chain, profileName]);
  if (parentResult.error) {
    return parentResult;
  }

  const parent = parentResult.profile;
  const merged = {
    ...parent,
    ...own,
  };

  for (const key of ['android', 'ios', 'env']) {
    if (isPlainObject(parent[key]) || isPlainObject(own[key])) {
      merged[key] = {
        ...(isPlainObject(parent[key]) ? parent[key] : {}),
        ...(isPlainObject(own[key]) ? own[key] : {}),
      };
    }
  }

  return { profile: merged, error: null };
}

function findFirstExisting(dir, candidates) {
  for (const name of candidates) {
    const candidatePath = path.join(dir, name);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

/**
 * Loads Expo static config, EAS config, and package.json from a project directory or explicit paths.
 */
export function loadProject(options = {}) {
  const targetInput = path.resolve(options.targetPath || '.');
  let targetStat;
  try {
    targetStat = fs.statSync(targetInput);
  } catch (err) {
    throw new ConfigReadError(`Target path "${targetInput}" does not exist: ${err.message}`);
  }

  let projectDir = targetInput;
  let inferredAppPath = null;
  let inferredEasPath = null;
  let inferredPkgPath = null;

  if (targetStat.isFile()) {
    projectDir = path.dirname(targetInput);
    const base = path.basename(targetInput).toLowerCase();
    if (base === 'eas.json') {
      inferredEasPath = targetInput;
    } else if (base === 'package.json') {
      inferredPkgPath = targetInput;
    } else {
      inferredAppPath = targetInput;
    }
  } else if (!targetStat.isDirectory()) {
    throw new ConfigReadError(`Target path "${targetInput}" is neither a directory nor a file.`);
  }

  const explicitAppPath = options.appConfigPath
    ? path.resolve(options.appConfigPath)
    : inferredAppPath;
  const explicitEasPath = options.easConfigPath
    ? path.resolve(options.easConfigPath)
    : inferredEasPath;
  const explicitPkgPath = options.packageJsonPath
    ? path.resolve(options.packageJsonPath)
    : inferredPkgPath;

  const appConfigPath =
    explicitAppPath ?? findFirstExisting(projectDir, ['app.config.json', 'app.json']);
  const easConfigPath = explicitEasPath ?? findFirstExisting(projectDir, ['eas.json']);
  const packageJsonPath =
    explicitPkgPath ?? findFirstExisting(projectDir, ['package.json']);
  const dynamicConfigPath = findFirstExisting(projectDir, DYNAMIC_APP_CONFIG_NAMES);

  if (explicitAppPath && !fs.existsSync(explicitAppPath)) {
    throw new ConfigReadError(`App config file not found: "${explicitAppPath}"`);
  }
  if (explicitEasPath && !fs.existsSync(explicitEasPath)) {
    throw new ConfigReadError(`EAS config file not found: "${explicitEasPath}"`);
  }
  if (explicitPkgPath && !fs.existsSync(explicitPkgPath)) {
    throw new ConfigReadError(`package.json not found: "${explicitPkgPath}"`);
  }

  const appConfig = appConfigPath
    ? unwrapExpoConfig(parseJsonFile(appConfigPath, 'app config'))
    : null;
  const easConfig = easConfigPath ? parseJsonFile(easConfigPath, 'eas.json') : null;
  const packageJson = packageJsonPath
    ? parseJsonFile(packageJsonPath, 'package.json')
    : null;

  if (!appConfig && !easConfig && !packageJson && !dynamicConfigPath) {
    throw new ConfigReadError(
      `No Expo configuration files (app.json, app.config.*, eas.json, package.json) found in "${projectDir}".`,
    );
  }

  return {
    projectDir,
    explicitAppConfig: Boolean(explicitAppPath),
    files: {
      appConfigPath,
      easConfigPath,
      packageJsonPath,
      dynamicConfigPath,
    },
    appConfig,
    easConfig,
    packageJson,
    sdkMajor: extractSdkMajor(packageJson, appConfig),
  };
}
