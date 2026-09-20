const fs = require('fs');
const { storeFile } = require('./paths');

function readAll() {
  const file = storeFile();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function writeAll(data) {
  const file = storeFile();
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(temporary, file);
}

function listServers() {
  const all = readAll();
  return Object.values(all).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function getServer(id) {
  const all = readAll();
  return all[id] || null;
}

function saveServer(server) {
  const all = readAll();
  all[server.id] = server;
  writeAll(all);
  return server;
}

function deleteServer(id) {
  const all = readAll();
  delete all[id];
  writeAll(all);
}

module.exports = { listServers, getServer, saveServer, deleteServer };
