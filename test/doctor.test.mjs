import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  analyzeProject,
  extractSdkMajor,
  resolveEasProfile,
  runChecks,
  runCli,
  shouldFail,
} from '../src/index.js';

function createBufferIo() {
  let out = '';
  let err = '';
  return {
    stdout: {
      isTTY: false,
      write(chunk) {
        out += chunk;
      },
    },
    stderr: {
      write(chunk) {
        err += chunk;
      },
    },
    read: () => ({ out, err }),
  };
}

function makeTempProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-build-doctor-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(
      full,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      'utf8',
    );
  }
  return dir;
}

function makeHealthyProject() {
  return {
    projectDir: '/fake/app',
    explicitAppConfig: false,
    files: {
      appConfigPath: '/fake/app/app.json',
      easConfigPath: '/fake/app/eas.json',
      packageJsonPath: '/fake/app/package.json',
      dynamicConfigPath: null,
    },
    sdkMajor: 58,
    packageJson: {
      dependencies: {
        expo: '~58.0.24',
        'expo-updates': '~58.0.10',
      },
      devDependencies: {
        'expo-dev-client': '~58.0.5',
      },
    },
    appConfig: {
      name: 'HealthyApp',
      slug: 'healthy-app',
      version: '1.0.0',
      scheme: 'healthyapp',
      runtimeVersion: { policy: 'appVersion' },
      updates: { url: 'https://u.expo.dev/11111111-2222-3333-4444-555555555555' },
      extra: { eas: { projectId: '11111111-2222-3333-4444-555555555555' } },
      ios: {
        bundleIdentifier: 'com.example.healthy',
        buildNumber: '1.0.0',
        config: { usesNonExemptEncryption: false },
        infoPlist: { NSCameraUsageDescription: 'Scan QR codes during onboarding.' },
      },
      android: {
        package: 'com.example.healthy',
        versionCode: 4,
      },
    },
    easConfig: {
      cli: { appVersionSource: 'remote' },
      build: {
        development: {
          developmentClient: true,
          distribution: 'internal',
        },
        preview: {
          distribution: 'internal',
          channel: 'preview',
          android: { buildType: 'apk' },
        },
        production: {
          channel: 'production',
          autoIncrement: true,
          android: { buildType: 'app-bundle' },
        },
      },
    },
  };
}

describe('extractSdkMajor', () => {
  it('parses semver ranges and sdkVersion fallbacks cleanly', () => {
    assert.equal(extractSdkMajor({ dependencies: { expo: '~58.0.24' } }, null), 58);
    assert.equal(extractSdkMajor({ dependencies: { expo: '^54.0.0' } }, null), 54);
    assert.equal(extractSdkMajor({ devDependencies: { expo: '>=55.0.0' } }, null), 55);
    assert.equal(extractSdkMajor(null, { sdkVersion: '53.0.0' }), 53);
    assert.equal(extractSdkMajor({ dependencies: { expo: '*' } }, null), null);
    assert.equal(extractSdkMajor({ dependencies: { expo: 'latest' } }, null), null);
  });
});

describe('resolveEasProfile', () => {
  it('merges parent profiles including nested android overrides', () => {
    const profiles = {
      base: {
        distribution: 'internal',
        android: { buildType: 'apk', resourceClass: 'medium' },
      },
      staging: {
        extends: 'base',
        channel: 'staging',
        android: { buildType: 'app-bundle' },
      },
    };
    const res = resolveEasProfile(profiles, 'staging');
    assert.equal(res.error, null);
    assert.equal(res.profile.distribution, 'internal');
    assert.equal(res.profile.channel, 'staging');
    assert.deepEqual(res.profile.android, {
      buildType: 'app-bundle',
      resourceClass: 'medium',
    });
  });

  it('detects missing extends targets and circular inheritance', () => {
    const missing = resolveEasProfile({ prod: { extends: 'ghost' } }, 'prod');
    assert.equal(missing.error.kind, 'missing-extends');
    assert.equal(missing.error.target, 'ghost');

    const loop = resolveEasProfile(
      { a: { extends: 'b' }, b: { extends: 'a' } },
      'a',
    );
    assert.equal(loop.error.kind, 'circular-extends');
  });
});

describe('rule checks', () => {
  it('passes cleanly with zero findings on a healthy SDK 58 config', () => {
    const res = runChecks(makeHealthyProject(), { checkFiles: false });
    assert.equal(res.summary.total, 0);
    assert.deepEqual(res.findings, []);
  });

  it('flags missing appVersionSource (EBD-VER-001) and remote + nativeVersion conflict (EBD-VER-002)', () => {
    const p1 = makeHealthyProject();
    delete p1.easConfig.cli.appVersionSource;
    const r1 = runChecks(p1, { checkFiles: false });
    assert.ok(r1.findings.some((f) => f.id === 'EBD-VER-001' && f.severity === 'warn'));

    const p2 = makeHealthyProject();
    p2.appConfig.runtimeVersion = { policy: 'nativeVersion' };
    const r2 = runChecks(p2, { checkFiles: false });
    assert.ok(r2.findings.some((f) => f.id === 'EBD-VER-002' && f.severity === 'error'));
  });

  it('flags invalid iOS bundleIdentifier, encryption flag, buildNumber, and empty NSUsageDescription', () => {
    const p = makeHealthyProject();
    p.appConfig.ios = {
      bundleIdentifier: 'com.bad_underscore',
      buildNumber: 12,
      infoPlist: { NSPhotoLibraryUsageDescription: '   ' },
    };
    const res = runChecks(p, { checkFiles: false });
    const ids = res.findings.map((f) => f.id);
    assert.ok(ids.includes('EBD-IOS-001'));
    assert.ok(ids.includes('EBD-IOS-002'));
    assert.ok(ids.includes('EBD-IOS-003'));
    assert.ok(ids.includes('EBD-IOS-004'));
  });

  it('flags invalid Android package and versionCode', () => {
    const p = makeHealthyProject();
    p.appConfig.android = {
      package: 'Com.BadCap.app',
      versionCode: 0,
    };
    const res = runChecks(p, { checkFiles: false });
    const ids = res.findings.map((f) => f.id);
    assert.ok(ids.includes('EBD-AND-001'));
    assert.ok(ids.includes('EBD-AND-002'));
  });

  it('skips iOS rules when platforms restricts the project to android only', () => {
    const p = makeHealthyProject();
    p.appConfig.platforms = ['android'];
    delete p.appConfig.ios;
    const res = runChecks(p, { checkFiles: false });
    assert.equal(res.summary.total, 0);
  });

  it('flags EAS profile mismatches: store apk, internal aab, missing expo-dev-client, channel+devClient, deprecated keys, extends cycle', () => {
    const p = makeHealthyProject();
    delete p.packageJson.devDependencies['expo-dev-client'];
    p.easConfig.build = {
      development: {
        developmentClient: true,
        channel: 'dev',
        releaseChannel: 'default',
        expoCli: '5.0.0',
      },
      preview: {
        distribution: 'internal',
        android: { buildType: 'app-bundle' },
      },
      production: {
        android: { buildType: 'apk' },
      },
      broken: {
        extends: 'nope',
      },
    };
    const res = runChecks(p, { checkFiles: false });
    const ids = new Set(res.findings.map((f) => f.id));
    for (const expected of [
      'EBD-EAS-001',
      'EBD-EAS-002',
      'EBD-EAS-003',
      'EBD-EAS-004',
      'EBD-EAS-005',
      'EBD-EAS-006',
    ]) {
      assert.ok(ids.has(expected), `expected rule ${expected} in ${[...ids].join(',')}`);
    }
  });

  it('flags newArchEnabled: false on SDK >= 55 and respects SDK 54', () => {
    const p55 = makeHealthyProject();
    p55.sdkMajor = 55;
    p55.appConfig.newArchEnabled = false;
    assert.ok(
      runChecks(p55, { checkFiles: false }).findings.some((f) => f.id === 'EBD-ARCH-001'),
    );

    const p54 = makeHealthyProject();
    p54.sdkMajor = 54;
    p54.appConfig.newArchEnabled = false;
    assert.equal(
      runChecks(p54, { checkFiles: false }).findings.some((f) => f.id === 'EBD-ARCH-001'),
      false,
    );
  });

  it('flags deprecated and inconsistent expo-build-properties options', () => {
    const p = makeHealthyProject();
    p.sdkMajor = 58;
    p.appConfig.plugins = [
      [
        'expo-build-properties',
        {
          ios: { deploymentTarget: '16.0' },
          android: { buildFromSource: true, minSdkVersion: 35, targetSdkVersion: 34 },
        },
      ],
    ];
    const plugFindings = runChecks(p, { checkFiles: false }).findings.filter(
      (f) => f.id === 'EBD-PLUG-001',
    );
    assert.equal(plugFindings.length, 3);
  });

  it('flags mismatched updates.url UUID, missing runtimeVersion with expo-updates, and bad schemes', () => {
    const p = makeHealthyProject();
    p.appConfig.scheme = ['valid-scheme', 'BadUpperCase'];
    p.appConfig.updates = {
      url: 'https://u.expo.dev/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    };
    delete p.appConfig.runtimeVersion;
    const res = runChecks(p, { checkFiles: false });
    const ids = new Set(res.findings.map((f) => f.id));
    assert.ok(ids.has('EBD-CFG-001'));
    assert.ok(ids.has('EBD-CFG-002'));
    assert.ok(ids.has('EBD-CFG-003'));
  });
});

describe('filesystem loading & CLI', () => {
  it('detects missing local asset files and succeeds when they exist on disk', () => {
    const dir = makeTempProject({
      'app.json': {
        expo: {
          name: 'FilesApp',
          slug: 'files-app',
          icon: './assets/icon.png',
          ios: {
            bundleIdentifier: 'com.example.files',
            config: { usesNonExemptEncryption: false },
          },
          android: {
            package: 'com.example.files',
            googleServicesFile: './google-services.json',
          },
          plugins: [['expo-splash-screen', { image: './assets/splash.png' }]],
        },
      },
      'assets/icon.png': 'png',
    });

    try {
      const missingRes = analyzeProject({ targetPath: dir });
      const missingAssets = missingRes.findings.filter((f) => f.id === 'EBD-ASSET-001');
      assert.equal(missingAssets.length, 2);

      const skippedRes = analyzeProject({ targetPath: dir, checkFiles: false });
      assert.equal(skippedRes.findings.some((f) => f.id === 'EBD-ASSET-001'), false);

      fs.writeFileSync(path.join(dir, 'google-services.json'), '{}');
      fs.writeFileSync(path.join(dir, 'assets', 'splash.png'), 'png');
      const okRes = analyzeProject({ targetPath: dir });
      assert.equal(okRes.summary.total, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports unwrapped flat --app-config JSON and dynamic app.config.js notice', () => {
    const dir = makeTempProject({
      'app.config.js': 'export default { expo: { name: "Dyn" } };',
      'eas.json': { cli: { appVersionSource: 'remote' }, build: { production: {} } },
    });

    try {
      const io1 = createBufferIo();
      const code1 = runCli([dir, '--json'], io1);
      assert.equal(code1, 0);
      const parsed1 = JSON.parse(io1.read().out);
      assert.ok(parsed1.findings.some((f) => f.id === 'EBD-CFG-004'));

      const flatPath = path.join(dir, 'resolved.json');
      fs.writeFileSync(
        flatPath,
        JSON.stringify({
          name: 'Dyn',
          slug: 'dyn',
          ios: { config: { usesNonExemptEncryption: false } },
          android: { package: 'com.example.dyn' },
        }),
      );

      const io2 = createBufferIo();
      const code2 = runCli([dir, '--app-config', flatPath, '--json'], io2);
      assert.equal(code2, 1);
      const parsed2 = JSON.parse(io2.read().out);
      assert.ok(parsed2.findings.some((f) => f.id === 'EBD-IOS-001'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects --profile filter and --fail-on modes cleanly', () => {
    const dir = makeTempProject({
      'app.json': {
        expo: {
          ios: { bundleIdentifier: 'com.example.ok' },
          android: { package: 'com.example.ok' },
        },
      },
      'eas.json': {
        cli: { appVersionSource: 'remote' },
        build: {
          preview: {
            distribution: 'internal',
            android: { buildType: 'app-bundle' },
          },
          production: {
            android: { buildType: 'app-bundle' },
          },
        },
      },
    });

    try {
      const ioProd = createBufferIo();
      assert.equal(runCli([dir, '--profile', 'production'], ioProd), 0);
      assert.match(ioProd.read().out, /Summary: 0 error\(s\), 1 warning\(s\)/);

      assert.equal(runCli([dir, '--profile', 'production', '--fail-on', 'warnings'], createBufferIo()), 1);
      assert.equal(runCli([dir, '--profile', 'preview', '--fail-on', 'none'], createBufferIo()), 0);
      assert.equal(runCli([dir, '--profile', 'preview'], createBufferIo()), 1);
      assert.equal(runCli([dir, '--profile', 'missing'], createBufferIo()), 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles -h, -v, malformed JSON, and bad flags cleanly', () => {
    const ioHelp = createBufferIo();
    assert.equal(runCli(['--help'], ioHelp), 0);
    assert.match(ioHelp.read().out, /Usage:/);

    const ioVer = createBufferIo();
    assert.equal(runCli(['--version'], ioVer), 0);
    assert.match(ioVer.read().out, /^\d+\.\d+\.\d+/);

    const ioBadFlag = createBufferIo();
    assert.equal(runCli(['--bogus'], ioBadFlag), 2);

    const dir = makeTempProject({ 'app.json': '{ broken json' });
    try {
      const ioBroken = createBufferIo();
      assert.equal(runCli([dir], ioBroken), 2);
      assert.match(ioBroken.read().err, /Invalid JSON/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('evaluates shouldFail thresholds across all modes', () => {
    assert.equal(shouldFail({ error: 1, warn: 0, info: 0, total: 1 }, 'errors'), true);
    assert.equal(shouldFail({ error: 0, warn: 2, info: 1, total: 3 }, 'errors'), false);
    assert.equal(shouldFail({ error: 0, warn: 1, info: 0, total: 1 }, 'warnings'), true);
    assert.equal(shouldFail({ error: 0, warn: 0, info: 1, total: 1 }, 'warnings'), false);
    assert.equal(shouldFail({ error: 0, warn: 0, info: 1, total: 1 }, 'all'), true);
    assert.equal(shouldFail({ error: 2, warn: 2, info: 2, total: 6 }, 'none'), false);
  });

  it('resolves sibling project files when given a direct eas.json or package.json file path', () => {
    const dir = makeTempProject({
      'app.json': {
        expo: {
          ios: { bundleIdentifier: 'com.example.sib', config: { usesNonExemptEncryption: false } },
          android: { package: 'com.example.sib' },
        },
      },
      'eas.json': { cli: { appVersionSource: 'remote' }, build: { production: {} } },
      'package.json': { dependencies: { expo: '~58.0.0' } },
    });

    try {
      const io = createBufferIo();
      const code = runCli([path.join(dir, 'eas.json'), '--json'], io);
      assert.equal(code, 0);
      const res = JSON.parse(io.read().out);
      assert.equal(res.sdkMajor, 58);
      assert.equal(res.summary.total, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks ios.icon light/dark/tinted local paths and skips remote http(s) URLs', () => {
    const dir = makeTempProject({
      'app.json': {
        expo: {
          icon: 'https://cdn.example.com/icon.png',
          ios: {
            bundleIdentifier: 'com.example.icons',
            config: { usesNonExemptEncryption: false },
            icon: {
              light: './assets/light.png',
              dark: './assets/missing-dark.png',
            },
          },
          android: { package: 'com.example.icons' },
        },
      },
      'assets/light.png': 'png',
    });

    try {
      const res = analyzeProject({ targetPath: dir });
      const missing = res.findings.filter((f) => f.id === 'EBD-ASSET-001');
      assert.equal(missing.length, 1);
      assert.match(missing[0].message, /ios\.icon\.dark/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits EBD-CFG-004 notice when both app.json and app.config.js are present', () => {
    const dir = makeTempProject({
      'app.json': {
        expo: {
          ios: { bundleIdentifier: 'com.example.both', config: { usesNonExemptEncryption: false } },
          android: { package: 'com.example.both' },
        },
      },
      'app.config.js': 'module.exports = { expo: { name: "Override" } };',
    });

    try {
      const res = analyzeProject({ targetPath: dir });
      const note = res.findings.find((f) => f.id === 'EBD-CFG-004');
      assert.ok(note);
      assert.match(note.title, /overrides static JSON/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies EAS rules across extended profiles and explicit distribution: "store"', () => {
    const p = makeHealthyProject();
    p.easConfig.build = {
      baseInternal: {
        developmentClient: true,
        channel: 'internal-dev',
      },
      customDev: {
        extends: 'baseInternal',
      },
      storeCandidate: {
        distribution: 'store',
        android: { buildType: 'apk' },
      },
    };
    const res = runChecks(p, { checkFiles: false });
    assert.ok(
      res.findings.some((f) => f.id === 'EBD-EAS-004' && f.profile === 'customDev'),
    );
    assert.ok(
      res.findings.some((f) => f.id === 'EBD-EAS-001' && f.profile === 'storeCandidate'),
    );
  });

  it('validates ios.scheme and android.scheme patterns including non-string values', () => {
    const p = makeHealthyProject();
    p.appConfig.ios.scheme = '9bad';
    p.appConfig.android.scheme = 123;
    const res = runChecks(p, { checkFiles: false });
    const schemeFindings = res.findings.filter((f) => f.id === 'EBD-CFG-003');
    assert.equal(schemeFindings.length, 2);
  });

  it('returns exit code 2 when explicit flag files are missing or directory has no configs', () => {
    const emptyDir = makeTempProject({});
    try {
      assert.equal(runCli([emptyDir], createBufferIo()), 2);
      assert.equal(
        runCli([emptyDir, '--app-config', path.join(emptyDir, 'missing.json')], createBufferIo()),
        2,
      );
      assert.equal(
        runCli([emptyDir, '--eas-config', path.join(emptyDir, 'missing.json')], createBufferIo()),
        2,
      );
      assert.equal(
        runCli([emptyDir, '--package-json', path.join(emptyDir, 'missing.json')], createBufferIo()),
        2,
      );
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('checks circular eas.json profile extends through runChecks cleanly', () => {
    const p = makeHealthyProject();
    p.easConfig.build = {
      alpha: { extends: 'beta' },
      beta: { extends: 'alpha' },
    };
    const res = runChecks(p, { checkFiles: false });
    const cycles = res.findings.filter((f) => f.id === 'EBD-EAS-006');
    assert.equal(cycles.length, 2);
  });

  it('supports plain non-wrapped flat app config JSON directly without --app-config', () => {
    const dir = makeTempProject({
      'app.config.json': {
        name: 'FlatJsonApp',
        slug: 'flat-json-app',
        ios: {
          bundleIdentifier: 'com.example.flat',
          buildNumber: '1.0.1',
          config: { usesNonExemptEncryption: false },
        },
        android: {
          package: 'com.example.flat',
          versionCode: 2,
        },
      },
    });
    try {
      const res = analyzeProject({ targetPath: dir });
      assert.equal(res.summary.total, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats readable plain text output with profile tags and summary', () => {
    const dir = makeTempProject({
      'app.json': {
        expo: {
          ios: { bundleIdentifier: 'com.example.txt', config: { usesNonExemptEncryption: false } },
          android: { package: 'com.example.txt' },
        },
      },
      'eas.json': {
        cli: { appVersionSource: 'local' },
        build: {
          production: { android: { buildType: 'apk' } },
        },
      },
    });
    try {
      const io = createBufferIo();
      assert.equal(runCli([dir], io), 1);
      const output = io.read().out;
      assert.match(output, /\[ERROR\] EBD-EAS-001 \(eas\.json:production\)/);
      assert.match(output, /Summary: 1 error\(s\), 0 warning\(s\), 0 info/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
