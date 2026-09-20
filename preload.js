const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Servidores
  listServers: () => ipcRenderer.invoke('servers:list'),
  getServer: (id) => ipcRenderer.invoke('servers:get', id),
  checkJava: () => ipcRenderer.invoke('servers:checkJava'),
  createServer: (options) => ipcRenderer.invoke('servers:create', options),
  onCreateProgress: (cb) => ipcRenderer.on('servers:createProgress', (e, data) => cb(data)),
  removeCreateProgressListeners: () => ipcRenderer.removeAllListeners('servers:createProgress'),
  deleteServer: (id, deleteFiles) => ipcRenderer.invoke('servers:delete', { id, deleteFiles }),
  updateProperties: (id, properties) => ipcRenderer.invoke('servers:updateProperties', { id, properties }),
  updateMemory: (id, memory) => ipcRenderer.invoke('servers:updateMemory', { id, memory }),
  updateOptimizeJvm: (id, enabled) => ipcRenderer.invoke('servers:updateOptimizeJvm', { id, enabled }),
  applyPerformancePreset: (id) => ipcRenderer.invoke('servers:applyPerformancePreset', id),
  getSystemMemory: () => ipcRenderer.invoke('servers:systemMemory'),
  openServerFolder: (id) => ipcRenderer.invoke('servers:openFolder', id),

  // Importar servidor / mundo existentes
  pickServerFolder: () => ipcRenderer.invoke('servers:pickImportFolder'),
  pickWorldFolder: () => ipcRenderer.invoke('worlds:pickFolder'),
  detectExistingServer: (folderPath) => ipcRenderer.invoke('servers:detectExisting', folderPath),
  importServer: (options) => ipcRenderer.invoke('servers:import', options),
  importWorld: (serverId, worldFolder) => ipcRenderer.invoke('servers:importWorld', { serverId, worldFolder }),

  // Proceso
  startServer: (id) => ipcRenderer.invoke('servers:start', id),
  stopServer: (id, force) => ipcRenderer.invoke('servers:stop', { id, force }),
  sendCommand: (id, command) => ipcRenderer.invoke('servers:sendCommand', { id, command }),
  isRunning: (id) => ipcRenderer.invoke('servers:isRunning', id),
  onLog: (id, cb) => ipcRenderer.on(`servers:log:${id}`, (e, line) => cb(line)),
  onExit: (id, cb) => ipcRenderer.on(`servers:exit:${id}`, (e, code) => cb(code)),
  removeLogListeners: (id) => {
    ipcRenderer.removeAllListeners(`servers:log:${id}`);
    ipcRenderer.removeAllListeners(`servers:exit:${id}`);
  },

  // Catálogo
  listVanillaVersions: () => ipcRenderer.invoke('catalog:vanillaVersions'),
  listForgeVersions: (mcVersion) => ipcRenderer.invoke('catalog:forgeVersions', mcVersion),
  getForgeRecommended: (mcVersion) => ipcRenderer.invoke('catalog:forgeRecommended', mcVersion),
  listNeoForgeVersions: (mcVersion) => ipcRenderer.invoke('catalog:neoforgeVersions', mcVersion),

  // Mods
  pickModsFolder: () => ipcRenderer.invoke('mods:pickFolder'),
  analyzeMods: (folder) => ipcRenderer.invoke('mods:analyze', folder),
  applyMods: (serverId, results, includeUnknown) =>
    ipcRenderer.invoke('mods:apply', { serverId, results, includeUnknown }),
  exportModsZip: (serverId, results) =>
    ipcRenderer.invoke('mods:exportZip', { serverId, results }),
  showInFolder: (filePath) => ipcRenderer.invoke('mods:showInFolder', filePath),
});
