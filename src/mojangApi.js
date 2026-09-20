// Todas las funciones usan fetch global (disponible en Electron >= 22 / Node >= 18)

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FORGE_PROMOTIONS_URL = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const NEOFORGE_MAVEN_METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fallo al consultar ${url}: HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fallo al consultar ${url}: HTTP ${res.status}`);
  return res.text();
}

// ---- Vanilla ----

async function listVanillaVersions({ includeSnapshots = false } = {}) {
  const manifest = await fetchJson(VERSION_MANIFEST_URL);
  return manifest.versions
    .filter((v) => includeSnapshots || v.type === 'release')
    .map((v) => ({ id: v.id, type: v.type, url: v.url }));
}

async function getVanillaServerDownload(versionId) {
  const manifest = await fetchJson(VERSION_MANIFEST_URL);
  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`Versión de Minecraft no encontrada: ${versionId}`);
  const versionJson = await fetchJson(entry.url);
  const server = versionJson.downloads && versionJson.downloads.server;
  if (!server) throw new Error(`La versión ${versionId} no tiene servidor oficial descargable`);
  return { url: server.url, sha1: server.sha1, size: server.size };
}

// ---- Forge ----

async function listForgeVersions(mcVersion) {
  // Forge publica metadatos Maven XML. Cada versión tiene el formato
  // "<minecraftVersion>-<forgeVersion>", por ejemplo "1.20.1-47.4.10".
  const xml = await fetchText(FORGE_MAVEN_METADATA_URL);
  const prefix = `${mcVersion}-`;
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((match) => match[1].trim())
    .filter((full) => full.startsWith(prefix))
    .map((full) => full.slice(prefix.length));

  return [...new Set(versions)].reverse(); // más reciente primero
}

async function getForgeRecommended(mcVersion) {
  const promotions = await fetchJson(FORGE_PROMOTIONS_URL);
  const rec = promotions.promos[`${mcVersion}-recommended`];
  const latest = promotions.promos[`${mcVersion}-latest`];
  return rec || latest || null;
}

function getForgeInstallerUrl(mcVersion, forgeVersion) {
  const full = `${mcVersion}-${forgeVersion}`;
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
}

// ---- NeoForge ----

async function listNeoForgeVersions(mcVersion) {
  // Las versiones de NeoForge siguen el patrón "<minor>.<patch>.<build>" ligado a la
  // versión de Minecraft 1.<minor>.<patch> (ej: MC 1.20.4 -> NeoForge 20.4.x)
  const xml = await fetchText(NEOFORGE_MAVEN_METADATA_URL);
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  const parts = mcVersion.split('.'); // ["1", "20", "4"]
  const prefix = parts.length >= 3 ? `${parts[1]}.${parts[2]}.` : `${parts[1]}.0.`;
  return versions.filter((v) => v.startsWith(prefix)).reverse();
}

function getNeoForgeInstallerUrl(neoForgeVersion) {
  return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoForgeVersion}/neoforge-${neoForgeVersion}-installer.jar`;
}

module.exports = {
  listVanillaVersions,
  getVanillaServerDownload,
  listForgeVersions,
  getForgeRecommended,
  getForgeInstallerUrl,
  listNeoForgeVersions,
  getNeoForgeInstallerUrl,
};
