/**
 * Pestaña "Configuración": archivos de configuración de los mods y reglas del
 * mundo (/gamerule).
 *
 * Dónde está la configuración de un servidor NeoForge/Forge:
 *   config/                     -> "common" y otras; vale para todos los mundos
 *   <mundo>/serverconfig/       -> "server"; es la que manda en ese mundo
 *   defaultconfigs/             -> plantilla que se copia a serverconfig al crear un mundo nuevo
 * Los "-client.toml" solo los usa el juego de cada jugador.
 *
 * Antes de guardar se copia el archivo a config-copias/<fecha>/ en la carpeta
 * del servidor (se guardan las últimas MAX_COPIES copias).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const toml = require('./tomlConfig');
const nbt = require('./nbt');
const { readJarMetadata } = require('./modAnalyzer');

const COPIES_DIR = 'config-copias';
const MAX_COPIES = 30;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.json', '.json5', '.cfg', '.properties', '.txt', '.yml', '.yaml', '.snbt', '.ini', '.conf']);
const SIDE_SUFFIX = /[-_.](common|server|client|general|config|startup)$/i;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function levelName(server) {
  return (server.properties && server.properties['level-name']) || 'world';
}

function roots(server) {
  return [
    { scope: 'serverconfig', rel: `${levelName(server)}/serverconfig` },
    { scope: 'config', rel: 'config' },
    { scope: 'defaultconfigs', rel: 'defaultconfigs' },
  ];
}

function hashOf(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Ruta relativa ("config/x.toml") -> ruta absoluta, comprobando que está en una
 * de las carpetas de configuración (nada de "../" ni de otros archivos del PC).
 */
function resolveConfigPath(server, rel) {
  const clean = String(rel || '').replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.split('/').some((p) => p === '..' || p === '')) {
    throw new Error('Ruta de configuración no válida.');
  }
  const root = roots(server).find((r) => clean.startsWith(`${r.rel}/`));
  if (!root) throw new Error('Ese archivo no es de configuración.');
  const ext = path.extname(clean).toLowerCase();
  if (ext !== '.toml' && !TEXT_EXTENSIONS.has(ext)) throw new Error('Ese tipo de archivo no se puede editar aquí.');
  const abs = path.resolve(server.dir, ...clean.split('/'));
  const rootAbs = path.resolve(server.dir, ...root.rel.split('/'));
  if (!abs.startsWith(rootAbs + path.sep)) throw new Error('Ruta de configuración no válida.');
  // Que un enlace simbólico no lleve fuera de la carpeta del servidor.
  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs);
    const realServer = fs.realpathSync(server.dir);
    if (!real.startsWith(realServer + path.sep)) throw new Error('Ruta de configuración no válida.');
  }
  return { abs, rel: clean, scope: root.scope, ext };
}

function walk(dir, depth, out, base) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) walk(full, depth - 1, out, base);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (ext === '.toml' || TEXT_EXTENSIONS.has(ext)) out.push(path.relative(base, full));
    }
  }
}

/** Nombre de los mods instalados por modId (leído de los .jar, con caché por fecha). */
const nameCache = new Map(); // ruta del jar -> { mtime, meta }
function installedMods(server) {
  const dir = path.join(server.dir, 'mods');
  const byId = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar'));
  } catch (err) {
    return byId;
  }
  for (const f of files) {
    const full = path.join(dir, f);
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch (err) {
      continue;
    }
    let cached = nameCache.get(full);
    if (!cached || cached.mtime !== mtime) {
      cached = { mtime, meta: readJarMetadata(full) };
      nameCache.set(full, cached);
    }
    if (cached.meta && cached.meta.modId) byId.set(cached.meta.modId, cached.meta.name || cached.meta.modId);
  }
  return byId;
}

function normalizeId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** De qué mod es un archivo: "config/create-server.toml" -> "create"; "config/cobblemon/main.json" -> "cobblemon". */
function groupKeyFor(relInsideRoot) {
  const parts = relInsideRoot.split('/');
  if (parts.length > 1) return parts[0].toLowerCase();
  const stem = parts[0].replace(/\.[^.]+$/, '');
  return stem.replace(SIDE_SUFFIX, '').replace(SIDE_SUFFIX, '').toLowerCase();
}

function sideOf(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '').toLowerCase();
  if (/[-_.]client$/.test(stem)) return 'client';
  if (/[-_.]server$/.test(stem)) return 'server';
  if (/[-_.]common$/.test(stem)) return 'common';
  return null;
}

/**
 * Lista los archivos de configuración agrupados por mod.
 * Devuelve { groups: [{ id, name, installed, files: [...] }], worldExists }.
 */
function listConfigs(server) {
  const mods = installedMods(server);
  const modsByNorm = new Map([...mods].map(([id, name]) => [normalizeId(id), { id, name }]));
  const groups = new Map();
  for (const root of roots(server)) {
    const rootAbs = path.join(server.dir, ...root.rel.split('/'));
    const found = [];
    walk(rootAbs, 3, found, rootAbs);
    for (const relInside of found) {
      const insidePosix = toPosix(relInside);
      const rel = `${root.rel}/${insidePosix}`;
      const key = groupKeyFor(insidePosix);
      const match = modsByNorm.get(normalizeId(key));
      const id = match ? match.id : key;
      if (!groups.has(id)) groups.set(id, { id, name: match ? match.name : key, installed: Boolean(match), files: [] });
      let size = 0;
      try {
        size = fs.statSync(path.join(rootAbs, relInside)).size;
      } catch (err) { /* nada */ }
      const ext = path.extname(rel).toLowerCase();
      groups.get(id).files.push({
        rel,
        name: path.basename(rel),
        scope: root.scope,
        side: sideOf(path.basename(rel)),
        kind: ext === '.toml' ? 'toml' : 'text',
        size,
      });
    }
  }
  // Qué archivo "manda": si un archivo de serverconfig tiene el mismo nombre que
  // uno de defaultconfigs o config, el de serverconfig es el que se usa en este mundo.
  for (const g of groups.values()) {
    const inWorld = new Set(g.files.filter((f) => f.scope === 'serverconfig').map((f) => f.name));
    for (const f of g.files) {
      if (f.scope === 'serverconfig') f.note = 'Es la que usa este mundo';
      else if (f.scope === 'defaultconfigs') f.note = inWorld.has(f.name) ? 'Solo para mundos nuevos (este mundo usa la de serverconfig)' : 'Solo se usa al crear un mundo nuevo';
      else if (f.side === 'client') f.note = 'Solo afecta al juego de cada jugador, no al servidor';
      const order = { serverconfig: 0, config: 1, defaultconfigs: 2 };
      f.order = order[f.scope] * 10 + (f.side === 'client' ? 5 : 0);
    }
    g.files.sort((a, b) => a.order - b.order || a.rel.localeCompare(b.rel));
    for (const f of g.files) delete f.order;
    g.serverRelevant = g.files.some((f) => f.side !== 'client');
  }
  const list = [...groups.values()].sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  return { groups: list, worldExists: fs.existsSync(path.join(server.dir, levelName(server), 'level.dat')) };
}

function readConfig(server, rel) {
  const { abs, rel: clean, scope, ext } = resolveConfigPath(server, rel);
  if (!fs.existsSync(abs)) throw new Error('El archivo ya no existe.');
  const stat = fs.statSync(abs);
  if (stat.size > MAX_FILE_BYTES) throw new Error('El archivo es demasiado grande para editarlo aquí.');
  const buf = fs.readFileSync(abs);
  const text = buf.toString('utf-8');
  const base = { rel: clean, scope, hash: hashOf(buf), name: path.basename(clean) };
  if (ext === '.toml') {
    try {
      return { ...base, kind: 'toml', ...toml.describe(text), content: text };
    } catch (err) {
      return { ...base, kind: 'text', content: text, warning: `No se ha podido leer como formulario (${err.message}); se edita como texto.` };
    }
  }
  return { ...base, kind: 'text', content: text };
}

/** Copia los archivos antes de tocarlos. Devuelve la carpeta de la copia (relativa). */
function backupFiles(server, absFiles) {
  const stamp = timestamp();
  const dir = path.join(server.dir, COPIES_DIR, stamp);
  for (const abs of absFiles) {
    if (!fs.existsSync(abs)) continue;
    const rel = path.relative(server.dir, abs);
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
  pruneCopies(server);
  return toPosix(path.join(COPIES_DIR, stamp));
}

function pruneCopies(server) {
  const base = path.join(server.dir, COPIES_DIR);
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (err) {
    return;
  }
  for (const old of dirs.slice(0, Math.max(0, dirs.length - MAX_COPIES))) {
    fs.rmSync(path.join(base, old), { recursive: true, force: true });
  }
}

function writeAtomic(abs, text) {
  const tmp = `${abs}.msm-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, abs);
}

/**
 * Guarda un archivo. Con "changes" ({ id: valor }) solo cambia esos valores del
 * .toml; con "content" reemplaza el texto entero (archivos que no son .toml, o
 * edición como texto). "hash" es el que dio readConfig: si el archivo ha
 * cambiado desde entonces, no se guarda.
 */
function saveConfig(server, { rel, hash, changes, content }) {
  const { abs, ext } = resolveConfigPath(server, rel);
  if (!fs.existsSync(abs)) throw new Error('El archivo ya no existe.');
  const buf = fs.readFileSync(abs);
  if (hash && hashOf(buf) !== hash) {
    throw new Error('El archivo ha cambiado desde que lo abriste (quizá lo ha reescrito el servidor). Vuelve a cargarlo.');
  }
  const text = buf.toString('utf-8');
  let next;
  if (changes && Object.keys(changes).length) {
    if (ext !== '.toml') throw new Error('Este archivo solo se puede editar como texto.');
    next = toml.applyChanges(text, changes);
  } else if (typeof content === 'string') {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('El texto es demasiado grande.');
    if (ext === '.toml') {
      try {
        toml.parse(content, { strict: true });
      } catch (err) {
        throw new Error(`El texto no es un TOML válido: ${err.message}`);
      }
    }
    if (ext === '.json') {
      try {
        JSON.parse(content);
      } catch (err) {
        throw new Error(`El texto no es un JSON válido: ${err.message}`);
      }
    }
    next = content;
  } else {
    throw new Error('No hay cambios que guardar.');
  }
  if (next === text) return { changed: false, hash: hashOf(buf) };
  const backupDir = backupFiles(server, [abs]);
  writeAtomic(abs, next);
  return { changed: true, backupDir, hash: hashOf(Buffer.from(next)) };
}

// ---------------------------------------------------------------------------
// Reglas del mundo (/gamerule)
// ---------------------------------------------------------------------------

/** Reglas conocidas (Minecraft 1.21) con explicación en español. */
const GAMERULES = [
  { key: 'playersSleepingPercentage', group: 'Dormir y noche', label: 'Porcentaje de jugadores que tienen que dormir', help: 'Para pasar la noche. 0 = basta con uno; 100 = todos.', type: 'int', default: 100, min: 0, max: 100, unit: '%' },
  { key: 'doInsomnia', group: 'Dormir y noche', label: 'Phantoms si no duermes', help: 'Aparecen phantoms a quien lleva varias noches sin dormir.', type: 'bool', default: true },
  { key: 'doDaylightCycle', group: 'Dormir y noche', label: 'Pasa el tiempo (día y noche)', help: 'Si lo apagas, se queda siempre la misma hora.', type: 'bool', default: true },
  { key: 'doWeatherCycle', group: 'Dormir y noche', label: 'Cambia el tiempo (lluvia, tormentas)', help: 'Si lo apagas, el tiempo se queda como está.', type: 'bool', default: true },
  { key: 'keepInventory', group: 'Jugadores', label: 'Conservar el inventario al morir', help: 'Al morir no se pierden los objetos ni la experiencia.', type: 'bool', default: false },
  { key: 'naturalRegeneration', group: 'Jugadores', label: 'Regenerar vida con la comida', help: 'Si lo apagas, solo se cura con pociones o manzanas de oro.', type: 'bool', default: true },
  { key: 'doImmediateRespawn', group: 'Jugadores', label: 'Reaparecer sin pantalla de muerte', help: 'Al morir se reaparece al momento.', type: 'bool', default: false },
  { key: 'showDeathMessages', group: 'Jugadores', label: 'Mensajes de muerte en el chat', help: '', type: 'bool', default: true },
  { key: 'announceAdvancements', group: 'Jugadores', label: 'Anunciar los logros en el chat', help: '', type: 'bool', default: true },
  { key: 'fallDamage', group: 'Jugadores', label: 'Daño por caída', help: '', type: 'bool', default: true },
  { key: 'fireDamage', group: 'Jugadores', label: 'Daño por fuego', help: '', type: 'bool', default: true },
  { key: 'drowningDamage', group: 'Jugadores', label: 'Daño por ahogarse', help: '', type: 'bool', default: true },
  { key: 'freezeDamage', group: 'Jugadores', label: 'Daño por congelación', help: 'En la nieve polvo.', type: 'bool', default: true },
  { key: 'spawnRadius', group: 'Jugadores', label: 'Radio de aparición', help: 'A cuántos bloques del punto de aparición puede salir un jugador nuevo.', type: 'int', default: 10, min: 0, max: 64, unit: ' bloques' },
  { key: 'mobGriefing', group: 'Mundo y mobs', label: 'Los mobs rompen o cambian bloques', help: 'Creepers, Endermen… Si lo apagas, los aldeanos tampoco recogen cosechas.', type: 'bool', default: true },
  { key: 'doFireTick', group: 'Mundo y mobs', label: 'El fuego se propaga', help: 'Si lo apagas, el fuego no se extiende ni quema bloques.', type: 'bool', default: true },
  { key: 'doMobSpawning', group: 'Mundo y mobs', label: 'Aparecen mobs', help: 'Si lo apagas no aparecen mobs de forma natural.', type: 'bool', default: true },
  { key: 'doPatrolSpawning', group: 'Mundo y mobs', label: 'Patrullas de saqueadores', help: '', type: 'bool', default: true },
  { key: 'disableRaids', group: 'Mundo y mobs', label: 'Desactivar asaltos a aldeas', help: '', type: 'bool', default: false },
  { key: 'doTraderSpawning', group: 'Mundo y mobs', label: 'Aparece el vendedor ambulante', help: '', type: 'bool', default: true },
  { key: 'doWardenSpawning', group: 'Mundo y mobs', label: 'Puede aparecer el Warden', help: '', type: 'bool', default: true },
  { key: 'doMobLoot', group: 'Mundo y mobs', label: 'Los mobs sueltan objetos', help: '', type: 'bool', default: true },
  { key: 'doTileDrops', group: 'Mundo y mobs', label: 'Los bloques rotos sueltan objeto', help: '', type: 'bool', default: true },
  { key: 'randomTickSpeed', group: 'Mundo y mobs', label: 'Velocidad de crecimiento', help: 'Cuánto crecen plantas y cultivos. 3 es lo normal; valores altos gastan más servidor.', type: 'int', default: 3, min: 0, max: 100, unit: '' },
  { key: 'maxEntityCramming', group: 'Mundo y mobs', label: 'Máximo de mobs apretujados', help: 'A partir de cuántos mobs en el mismo bloque empiezan a hacerse daño.', type: 'int', default: 24, min: 0, max: 200, unit: '' },
  { key: 'sendCommandFeedback', group: 'Comandos', label: 'Mostrar el resultado de los comandos', help: '', type: 'bool', default: true },
  { key: 'commandBlockOutput', group: 'Comandos', label: 'Avisos de los bloques de comandos', help: '', type: 'bool', default: true },
  { key: 'logAdminCommands', group: 'Comandos', label: 'Avisar a los OP de los comandos', help: '', type: 'bool', default: true },
];
const GAMERULE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

function levelDatPath(server) {
  return path.join(server.dir, levelName(server), 'level.dat');
}

/** Lee las reglas guardadas en level.dat (como texto, que es como las guarda el juego). */
function readGameRulesFromLevel(server) {
  const file = levelDatPath(server);
  if (!fs.existsSync(file)) return null;
  const doc = nbt.readFile(fs, file);
  const data = doc.root.value.get('Data');
  const rules = data && data.value.get('GameRules');
  const out = {};
  if (rules && rules.type === nbt.T.COMPOUND) {
    for (const [k, tag] of rules.value) if (tag.type === nbt.T.STRING) out[k] = tag.value;
  }
  return out;
}

function parseRuleValue(raw) {
  if (raw === 'true' || raw === 'false') return { type: 'bool', value: raw === 'true' };
  if (/^-?\d+$/.test(String(raw))) return { type: 'int', value: Number(raw) };
  return { type: 'text', value: raw };
}

/**
 * Reglas para enseñar: las conocidas (con explicación) y las que haya en el
 * mundo (incluidas las de mods), con su valor actual. "overrides" son valores
 * cambiados con el servidor encendido que todavía no se han guardado en level.dat.
 */
function listGameRules(server, overrides = {}) {
  const saved = readGameRulesFromLevel(server);
  const current = { ...(saved || {}), ...overrides };
  const known = new Set(GAMERULES.map((r) => r.key));
  const rules = GAMERULES.map((r) => {
    const raw = current[r.key];
    const parsed = raw === undefined ? null : parseRuleValue(raw);
    return { ...r, value: parsed ? parsed.value : r.default, inWorld: raw !== undefined };
  });
  const others = Object.keys(current)
    .filter((k) => !known.has(k))
    .sort((a, b) => a.localeCompare(b))
    .map((k) => {
      const p = parseRuleValue(current[k]);
      return { key: k, group: 'Otras (del juego o de mods)', label: k, help: '', type: p.type, value: p.value, default: null, inWorld: true };
    })
    .filter((r) => r.type !== 'text');
  return { rules: [...rules, ...others], worldExists: saved !== null };
}

/** Comprueba los cambios { regla: valor } y los devuelve como texto ("true", "50"). */
function validateGameRuleChanges(server, changes, overrides = {}) {
  const list = listGameRules(server, overrides).rules;
  const byKey = new Map(list.map((r) => [r.key, r]));
  const out = {};
  for (const [key, value] of Object.entries(changes || {})) {
    if (!GAMERULE_KEY.test(key)) throw new Error(`Regla no válida: ${key}`);
    const rule = byKey.get(key);
    if (!rule) throw new Error(`La regla "${key}" no existe en este mundo.`);
    if (rule.type === 'bool') {
      if (typeof value !== 'boolean') throw new Error(`"${rule.label}" tiene que ser sí o no.`);
      out[key] = value ? 'true' : 'false';
    } else {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new Error(`"${rule.label}" tiene que ser un número entero.`);
      if (rule.min !== undefined && n < rule.min) throw new Error(`"${rule.label}" no puede ser menor que ${rule.min}.`);
      if (rule.max !== undefined && n > rule.max) throw new Error(`"${rule.label}" no puede ser mayor que ${rule.max}.`);
      out[key] = String(n);
    }
  }
  return out;
}

/** Con el servidor apagado: escribe las reglas en level.dat (con copia antes). */
function writeGameRulesToLevel(server, values) {
  const file = levelDatPath(server);
  if (!fs.existsSync(file)) throw new Error('El mundo todavía no existe: arranca el servidor una vez para que se cree.');
  const doc = nbt.readFile(fs, file);
  const data = doc.root.value.get('Data');
  if (!data || data.type !== nbt.T.COMPOUND) throw new Error('level.dat no tiene el formato esperado.');
  let rules = data.value.get('GameRules');
  if (!rules) {
    rules = { type: nbt.T.COMPOUND, value: new Map() };
    data.value.set('GameRules', rules);
  }
  for (const [k, v] of Object.entries(values)) rules.value.set(k, { type: nbt.T.STRING, value: v });
  const backupDir = backupFiles(server, [file]);
  nbt.writeFile(fs, file, doc);
  return { backupDir };
}

module.exports = {
  listConfigs,
  readConfig,
  saveConfig,
  resolveConfigPath,
  listGameRules,
  validateGameRuleChanges,
  writeGameRulesToLevel,
  GAMERULES,
  COPIES_DIR,
};
