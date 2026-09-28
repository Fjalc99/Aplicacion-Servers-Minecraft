const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Carpeta donde se guardan servers.json y los servidores creados.
 *
 * - Si existe la variable de entorno DATA_DIR, se usa esa (versión web o
 *   cualquier ejecución fuera de Electron que quiera una carpeta concreta).
 * - Dentro de Electron, la carpeta de datos de la app (app.getPath('userData')).
 * - Fuera de Electron sin DATA_DIR, la misma ruta que usa "npm start" en
 *   escritorio, para que la web vea los mismos servidores.
 */
function userDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);

  if (process.versions.electron) {
    return require('electron').app.getPath('userData');
  }

  return defaultDesktopDataDir();
}

function defaultDesktopDataDir() {
  const appName = 'minecraft-server-manager';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}

function serversRootDir() {
  const dir = path.join(userDataDir(), 'servers');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function storeFile() {
  const dir = userDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'servers.json');
}

function serverDir(id) {
  return path.join(serversRootDir(), id);
}

module.exports = { userDataDir, serversRootDir, storeFile, serverDir };
