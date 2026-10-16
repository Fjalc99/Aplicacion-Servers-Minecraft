const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, writeFile } = require('./helpers');

process.env.DATA_DIR = tmpDir('msm-update-');
const u = require('../src/loaderUpdater');

const NEO = ['21.1.0-beta', '21.1.1', '21.1.77', '21.1.200', '21.1.209', '21.1.210-beta'];
const fakeApi = {
  listNeoForgeVersions: async () => [...NEO], // el orden da igual
  listForgeVersions: async () => ['47.2.0', '47.3.0', '47.4.10'],
  getForgeRecommended: async () => '47.3.0',
  getNeoForgeInstallerUrl: (v) => `https://maven.example/neoforge-${v}-installer.jar`,
  getForgeInstallerUrl: (mc, v) => `https://maven.example/forge-${mc}-${v}-installer.jar`,
  listVanillaVersions: async () => [{ id: '1.21.4' }, { id: '1.21.3' }, { id: '1.21.1' }, { id: '1.20.1' }],
  getVanillaServerDownload: async (v) => ({ url: `https://mojang.example/${v}/server.jar` }),
};

function neoServer(version = '21.1.77', { loaderVersion = null } = {}) {
  const dir = tmpDir();
  const script = (v) => `java @user_jvm_args.txt @libraries/net/neoforged/neoforge/${v}/win_args.txt %*\n`;
  writeFile(path.join(dir, 'run.bat'), script(version));
  writeFile(path.join(dir, 'run.sh'), script(version).replace('win_args', 'unix_args'));
  writeFile(path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge', version, 'win_args.txt'), 'x');
  return { id: 'n', loader: 'neoforge', mcVersion: 'desconocida', loaderVersion, dir, launch: { type: 'script', value: 'run.bat' } };
}

/** Instalador falso que hace lo mismo que el de NeoForge: librerías nuevas + run.bat/run.sh nuevos. */
function fakeInstaller(version, { rewriteScripts = true } = {}) {
  return async (dir, onOutput) => {
    assert.ok(fs.existsSync(path.join(dir, 'installer.jar')), 'el instalador está descargado en la carpeta');
    onOutput('Installing libraries...\n');
    writeFile(path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge', version, 'win_args.txt'), 'x');
    if (rewriteScripts) {
      fs.writeFileSync(path.join(dir, 'run.bat'), `java @user_jvm_args.txt @libraries/net/neoforged/neoforge/${version}/win_args.txt %*\n`);
      fs.writeFileSync(path.join(dir, 'run.sh'), `java @user_jvm_args.txt @libraries/net/neoforged/neoforge/${version}/unix_args.txt "$@"\n`);
    }
  };
}
const fakeDownload = (urls) => async (url, dest) => {
  urls.push(url);
  writeFile(dest, 'jar');
};

test('compara versiones (betas por debajo de la versión final)', () => {
  assert.deepEqual(['21.1.200', '21.1.9', '21.1.0-beta', '21.1.0'].sort(u.compareVersions), ['21.1.0-beta', '21.1.0', '21.1.9', '21.1.200']);
  assert.equal(u.mcVersionFromNeoForge('21.1.77'), '1.21.1');
  assert.equal(u.mcVersionFromNeoForge('21.0.3'), '1.21');
});

test('detecta la versión instalada de verdad mirando run.bat y libraries/', () => {
  assert.deepEqual(u.detectInstalled(neoServer('21.1.77')), { loaderVersion: '21.1.77', mcVersion: '1.21.1' });

  const forgeDir = tmpDir();
  writeFile(path.join(forgeDir, 'run.bat'), 'java @libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt\n');
  assert.deepEqual(u.detectInstalled({ loader: 'forge', dir: forgeDir }), { loaderVersion: '47.2.0', mcVersion: '1.20.1' });

  // Sin scripts: la carpeta de librerías más alta
  const onlyLibs = tmpDir();
  writeFile(path.join(onlyLibs, 'libraries', 'net', 'neoforged', 'neoforge', '21.1.9', 'a'), 'x');
  writeFile(path.join(onlyLibs, 'libraries', 'net', 'neoforged', 'neoforge', '21.1.77', 'a'), 'x');
  assert.equal(u.detectInstalled({ loader: 'neoforge', dir: onlyLibs }).loaderVersion, '21.1.77');
});

test('getUpdateInfo: versiones de la misma MC, más nuevas marcadas, última estable', async () => {
  const info = await u.getUpdateInfo(neoServer('21.1.77'), { api: fakeApi });
  assert.equal(info.mcVersion, '1.21.1');
  assert.equal(info.current, '21.1.77');
  assert.equal(info.latest, '21.1.209', 'la beta no cuenta como última');
  assert.equal(info.upToDate, false);
  assert.equal(info.versions[0].version, '21.1.210-beta');
  assert.equal(info.versions.find((v) => v.version === '21.1.200').newer, true);
  assert.equal(info.versions.find((v) => v.version === '21.1.1').newer, false);

  const forge = tmpDir();
  writeFile(path.join(forge, 'run.bat'), 'java @libraries/net/minecraftforge/forge/1.20.1-47.4.10/win_args.txt\n');
  const finfo = await u.getUpdateInfo({ loader: 'forge', dir: forge }, { api: fakeApi });
  assert.equal(finfo.upToDate, true);
  assert.equal(finfo.recommended, '47.3.0');
});

test('actualizar NeoForge: descarga el instalador oficial, lo ejecuta y apunta a la versión nueva', async () => {
  const server = neoServer('21.1.77');
  const urls = [];
  const logs = [];
  const fields = await u.updateServerVersion(server, '21.1.209', {
    onLog: (t) => logs.push(t),
    deps: { api: fakeApi, download: fakeDownload(urls), install: fakeInstaller('21.1.209') },
  });
  assert.deepEqual(urls, ['https://maven.example/neoforge-21.1.209-installer.jar']);
  assert.equal(fields.loaderVersion, '21.1.209');
  assert.equal(fields.mcVersion, '1.21.1');
  assert.equal(fs.existsSync(path.join(server.dir, 'installer.jar')), false, 'se borra el instalador');
  assert.equal(u.detectInstalled(server).loaderVersion, '21.1.209');
  assert.ok(logs.join('').includes('Installing libraries'));
});

test('si el instalador no rehace run.bat, se corrige a mano', async () => {
  const server = neoServer('21.1.77');
  await u.updateServerVersion(server, '21.1.200', {
    deps: { api: fakeApi, download: fakeDownload([]), install: fakeInstaller('21.1.200', { rewriteScripts: false }) },
  });
  assert.match(fs.readFileSync(path.join(server.dir, 'run.bat'), 'utf-8'), /neoforge\/21\.1\.200\/win_args/);
  assert.match(fs.readFileSync(path.join(server.dir, 'run.sh'), 'utf-8'), /neoforge\/21\.1\.200\/unix_args/);
});

test('rechaza versiones que no existen para esa MC o con caracteres raros, y borra el instalador si falla', async () => {
  const server = neoServer('21.1.77');
  const deps = { api: fakeApi, download: fakeDownload([]), install: fakeInstaller('x') };
  await assert.rejects(u.updateServerVersion(server, '20.4.1', { deps }), /no existe para Minecraft 1\.21\.1/);
  await assert.rejects(u.updateServerVersion(server, '../../x', { deps }), /Versión no válida/);

  const failing = { ...deps, install: async () => { throw new Error('El instalador terminó con código 1.'); } };
  await assert.rejects(u.updateServerVersion(server, '21.1.200', { deps: failing }), /código 1/);
  assert.equal(fs.existsSync(path.join(server.dir, 'installer.jar')), false);
  assert.equal(u.detectInstalled(server).loaderVersion, '21.1.77', 'sigue como estaba');
});

test('Vanilla: solo a versiones más nuevas; cambia server.jar', async () => {
  const dir = tmpDir();
  writeFile(path.join(dir, 'server.jar'), 'viejo');
  const server = { loader: 'vanilla', mcVersion: '1.21.1', dir, launch: { type: 'jar', value: 'server.jar' } };
  const info = await u.getUpdateInfo(server, { api: fakeApi });
  assert.deepEqual(info.versions.map((v) => v.version), ['1.21.4', '1.21.3']);

  const urls = [];
  const deps = { api: fakeApi, download: fakeDownload(urls) };
  await assert.rejects(u.updateServerVersion(server, '1.20.1', { deps }), /más nueva/);
  const fields = await u.updateServerVersion(server, '1.21.4', { deps });
  assert.deepEqual(fields, { mcVersion: '1.21.4' });
  assert.deepEqual(urls, ['https://mojang.example/1.21.4/server.jar']);
  assert.equal(fs.readFileSync(path.join(dir, 'server.jar'), 'utf-8'), 'jar');
});
