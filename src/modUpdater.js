/**
 * Actualizar los mods del servidor con Modrinth.
 *
 * Para cada .jar de la carpeta mods/ se busca (por su hash) la última versión
 * del MISMO mod para el MISMO loader y la MISMA versión de Minecraft del
 * servidor; nunca se propone una versión para otra MC. Por defecto solo se
 * proponen versiones estables (release) si la que tienes es estable.
 *
 * Al aplicar: se descarga la versión nueva, se comprueba su hash con el que
 * publica Modrinth y la vieja se mueve a mods-antiguos-<fecha>/ (no se borra).
 * Lo que se descarga se decide AQUÍ volviendo a consultar Modrinth: la interfaz
 * solo dice qué mods quiere actualizar, nunca manda URLs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { downloadFile } = require('./downloader');
const { detectInstalled } = require('./loaderUpdater');
const curseforge = require('./curseforge');

const API = () => process.env.MSM_MODRINTH_URL || 'https://api.modrinth.com/v2'; // la variable es solo para tests
const USER_AGENT = 'Fjalc99/Aplicacion-Servers-Minecraft (minecraft-server-manager)';

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function api(fetchImpl, pathname, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetchImpl(`${API()}${pathname}`, {
      method,
      headers: { 'User-Agent': USER_AGENT, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Error('No se ha podido contactar con Modrinth. Comprueba la conexión a internet.');
  }
  if (!res.ok) throw new Error(`Modrinth ha respondido con un error (${res.status}).`);
  return res.json();
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function loadersFor(server) {
  if (server.loader === 'neoforge') return ['neoforge'];
  if (server.loader === 'forge') return ['forge'];
  throw new Error('Solo los servidores Forge o NeoForge tienen mods que actualizar.');
}

const newer = (a, b) => new Date(a.date_published).getTime() > new Date(b.date_published).getTime();

/**
 * Busca actualizaciones. Devuelve la información completa (con los objetos de
 * versión de Modrinth) para uso interno; publicResult() la recorta para la interfaz.
 */
async function findUpdates(server, { fetchImpl = fetch, includeBeta = false, curseforgeKey } = {}) {
  const loaders = loadersFor(server);
  const mcVersion = detectInstalled(server).mcVersion || server.mcVersion;
  if (!mcVersion || mcVersion === 'desconocida') {
    throw new Error('No sé qué versión de Minecraft tiene este servidor, así que no puedo buscar versiones compatibles.');
  }
  const modsDir = path.join(server.dir, 'mods');
  const files = fs.existsSync(modsDir)
    ? fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar')).sort((a, b) => a.localeCompare(b))
    : [];
  if (files.length === 0) return { mcVersion, loader: loaders[0], checked: 0, identified: 0, updates: [], notOnModrinth: [], warnings: [] };

  const hashOf = new Map(); // fileName -> sha1
  for (const f of files) {
    hashOf.set(f, crypto.createHash('sha1').update(fs.readFileSync(path.join(modsDir, f))).digest('hex'));
  }
  const hashes = [...new Set(hashOf.values())];

  const current = {};
  const latest = {};
  for (const group of chunk(hashes, 100)) {
    Object.assign(current, await api(fetchImpl, '/version_files', { method: 'POST', body: { hashes: group, algorithm: 'sha1' } }));
    Object.assign(
      latest,
      await api(fetchImpl, '/version_files/update', {
        method: 'POST',
        body: { hashes: group, algorithm: 'sha1', loaders, game_versions: [mcVersion] },
      })
    );
  }

  const installedProjects = new Set(Object.values(current).map((v) => v.project_id));
  const candidates = [];
  for (const fileName of files) {
    const sha = hashOf.get(fileName);
    const cur = current[sha];
    let next = latest[sha];
    if (!cur || !next || next.id === cur.id || !newer(next, cur)) continue;

    // Si tienes una versión estable y la última es beta/alpha, se busca la última estable.
    if (!includeBeta && next.version_type !== 'release' && cur.version_type === 'release') {
      const q = `loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
      const versions = await api(fetchImpl, `/project/${encodeURIComponent(cur.project_id)}/version?${q}`);
      next = versions
        .filter((v) => v.version_type === 'release' && newer(v, cur))
        .sort((a, b) => new Date(b.date_published) - new Date(a.date_published))[0];
      if (!next) continue;
    }
    candidates.push({ fileName, current: cur, next });
  }

  // Nombres de los mods y de las dependencias que faltan
  const missingByUpdate = candidates.map((c) =>
    (c.next.dependencies || [])
      .filter((d) => d.dependency_type === 'required' && d.project_id && !installedProjects.has(d.project_id))
      .map((d) => d.project_id)
  );
  const ids = [...new Set([...installedProjects, ...missingByUpdate.flat()])];
  const projects = new Map();
  for (const group of chunk(ids, 100)) {
    const list = await api(fetchImpl, `/projects?ids=${encodeURIComponent(JSON.stringify(group))}`);
    for (const p of list) projects.set(p.id, p);
  }

  const updates = candidates.map((c, i) => {
    const project = projects.get(c.current.project_id);
    const file = c.next.files.find((f) => f.primary) || c.next.files[0];
    return {
      fileName: c.fileName,
      name: project ? project.title : c.fileName,
      projectId: c.current.project_id,
      clientSide: project ? project.client_side : null,
      currentVersion: c.current.version_number,
      newVersion: c.next.version_number,
      versionType: c.next.version_type,
      published: c.next.date_published,
      newFileName: file ? file.filename : null,
      size: file ? file.size : null,
      url: project ? `https://modrinth.com/mod/${project.slug}/version/${c.next.id}` : null,
      missingDeps: missingByUpdate[i].map((id) => (projects.get(id) ? projects.get(id).title : id)),
      source: 'modrinth',
      canDownload: Boolean(file),
      _download: file ? { url: file.url, fileName: file.filename, sha1: file.hashes && file.hashes.sha1, sha512: file.hashes && file.hashes.sha512 } : null,
    };
  });

  const notOnModrinth = files.filter((f) => !current[hashOf.get(f)]);
  const installedNames = new Set(
    [...installedProjects].filter((id) => projects.has(id)).map((id) => projects.get(id).title.toLowerCase())
  );

  // ---------- CurseForge, para lo que no está en Modrinth ----------
  const warnings = [];
  let notFound = notOnModrinth;
  const cfKey = curseforgeKey === undefined ? curseforge.getApiKey() : curseforgeKey;
  if (notOnModrinth.length && !cfKey) warnings.push('curseforge-sin-clave');
  if (notOnModrinth.length && cfKey) {
    try {
      const cf = await curseforgeUpdates(server, notOnModrinth, { modsDir, mcVersion, cfKey, fetchImpl, includeBeta, installedNames });
      updates.push(...cf.updates);
      notFound = cf.notFound;
    } catch (err) {
      warnings.push(`No se ha podido consultar CurseForge: ${err.message}`);
    }
  }

  updates.sort((a, b) => a.name.localeCompare(b.name));
  return {
    mcVersion,
    loader: loaders[0],
    checked: files.length,
    identified: files.length - notFound.length,
    updates,
    notOnModrinth: notFound,
    warnings,
  };
}

/** Actualizaciones de los mods que solo están en CurseForge. */
async function curseforgeUpdates(server, fileNames, { modsDir, mcVersion, cfKey, fetchImpl, includeBeta, installedNames }) {
  const loaderType = curseforge.MOD_LOADER[server.loader];
  const prints = new Map(); // fingerprint -> fileName
  for (const f of fileNames) prints.set(curseforge.fingerprint(fs.readFileSync(path.join(modsDir, f))), f);
  const found = await curseforge.lookupFingerprints([...prints.keys()], { apiKey: cfKey, fetchImpl });
  const notFound = fileNames.filter((f) => ![...found.entries()].some(([print]) => prints.get(print) === f));

  const installed = [...found.entries()].map(([print, info]) => ({ fileName: prints.get(print), ...info }));
  const installedModIds = new Set(installed.map((m) => m.modId));
  const mods = await curseforge.getMods([...installedModIds], { apiKey: cfKey, fetchImpl });

  const updates = [];
  const missingIds = new Set();
  for (const inst of installed) {
    const mod = mods.get(inst.modId);
    if (!mod || !inst.fileId) continue;
    const allowed = includeBeta ? [1, 2, 3] : inst.releaseType && inst.releaseType !== 1 ? [1, 2] : [1];
    const best = (mod.latestFilesIndexes || [])
      .filter((x) => x.gameVersion === mcVersion && x.modLoader === loaderType && allowed.includes(x.releaseType))
      .sort((a, b) => b.fileId - a.fileId)[0];
    if (!best || best.fileId <= inst.fileId) continue;

    const file = await curseforge.getFile(inst.modId, best.fileId, { apiKey: cfKey, fetchImpl });
    if (!file) continue;
    const sha1 = ((file.hashes || []).find((h) => h.algo === 1) || {}).value;
    const deps = (file.dependencies || []).filter((d) => d.relationType === 3 && !installedModIds.has(d.modId)).map((d) => d.modId);
    deps.forEach((id) => missingIds.add(id));
    updates.push({
      fileName: inst.fileName,
      name: mod.name,
      projectId: `cf:${inst.modId}`,
      clientSide: null,
      currentVersion: inst.displayName || inst.fileName,
      newVersion: file.displayName || file.fileName,
      versionType: curseforge.RELEASE_TYPE[file.releaseType] || 'release',
      published: file.fileDate,
      newFileName: file.fileName,
      size: file.fileLength || null,
      url: mod.links && mod.links.websiteUrl ? `${mod.links.websiteUrl}/files/${file.id}` : null,
      missingDeps: deps,
      source: 'curseforge',
      // Algunos autores no dejan descargar desde otras apps: entonces se avisa y se hace a mano.
      canDownload: Boolean(file.downloadUrl),
      _download: file.downloadUrl ? { url: file.downloadUrl, fileName: file.fileName, sha1 } : null,
    });
  }

  if (missingIds.size) {
    const depMods = await curseforge.getMods([...missingIds], { apiKey: cfKey, fetchImpl });
    for (const u of updates) {
      u.missingDeps = u.missingDeps
        .map((id) => (depMods.get(id) ? depMods.get(id).name : `mod ${id}`))
        .filter((name) => !installedNames.has(name.toLowerCase())); // puede estar instalado por Modrinth
    }
  }
  return { updates, notFound };
}

/** Lo que ve la interfaz (sin los objetos internos de Modrinth). */
function publicResult(result) {
  return { ...result, updates: result.updates.map(({ _download, ...rest }) => rest) };
}

function sha(file, algorithm) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('hex');
}

/** Solo se descarga de Modrinth o del CDN de CurseForge (o de las APIs falsas de los tests). */
function allowedUrl(url) {
  try {
    const host = new URL(url).hostname;
    const apiHost = new URL(API()).hostname;
    const cfHost = process.env.MSM_CURSEFORGE_URL ? new URL(process.env.MSM_CURSEFORGE_URL).hostname : null;
    return host.endsWith('.modrinth.com') || host.endsWith('.forgecdn.net') || host === apiHost || host === cfHost;
  } catch (err) {
    return false;
  }
}

/**
 * Actualiza los mods indicados (por nombre de archivo actual).
 * deps (tests): { fetchImpl, download(url, dest, onProgress) }
 * Devuelve { updated: [{ fileName, newFileName, name }], failed: [{ fileName, error }], asideDir }
 */
async function applyUpdates(
  server,
  fileNames,
  { fetchImpl = fetch, download = downloadFile, includeBeta = false, curseforgeKey, onProgress = () => {} } = {}
) {
  const wanted = new Set(fileNames || []);
  const { updates } = await findUpdates(server, { fetchImpl, includeBeta, curseforgeKey });
  const selected = updates.filter((u) => wanted.has(u.fileName));
  const modsDir = path.join(server.dir, 'mods');
  let asideDir = null;
  const aside = () => {
    if (!asideDir) {
      asideDir = path.join(server.dir, `mods-antiguos-${timestamp()}`);
      fs.mkdirSync(asideDir, { recursive: true });
    }
    return asideDir;
  };

  const result = { updated: [], failed: [], asideDir: null };
  for (let i = 0; i < selected.length; i++) {
    const u = selected[i];
    const d = u._download;
    onProgress({ index: i + 1, total: selected.length, name: u.name, phase: 'download' });
    const newName = d ? path.basename(String(d.fileName || '')) : '';
    const tmp = newName ? path.join(modsDir, `${newName}.descargando`) : null;
    try {
      if (!d) throw new Error('El autor no permite descargarlo desde otras apps: actualízalo a mano desde su página.');
      if (!newName.toLowerCase().endsWith('.jar') || newName !== d.fileName) throw new Error('La descarga no es un .jar válido.');
      if (!allowedUrl(d.url)) throw new Error('La descarga no viene de Modrinth ni de CurseForge; no se instala.');
      await download(d.url, tmp, (p) => onProgress({ index: i + 1, total: selected.length, name: u.name, phase: 'download', ...p }));
      if (d.sha512 && sha(tmp, 'sha512') !== d.sha512) throw new Error('El archivo descargado no coincide con el original (descarga dañada).');
      if (d.sha1 && sha(tmp, 'sha1') !== d.sha1) throw new Error('El archivo descargado no coincide con el original (descarga dañada).');

      const oldPath = path.join(modsDir, u.fileName);
      if (fs.existsSync(oldPath)) fs.renameSync(oldPath, path.join(aside(), u.fileName));
      const target = path.join(modsDir, newName);
      if (fs.existsSync(target)) fs.renameSync(target, path.join(aside(), `${newName}.repetido`));
      fs.renameSync(tmp, target);
      result.updated.push({ fileName: u.fileName, newFileName: newName, name: u.name });
    } catch (err) {
      if (tmp) fs.rmSync(tmp, { force: true });
      result.failed.push({ fileName: u.fileName, name: u.name, error: err.message });
    }
  }
  result.asideDir = asideDir;
  return result;
}

module.exports = { findUpdates, publicResult, applyUpdates };
