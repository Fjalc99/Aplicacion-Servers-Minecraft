const { app, BrowserWindow, ipcMain, shell, dialog, session, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./src/store');
const serverManager = require('./src/serverManager');
const mojang = require('./src/mojangApi');
const javaProcess = require('./src/javaProcess');
const modAnalyzer = require('./src/modAnalyzer');
const zipWriter = require('./src/zipWriter');

let mainWindow;
let tray = null;

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

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('Minecraft Server Manager');

  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar ventana', click: () => { mainWindow.show(); mainWindow.focus(); } },
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

// ---------- IPC: servidores ----------

ipcMain.handle('servers:list', () => store.listServers());
ipcMain.handle('servers:get', (e, id) => store.getServer(id));
ipcMain.handle('servers:checkJava', () => serverManager.checkJava());

ipcMain.handle('servers:create', async (event, options) => {
  try {
    const server = await serverManager.createServer(options, (progress) => {
      event.sender.send('servers:createProgress', progress);
    });
    return { ok: true, server };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('servers:delete', (e, { id, deleteFiles }) => {
  serverManager.deleteServer(id, { deleteFiles });
  return true;
});

ipcMain.handle('servers:updateProperties', (e, { id, properties }) =>
  serverManager.updateProperties(id, properties)
);

ipcMain.handle('servers:updateMemory', (e, { id, memory }) =>
  serverManager.updateMemory(id, memory)
);

ipcMain.handle('servers:updateOptimizeJvm', (e, { id, enabled }) =>
  serverManager.updateOptimizeJvm(id, enabled)
);

ipcMain.handle('servers:applyPerformancePreset', (e, id) =>
  serverManager.applyPerformancePreset(id)
);

ipcMain.handle('servers:systemMemory', () => ({
  totalMb: Math.round(require('os').totalmem() / 1024 / 1024),
}));

ipcMain.handle('servers:openFolder', (e, id) => {
  const server = store.getServer(id);
  if (server) shell.openPath(server.dir);
});

// ---------- IPC: importar servidor / mundo existentes ----------

ipcMain.handle('servers:pickImportFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona la carpeta del servidor existente',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('worlds:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona la carpeta del mundo',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('servers:detectExisting', (e, folderPath) => {
  try {
    return { ok: true, result: serverManager.detectExistingServer(folderPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('servers:import', (e, options) => {
  try {
    const server = serverManager.importServer(options);
    return { ok: true, server };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('servers:importWorld', (e, { serverId, worldFolder }) => {
  try {
    const result = serverManager.importWorld(serverId, worldFolder);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC: proceso del servidor ----------

ipcMain.handle('servers:start', (event, id) => {
  const server = store.getServer(id);
  if (!server) throw new Error('Servidor no encontrado');
  javaProcess.startServer(
    server,
    (line) => event.sender.send(`servers:log:${id}`, line),
    (code) => event.sender.send(`servers:exit:${id}`, code)
  );
  return true;
});

ipcMain.handle('servers:stop', (e, { id, force }) => {
  javaProcess.stopServer(id, { force });
  return true;
});

ipcMain.handle('servers:sendCommand', (e, { id, command }) => {
  javaProcess.sendCommand(id, command);
  return true;
});

ipcMain.handle('servers:isRunning', (e, id) => javaProcess.isRunning(id));

// ---------- IPC: catálogo de versiones ----------

ipcMain.handle('catalog:vanillaVersions', () => mojang.listVanillaVersions());
ipcMain.handle('catalog:forgeVersions', (e, mcVersion) => mojang.listForgeVersions(mcVersion));
ipcMain.handle('catalog:forgeRecommended', (e, mcVersion) => mojang.getForgeRecommended(mcVersion));
ipcMain.handle('catalog:neoforgeVersions', (e, mcVersion) => mojang.listNeoForgeVersions(mcVersion));

// ---------- IPC: mods ----------

ipcMain.handle('mods:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('mods:analyze', async (e, folder) => {
  try {
    const results = await modAnalyzer.analyzeMods(folder);
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mods:apply', (e, { serverId, results, includeUnknown }) => {
  try {
    const server = store.getServer(serverId);
    if (!server) throw new Error('Servidor no encontrado');
    const modsDir = path.join(server.dir, 'mods');
    const result = modAnalyzer.applyModsToServer(modsDir, results, { includeUnknown });
    return { ok: true, ...result };
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

    const entries = results
      .filter((r) => fs.existsSync(r.file))
      .map((r) => ({ name: r.fileName, filePath: r.file }));

    if (entries.length === 0) {
      return { ok: false, error: 'No hay ficheros válidos que empaquetar.' };
    }

    zipWriter.createZip(entries, save.filePath);
    const size = fs.statSync(save.filePath).size;

    return { ok: true, zipPath: save.filePath, count: entries.length, size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mods:showInFolder', (e, filePath) => {
  shell.showItemInFolder(filePath);
  return true;
});
