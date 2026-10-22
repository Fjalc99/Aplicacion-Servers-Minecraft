/**
 * La lista de mods del servidor tal y como la enseña la pestaña Mods:
 * nombre, versión, lado, origen, si está desactivado, problemas (duplicado,
 * mod de cliente metido en el servidor) y qué otros mods lo necesitan.
 *
 * Desactivar un mod = renombrarlo a .jar.disabled (el servidor no lo carga);
 * quitar = moverlo a mods-quitados-<fecha>/ en la carpeta del servidor.
 */
const fs = require('fs');
const path = require('path');
const { analyzeMods, markDuplicates } = require('./modAnalyzer');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function modsDir(server) {
  return path.join(server.dir, 'mods');
}

/** Nombre de archivo de mod seguro (sin rutas) dentro de mods/. */
function modPath(server, fileName) {
  const name = String(fileName || '');
  const lower = name.toLowerCase();
  if (name !== path.basename(name) || name.includes('/') || name.includes('\\') || !(lower.endsWith('.jar') || lower.endsWith('.jar.disabled'))) {
    throw new Error(`Nombre de mod no válido: ${name}`);
  }
  return path.join(modsDir(server), name);
}

async function listServerMods(server, opts = {}) {
  const dir = modsDir(server);
  if (!fs.existsSync(dir)) return { mods: [], warnings: [], dir };
  const { results, warnings } = await analyzeMods(dir, { ...opts, includeDisabled: true });

  // Duplicados: solo entre los activos (uno desactivado no estorba)
  const active = results.filter((r) => !r.disabled);
  for (const r of results) {
    delete r.duplicateOf;
    delete r.keepDuplicate;
  }
  markDuplicates(active);

  // Quién necesita a quién (según lo que declara cada .jar)
  const neededBy = new Map();
  for (const r of active) {
    for (const dep of r.requires || []) {
      if (!neededBy.has(dep)) neededBy.set(dep, []);
      neededBy.get(dep).push(r.name);
    }
  }

  const mods = results.map((r) => {
    let problem = null;
    let note = null;
    if (!r.disabled && r.duplicateOf && !r.keepDuplicate) {
      problem = 'Duplicado';
      note = `Hay otra versión del mismo mod (${r.duplicateOf.join(', ')}). Con dos versiones el servidor no arranca: desactiva o quita una.`;
    } else if (!r.disabled && r.status === 'client-only') {
      problem = 'Sobra aquí';
      note = 'Es solo de cliente: en el servidor no hace nada y a veces da errores al arrancar. Puedes quitarlo de aquí y dejarlo solo en tu Minecraft.';
    }
    const dependents = r.modId ? [...new Set(neededBy.get(r.modId) || [])].filter((n) => n !== r.name) : [];
    return {
      fileName: r.fileName,
      file: r.file,
      name: r.name,
      version: r.version || null,
      side: r.status === 'client-only' ? 'client' : r.clientSide === 'unsupported' ? 'server' : r.status === 'unknown' ? 'unknown' : 'both',
      source: r.source === 'modrinth' ? 'Modrinth' : r.curseforgeUrl ? 'CurseForge' : 'Sin identificar',
      url: r.modrinthUrl || r.curseforgeUrl || null,
      disabled: r.disabled,
      problem,
      note,
      dependents,
      modId: r.modId || null,
    };
  });
  mods.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) || a.fileName.localeCompare(b.fileName));
  return { mods, warnings, dir };
}

/** Activa (.jar) o desactiva (.jar.disabled) un mod. Devuelve el nombre nuevo. */
function setModEnabled(server, fileName, enabled) {
  const from = modPath(server, fileName);
  if (!fs.existsSync(from)) throw new Error('Ese mod ya no está en la carpeta.');
  const isDisabled = fileName.toLowerCase().endsWith('.jar.disabled');
  if (enabled === !isDisabled) return fileName;
  const newName = enabled ? fileName.slice(0, -'.disabled'.length) : `${fileName}.disabled`;
  const to = path.join(modsDir(server), newName);
  if (fs.existsSync(to)) throw new Error(`Ya existe ${newName} en la carpeta mods.`);
  fs.renameSync(from, to);
  return newName;
}

/** Mueve mods a mods-quitados-<fecha>/ (no se borran). */
function removeServerMods(server, fileNames) {
  const result = { removed: [], failed: [], asideDir: null };
  for (const fileName of fileNames || []) {
    try {
      const from = modPath(server, fileName);
      if (!fs.existsSync(from)) throw new Error('ya no está');
      if (!result.asideDir) {
        result.asideDir = path.join(server.dir, `mods-quitados-${timestamp()}`);
        fs.mkdirSync(result.asideDir, { recursive: true });
      }
      fs.renameSync(from, path.join(result.asideDir, fileName));
      result.removed.push(fileName);
    } catch (err) {
      result.failed.push({ fileName, error: err.message });
    }
  }
  return result;
}

module.exports = { listServerMods, setModEnabled, removeServerMods };
