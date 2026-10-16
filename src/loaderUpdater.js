/**
 * Actualizar la versión de un servidor desde la app:
 *
 *   - Forge / NeoForge: cambia la versión del loader DENTRO de la misma versión
 *     de Minecraft (p. ej. NeoForge 21.1.77 -> 21.1.200 para la 1.21.1). Es lo
 *     seguro: los mods siguen siendo compatibles. Se descarga el instalador
 *     oficial y se ejecuta con --installServer sobre la carpeta del servidor
 *     (instala las librerías nuevas y rehace run.bat/run.sh).
 *   - Vanilla: sube a una versión más nueva de Minecraft (cambia server.jar).
 *
 * Cambiar la versión de Minecraft de un servidor con mods no se ofrece: los mods
 * son de una versión concreta y el mundo se rompería.
 *
 * Quién llama (appCore) se encarga de que el servidor esté apagado y de hacer
 * antes un backup completo.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const mojang = require('./mojangApi');
const { downloadFile } = require('./downloader');

const VERSION_PATTERN = /^[0-9A-Za-z.+\-_]{1,64}$/;

/** Compara versiones tipo "21.1.77", "47.3.0", "1.21.1", "21.1.0-beta". */
function compareVersions(a, b) {
  const parse = (v) => {
    const [main, ...rest] = String(v).split(/-(.*)/s);
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre: rest.filter(Boolean).join('') };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d !== 0) return d;
  }
  if (x.pre && !y.pre) return -1; // 21.1.0-beta < 21.1.0
  if (!x.pre && y.pre) return 1;
  return x.pre.localeCompare(y.pre);
}

function isPrerelease(version) {
  return /alpha|beta|rc|pre|snapshot/i.test(String(version));
}

/** "21.1.77" -> "1.21.1"; "21.0.5" -> "1.21". */
function mcVersionFromNeoForge(version) {
  const [major, minor] = String(version).split('.');
  if (!major || minor === undefined) return null;
  return minor === '0' ? `1.${major}` : `1.${major}.${minor}`;
}

function readLaunchScripts(dir) {
  return ['run.bat', 'run.sh']
    .map((name) => path.join(dir, name))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf-8'))
    .join('\n');
}

function highestSubfolder(dir) {
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  return names.sort(compareVersions).pop() || null;
}

/**
 * Versión instalada de verdad en la carpeta (mirando run.bat/run.sh y
 * libraries/), que puede no coincidir con lo guardado en la app (servidores
 * importados o actualizados a mano). Devuelve { loaderVersion, mcVersion }.
 */
function detectInstalled(server) {
  const scripts = readLaunchScripts(server.dir);
  if (server.loader === 'neoforge') {
    const fromScript = scripts.match(/libraries[\\/]net[\\/]neoforged[\\/]neoforge[\\/]([^\\/\s]+)[\\/]/);
    const version =
      (fromScript && fromScript[1]) ||
      highestSubfolder(path.join(server.dir, 'libraries', 'net', 'neoforged', 'neoforge')) ||
      server.loaderVersion ||
      null;
    return { loaderVersion: version, mcVersion: (version && mcVersionFromNeoForge(version)) || server.mcVersion };
  }
  if (server.loader === 'forge') {
    const fromScript = scripts.match(/libraries[\\/]net[\\/]minecraftforge[\\/]forge[\\/]([^\\/\s]+)[\\/]/);
    const full =
      (fromScript && fromScript[1]) || highestSubfolder(path.join(server.dir, 'libraries', 'net', 'minecraftforge', 'forge'));
    if (full && full.includes('-')) {
      const [mc, ...rest] = full.split('-');
      return { loaderVersion: rest.join('-'), mcVersion: mc };
    }
    return { loaderVersion: server.loaderVersion || null, mcVersion: server.mcVersion };
  }
  return { loaderVersion: null, mcVersion: server.mcVersion };
}

/**
 * Qué versiones se pueden poner. Devuelve:
 * { loader, mcVersion, current, latest, recommended, upToDate, versions: [{ version, newer, prerelease, recommended }] }
 */
async function getUpdateInfo(server, { api = mojang } = {}) {
  const installed = detectInstalled(server);
  const mcVersion = installed.mcVersion;

  if (server.loader === 'vanilla') {
    const releases = await api.listVanillaVersions(); // más reciente primero
    const current = server.mcVersion;
    const index = releases.findIndex((v) => v.id === current);
    const newer = index === -1 ? [] : releases.slice(0, index);
    const versions = newer.slice(0, 30).map((v) => ({ version: v.id, newer: true, prerelease: false, recommended: false }));
    return {
      loader: 'vanilla',
      mcVersion: current,
      current,
      latest: releases[0] ? releases[0].id : null,
      recommended: null,
      upToDate: index === 0,
      unknownCurrent: index === -1,
      versions,
    };
  }

  if (!mcVersion || mcVersion === 'desconocida') {
    throw new Error('No sé qué versión de Minecraft tiene este servidor, así que no puedo buscar versiones compatibles.');
  }

  const list = server.loader === 'forge' ? await api.listForgeVersions(mcVersion) : await api.listNeoForgeVersions(mcVersion);
  const recommended = server.loader === 'forge' ? await api.getForgeRecommended(mcVersion).catch(() => null) : null;
  const sorted = [...new Set(list)].sort((a, b) => compareVersions(b, a));
  const current = installed.loaderVersion;
  const latest = sorted.find((v) => !isPrerelease(v)) || sorted[0] || null;

  const versions = sorted.slice(0, 40).map((version) => ({
    version,
    newer: current ? compareVersions(version, current) > 0 : true,
    prerelease: isPrerelease(version),
    recommended: version === recommended,
  }));
  if (current && !versions.some((v) => v.version === current) && sorted.includes(current)) {
    versions.push({ version: current, newer: false, prerelease: isPrerelease(current), recommended: current === recommended });
  }

  return {
    loader: server.loader,
    mcVersion,
    current,
    latest,
    recommended,
    upToDate: Boolean(current && latest && compareVersions(current, latest) >= 0),
    unknownCurrent: !current,
    versions,
    available: sorted,
  };
}

function runInstaller(dir, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn('java', ['-jar', 'installer.jar', '--installServer'], { cwd: dir, windowsHide: true });
    child.stdout.on('data', (d) => onOutput(d.toString()));
    child.stderr.on('data', (d) => onOutput(d.toString()));
    child.on('error', (err) => reject(new Error(`No se pudo ejecutar Java: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`El instalador terminó con código ${code}.`))));
  });
}

/**
 * Cambia la versión. Devuelve los campos a guardar en el servidor:
 *   Forge/NeoForge: { loaderVersion, mcVersion, launch }
 *   Vanilla:        { mcVersion }
 *
 * deps (para tests): { api, download(url, dest, onProgress), install(dir, onOutput) }
 */
async function updateServerVersion(server, targetVersion, { onLog = () => {}, onProgress = () => {}, deps = {} } = {}) {
  const api = deps.api || mojang;
  const download = deps.download || downloadFile;
  const install = deps.install || runInstaller;

  const target = String(targetVersion || '').trim();
  if (!VERSION_PATTERN.test(target)) throw new Error('Versión no válida.');

  const info = await getUpdateInfo(server, { api });

  if (server.loader === 'vanilla') {
    if (!info.versions.some((v) => v.version === target)) {
      throw new Error('Solo se puede subir a una versión de Minecraft más nueva que la actual.');
    }
    onLog(`Buscando la descarga oficial de Minecraft ${target}…\n`);
    const { url } = await api.getVanillaServerDownload(target);
    const jarName = (server.launch && server.launch.type === 'jar' && server.launch.value) || 'server.jar';
    const jarPath = path.join(server.dir, jarName);
    const tmp = `${jarPath}.descargando`;
    onLog(`Descargando server.jar de ${target}…\n`);
    await download(url, tmp, (p) => onProgress({ phase: 'download', ...p }));
    fs.renameSync(tmp, jarPath);
    onLog('Listo. La primera vez que arranque convertirá el mundo a la versión nueva.\n');
    return { mcVersion: target };
  }

  if (server.loader !== 'forge' && server.loader !== 'neoforge') {
    throw new Error('Este tipo de servidor no se puede actualizar desde la app.');
  }
  if (!(info.available || []).includes(target)) {
    throw new Error(`La versión ${target} no existe para Minecraft ${info.mcVersion}.`);
  }

  const url =
    server.loader === 'forge'
      ? api.getForgeInstallerUrl(info.mcVersion, target)
      : api.getNeoForgeInstallerUrl(target);
  const installerPath = path.join(server.dir, 'installer.jar');
  const label = server.loader === 'forge' ? 'Forge' : 'NeoForge';

  try {
    onLog(`Descargando el instalador oficial de ${label} ${target}…\n`);
    await download(url, installerPath, (p) => onProgress({ phase: 'download', ...p }));
    onLog(`Instalando ${label} ${target} (descarga librerías; puede tardar un par de minutos)…\n`);
    onProgress({ phase: 'install' });
    await install(server.dir, (text) => onLog(text));
  } finally {
    fs.rmSync(installerPath, { force: true });
    fs.rmSync(`${installerPath}.log`, { force: true });
  }

  const scriptName = os.platform() === 'win32' ? 'run.bat' : 'run.sh';
  let launch = server.launch;
  if (fs.existsSync(path.join(server.dir, scriptName))) {
    launch = { type: 'script', value: scriptName };
  }

  // Si el instalador no ha rehecho run.bat/run.sh, se apunta a mano a la versión
  // nueva (solo si sus librerías están de verdad instaladas).
  const after = detectInstalled({ ...server, loaderVersion: target });
  if (after.loaderVersion && after.loaderVersion !== target) {
    const group = server.loader === 'forge' ? ['net', 'minecraftforge', 'forge'] : ['net', 'neoforged', 'neoforge'];
    const oldFolder = server.loader === 'forge' ? `${info.mcVersion}-${after.loaderVersion}` : after.loaderVersion;
    const newFolder = server.loader === 'forge' ? `${info.mcVersion}-${target}` : target;
    if (!fs.existsSync(path.join(server.dir, 'libraries', ...group, newFolder))) {
      throw new Error(
        `El instalador terminó, pero no ha dejado instalada la versión ${target}. Revisa la consola; tienes el backup completo para volver atrás.`
      );
    }
    for (const name of ['run.bat', 'run.sh']) {
      const file = path.join(server.dir, name);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf-8');
      fs.writeFileSync(file, text.split(`/${group[2]}/${oldFolder}/`).join(`/${group[2]}/${newFolder}/`));
    }
    onLog(`run.bat/run.sh apuntaban todavía a ${after.loaderVersion}; actualizados a ${target}.\n`);
  }
  onLog(`${label} actualizado a ${target}.\n`);
  return { loaderVersion: target, mcVersion: info.mcVersion, launch };
}

module.exports = {
  compareVersions,
  isPrerelease,
  mcVersionFromNeoForge,
  detectInstalled,
  getUpdateInfo,
  updateServerVersion,
};
