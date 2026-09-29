const fs = require('fs');
const path = require('path');
const { userDataDir } = require('./paths');

/**
 * Ajustes generales de la aplicación (compartidos por escritorio y web), en
 * <carpeta de datos>/settings.json.
 */
function settingsFile() {
  return path.join(userDataDir(), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
  } catch (err) {
    return {};
  }
}

function writeSettings(settings) {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), 'utf-8');
  fs.renameSync(temporary, file);
}

// Un nombre de dominio o una IP, sin puerto ni "http://".
const HOST_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;

/** Dirección pública con la que tus amigos se conectan (p. ej. tuservidor.duckdns.org). */
function setPublicAddress(value) {
  const clean = String(value || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  if (clean && !HOST_PATTERN.test(clean)) {
    throw new Error('Escribe solo el dominio o la IP, por ejemplo: tuservidor.duckdns.org');
  }
  const settings = readSettings();
  settings.publicAddress = clean || null;
  writeSettings(settings);
  return settings.publicAddress;
}

function getPublicAddress() {
  return readSettings().publicAddress || process.env.MSM_DIRECCION_PUBLICA || null;
}

module.exports = { readSettings, writeSettings, setPublicAddress, getPublicAddress };
