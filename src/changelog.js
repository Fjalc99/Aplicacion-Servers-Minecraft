/**
 * Historial de cambios de cada servidor ("notas de versión" automáticas).
 *
 * La app apunta sola lo que cambia: mods añadidos, quitados, actualizados,
 * activados o desactivados; versión de NeoForge/Forge/Minecraft; opciones de
 * configuración; reglas del mundo; backups restaurados. También notas escritas
 * a mano.
 *
 * Los mods no se apuntan uno a uno desde cada botón: se guarda una "foto" de la
 * carpeta mods y, después de cada operación (o al abrir el historial o arrancar
 * el servidor), se compara con la foto anterior. Así también se detectan los
 * cambios hechos a mano en la carpeta, fuera de la app.
 *
 * Se guarda en <datos de la app>/cambios/<id>.json (fuera de la carpeta del
 * servidor, para que restaurar un backup no borre el historial).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const paths = require('./paths');
const { readJarMetadata } = require('./modAnalyzer');

const MERGE_WINDOW_MS = 30 * 60 * 1000; // cambios seguidos en 30 min van a la misma entrada
const MAX_ENTRIES = 300;
const MAX_NOTE = 1000;

function storeFile(serverId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(serverId))) throw new Error('Servidor no válido.');
  return path.join(paths.userDataDir(), 'cambios', `${serverId}.json`);
}

function load(serverId) {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(serverId), 'utf-8'));
    return { snapshot: data.snapshot || null, entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch (err) {
    return { snapshot: null, entries: [] };
  }
}

function save(serverId, data) {
  const file = storeFile(serverId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Foto de la carpeta mods
// ---------------------------------------------------------------------------

const metaCache = new Map(); // ruta -> { stamp, meta }

function jarMeta(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return null;
  }
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  const cached = metaCache.get(file);
  if (cached && cached.stamp === stamp) return cached.meta;
  const meta = readJarMetadata(file);
  metaCache.set(file, { stamp, meta });
  return meta;
}

/** { clave: { file, name, version, enabled } } de los mods del servidor. */
function snapshotMods(server) {
  const dir = path.join(server.dir, 'mods');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.jar(\.disabled)?$/i.test(f));
  } catch (err) {
    return {};
  }
  const out = {};
  for (const file of files.sort()) {
    const enabled = !/\.disabled$/i.test(file);
    const meta = jarMeta(path.join(dir, file)) || {};
    const stem = file.replace(/\.disabled$/i, '').replace(/\.jar$/i, '');
    let key = meta.modId || `archivo:${stem.toLowerCase()}`;
    if (out[key]) key = `${key}|${file}`; // el mismo mod dos veces (duplicado)
    out[key] = { file, name: meta.name || meta.modId || stem, version: meta.version || null, enabled };
  }
  return out;
}

function diffSnapshots(before, after) {
  const items = [];
  for (const [key, cur] of Object.entries(after)) {
    const prev = before[key];
    if (!prev) {
      items.push({ type: 'modAdded', name: cur.name, version: cur.version, enabled: cur.enabled });
      continue;
    }
    const versionChanged = cur.version && prev.version ? cur.version !== prev.version : cur.file.replace(/\.disabled$/i, '') !== prev.file.replace(/\.disabled$/i, '');
    if (versionChanged) items.push({ type: 'modUpdated', name: cur.name, from: prev.version || prev.file, to: cur.version || cur.file });
    if (cur.enabled !== prev.enabled) items.push({ type: cur.enabled ? 'modEnabled' : 'modDisabled', name: cur.name });
  }
  for (const [key, prev] of Object.entries(before)) {
    if (!after[key]) items.push({ type: 'modRemoved', name: prev.name, version: prev.version });
  }
  const order = ['modAdded', 'modUpdated', 'modRemoved', 'modEnabled', 'modDisabled'];
  items.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  return items;
}

// ---------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------

function addItems(data, items, { source = 'app', by = null, now = Date.now() } = {}) {
  if (!items.length) return null;
  const last = data.entries[data.entries.length - 1];
  if (last && last.source === source && now - last.endAt < MERGE_WINDOW_MS && (last.by || null) === (by || null)) {
    last.items.push(...items);
    last.endAt = now;
    return last;
  }
  const entry = { id: crypto.randomBytes(6).toString('hex'), at: now, endAt: now, source, by: by || null, items: [...items] };
  data.entries.push(entry);
  if (data.entries.length > MAX_ENTRIES) data.entries.splice(0, data.entries.length - MAX_ENTRIES);
  return entry;
}

/**
 * Compara la carpeta mods con la última foto y apunta las diferencias.
 * source: 'app' (después de algo hecho con la app) o 'detected' (hecho a mano).
 */
function recordModChanges(server, { source = 'app', by = null } = {}) {
  const data = load(server.id);
  const current = snapshotMods(server);
  if (!data.snapshot) {
    data.snapshot = current;
    const count = Object.keys(current).length;
    addItems(data, [{ type: 'baseline', count }], { source: 'app' });
    save(server.id, data);
    return [];
  }
  const items = diffSnapshots(data.snapshot, current);
  data.snapshot = current;
  addItems(data, items, { source, by });
  save(server.id, data);
  return items;
}

/** Apunta cambios que no son de mods (versión, config, reglas, restauraciones, notas). */
function record(server, items, { by = null } = {}) {
  const clean = (items || []).filter(Boolean);
  if (!clean.length) return;
  const data = load(server.id);
  addItems(data, clean, { source: 'app', by });
  save(server.id, data);
}

function addNote(server, text, { by = null } = {}) {
  const note = String(text || '').trim().slice(0, MAX_NOTE);
  if (!note) throw new Error('Escribe la nota.');
  const data = load(server.id);
  // Las notas van siempre en su propia entrada (no se juntan con lo anterior).
  const entry = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), endAt: Date.now(), source: 'note', by, items: [{ type: 'note', text: note }] };
  data.entries.push(entry);
  save(server.id, data);
  return entry;
}

function deleteEntry(server, entryId) {
  const data = load(server.id);
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => e.id !== entryId);
  if (data.entries.length === before) throw new Error('Esa entrada ya no existe.');
  save(server.id, data);
}

/** Entradas de la más nueva a la más vieja (antes mira si han cambiado los mods a mano). */
function list(server, { detect = true } = {}) {
  if (detect) recordModChanges(server, { source: 'detected' });
  return load(server.id).entries.slice().reverse();
}

// ---------------------------------------------------------------------------
// Texto para Discord
// ---------------------------------------------------------------------------

function fmtDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LOADER_NAME = { neoforge: 'NeoForge', forge: 'Forge', fabric: 'Fabric', quilt: 'Quilt', vanilla: 'Minecraft', paper: 'Paper' };

/** Una línea de texto por cambio (sirve para Discord y para tests). */
function itemText(it) {
  const v = (x) => (x ? ` ${x}` : '');
  switch (it.type) {
    case 'modAdded': return `➕ Añadido: ${it.name}${v(it.version)}${it.enabled === false ? ' (desactivado)' : ''}`;
    case 'modRemoved': return `➖ Quitado: ${it.name}${v(it.version)}`;
    case 'modUpdated': return `⬆️ Actualizado: ${it.name} ${it.from} → ${it.to}`;
    case 'modEnabled': return `▶️ Activado: ${it.name}`;
    case 'modDisabled': return `⏸️ Desactivado: ${it.name}`;
    case 'loader': return `🔧 ${LOADER_NAME[it.loader] || it.loader} ${it.from || '?'} → ${it.to}`;
    case 'config': return it.asText
      ? `⚙️ Configuración: ${it.file} (editado a mano)`
      : `⚙️ Configuración ${it.file}: ${(it.changes || []).map((c) => `${c.key} ${c.from} → ${c.to}`).join(', ')}`;
    case 'gamerule': return `🌍 Regla del mundo: ${it.label || it.key} ${it.from} → ${it.to}`;
    case 'restore': return it.kind === 'full' ? `♻️ Restaurado el backup completo ${it.file}` : `♻️ Restaurado el backup del mundo ${it.file}`;
    case 'note': return `📝 ${it.text}`;
    case 'baseline': return `📋 Empieza el historial (${it.count} mods instalados)`;
    default: return '';
  }
}

const MOD_TYPES = new Set(['modAdded', 'modRemoved', 'modUpdated', 'modEnabled', 'modDisabled', 'loader']);

function discordText(serverName, entries) {
  const lines = [`**📋 Cambios en ${serverName}**`];
  let modsChanged = false;
  for (const e of entries) {
    const items = e.items.filter((it) => it.type !== 'baseline');
    if (!items.length) continue;
    lines.push('', `**${fmtDate(e.at)}**${e.source === 'detected' ? ' _(cambios hechos en la carpeta)_' : ''}`);
    for (const it of items) {
      lines.push(itemText(it));
      if (MOD_TYPES.has(it.type)) modsChanged = true;
    }
  }
  if (modsChanged) lines.push('', '_Actualizad vuestros mods (o el modpack) antes de entrar._');
  return lines.join('\n');
}

module.exports = {
  snapshotMods,
  diffSnapshots,
  recordModChanges,
  record,
  addNote,
  deleteEntry,
  list,
  discordText,
  itemText,
  MERGE_WINDOW_MS,
};
