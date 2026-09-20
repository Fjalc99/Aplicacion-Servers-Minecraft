const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function userDataDir() {
  return app.getPath('userData');
}

function serversRootDir() {
  const dir = path.join(userDataDir(), 'servers');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function storeFile() {
  return path.join(userDataDir(), 'servers.json');
}

function serverDir(id) {
  return path.join(serversRootDir(), id);
}

module.exports = { userDataDir, serversRootDir, storeFile, serverDir };
