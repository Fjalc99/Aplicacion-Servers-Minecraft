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
const settings = require('./settings');
const duckdns = require('./duckdns');
const playit = require('./playit');

/** Primera IPv4 de la red local (la que usan los que están en tu misma WiFi). */
function lanIpv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

/**
 * Lógica compartida por la app de escritorio (main.js, vía IPC de Electron) y
 * la versión web (web/server.js, vía HTTP + WebSocket). No depende de Electron.
 *
 * deps:
 *   send(channel, payload)  -> envía un evento a la interfaz (log, jugadores, caídas...)
 *   notify(title, body, serverId) -> muestra una notificación (serverId permite
 *                                    a la web enviarla solo a quien ve ese servidor)
 *
 * Devuelve { handlers, launchServer, buildModsZip }. Cada handler recibe
 * (arg, ctx), donde arg es el mismo único argumento que manda la interfaz y
 * ctx.reply(channel, payload) envía progreso a quien hizo la petición.
 */
const AUTO_STOP_DEFAULT_MINUTES = 10;
const AUTO_STOP_MAX_MINUTES = 240;

/** Apagado automático de un servidor: activado por defecto a los 10 minutos. */
function autoStopConfig(server) {
  const config = (server && server.autoStop) || {};
  return {
    enabled: config.enabled !== false,
    minutes: Number(config.minutes) || AUTO_STOP_DEFAULT_MINUTES,
  };
}

/**
 * minuteMs solo existe para los tests (para no esperar minutos de verdad).
 */
function createAppCore({ send, notify, minuteMs = 60 * 1000 }) {
  // ---------------------------------------------------------------------------
  // Apagado automático sin jugadores
  // ---------------------------------------------------------------------------
  // serverId -> { timer, at }: cuenta atrás en marcha para apagar un servidor vacío
  const idleStops = new Map();

  function cancelIdleStop(serverId) {
    const pending = idleStops.get(serverId);
    if (pending) clearTimeout(pending.timer);
    idleStops.delete(serverId);
  }

  /**
   * Revisa si un servidor en marcha debe empezar (o dejar) la cuenta atrás:
   * solo cuenta cuando ya está "en línea" (ha cargado del todo) y no hay nadie.
   */
  function evaluateIdleStop(serverId) {
    const server = store.getServer(serverId);
    const status = javaProcess.getStatus(serverId);
    const config = autoStopConfig(server);
    const shouldCount = server && config.enabled && status.state === 'online' && status.players.length === 0;

    if (!shouldCount) {
      cancelIdleStop(serverId);
      return;
    }
    if (idleStops.has(serverId)) return; // ya está contando

    const delay = config.minutes * minuteMs;
    const timer = setTimeout(() => {
      idleStops.delete(serverId);
      const now = javaProcess.getStatus(serverId);
      if (now.state !== 'online' || now.players.length > 0) return;
      send(`servers:log:${serverId}`, `\n[Apagado automático: nadie se ha conectado en ${config.minutes} min]\n`);
      notify('Servidor apagado por inactividad', `"${server.name}" se ha apagado porque no había nadie jugando.`, serverId);
      javaProcess.stopServer(serverId, { force: false });
    }, delay);
    if (timer.unref) timer.unref();
    idleStops.set(serverId, { timer, at: Date.now() + delay });
  }

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
        notify('Servidor iniciado', `"${server.name}" ya está listo para jugar.`, server.id);
        evaluateIdleStop(server.id);
      },
      onPlayersChange: (players) => {
        send(`servers:players:${server.id}`, players);
        evaluateIdleStop(server.id);
      },
      onExit: async ({ code, crashed, recentLogText }) => {
        cancelIdleStop(server.id);
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

        notify('El servidor se ha caído', `"${server.name}": ${diagnosis}`, server.id);

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

    // Estado "para jugadores" (página de inicio del servidor)
    'servers:status': (id) => {
      const server = requireServer(id);
      const props = server.properties || {};
      return {
        ...javaProcess.getStatus(id),
        maxPlayers: Number(props['max-players']) || 20,
        port: Number(props['server-port']) || 25565,
        joinAddress: server.joinAddress || null,
        autoStop: autoStopConfig(server),
        autoStopAt: idleStops.has(id) ? idleStops.get(id).at : null,
        // Hora de este PC: la interfaz la usa para corregir si el reloj del
        // navegador (p. ej. el móvil de un amigo) va adelantado o atrasado.
        now: Date.now(),
      };
    },

    'servers:updateAutoStop': ({ id, enabled, minutes }) => {
      const server = requireServer(id);
      const value = Number(minutes);
      if (!Number.isInteger(value) || value < 1 || value > AUTO_STOP_MAX_MINUTES) {
        throw new Error(`Los minutos tienen que estar entre 1 y ${AUTO_STOP_MAX_MINUTES}.`);
      }
      server.autoStop = { enabled: Boolean(enabled), minutes: value };
      store.saveServer(server);
      // Si está en marcha, se reinicia la cuenta atrás con el ajuste nuevo.
      cancelIdleStop(id);
      if (javaProcess.isRunning(id)) evaluateIdleStop(id);
      return autoStopConfig(server);
    },

    // Dirección propia de este servidor (la de su túnel de playit.gg). Vacía = la general.
    'servers:setJoinAddress': ({ id, address }) => {
      const server = requireServer(id);
      server.joinAddress = playit.normalizeJoinAddress(address);
      store.saveServer(server);
      return server.joinAddress;
    },

    'app:playitStatus': async () => ({ running: await playit.isAgentRunning() }),

    'app:connectionInfo': () => ({ publicAddress: settings.getPublicAddress(), lanIp: lanIpv4() }),
    'app:setPublicAddress': (value) => settings.setPublicAddress(value),

    // DuckDNS (el token nunca sale de aquí: publicInfo solo dice si está puesto)
    'app:getDuckDns': () => duckdns.publicInfo(),
    'app:setDuckDns': ({ subdomain, token }) => duckdns.configure({ subdomain, token }),
    'app:updateDuckDnsNow': () => duckdns.updateNow(),
    'app:removeDuckDns': () => duckdns.remove(),
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

module.exports = { createAppCore, autoStopConfig };
