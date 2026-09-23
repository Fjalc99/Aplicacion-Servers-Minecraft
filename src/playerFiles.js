const fs = require('fs');
const path = require('path');

const FILES = {
  whitelist: 'whitelist.json',
  ops: 'ops.json',
  bans: 'banned-players.json',
};

// Comandos que dejan el cambio aplicado en caliente si el servidor está en marcha
// (editar el .json directamente con el proceso vivo no tiene efecto hasta un reload).
const REMOVE_COMMANDS = {
  whitelist: (name) => `whitelist remove ${name}`,
  ops: (name) => `deop ${name}`,
  bans: (name) => `pardon ${name}`,
};

function fileFor(serverDir, kind) {
  if (!FILES[kind]) throw new Error(`Lista desconocida: ${kind}`);
  return path.join(serverDir, FILES[kind]);
}

function readList(serverDir, kind) {
  const file = fileFor(serverDir, kind);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function removeByNameFromFile(serverDir, kind, name) {
  const file = fileFor(serverDir, kind);
  const list = readList(serverDir, kind);
  const filtered = list.filter((entry) => (entry.name || '').toLowerCase() !== name.toLowerCase());
  fs.writeFileSync(file, JSON.stringify(filtered, null, 2));
  return filtered;
}

module.exports = { FILES, REMOVE_COMMANDS, readList, removeByNameFromFile };
