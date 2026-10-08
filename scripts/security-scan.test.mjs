import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const scanScript = new URL('./security-scan.mjs', import.meta.url).pathname;
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
function git(directory, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic scanner test', '-c', 'user.email=scanner@example.invalid', ...args], {cwd:directory,encoding:'utf8'});
  assert.equal(result.status, 0, 'Isolated fixture Git operation failed');
}
test('security scanner detects synthetic secrets and unsafe source/config without printing values', async () => {
  assert.ok(process.env.GITLEAKS_BIN, 'Set GITLEAKS_BIN to the verified scanner');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'poki-scan-regression-'));
  try {
    git(directory, ['init', '-q', '-b', 'main']);
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({name:'synthetic-fixture',lockfileVersion:3,packages:{}}));
    git(directory, ['add', 'package-lock.json']); git(directory, ['commit', '-q', '-m', 'Synthetic clean fixture']);
    let result = spawnSync(process.execPath, [scanScript], {cwd:directory,encoding:'utf8',env:childEnv});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const syntheticToken = 'ghp_' + randomBytes(32).toString('hex').slice(0,36);
    await writeFile(path.join(directory, 'synthetic-secret.txt'), 'fixture_token=' + syntheticToken);
    await writeFile(path.join(directory, '.env'), 'fixture_only=true');
    await mkdir(path.join(directory, '.github/workflows'), {recursive:true});
    await writeFile(path.join(directory, '.github/workflows/deploy.yml'), 'jobs:\n  unsafe:\n    steps:\n      - uses: actions/checkout@v4\n');
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({packages:{'node_modules/unsafe':{resolved:'https://untrusted.invalid/package.tgz',integrity:'sha1-invalid'}}}));
    git(directory, ['add', '.']); git(directory, ['commit', '-q', '-m', 'Synthetic unsafe fixture']);
    result = spawnSync(process.execPath, [scanScript], {cwd:directory,encoding:'utf8',env:childEnv});
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    for (const rule of ['LOCKFILE_PROVENANCE','PRIVATE_RUNTIME_FILE','UNPINNED_GITHUB_ACTION','PHASE0_DEPLOYMENT_DISABLED','github-pat']) assert.ok(output.includes(rule), rule + ': ' + output.replaceAll(syntheticToken, '[REDACTED]'));
    assert.ok(!output.includes(syntheticToken), 'Scanner output must never print secret values');
  } finally { await rm(directory, {recursive:true,force:true}); }
});


test('a staged synthetic secret is detected even after its working copy is clean', async () => {
  assert.ok(process.env.GITLEAKS_BIN, 'Set GITLEAKS_BIN to the verified scanner');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'poki-index-regression-'));
  try {
    git(directory, ['init', '-q', '-b', 'main']);
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ packages: {} }));
    git(directory, ['add', '.']); git(directory, ['commit', '-q', '-m', 'Synthetic clean index fixture']);
    const syntheticToken = 'ghp_' + randomBytes(32).toString('hex').slice(0,36);
    await writeFile(path.join(directory, 'staged-fixture.txt'), 'fixture_token=' + syntheticToken);
    git(directory, ['add', 'staged-fixture.txt']);
    await writeFile(path.join(directory, 'staged-fixture.txt'), 'Synthetic clean working copy.');
    const result = spawnSync(process.execPath, [scanScript], {cwd:directory,encoding:'utf8',env:childEnv});
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.match(output, /"scope":"staged-index","rule":"github-pat"/);
    assert.ok(output.includes('working-tree: 0 detected secret findings'));
    assert.ok(!output.includes(syntheticToken), 'Index findings must never print secret values');
  } finally { await rm(directory, {recursive:true,force:true}); }
});
