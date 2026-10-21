const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmpDir, writeFile } = require('./helpers');
const curseforge = require('../src/curseforge');
const { findUpdates, publicResult, applyUpdates } = require('../src/modUpdater');

const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');
const day = (n) => new Date(Date.UTC(2026, 0, n)).toISOString();

function setup({ badHash = false } = {}) {
  const dir = tmpDir();
  const mods = path.join(dir, 'mods');
  writeFile(path.join(dir, 'run.sh'), 'java @libraries/net/neoforged/neoforge/21.1.77/unix_args.txt\n');
  const files = {
    'create-6.0.jar': 'create viejo',
    'jei-19.1.jar': 'jei viejo',
    'lib-1.0.jar': 'lib al dia',
    'solo-cf-1.0.jar': 'mod de curseforge',
    'cf-sin-descarga-1.0.jar': 'mod cf bloqueado',
  };
  for (const [name, content] of Object.entries(files)) writeFile(path.join(mods, name), content);
  const H = Object.fromEntries(Object.entries(files).map(([n, c]) => [n, sha1(c)]));
  const newContent = { create: 'create nuevo', jei: 'jei 19.2 estable', cf: 'cf nuevo' };

  const v = (id, project, number, type, date, file, deps = []) => ({
    id, project_id: project, version_number: number, version_type: type, date_published: date,
    files: file ? [{ primary: true, filename: file.name, url: `https://cdn.modrinth.com/data/${project}/${file.name}`, size: 10, hashes: { sha1: file.sha1 } }] : [],
    dependencies: deps,
  });
  const current = {
    [H['create-6.0.jar']]: v('c1', 'P_CREATE', '6.0', 'release', day(1)),
    [H['jei-19.1.jar']]: v('j1', 'P_JEI', '19.1', 'release', day(1)),
    [H['lib-1.0.jar']]: v('l1', 'P_LIB', '1.0', 'release', day(1)),
  };
  const latest = {
    [H['create-6.0.jar']]: v('c2', 'P_CREATE', '6.1', 'release', day(10), { name: 'create-6.1.jar', sha1: badHash ? 'mal' : sha1(newContent.create) },
      [{ project_id: 'P_DEP', dependency_type: 'required' }, { project_id: 'P_LIB', dependency_type: 'required' }]),
    [H['jei-19.1.jar']]: v('j3', 'P_JEI', '19.3-beta', 'beta', day(12), { name: 'jei-19.3-beta.jar', sha1: 'x' }),
    [H['lib-1.0.jar']]: current[H['lib-1.0.jar']],
  };
  const projectVersions = {
    P_JEI: [latest[H['jei-19.1.jar']], v('j2', 'P_JEI', '19.2', 'release', day(8), { name: 'jei-19.2.jar', sha1: sha1(newContent.jei) })],
  };
  const titles = { P_CREATE: 'Create', P_JEI: 'Just Enough Items', P_LIB: 'Lib', P_DEP: 'Ponder Lib' };

  const fp = (name) => curseforge.fingerprint(Buffer.from(files[name]));
  const cfInstalled = { [fp('solo-cf-1.0.jar')]: { modId: 7, fileId: 100 }, [fp('cf-sin-descarga-1.0.jar')]: { modId: 8, fileId: 200 } };
  const cfFiles = {
    '7/150': { id: 150, displayName: 'Solo CF 1.1', fileName: 'solo-cf-1.1.jar', releaseType: 1, fileDate: day(9),
      downloadUrl: 'https://edge.forgecdn.net/files/150/solo-cf-1.1.jar', hashes: [{ algo: 1, value: sha1(newContent.cf) }], dependencies: [] },
    '8/250': { id: 250, displayName: 'Bloqueado 1.1', fileName: 'cf-bloqueado-1.1.jar', releaseType: 1, fileDate: day(9), downloadUrl: null, hashes: [], dependencies: [] },
  };

  const json = (data) => ({ ok: true, status: 200, json: async () => data });
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.endsWith('/version_files')) return json(Object.fromEntries(body.hashes.filter((h) => current[h]).map((h) => [h, current[h]])));
    if (url.endsWith('/version_files/update')) {
      assert.deepEqual(body.loaders, ['neoforge']);
      assert.deepEqual(body.game_versions, ['1.21.1']);
      return json(Object.fromEntries(body.hashes.filter((h) => latest[h]).map((h) => [h, latest[h]])));
    }
    if (url.includes('/project/P_JEI/version')) return json(projectVersions.P_JEI);
    if (url.includes('/projects?ids=')) {
      const ids = JSON.parse(decodeURIComponent(url.split('ids=')[1]));
      return json(ids.map((id) => ({ id, title: titles[id], slug: id.toLowerCase(), client_side: 'required' })));
    }
    if (url.endsWith('/v1/fingerprints/432')) {
      return json({ data: { exactMatches: body.fingerprints.filter((f) => cfInstalled[f]).map((f) => ({ id: cfInstalled[f].modId, file: { id: cfInstalled[f].fileId, modId: cfInstalled[f].modId, fileFingerprint: f, releaseType: 1, gameVersions: ['1.21.1'] } })) } });
    }
    if (url.endsWith('/v1/mods')) {
      return json({ data: body.modIds.map((id) => ({ id, name: id === 7 ? 'Solo CF' : 'Bloqueado', links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/m${id}` },
        latestFilesIndexes: [
          { gameVersion: '1.21.1', modLoader: 6, releaseType: 1, fileId: id === 7 ? 150 : 250 },
          { gameVersion: '1.21.4', modLoader: 6, releaseType: 1, fileId: 999 }, // otra MC: no cuenta
        ] })) });
    }
    const m = url.match(/\/v1\/mods\/(\d+)\/files\/(\d+)$/);
    if (m) return json({ data: cfFiles[`${m[1]}/${m[2]}`] });
    throw new Error(`URL inesperada: ${url}`);
  };
  const downloads = [];
  const download = async (url, dest) => {
    downloads.push(url);
    const name = path.basename(url);
    fs.writeFileSync(dest, name.startsWith('create') ? newContent.create : name.startsWith('jei') ? newContent.jei : newContent.cf);
  };
  return { server: { id: 's', loader: 'neoforge', mcVersion: '1.21.1', dir }, mods, fetchImpl, download, downloads };
}

test('busca actualizaciones en Modrinth y CurseForge para la misma MC y loader', async () => {
  const { server, fetchImpl } = setup();
  const r = publicResult(await findUpdates(server, { fetchImpl, curseforgeKey: 'clave' }));
  const by = Object.fromEntries(r.updates.map((u) => [u.fileName, u]));
  assert.equal(r.mcVersion, '1.21.1');
  assert.deepEqual(Object.keys(by).sort(), ['cf-sin-descarga-1.0.jar', 'create-6.0.jar', 'jei-19.1.jar', 'solo-cf-1.0.jar']);
  assert.equal(by['create-6.0.jar'].newVersion, '6.1');
  assert.deepEqual(by['create-6.0.jar'].missingDeps, ['Ponder Lib'], 'Lib ya está instalada; Ponder Lib no');
  assert.equal(by['jei-19.1.jar'].newVersion, '19.2', 'tienes estable: se propone la última estable, no la beta');
  assert.equal(by['solo-cf-1.0.jar'].source, 'curseforge');
  assert.equal(by['solo-cf-1.0.jar'].newFileName, 'solo-cf-1.1.jar');
  assert.equal(by['cf-sin-descarga-1.0.jar'].canDownload, false);
  assert.ok(r.updates.every((u) => !('_download' in u)), 'la interfaz no recibe URLs');
  assert.equal(r.identified, 5);

  const withBeta = await findUpdates(server, { fetchImpl, curseforgeKey: 'clave', includeBeta: true });
  assert.equal(withBeta.updates.find((u) => u.fileName === 'jei-19.1.jar').newVersion, '19.3-beta');

  const noKey = await findUpdates(server, { fetchImpl, curseforgeKey: null });
  assert.deepEqual(noKey.warnings, ['curseforge-sin-clave']);
  assert.deepEqual(noKey.notOnModrinth.sort(), ['cf-sin-descarga-1.0.jar', 'solo-cf-1.0.jar']);
});

test('aplicar: descarga, comprueba el hash y aparta la versión vieja', async () => {
  const { server, mods, fetchImpl, download, downloads } = setup();
  const r = await applyUpdates(server, ['create-6.0.jar', 'solo-cf-1.0.jar', 'cf-sin-descarga-1.0.jar'], { fetchImpl, download, curseforgeKey: 'clave' });
  assert.deepEqual(r.updated.map((u) => u.newFileName).sort(), ['create-6.1.jar', 'solo-cf-1.1.jar']);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /no permite descargarlo/);
  assert.deepEqual(downloads.length, 2);
  assert.ok(fs.existsSync(path.join(mods, 'create-6.1.jar')));
  assert.equal(fs.existsSync(path.join(mods, 'create-6.0.jar')), false);
  assert.equal(fs.readFileSync(path.join(r.asideDir, 'create-6.0.jar'), 'utf-8'), 'create viejo', 'la vieja se guarda');
  assert.ok(fs.existsSync(path.join(mods, 'jei-19.1.jar')), 'lo no elegido no se toca');
  assert.ok(fs.existsSync(path.join(mods, 'cf-sin-descarga-1.0.jar')));
});

test('si la descarga no coincide con el hash publicado, no se instala y se queda la vieja', async () => {
  const { server, mods, fetchImpl, download } = setup({ badHash: true });
  const r = await applyUpdates(server, ['create-6.0.jar'], { fetchImpl, download, curseforgeKey: null });
  assert.equal(r.updated.length, 0);
  assert.match(r.failed[0].error, /descarga dañada/);
  assert.ok(fs.existsSync(path.join(mods, 'create-6.0.jar')));
  assert.deepEqual(fs.readdirSync(mods).filter((f) => f.includes('descargando')), []);
});
