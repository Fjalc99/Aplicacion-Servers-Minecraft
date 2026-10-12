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
  updateAutoRestart: (id, enabled) => ipcRenderer.invoke('servers:updateAutoRestart', { id, enabled }),
  updateAutoBackup: (id, onStop, everyHours) =>
    ipcRenderer.invoke('servers:updateAutoBackup', { id, onStop, everyHours }),
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
  getServerStatus: (id) => ipcRenderer.invoke('servers:status', id),
  updateAutoStop: (id, enabled, minutes) => ipcRenderer.invoke('servers:updateAutoStop', { id, enabled, minutes }),
  leaveStartQueue: (id) => ipcRenderer.invoke('servers:leaveQueue', id),
  getConnectionInfo: () => ipcRenderer.invoke('app:connectionInfo'),
  setPublicAddress: (value) => ipcRenderer.invoke('app:setPublicAddress', value),
  getDuckDns: () => ipcRenderer.invoke('app:getDuckDns'),
  setDuckDns: (subdomain, token) => ipcRenderer.invoke('app:setDuckDns', { subdomain, token }),
  updateDuckDnsNow: () => ipcRenderer.invoke('app:updateDuckDnsNow'),
  removeDuckDns: () => ipcRenderer.invoke('app:removeDuckDns'),
  setServerJoinAddress: (id, address) => ipcRenderer.invoke('servers:setJoinAddress', { id, address }),
  getPlayitStatus: () => ipcRenderer.invoke('app:playitStatus'),

  // Solo versión web: usuarios y cuenta propia
  listUsers: () => ipcRenderer.invoke('users:list'),
  approveUser: (username) => ipcRenderer.invoke('users:approve', username),
  rejectUser: (username) => ipcRenderer.invoke('users:reject', username),
  setUserRole: (username, role) => ipcRenderer.invoke('users:setRole', { username, role }),
  setUserCommands: (username, enabled) => ipcRenderer.invoke('users:setCommands', { username, enabled }),
  resetUserPassword: (username) => ipcRenderer.invoke('users:resetPassword', username),
  deleteUser: (username) => ipcRenderer.invoke('users:delete', username),
  changeMyPassword: (current, next) => ipcRenderer.invoke('account:changePassword', { current, next }),
  getWebTunnel: () => ipcRenderer.invoke('webTunnel:status'),
  startWebTunnel: () => ipcRenderer.invoke('webTunnel:start'),
  stopWebTunnel: () => ipcRenderer.invoke('webTunnel:stop'),
  setWebTunnelAutostart: (enabled) => ipcRenderer.invoke('webTunnel:setAutostart', enabled),
  getPlayers: (id) => ipcRenderer.invoke('servers:getPlayers', id),
  getResourceUsage: (id) => ipcRenderer.invoke('servers:resourceUsage', id),
  onLog: (id, cb) => ipcRenderer.on(`servers:log:${id}`, (e, line) => cb(line)),
  onExit: (id, cb) => ipcRenderer.on(`servers:exit:${id}`, (e, payload) => cb(payload)),
  onPlayersChange: (id, cb) => ipcRenderer.on(`servers:players:${id}`, (e, players) => cb(players)),
  removeLogListeners: (id) => {
    ipcRenderer.removeAllListeners(`servers:log:${id}`);
    ipcRenderer.removeAllListeners(`servers:exit:${id}`);
    ipcRenderer.removeAllListeners(`servers:players:${id}`);
  },

  // Backups
  listBackups: (id) => ipcRenderer.invoke('servers:listBackups', id),
  createBackup: (id) => ipcRenderer.invoke('servers:createBackup', id),
  createFullBackup: (id) => ipcRenderer.invoke('servers:createFullBackup', id),
  downloadBackup: (id, fileName) => ipcRenderer.invoke('servers:downloadBackup', { id, fileName }),
  restoreBackup: (id, fileName) => ipcRenderer.invoke('servers:restoreBackup', { id, fileName }),
  deleteBackup: (id, fileName) => ipcRenderer.invoke('servers:deleteBackup', { id, fileName }),
  onBackupProgress: (id, cb) => ipcRenderer.on(`servers:backupProgress:${id}`, (e, info) => cb(info)),
  removeBackupProgressListeners: (id) => ipcRenderer.removeAllListeners(`servers:backupProgress:${id}`),

  // Catálogo
  listVanillaVersions: () => ipcRenderer.invoke('catalog:vanillaVersions'),
  listForgeVersions: (mcVersion) => ipcRenderer.invoke('catalog:forgeVersions', mcVersion),
  getForgeRecommended: (mcVersion) => ipcRenderer.invoke('catalog:forgeRecommended', mcVersion),
  listNeoForgeVersions: (mcVersion) => ipcRenderer.invoke('catalog:neoforgeVersions', mcVersion),

  // Whitelist / ops / baneados
  readPlayerList: (id, kind) => ipcRenderer.invoke('servers:readPlayerList', { id, kind }),
  removeFromPlayerList: (id, kind, name) =>
    ipcRenderer.invoke('servers:removeFromPlayerList', { id, kind, name }),

  // Mods
  pickModsFolder: () => ipcRenderer.invoke('mods:pickFolder'),
  analyzeMods: (folder, serverId) => ipcRenderer.invoke('mods:analyze', { folder, serverId }),
  applyMods: (serverId, results, includeUnknown) =>
    ipcRenderer.invoke('mods:apply', { serverId, results, includeUnknown }),
  exportModsZip: (serverId, results) =>
    ipcRenderer.invoke('mods:exportZip', { serverId, results }),
  showInFolder: (filePath) => ipcRenderer.invoke('mods:showInFolder', filePath),
  onModsExportProgress: (cb) => ipcRenderer.on('mods:exportProgress', (e, info) => cb(info)),
  removeModsExportProgressListeners: () => ipcRenderer.removeAllListeners('mods:exportProgress'),
});
