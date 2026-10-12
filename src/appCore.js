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
 * Devuelve { handlers, launchServer, buildModsZip, backupFilePath }. Cada handler recibe
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

  // ---------------------------------------------------------------------------
  // Copias de seguridad: una cosa cada vez por servidor
  // ---------------------------------------------------------------------------
  // serverId -> 'backup' | 'restore'. Evita dos backups a la vez (un backup
  // completo puede tardar minutos) y que alguien encienda el servidor mientras
  // se está restaurando su carpeta.
  const backupJobs = new Map();

  async function runBackupJob(serverId, kind, fn) {
    const current = backupJobs.get(serverId);
    if (current) {
      throw new Error(
        current === 'restore'
          ? 'Se está restaurando un backup de este servidor; espera a que termine.'
          : 'Ya se está haciendo un backup de este servidor; espera a que termine.'
      );
    }
    backupJobs.set(serverId, kind);
    try {
      return await fn();
    } finally {
      backupJobs.delete(serverId);
    }
  }

  // Esperas a una línea concreta de la consola (p. ej. "Saved the game").
  const logWaiters = new Map(); // serverId -> Set<fn(line)>

  function waitForLog(serverId, pattern, timeoutMs) {
    return new Promise((resolve) => {
      if (!logWaiters.has(serverId)) logWaiters.set(serverId, new Set());
      const set = logWaiters.get(serverId);
      const done = (value) => {
        clearTimeout(timer);
        set.delete(check);
        resolve(value);
      };
      const check = (line) => {
        if (pattern.test(line)) done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      set.add(check);
    });
  }

  /**
   * Si el servidor está en marcha, antes de copiar se le pide que guarde todo
   * en disco y que deje de escribir el mundo mientras dura la copia (save-off),
   * para que el backup no quede a medias. Al terminar (bien o mal) vuelve a
   * guardar con normalidad (save-on).
   */
  async function withSavesPaused(server, fn) {
    const status = javaProcess.isRunning(server.id) ? javaProcess.getStatus(server.id) : null;
    if (!status || status.state !== 'online') return fn();

    let paused = false;
    try {
      javaProcess.sendCommand(server.id, 'save-off');
      paused = true;
      const saved = waitForLog(server.id, /Saved the game|Saved the world/i, 60000);
      javaProcess.sendCommand(server.id, 'save-all flush');
      await saved;
    } catch (err) {
      /* si no acepta comandos, se copia igualmente */
    }
    try {
      return await fn();
    } finally {
      if (paused && javaProcess.isRunning(server.id)) {
        try {
          javaProcess.sendCommand(server.id, 'save-on');
        } catch (err) {
          /* el servidor se ha cerrado mientras tanto */
        }
      }
    }
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
        await runBackupJob(server.id, 'backup', () =>
          withSavesPaused(server, () => backupManager.createBackup(store.getServer(server.id) || server))
        );
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
    if (backupJobs.get(server.id) === 'restore') {
      throw new Error('Se está restaurando un backup de este servidor; espera a que termine para encenderlo.');
    }
    javaProcess.startServer(server, {
      onLog: (line) => {
        send(`servers:log:${server.id}`, line);
        const waiters = logWaiters.get(server.id);
        if (waiters) for (const check of [...waiters]) check(line);
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
              await runBackupJob(server.id, 'backup', () => backupManager.createBackup(current));
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
        const result = await runBackupJob(id, 'backup', () =>
          withSavesPaused(server, () =>
            backupManager.createBackup(server, {
              onProgress: (info) => ctx.reply(`servers:backupProgress:${id}`, info),
            })
          )
        );
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    // Backup de la carpeta entera del servidor (mods, config, mundo...)
    'servers:createFullBackup': async (id, ctx) => {
      try {
        const server = requireServer(id);
        const result = await runBackupJob(id, 'backup', () =>
          withSavesPaused(server, () =>
            backupManager.createFullBackup(server, {
              onProgress: (info) => ctx.reply(`servers:backupProgress:${id}`, info),
            })
          )
        );
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    // Restaura un backup del mundo o uno completo (según el fichero elegido).
    'servers:restoreBackup': async ({ id, fileName }, ctx) => {
      try {
        const server = requireServer(id);
        if (javaProcess.isRunning(id)) throw new Error('Detén el servidor antes de restaurar un backup.');
        if (!backupManager.isFullBackup(fileName)) {
          const result = await runBackupJob(id, 'restore', async () => backupManager.restoreBackup(server, fileName));
          return { ok: true, kind: 'world', ...result };
        }
        const result = await runBackupJob(id, 'restore', async () => {
          if (javaProcess.isRunning(id)) throw new Error('Detén el servidor antes de restaurar un backup.');
          return backupManager.restoreFullBackup(server, fileName, {
            onProgress: (info) => ctx && ctx.reply && ctx.reply(`servers:backupProgress:${id}`, info),
          });
        });
        const updated = serverManager.reloadPropertiesFromDisk(id);
        return { ok: true, kind: 'full', ...result, server: updated };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    'servers:deleteBackup': ({ id, fileName }) => {
      try {
        if (backupJobs.has(id)) throw new Error('Espera a que termine el backup o la restauración en curso.');
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

  /** Ruta de un backup existente (para descargarlo o guardarlo en otro sitio). */
  function backupFilePath(id, fileName) {
    const file = backupManager.backupPath(requireServer(id), fileName);
    if (!fs.existsSync(file)) throw new Error('No se encuentra ese backup.');
    return file;
  }

  return { handlers, launchServer, buildModsZip, backupFilePath };
}

module.exports = { createAppCore, autoStopConfig };
