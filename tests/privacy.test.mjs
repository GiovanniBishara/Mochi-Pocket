// The repository itself must pass the privacy check (see scripts/privacy-check.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('no personal data in the repository', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'privacy-check.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
