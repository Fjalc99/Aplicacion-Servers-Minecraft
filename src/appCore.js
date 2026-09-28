const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('./store');
const serverManager = require('./serverManager');
const mojang = require('./mojangApi');
const javaProcess = require('./javaProcess');
const modAnalyzer = require('./modAnalyzer');
const zipWriter = require('./zipWriter');
const backupManager = require('./backupManager');
const crashDiagnostics = require('./crashDiagnostics');
const playerFiles = require('./playerFiles');

/**
 * Lógica compartida por la app de escritorio (main.js, vía IPC de Electron) y
 * la versión web (web/server.js, vía HTTP + WebSocket). No depende de Electron.
 *
 * deps:
 *   send(channel, payload)  -> envía un evento a la interfaz (log, jugadores, caídas...)
 *   notify(title, body)     -> muestra una notificación al usuario
 *
 * Devuelve { handlers, launchServer, buildModsZip }. Cada handler recibe
 * (arg, ctx), donde arg es el mismo único argumento que manda la interfaz y
 * ctx.reply(channel, payload) envía progreso a quien hizo la petición.
 */
function createAppCore({ send, notify }) {
  // serverId -> intervalId, para las copias de seguridad automáticas "cada X horas"
  const autoBackupIntervals = new Map();

  function stopAutoBackupInterval(serverId) {
    const interval = autoBackupIntervals.get(serverId);
    if (interval) {
      clearInterval(interval);
      autoBackupIntervals.delete(serverId);
    }
  }

  function startAutoBackupIntervalIfNeeded(server) {
    stopAutoBackupInterval(server.id);
    const hours = server.autoBackup && server.autoBackup.everyHours;
    if (!hours || hours <= 0) return;

    const interval = setInterval(async () => {
      try {
        await backupManager.createBackup(server);
        send(`servers:log:${server.id}`, '\n[Backup automático realizado]\n');
      } catch (err) {
        send(`servers:log:${server.id}`, `\n[Backup automático fallido: ${err.message}]\n`);
      }
    }, hours * 60 * 60 * 1000);

    autoBackupIntervals.set(server.id, interval);
  }

  /**
   * Arranca un servidor cableando logs, jugadores, notificación de "listo",
   * diagnóstico de caídas, backup automático al parar y reinicio automático si
   * se cae solo. Se usa tanto desde "Iniciar" como desde el propio reinicio
   * automático (que no viene de un clic del usuario).
   */
  function launchServer(server) {
    javaProcess.startServer(server, {
      onLog: (line) => {
        send(`servers:log:${server.id}`, line);
      },
      onReady: () => {
        notify('Servidor iniciado', `"${server.name}" ya está listo para jugar.`);
      },
      onPlayersChange: (players) => {
        send(`servers:players:${server.id}`, players);
      },
      onExit: async ({ code, crashed, recentLogText }) => {
        stopAutoBackupInterval(server.id);

        const diagnosis = crashed ? crashDiagnostics.diagnose(recentLogText) : null;
        send(`servers:exit:${server.id}`, { code, crashed, diagnosis });

        if (!crashed) {
          // Parada intencionada: si está configurado, backup justo después de que
          // el proceso haya terminado de guardar el mundo por sí mismo.
          const current = store.getServer(server.id);
          if (current && current.autoBackup && current.autoBackup.onStop) {
            try {
              await backupManager.createBackup(current);
              send(`servers:log:${server.id}`, '\n[Backup automático tras detener el servidor]\n');
            } catch (err) {
              send(`servers:log:${server.id}`, `\n[No se pudo hacer el backup automático: ${err.message}]\n`);
            }
          }
          return;
        }

        notify('El servidor se ha caído', `"${server.name}": ${diagnosis}`);

        const current = store.getServer(server.id);
        if (current && current.autoRestart) {
          send(`servers:log:${server.id}`, '\n[El servidor se cayó solo; reiniciando automáticamente en 5s...]\n');
          setTimeout(() => {
            const stillExists = store.getServer(server.id);
            if (stillExists && !javaProcess.isRunning(server.id)) {
              launchServer(stillExists);
              startAutoBackupIntervalIfNeeded(stillExists);
            }
          }, 5000);
        }
      },
    });
  }

  /**
   * Empaqueta en outPath los mods indicados. Lo usan tanto el escritorio
   * (con diálogo de "Guardar como") como la web (que lo ofrece como descarga).
   */
  async function buildModsZip(results, outPath, onProgress) {
    const entries = results
      .filter((r) => fs.existsSync(r.file))
      .map((r) => ({ name: r.fileName, filePath: r.file }));

    if (entries.length === 0) {
      return { ok: false, error: 'No hay ficheros válidos que empaquetar.' };
    }

    await zipWriter.createZip(entries, outPath, onProgress);
    const size = fs.statSync(outPath).size;
    return { ok: true, zipPath: outPath, count: entries.length, size };
  }

  const requireServer = (id) => {
    const server = store.getServer(id);
    if (!server) throw new Error('Servidor no encontrado');
    return server;
  };

  const handlers = {
    // ---------- Servidores ----------
    'servers:list': () => store.listServers(),
    'servers:get': (id) => store.getServer(id),
    'servers:checkJava': () => serverManager.checkJava(),

    'servers:create': async (options, ctx) => {
      try {
        const server = await serverManager.createServer(options, (progress) => {
          ctx.reply('servers:createProgress', progress);
        });
        return { ok: true, server };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    'servers:delete': ({ id, deleteFiles }) => {
      serverManager.deleteServer(id, { deleteFiles });
      return true;
    },

    'servers:updateProperties': ({ id, properties }) => serverManager.updateProperties(id, properties),
    'servers:updateMemory': ({ id, memory }) => serverManager.updateMemory(id, memory),
    'servers:updateOptimizeJvm': ({ id, enabled }) => serverManager.updateOptimizeJvm(id, enabled),
    'servers:applyPerformancePreset': (id) => serverManager.applyPerformancePreset(id),

    'servers:systemMemory': () => ({
      totalMb: Math.round(os.totalmem() / 1024 / 1024),
    }),

    // ---------- Importar servidor / mundo existentes ----------
    'servers:detectExisting': (folderPath) => {
      try {
        return { ok: true, result: serverManager.detectExistingServer(folderPath) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    'servers:import': (options) => {
      try {
        const server = serverManager.importServer(options);
        return { ok: true, server };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    'servers:importWorld': ({ serverId, worldFolder }) => {
      try {
        const result = serverManager.importWorld(serverId, worldFolder);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    // ---------- Proceso del servidor ----------
    'servers:start': (id) => {
      const server = requireServer(id);
      launchServer(server);
      startAutoBackupIntervalIfNeeded(server);
      return true;
    },

    'servers:stop': ({ id, force }) => {
      javaProcess.stopServer(id, { force });
      return true;
    },

    'servers:sendCommand': ({ id, command }) => {
      javaProcess.sendCommand(id, command);
      return true;
    },

    'servers:isRunning': (id) => javaProcess.isRunning(id),
    'servers:getPlayers': (id) => javaProcess.getPlayers(id),
    'servers:resourceUsage': (id) => javaProcess.getResourceUsage(id),

    'servers:updateAutoRestart': ({ id, enabled }) => serverManager.updateAutoRestart(id, enabled),

    'servers:updateAutoBackup': ({ id, onStop, everyHours }) => {
      const server = serverManager.updateAutoBackup(id, { onStop, everyHours });
      if (javaProcess.isRunning(id)) startAutoBackupIntervalIfNeeded(server);
      return server;
    },

    // ---------- Backups ----------
    'servers:listBackups': (id) => backupManager.listBackups(requireServer(id)),

    'servers:createBackup': async (id, ctx) => {
      try {
        const server = requireServer(id);
        const result = await backupManager.createBackup(server, {
          onProgress: (info) => ctx.reply(`servers:backupProgress:${id}`, info),
        });
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    'servers:restoreBackup': ({ id, fileName }) => {
      try {
        const server = requireServer(id);
        if (javaProcess.isRunning(id)) throw new Error('Detén el servidor antes de restaurar un backup.');
        const result = backupManager.restoreBackup(server, fileName);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    'servers:deleteBackup': ({ id, fileName }) => {
      try {
        backupManager.deleteBackup(requireServer(id), fileName);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    // ---------- Whitelist / ops / baneados ----------
    'servers:readPlayerList': ({ id, kind }) => playerFiles.readList(requireServer(id).dir, kind),

    'servers:removeFromPlayerList': ({ id, kind, name }) => {
      try {
        const server = requireServer(id);
        if (javaProcess.isRunning(id)) {
          javaProcess.sendCommand(id, playerFiles.REMOVE_COMMANDS[kind](name));
          return { ok: true, live: true };
        }
        const list = playerFiles.removeByNameFromFile(server.dir, kind, name);
        return { ok: true, live: false, list };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    // ---------- Catálogo de versiones ----------
    'catalog:vanillaVersions': () => mojang.listVanillaVersions(),
    'catalog:forgeVersions': (mcVersion) => mojang.listForgeVersions(mcVersion),
    'catalog:forgeRecommended': (mcVersion) => mojang.getForgeRecommended(mcVersion),
    'catalog:neoforgeVersions': (mcVersion) => mojang.listNeoForgeVersions(mcVersion),

    // ---------- Mods ----------
    'mods:analyze': async ({ folder, serverId }) => {
      try {
        let results = await modAnalyzer.analyzeMods(folder);
        if (serverId) {
          const server = store.getServer(serverId);
          if (server) {
            const modsDir = path.join(server.dir, 'mods');
            results = await modAnalyzer.diffAgainstServer(results, modsDir);
          }
        }
        return { ok: true, results };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    'mods:apply': ({ serverId, results, includeUnknown }) => {
      try {
        const server = requireServer(serverId);
        const modsDir = path.join(server.dir, 'mods');
        const result = modAnalyzer.applyModsToServer(modsDir, results, { includeUnknown });
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };

  return { handlers, launchServer, buildModsZip };
}

module.exports = { createAppCore };
