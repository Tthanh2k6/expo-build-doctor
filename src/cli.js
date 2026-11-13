import path from 'node:path';
import { createRequire } from 'node:module';
import { ConfigReadError, loadProject } from './loader.js';
import { runChecks } from './rules.js';

const require = createRequire(import.meta.url);
const PKG = require('../package.json');

const FAIL_ON_VALUES = new Set(['errors', 'warnings', 'all', 'none']);

const HELP_TEXT = `expo-build-doctor v${PKG.version}

Static pre-flight checker for Expo app.json / app.config.json, eas.json,
and package.json before running \`eas build\` or store submission.

Usage:
  expo-build-doctor [project-dir] [options]

Options:
  --app-config <path>    Path to app.json / app.config.json (or \`npx expo config --json\` file)
  --eas-config <path>    Path to eas.json
  --package-json <path>  Path to package.json
  --profile <name>       Check only the named eas.json build profile
  --fail-on <mode>       Exit 1 threshold: errors (default), warnings, all, none
  --no-check-files       Skip checking whether local icon/splash/Firebase file paths exist
  --json                 Print machine-readable JSON output
  -h, --help             Show this help message
  -v, --version          Print version number

Exit codes:
  0  Passed threshold defined by --fail-on
  1  One or more findings met or exceeded --fail-on
  2  Invalid CLI usage or unreadable/malformed config file
`;

/**
 * Parses argv tokens cleanly into structured CLI flags.
 */
export function parseArgs(argv) {
  const opts = {
    targetPath: '.',
    hasPositionalTarget: false,
    appConfigPath: null,
    easConfigPath: null,
    packageJsonPath: null,
    profile: null,
    failOn: 'errors',
    checkFiles: true,
    json: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      return opts;
    }
    if (arg === '-v' || arg === '--version') {
      opts.version = true;
      return opts;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '--check-files') {
      opts.checkFiles = true;
      continue;
    }
    if (arg === '--no-check-files') {
      opts.checkFiles = false;
      continue;
    }

    const valueFlags = {
      '--app-config': 'appConfigPath',
      '--eas-config': 'easConfigPath',
      '--package-json': 'packageJsonPath',
      '--profile': 'profile',
      '--fail-on': 'failOn',
    };

    if (Object.hasOwn(valueFlags, arg)) {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new ConfigReadError(`Flag ${arg} requires a value.`);
      }
      opts[valueFlags[arg]] = next;
      i += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new ConfigReadError(`Unknown option: ${arg}`);
    }

    if (opts.hasPositionalTarget) {
      throw new ConfigReadError(`Unexpected extra argument: ${arg}`);
    }
    opts.targetPath = arg;
    opts.hasPositionalTarget = true;
  }

  if (!FAIL_ON_VALUES.has(opts.failOn)) {
    throw new ConfigReadError(
      `Invalid --fail-on value "${opts.failOn}". Expected one of: errors, warnings, all, none.`,
    );
  }

  return opts;
}

/**
 * Returns true if any finding meets the configured `--fail-on` threshold.
 */
export function shouldFail(summary, failOn) {
  if (failOn === 'none') return false;
  if (failOn === 'all') return summary.total > 0;
  if (failOn === 'warnings') return summary.error > 0 || summary.warn > 0;
  return summary.error > 0;
}

/**
 * Formats a concise, readable terminal report (plain text, safe when piped or in CI).
 */
export function formatTextReport(result, useColor = false) {
  const c = useColor
    ? {
        error: (s) => `\x1b[31m${s}\x1b[0m`,
        warn: (s) => `\x1b[33m${s}\x1b[0m`,
        info: (s) => `\x1b[36m${s}\x1b[0m`,
        ok: (s) => `\x1b[32m${s}\x1b[0m`,
        dim: (s) => `\x1b[2m${s}\x1b[0m`,
      }
    : {
        error: (s) => s,
        warn: (s) => s,
        info: (s) => s,
        ok: (s) => s,
        dim: (s) => s,
      };

  const loaded = [];
  if (result.files.appConfigPath) loaded.push(path.basename(result.files.appConfigPath));
  else if (result.files.dynamicConfigPath) loaded.push(`${path.basename(result.files.dynamicConfigPath)} (unparsed)`);
  if (result.files.easConfigPath) loaded.push(path.basename(result.files.easConfigPath));
  if (result.files.packageJsonPath) loaded.push(path.basename(result.files.packageJsonPath));

  const lines = [
    `expo-build-doctor v${PKG.version} — ${result.projectDir}`,
    c.dim(
      `Files: ${loaded.join(', ') || 'none'} | Expo SDK: ${result.sdkMajor ?? 'unknown'}`,
    ),
    '',
  ];

  if (result.findings.length === 0) {
    lines.push(c.ok('OK: No static Expo/EAS build blockers detected.'));
  } else {
    for (const f of result.findings) {
      const badge = `[${f.severity.toUpperCase()}]`;
      const coloredBadge = c[f.severity](badge.padEnd(7));
      const scope = f.profile ? `${f.id} (${f.source}:${f.profile})` : `${f.id} (${f.source})`;
      lines.push(`${coloredBadge} ${scope} — ${f.title}`);
      lines.push(`        ${f.message}`);
      lines.push(c.dim(`        Fix: ${f.suggestion}`));
    }
    lines.push('');
  }

  const { error, warn, info } = result.summary;
  lines.push(`Summary: ${error} error(s), ${warn} warning(s), ${info} info`);
  return lines.join('\n');
}

/**
 * Runs the full CLI pipeline with injectable stdio streams for clean testing.
 */
export function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const isTTY = io.isTTY ?? Boolean(stdout.isTTY && !process.env.NO_COLOR);

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 2;
  }

  if (opts.help) {
    stdout.write(HELP_TEXT);
    return 0;
  }
  if (opts.version) {
    stdout.write(`${PKG.version}\n`);
    return 0;
  }

  try {
    const project = loadProject(opts);
    const result = runChecks(project, {
      profile: opts.profile,
      checkFiles: opts.checkFiles,
    });

    if (opts.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(`${formatTextReport(result, isTTY)}\n`);
    }

    return shouldFail(result.summary, opts.failOn) ? 1 : 0;
  } catch (err) {
    if (err instanceof ConfigReadError) {
      stderr.write(`Error: ${err.message}\n`);
      return 2;
    }
    stderr.write(`Unexpected error: ${err?.stack || err}\n`);
    return 2;
  }
}
