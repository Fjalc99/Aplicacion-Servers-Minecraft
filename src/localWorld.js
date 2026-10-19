/**
 * Llevar el mundo del servidor a una partida de UN JUGADOR (para abrirla, por
 * ejemplo, con e4mc) y traerla de vuelta.
 *
 * La diferencia importante: en un servidor cada jugador se guarda en
 * world/playerdata/<uuid>.dat, pero en una partida local el ANFITRIÓN se guarda
 * dentro de level.dat (Data.Player). Si solo se copiara la carpeta, aparecerías
 * en el spawn sin tu inventario. Aquí se mueve ese dato al sitio correcto en
 * cada dirección.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const nbt = require('./nbt');

const EXPORT_META = 'msm-exportado.json';
const DIFFICULTY = { peaceful: 0, easy: 1, normal: 2, hard: 3 };

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function levelName(server) {
  return (server.properties && server.properties['level-name']) || 'world';
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Dónde están las instancias de Minecraft de este PC
// ---------------------------------------------------------------------------

/** Carpetas típicas de los launchers. roots solo existe para los tests. */
function launcherRoots(roots) {
  if (roots) return roots;
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    { launcher: 'CurseForge', dir: path.join(home, 'curseforge', 'minecraft', 'Instances'), sub: '' },
    { launcher: 'Modrinth', dir: path.join(appData, 'ModrinthApp', 'profiles'), sub: '' },
    { launcher: 'Modrinth', dir: path.join(appData, 'com.modrinth.theseus', 'profiles'), sub: '' },
    { launcher: 'Prism', dir: path.join(appData, 'PrismLauncher', 'instances'), sub: 'minecraft' },
    { launcher: 'Prism', dir: path.join(home, '.local', 'share', 'PrismLauncher', 'instances'), sub: 'minecraft' },
    { launcher: 'Minecraft', single: path.join(appData, '.minecraft') },
    { launcher: 'Minecraft', single: path.join(home, '.minecraft') },
  ];
}

/** Instancias encontradas: [{ path, label, launcher, mods }] */
function detectInstances(roots) {
  const found = [];
  const seen = new Set();
  const add = (launcher, dir, name) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved) || !fs.existsSync(resolved)) return;
    const modsDir = path.join(resolved, 'mods');
    const mods = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar')).length : 0;
    if (!fs.existsSync(path.join(resolved, 'saves')) && mods === 0) return;
    seen.add(resolved);
    found.push({ path: resolved, label: `${name} (${launcher})`, launcher, mods });
  };
  for (const root of launcherRoots(roots)) {
    try {
      if (root.single) {
        add(root.launcher, root.single, '.minecraft');
        continue;
      }
      if (!fs.existsSync(root.dir)) continue;
      for (const entry of fs.readdirSync(root.dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = root.sub ? path.join(root.dir, entry.name, root.sub) : path.join(root.dir, entry.name);
        const alt = root.sub ? path.join(root.dir, entry.name, `.${root.sub}`) : null;
        add(root.launcher, fs.existsSync(dir) || !alt ? dir : alt, entry.name);
      }
    } catch (err) {
      /* carpeta sin permisos: se ignora */
    }
  }
  return found.sort((a, b) => b.mods - a.mods || a.label.localeCompare(b.label));
}

/** Comprueba que una carpeta parece una instancia (tiene mods/ o saves/). */
function checkInstance(instanceDir) {
  const dir = path.resolve(String(instanceDir || ''));
  if (!instanceDir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('No se encuentra la carpeta de tu Minecraft.');
  }
  if (!fs.existsSync(path.join(dir, 'saves')) && !fs.existsSync(path.join(dir, 'mods'))) {
    throw new Error('Esa carpeta no parece de Minecraft: elige la de la instancia (la que tiene dentro "mods" y "saves").');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Jugadores del servidor
// ---------------------------------------------------------------------------

/** Jugadores que tienen datos guardados en el mundo: [{ uuid, name, op }] */
function listPlayers(server) {
  const playerDir = path.join(server.dir, levelName(server), 'playerdata');
  if (!fs.existsSync(playerDir)) return [];
  const cache = readJson(path.join(server.dir, 'usercache.json'), []);
  const ops = readJson(path.join(server.dir, 'ops.json'), []);
  const nameOf = new Map(cache.map((e) => [String(e.uuid).toLowerCase(), e.name]));
  const opSet = new Set(ops.map((e) => String(e.uuid).toLowerCase()));
  return fs
    .readdirSync(playerDir)
    .filter((f) => /^[0-9a-f-]{36}\.dat$/i.test(f))
    .map((f) => {
      const uuid = f.slice(0, 36).toLowerCase();
      return { uuid, name: nameOf.get(uuid) || uuid, op: opSet.has(uuid), mtime: fs.statSync(path.join(playerDir, f)).mtimeMs };
    })
    .sort((a, b) => b.op - a.op || b.mtime - a.mtime);
}

function checkUuid(uuid) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(uuid || ''))) {
    throw new Error('Elige qué jugador eres tú.');
  }
  return String(uuid).toLowerCase();
}

// ---------------------------------------------------------------------------
// Copias
// ---------------------------------------------------------------------------

function copyDir(from, to, { skip = () => false } = {}) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest, { skip });
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

const skipLock = (name) => name.toLowerCase() === 'session.lock';

function safeFolderName(name) {
  const clean = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim();
  return clean.slice(0, 60) || 'Servidor';
}

function uniqueFolder(parent, base) {
  let name = base;
  for (let i = 2; fs.existsSync(path.join(parent, name)); i++) name = `${base} (${i})`;
  return name;
}

/** ¿Está Minecraft usando este mundo ahora mismo? */
function worldInUse(worldDir) {
  const lock = path.join(worldDir, 'session.lock');
  if (!fs.existsSync(lock)) return false;
  try {
    const fd = fs.openSync(lock, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (err) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes(err.code);
  }
}

/**
 * Copia la configuración de mods del servidor a la instancia. No toca los
 * archivos de cliente (*client*) y guarda los que sustituye en config-antes-<fecha>.
 */
function copyServerConfig(serverConfigDir, instanceDir) {
  const result = { copied: 0, replaced: 0, backupDir: null };
  if (!fs.existsSync(serverConfigDir)) return result;
  const destRoot = path.join(instanceDir, 'config');
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      if (/client/i.test(entry.name)) continue;
      const src = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(src, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const dest = path.join(destRoot, relPath);
      if (fs.existsSync(dest)) {
        if (fs.readFileSync(dest).equals(fs.readFileSync(src))) continue;
        if (!result.backupDir) result.backupDir = path.join(instanceDir, `config-antes-${timestamp()}`);
        const backup = path.join(result.backupDir, relPath);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(dest, backup);
        result.replaced++;
      } else {
        result.copied++;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  };
  walk(serverConfigDir, '');
  return result;
}

// ---------------------------------------------------------------------------
// Exportar: servidor -> partida local
// ---------------------------------------------------------------------------

/**
 * opts: { instanceDir, uuid, saveName, copyConfig }
 * Devuelve { saveFolder, savePath, playerApplied, config }
 */
function exportToLocal(server, { instanceDir, uuid, saveName, copyConfig = true } = {}) {
  const instance = checkInstance(instanceDir);
  const hostUuid = checkUuid(uuid);
  const worldDir = path.join(server.dir, levelName(server));
  if (!fs.existsSync(path.join(worldDir, 'level.dat'))) {
    throw new Error('Este servidor todavía no tiene mundo (falta level.dat). Arráncalo una vez antes.');
  }

  const savesDir = path.join(instance, 'saves');
  fs.mkdirSync(savesDir, { recursive: true });
  const displayName = String(saveName || '').trim() || `${server.name} (del servidor)`;
  const folder = uniqueFolder(savesDir, safeFolderName(displayName));
  const savePath = path.join(savesDir, folder);

  copyDir(worldDir, savePath, { skip: skipLock });

  try {
    const levelFile = path.join(savePath, 'level.dat');
    const doc = nbt.readFile(fs, levelFile);
    const data = doc.root.value.get('Data');
    if (!data || data.type !== nbt.T.COMPOUND) throw new Error('level.dat no tiene el formato esperado.');

    // Tu jugador: de playerdata/<uuid>.dat a level.dat (donde lo lee el modo un jugador)
    let playerApplied = false;
    const playerFile = path.join(savePath, 'playerdata', `${hostUuid}.dat`);
    if (fs.existsSync(playerFile)) {
      const player = nbt.readFile(fs, playerFile);
      data.value.set('Player', { type: nbt.T.COMPOUND, value: player.root.value });
      playerApplied = true;
    } else {
      data.value.delete('Player');
    }

    data.value.set('LevelName', { type: nbt.T.STRING, value: displayName });
    const difficulty = DIFFICULTY[String((server.properties || {}).difficulty || '').toLowerCase()];
    if (difficulty !== undefined) data.value.set('Difficulty', { type: nbt.T.BYTE, value: difficulty });
    // Si eres OP en el servidor, en local tendrás los trucos activados (comandos).
    const ops = readJson(path.join(server.dir, 'ops.json'), []);
    if (ops.some((e) => String(e.uuid).toLowerCase() === hostUuid)) {
      data.value.set('allowCommands', { type: nbt.T.BYTE, value: 1 });
    }
    nbt.writeFile(fs, levelFile, doc);

    fs.writeFileSync(
      path.join(savePath, EXPORT_META),
      JSON.stringify(
        {
          serverId: server.id,
          serverName: server.name,
          uuid: hostUuid,
          exportedAt: Date.now(),
          serverLevelDatMtime: fs.statSync(path.join(worldDir, 'level.dat')).mtimeMs,
        },
        null,
        2
      )
    );

    const config = copyConfig ? copyServerConfig(path.join(server.dir, 'config'), instance) : null;
    return { saveFolder: folder, savePath, playerApplied, config };
  } catch (err) {
    fs.rmSync(savePath, { recursive: true, force: true }); // no dejar una partida a medias
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Importar: partida local -> servidor
// ---------------------------------------------------------------------------

/** Partidas de una instancia: [{ folder, name, mtime, exported: {serverId, serverName, exportedAt} | null }] */
function listSaves(instanceDir) {
  const instance = checkInstance(instanceDir);
  const savesDir = path.join(instance, 'saves');
  if (!fs.existsSync(savesDir)) return [];
  return fs
    .readdirSync(savesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(savesDir, e.name, 'level.dat')))
    .map((e) => {
      const dir = path.join(savesDir, e.name);
      const meta = readJson(path.join(dir, EXPORT_META), null);
      let name = e.name;
      try {
        const data = nbt.readFile(fs, path.join(dir, 'level.dat')).root.value.get('Data');
        name = data.value.get('LevelName').value || e.name;
      } catch (err) {
        /* level.dat ilegible: se muestra el nombre de la carpeta */
      }
      return { folder: e.name, name, mtime: fs.statSync(path.join(dir, 'level.dat')).mtimeMs, exported: meta };
    })
    .sort((a, b) => Boolean(b.exported) - Boolean(a.exported) || b.mtime - a.mtime);
}

/**
 * opts: { instanceDir, saveFolder, uuid, force }
 * Si el mundo del servidor ha cambiado desde que se exportó, devuelve
 * { needsConfirm: true, reason } salvo que force sea true.
 * Si no, devuelve { previousWorldSavedAs, playerRestored }.
 */
function importFromLocal(server, { instanceDir, saveFolder, uuid, force = false } = {}) {
  const instance = checkInstance(instanceDir);
  const folder = String(saveFolder || '');
  if (!folder || folder !== path.basename(folder) || folder.startsWith('.')) throw new Error('Partida no válida.');
  const savePath = path.join(instance, 'saves', folder);
  if (!fs.existsSync(path.join(savePath, 'level.dat'))) throw new Error('No se encuentra esa partida.');
  if (worldInUse(savePath)) throw new Error('Esa partida está abierta en Minecraft: ciérralo antes de traerla.');

  const meta = readJson(path.join(savePath, EXPORT_META), null);
  const hostUuid = checkUuid(uuid || (meta && meta.uuid));
  const level = levelName(server);
  const worldDir = path.join(server.dir, level);

  if (!force && meta && meta.serverId === server.id && fs.existsSync(path.join(worldDir, 'level.dat'))) {
    const serverMtime = fs.statSync(path.join(worldDir, 'level.dat')).mtimeMs;
    if (serverMtime > meta.serverLevelDatMtime + 1000) {
      return {
        needsConfirm: true,
        reason: 'El mundo del servidor ha cambiado desde que exportaste esta partida (alguien ha jugado en el servidor). Si la traes, se perderá lo que se hizo en el servidor desde entonces (se guarda una copia aparte).',
      };
    }
  }
  if (!force && meta && meta.serverId && meta.serverId !== server.id) {
    return {
      needsConfirm: true,
      reason: `Esta partida se exportó de otro servidor ("${meta.serverName}"). ¿Seguro que quieres ponerla en este?`,
    };
  }

  // 1) Copia de la partida junto al servidor, y ahí se arregla el jugador
  const staging = path.join(server.dir, `${level}.importando-${timestamp()}`);
  copyDir(savePath, staging, { skip: (name) => skipLock(name) || name === EXPORT_META });
  let playerRestored = false;
  try {
    const levelFile = path.join(staging, 'level.dat');
    const doc = nbt.readFile(fs, levelFile);
    const data = doc.root.value.get('Data');
    if (!data || data.type !== nbt.T.COMPOUND) throw new Error('level.dat no tiene el formato esperado.');
    const player = data.value.get('Player');
    if (player && player.type === nbt.T.COMPOUND) {
      const playerDir = path.join(staging, 'playerdata');
      fs.mkdirSync(playerDir, { recursive: true });
      nbt.writeFile(fs, path.join(playerDir, `${hostUuid}.dat`), { name: '', root: player });
      data.value.delete('Player');
      nbt.writeFile(fs, levelFile, doc);
      playerRestored = true;
    }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  // 2) El mundo actual del servidor se aparta (no se borra) y entra el nuevo
  let previousWorldSavedAs = null;
  if (fs.existsSync(worldDir)) {
    previousWorldSavedAs = `${level}.antes-de-restaurar-${timestamp()}`;
    fs.renameSync(worldDir, path.join(server.dir, previousWorldSavedAs));
  }
  fs.renameSync(staging, worldDir);
  return { previousWorldSavedAs, playerRestored };
}

module.exports = { detectInstances, listPlayers, listSaves, exportToLocal, importFromLocal, copyServerConfig, EXPORT_META };
