import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, lstat, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw new Error('Security check unavailable: ' + command);
  return result;
};
const snapshot = await mkdtemp(path.join(os.tmpdir(), 'poki-secrets-snapshot-'));
const report = path.join(snapshot, 'scanner-report.json');
let failed = false;
try {
  const files = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (files.status !== 0) throw new Error('Cannot inventory repository');
  const manifest = JSON.parse(await readFile('package-lock.json', 'utf8'));
  for (const [name, entry] of Object.entries(manifest.packages ?? {})) {
    if (!name) continue;
    if (!entry.resolved?.startsWith('https://registry.npmjs.org/') || !entry.integrity?.startsWith('sha512-')) {
      console.error(JSON.stringify({ path: name, rule: 'LOCKFILE_PROVENANCE' })); failed = true;
    }
  }
  for (const filename of files.stdout.split('\0').filter(Boolean)) {
    if (filename.startsWith('.github/workflows/')) {
      let workflow;
      try { workflow = await readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const line of workflow.split('\n')) {
        const action = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
        if (action && !/^[^@]+@[a-f0-9]{40}$/.test(action[1])) {
          console.error(JSON.stringify({ path: filename, rule: 'UNPINNED_GITHUB_ACTION' })); failed = true;
        }
      }
      if (filename.includes('deploy') || /appleboy\/ssh-action|git reset --hard|DEPLOY_(?:KEY|HOST)/.test(workflow)) {
        console.error(JSON.stringify({ path: filename, rule: 'PHASE0_DEPLOYMENT_DISABLED' })); failed = true;
      }
    }
    if (/^(?:(?:.*\/)?\.env(?:\..*)?|(?:.*\/)?(?:jobs\.json|profile\.json|resume\.txt|.*\.(?:db|sqlite|sqlite3|pem|key)))$/.test(filename) && path.basename(filename) !== '.env.example') {
      console.error(JSON.stringify({ path: filename, rule: 'PRIVATE_RUNTIME_FILE' })); failed = true;
    }
    let stat;
    try { stat = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) { console.error(JSON.stringify({ path: filename, rule: 'NON_REGULAR_SOURCE' })); failed = true; continue; }
    const target = path.join(snapshot, 'tree', filename);
    await mkdir(path.dirname(target), { recursive: true }); await copyFile(filename, target);
  }
  // Scan immutable staged blobs too: a clean working copy must not hide a staged secret.
  const staged = run('git', ['ls-files', '--stage', '-z']);
  if (staged.status !== 0) throw new Error('Cannot inventory staged index');
  await mkdir(path.join(snapshot, 'index'), { recursive: true });
  for (const entry of staged.stdout.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t');
    const header = entry.slice(0, separator).match(/^(100644|100755) ([a-f0-9]{40,64}) 0$/);
    const filename = entry.slice(separator + 1);
    if (!header || path.isAbsolute(filename) || filename.split('/').includes('..')) {
      console.error(JSON.stringify({ path: filename, rule: 'NON_REGULAR_OR_UNMERGED_INDEX' })); failed = true; continue;
    }
    const blob = spawnSync('git', ['cat-file', 'blob', header[2]], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    if (blob.error || blob.status !== 0) throw new Error('Cannot read staged blob');
    const target = path.join(snapshot, 'index', filename);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, blob.stdout, { mode: 0o600 });
  }
  const scanner = process.env.GITLEAKS_BIN ?? 'gitleaks';
  for (const scope of ['history', 'staged-index', 'working-tree']) {
    const args = scope === 'history' ? ['git', '.'] : ['dir', path.join(snapshot, scope === 'staged-index' ? 'index' : 'tree')];
    const result = run(scanner, [...args, '--redact=100', '--no-banner', '--log-level=error', '--report-format=json', '--report-path=' + report]);
    if (result.status !== 0 && result.status !== 1) throw new Error('Gitleaks could not complete ' + scope);
    const findings = JSON.parse(await readFile(report, 'utf8'));
    for (const finding of findings) console.error(JSON.stringify({ scope, rule: finding.RuleID, path: finding.File, line: finding.StartLine, commit: finding.Commit }));
    if (findings.length || result.status === 1) failed = true;
    console.log(scope + ': ' + findings.length + ' detected secret findings (values redacted)');
  }
  if (failed) process.exitCode = 1;
  else console.log('Secret, private-runtime-file and lockfile provenance checks passed.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Security scan failed'); process.exitCode = 1;
} finally { await rm(snapshot, { recursive: true, force: true }); }
