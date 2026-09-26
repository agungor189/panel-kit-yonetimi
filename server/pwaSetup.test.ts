import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

async function readRepoFile(path: string) {
  return readFile(new URL(path, `file://${repoRoot}/`));
}

test('PWA manifest, metadata and referenced icons are valid', async () => {
  const manifest = JSON.parse((await readRepoFile('public/manifest.json')).toString('utf8'));
  const html = (await readRepoFile('index.html')).toString('utf8');

  assert.equal(manifest.name, 'DSDST Panel');
  assert.equal(manifest.short_name, 'DSDST');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes" \/>/);
  assert.match(html, /<meta name="theme-color" content="#111827" \/>/);
  assert.match(
    html,
    /<link rel="manifest" href="\/manifest\.json" type="application\/manifest\+json" crossorigin="use-credentials" \/>/,
  );

  for (const [referencedIcon, expectedSize] of [
    ['public/favicon-32x32.png', 32],
    ['public/favicon-16x16.png', 16],
    ['public/apple-touch-icon.png', 180],
  ] as const) {
    const iconBytes = await readRepoFile(referencedIcon);
    assert.deepEqual([...iconBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(iconBytes.readUInt32BE(16), expectedSize);
    assert.equal(iconBytes.readUInt32BE(20), expectedSize);
  }
  assert.match((await readRepoFile('public/logo.svg')).toString('utf8'), /<svg\b/);
  assert.deepEqual(
    [...(await readRepoFile('public/favicon.ico')).subarray(0, 4)],
    [0, 0, 1, 0],
  );

  const requiredIcons = new Map([
    ['192x192', 192],
    ['512x512', 512],
  ]);
  assert.ok(Array.isArray(manifest.icons));

  for (const icon of manifest.icons) {
    const expectedSize = requiredIcons.get(icon.sizes);
    if (!expectedSize) continue;

    assert.equal(icon.type, 'image/png');
    const iconBytes = await readRepoFile(`public/${icon.src.replace(/^\//, '')}`);
    assert.deepEqual([...iconBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(iconBytes.readUInt32BE(16), expectedSize);
    assert.equal(iconBytes.readUInt32BE(20), expectedSize);
    requiredIcons.delete(icon.sizes);
  }

  assert.deepEqual([...requiredIcons.keys()], []);
});
