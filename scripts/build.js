#!/usr/bin/env node

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const extensionSource = path.join(root, 'chrome-extension');
const distDir = path.join(root, 'dist');
const artifactsDir = path.join(root, 'artifacts');
const fixedTime = new Date('2024-01-01T00:00:00Z');

const packageJson = readJson('package.json');
const baseManifest = readJson('chrome-extension/manifest.json');

const firefoxSettings = {
  gecko: {
    id: 'prompt-otter@robinja2200.github.io',
    strict_min_version: '142.0',
    data_collection_permissions: {
      required: ['none'],
    },
  },
};

if (process.env.OMIT_FIREFOX_DATA_COLLECTION_PERMISSIONS === '1') {
  delete firefoxSettings.gecko.data_collection_permissions;
}

function main() {
  const command = process.argv[2] || 'build';
  const tag = process.argv[3] || process.env.GITHUB_REF_NAME || '';

  if (command === 'validate') {
    validate(tag);
    return;
  }

  validate(tag);

  if (command === 'build') {
    cleanGenerated();
    buildChrome();
    buildFirefox();
    copyUserscriptArtifact();
    buildSourceArchive();
    return;
  }

  if (command === 'build:chrome') {
    cleanTarget('chrome');
    buildChrome();
    return;
  }

  if (command === 'build:firefox') {
    cleanTarget('firefox');
    buildFirefox();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function validate(tag) {
  const version = packageJson.version;
  const manifestVersion = baseManifest.version;
  const contentVersion = matchRequired(
    readText('chrome-extension/content.js'),
    /Prompt Otter v([0-9]+\.[0-9]+\.[0-9][0-9A-Za-z.-]*)/,
    'chrome-extension/content.js header version',
  );
  const userscriptVersion = matchRequired(
    readText('prompt-otter.user.js'),
    /@version\s+([0-9]+\.[0-9]+\.[0-9][0-9A-Za-z.-]*)/,
    'prompt-otter.user.js @version',
  );

  const versions = {
    'package.json': version,
    'chrome-extension/manifest.json': manifestVersion,
    'chrome-extension/content.js': contentVersion,
    'prompt-otter.user.js': userscriptVersion,
  };

  const mismatches = Object.entries(versions).filter(([, value]) => value !== version);
  if (mismatches.length > 0) {
    const details = Object.entries(versions)
      .map(([file, value]) => `  ${file}: ${value}`)
      .join('\n');
    throw new Error(`Version mismatch. Expected ${version} everywhere:\n${details}`);
  }

  if (tag && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match package version v${version}`);
  }
}

function buildChrome() {
  const target = path.join(distDir, 'chrome');
  copyExtensionFiles(target);
  writeJson(path.join(target, 'manifest.json'), createChromeManifest());
  normalizeTree(target);
  zipDirectory(target, path.join(artifactsDir, `prompt-otter-chrome-v${packageJson.version}.zip`));
}

function buildFirefox() {
  const target = path.join(distDir, 'firefox');
  copyExtensionFiles(target);
  writeJson(path.join(target, 'manifest.json'), createFirefoxManifest());
  normalizeTree(target);
  zipDirectory(target, path.join(artifactsDir, `prompt-otter-firefox-v${packageJson.version}.zip`));
}

function createChromeManifest() {
  const manifest = structuredClone(baseManifest);
  delete manifest.browser_specific_settings;
  return manifest;
}

function createFirefoxManifest() {
  const manifest = structuredClone(baseManifest);
  manifest.browser_specific_settings = firefoxSettings;
  return manifest;
}

function copyUserscriptArtifact() {
  ensureDir(artifactsDir);
  const target = path.join(artifactsDir, `prompt-otter-v${packageJson.version}.user.js`);
  fs.copyFileSync(path.join(root, 'prompt-otter.user.js'), target);
  fs.utimesSync(target, fixedTime, fixedTime);
}

function buildSourceArchive() {
  const files = `${gitOutput(['ls-files'])}\n${gitOutput(['ls-files', '--others', '--exclude-standard'])}`
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.endsWith('.zip'));

  const stage = path.join(distDir, 'source');
  rm(stage);
  ensureDir(stage);
  for (const file of files) {
    copyFile(path.join(root, file), path.join(stage, file));
  }
  normalizeTree(stage);
  zipDirectory(stage, path.join(artifactsDir, `prompt-otter-source-v${packageJson.version}.zip`));
}

function gitOutput(args) {
  try {
    return childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  } catch (error) {
    if (error.stdout) return String(error.stdout);
    throw error;
  }
}

function copyExtensionFiles(target) {
  rm(target);
  ensureDir(target);
  copyFile(path.join(extensionSource, 'content.js'), path.join(target, 'content.js'));
  copyDirectory(path.join(extensionSource, 'icons'), path.join(target, 'icons'));
}

function zipDirectory(sourceDir, zipPath) {
  ensureDir(path.dirname(zipPath));
  rm(zipPath);
  const relativeZip = path.relative(sourceDir, zipPath);
  const files = walk(sourceDir)
    .filter((entry) => fs.statSync(entry).isFile())
    .map((entry) => path.relative(sourceDir, entry))
    .sort();
  childProcess.execFileSync('zip', ['-X', '-q', relativeZip, ...files], {
    cwd: sourceDir,
    stdio: 'inherit',
  });
}

function cleanGenerated() {
  rm(distDir);
  rm(artifactsDir);
  ensureDir(distDir);
  ensureDir(artifactsDir);
}

function cleanTarget(targetName) {
  rm(path.join(distDir, targetName));
  ensureDir(artifactsDir);
}

function normalizeTree(target) {
  for (const entry of walk(target).sort().reverse()) {
    fs.utimesSync(entry, fixedTime, fixedTime);
  }
  fs.utimesSync(target, fixedTime, fixedTime);
}

function walk(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    return [target];
  }
  return fs.readdirSync(target).flatMap((name) => walk(path.join(target, name))).concat(target);
}

function copyDirectory(from, to) {
  ensureDir(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(source, target);
    } else if (entry.isFile()) {
      copyFile(source, target);
    }
  }
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  fs.utimesSync(to, fixedTime, fixedTime);
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function writeJson(target, value) {
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  fs.utimesSync(target, fixedTime, fixedTime);
}

function matchRequired(text, regex, label) {
  const match = text.match(regex);
  if (!match) {
    throw new Error(`Could not find ${label}`);
  }
  return match[1];
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function rm(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

main();
