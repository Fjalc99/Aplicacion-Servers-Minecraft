const { app, BrowserWindow, ipcMain, shell, dialog, session, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./src/store');
const javaProcess = require('./src/javaProcess');
const { createAppCore } = require('./src/appCore');
const duckdns = require('./src/duckdns');

// electron-updater solo tiene sentido en la app empaquetada (en desarrollo no
// hay app-update.yml). Se carga con try para que un fallo aquí nunca impida
// arrancar la aplicación.
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (e) {
  autoUpdater = null;
}

let mainWindow;
let tray = null;

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, icon: path.join(__dirname, 'build', 'icon.png') }).show();
}

// Toda la lógica que no depende de Electron (lanzar servidores, backups,
// reinicio automático, mods, jugadores...) vive en src/appCore.js y la
// comparte la versión web (web/server.js). Aquí solo se conecta con la ventana.
const core = createAppCore({
  send: (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  },
  notify,
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1c1f26',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Minimizar (el guion "_") oculta la ventana y la app sigue en segundo plano,
  // accesible desde el icono de la bandeja. La X, en cambio, cierra la app de verdad.
  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('close', (event) => {
    if (app.isQuiting) return;
    if (!confirmQuitIfServersRunning()) {
      event.preventDefault();
      return;
    }
    app.isQuiting = true;
  });
}

// Antes de cerrar de verdad, avisa si hay servidores en marcha: al cerrar la app
// se corta la tubería de consola del proceso Java y el servidor puede caerse.
function confirmQuitIfServersRunning() {
  const runningNames = store
    .listServers()
    .filter((s) => javaProcess.isRunning(s.id))
    .map((s) => s.name);

  if (runningNames.length === 0) return true;

  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['Cancelar', 'Cerrar de todas formas'],
    defaultId: 0,
    cancelId: 0,
    title: 'Servidores en marcha',
    message: `Tienes ${runningNames.length} servidor(es) en ejecución: ${runningNames.join(', ')}.`,
    detail: 'Cerrar la aplicación del todo puede provocar que el proceso del servidor se caiga al perder la consola. Si solo quieres liberar recursos, minimiza la ventana en vez de cerrarla con la X.',
  });
  return choice === 1;
}

// ---------- Auto-actualización (GitHub Releases) ----------

let updateCheckIsManual = false;

function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    notify('Actualización disponible', `Descargando la versión ${info.version} en segundo plano…`);
  });

  autoUpdater.on('update-not-available', () => {
    if (updateCheckIsManual) notify('Sin actualizaciones', `Ya tienes la última versión (${app.getVersion()}).`);
    updateCheckIsManual = false;
  });

  autoUpdater.on('error', (err) => {
    if (updateCheckIsManual) notify('No se pudo buscar actualizaciones', err ? err.message : 'Error desconocido');
    updateCheckIsManual = false;
  });

  autoUpdater.on('update-downloaded', async (info) => {
    updateCheckIsManual = false;
    notify('Actualización lista', `La versión ${info.version} se instalará al cerrar la aplicación.`);
    if (!mainWindow) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Reiniciar ahora', 'Más tarde'],
      defaultId: 1,
      cancelId: 1,
      title: 'Actualización descargada',
      message: `La versión ${info.version} está lista para instalarse.`,
      detail: 'Si eliges "Más tarde", se instalará automáticamente la próxima vez que cierres la aplicación.',
    });
    if (response === 0 && confirmQuitIfServersRunning()) {
      app.isQuiting = true;
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.checkForUpdates().catch(() => {});
}

function checkForUpdatesManually() {
  if (!autoUpdater || !app.isPackaged) {
    notify('Actualizaciones', 'La búsqueda de actualizaciones solo funciona en la versión instalada de la aplicación.');
    return;
  }
  updateCheckIsManual = true;
  autoUpdater.checkForUpdates().catch((err) => {
    notify('No se pudo buscar actualizaciones', err.message);
    updateCheckIsManual = false;
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('Minecraft Server Manager');

  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar ventana', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Buscar actualizaciones', click: () => checkForUpdatesManually() },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        if (!confirmQuitIfServersRunning()) return;
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

app.whenReady().then(async () => {
  // Durante el desarrollo los recursos locales pueden quedar en la caché de
  // Chromium entre reinicios. Limpiarla asegura cargar el renderer actual.
  await session.defaultSession.clearCache();
  createWindow();
  createTray();
  duckdns.startUpdater();
  setupAutoUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on('before-quit', () => {
  app.isQuiting = true;
});

app.on('window-all-closed', () => {
  // La X (mainWindow.on('close', ...)) ya confirmó el cierre y marcó
  // app.isQuiting antes de dejar que la ventana se destruya, así que aquí solo
  // queda salir de verdad (excepto en macOS, donde es habitual seguir en el Dock).
  if (process.platform !== 'darwin') app.quit();
});


// ---------- IPC: handlers compartidos (src/appCore.js) ----------

for (const [channel, handler] of Object.entries(core.handlers)) {
  ipcMain.handle(channel, (event, arg) =>
    handler(arg, { reply: (replyChannel, payload) => event.sender.send(replyChannel, payload) })
  );
}

// ---------- IPC: solo escritorio (diálogos nativos y explorador de archivos) ----------

async function pickFolder(title) {
  const result = await dialog.showOpenDialog(mainWindow, { title, properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

ipcMain.handle('servers:pickImportFolder', () => pickFolder('Selecciona la carpeta del servidor existente'));
ipcMain.handle('worlds:pickFolder', () => pickFolder('Selecciona la carpeta del mundo'));
ipcMain.handle('worlds:pickInstanceFolder', () =>
  pickFolder('Selecciona la carpeta de tu Minecraft (la de la instancia, que tiene dentro "mods" y "saves")')
);
ipcMain.handle('mods:pickFolder', () => pickFolder('Selecciona la carpeta de mods del cliente'));

ipcMain.handle('servers:openFolder', (e, id) => {
  const server = store.getServer(id);
  if (server) shell.openPath(server.dir);
});

ipcMain.handle('mods:showInFolder', (e, filePath) => {
  shell.showItemInFolder(filePath);
  return true;
});

// Guarda una copia de un backup donde elija el usuario (un disco externo, la
// nube...). En la web, el mismo canal lo convierte en una descarga.
ipcMain.handle('servers:downloadBackup', async (e, { id, fileName }) => {
  try {
    const source = core.backupFilePath(id, fileName);
    const server = store.getServer(id);
    const prefix = server ? `${server.name.replace(/[^\w\-]+/g, '_')}-` : '';
    const save = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar una copia del backup',
      defaultPath: path.join(app.getPath('desktop'), `${prefix}${fileName}`),
      filters: [{ name: 'Archivo ZIP', extensions: ['zip'] }],
    });
    if (save.canceled || !save.filePath) return { ok: false, canceled: true };
    await fs.promises.copyFile(source, save.filePath);
    return { ok: true, savedTo: save.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mods:exportZip', async (e, { serverId, results }) => {
  try {
    const server = store.getServer(serverId);
    const suggestedName = server
      ? `mods-${server.name.replace(/[^\w\-]+/g, '_')}.zip`
      : 'mods-servidor.zip';

    const save = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar ZIP con los mods del servidor',
      defaultPath: path.join(app.getPath('desktop'), suggestedName),
      filters: [{ name: 'Archivo ZIP', extensions: ['zip'] }],
    });
    if (save.canceled || !save.filePath) return { ok: false, canceled: true };

    return await core.buildModsZip(results, save.filePath, (info) => {
      e.sender.send('mods:exportProgress', info);
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
