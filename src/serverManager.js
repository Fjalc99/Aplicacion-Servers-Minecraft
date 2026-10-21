const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

const { serverDir } = require('./paths');
const store = require('./store');
const mojang = require('./mojangApi');
const { downloadFile } = require('./downloader');
const { buildServerProperties, DEFAULTS } = require('./serverProperties');
const javaProcess = require('./javaProcess');

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function validateServerOptions(options) {
  if (!options || !['vanilla', 'forge', 'neoforge'].includes(options.loader)) {
    throw new Error('Elige Vanilla, Forge o NeoForge.');
  }
  if (typeof options.name !== 'string' || !options.name.trim()) {
    throw new Error('El servidor necesita un nombre.');
  }
  if (typeof options.mcVersion !== 'string' || !options.mcVersion.trim()) {
    throw new Error('Indica una versión de Minecraft.');
  }
  if (!Number.isInteger(Number(options.memory)) || Number(options.memory) < 512) {
    throw new Error('La memoria debe ser un número entero de al menos 512 MB.');
  }
  const port = Number((options.properties || {})['server-port'] || DEFAULTS['server-port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('El puerto debe estar entre 1 y 65535.');
  }
}

function normalizedProperties(properties) {
  return { ...DEFAULTS, ...(properties || {}) };
}

function checkJava() {
  const result = spawnSync('java', ['-version']);
  if (result.error) {
    return { ok: false, message: 'No se encontró Java en el PATH del sistema. Instala Java (17+ recomendado) antes de crear un servidor.' };
  }
  const version = (result.stderr || result.stdout || '').toString().split('\n')[0];
  return { ok: true, message: version };
}

function installLoader(dir, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn('java', ['-jar', 'installer.jar', '--installServer'], {
      cwd: dir,
      windowsHide: true,
    });
    child.stdout.on('data', (data) => onOutput(data.toString()));
    child.stderr.on('data', (data) => onOutput(data.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`El instalador terminó con código ${code}.`));
    });
  });
}

/**
 * options: {
 *   name, loader: 'vanilla'|'forge'|'neoforge', mcVersion, loaderVersion,
 *   memory (MB), properties: { difficulty, gamemode, ... }
 * }
 */
async function createServer(options, onProgress) {
  const log = (msg) => onProgress && onProgress({ phase: 'log', message: msg });
  validateServerOptions(options);

  const javaCheck = checkJava();
  if (!javaCheck.ok) throw new Error(javaCheck.message);

  const id = newId();
  const dir = serverDir(id);
  fs.mkdirSync(dir, { recursive: true });

  let launch;

  if (options.loader === 'vanilla') {
    log('Buscando descarga oficial del servidor…');
    const { url } = await mojang.getVanillaServerDownload(options.mcVersion);
    const jarPath = path.join(dir, 'server.jar');
    log('Descargando server.jar…');
    await downloadFile(url, jarPath, ({ received, total }) => {
      onProgress && onProgress({ phase: 'download', received, total });
    });
    launch = { type: 'jar', value: 'server.jar' };
  } else if (options.loader === 'forge' || options.loader === 'neoforge') {
    const installerPath = path.join(dir, 'installer.jar');
    let installerUrl;

    if (options.loader === 'forge') {
      installerUrl = mojang.getForgeInstallerUrl(options.mcVersion, options.loaderVersion);
    } else {
      installerUrl = mojang.getNeoForgeInstallerUrl(options.loaderVersion);
    }

    log('Descargando instalador…');
    await downloadFile(installerUrl, installerPath, ({ received, total }) => {
      onProgress && onProgress({ phase: 'download', received, total });
    });

    log('Ejecutando instalador (esto puede tardar un poco)…');
    try {
      await installLoader(dir, log);
    } catch (error) {
      throw new Error(`El instalador de ${options.loader} terminó con error. ${error.message}`);
    }

    fs.rmSync(installerPath, { force: true });
    fs.rmSync(installerPath + '.log', { force: true });

    const scriptName = os.platform() === 'win32' ? 'run.bat' : 'run.sh';
    if (fs.existsSync(path.join(dir, scriptName))) {
      launch = { type: 'script', value: scriptName };
    } else {
      // Instaladores antiguos (pre 1.17) dejan el jar del servidor directamente
      const jar = fs.readdirSync(dir).find((f) => /forge.*\.jar$/i.test(f) || /neoforge.*\.jar$/i.test(f));
      if (!jar) throw new Error('No se ha encontrado el jar/script de arranque tras la instalación.');
      launch = { type: 'jar', value: jar };
    }
  } else {
    throw new Error('Tipo de servidor no soportado: ' + options.loader);
  }

  log('Aceptando el EULA…');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');

  log('Escribiendo server.properties…');
  const properties = normalizedProperties(options.properties);
  fs.writeFileSync(path.join(dir, 'server.properties'), buildServerProperties(properties));

  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });

  const server = {
    id,
    name: options.name.trim(),
    loader: options.loader,
    mcVersion: options.mcVersion,
    loaderVersion: options.loaderVersion || null,
    dir,
    memory: Number(options.memory),
    optimizeJvm: options.optimizeJvm !== false,
    autoRestart: false,
    autoBackup: { onStop: false, everyHours: 0 },
    properties,
    launch,
    createdAt: new Date().toISOString(),
  };

  store.saveServer(server);
  log('Servidor creado correctamente.');
  return server;
}

function deleteServer(id, { deleteFiles = false } = {}) {
  const server = store.getServer(id);
  if (!server) return;
  if (javaProcess.isRunning(id)) {
    throw new Error('Detén el servidor antes de eliminarlo.');
  }
  // Una carpeta importada pertenece al usuario: eliminarla solo quita su
  // registro de la aplicación, nunca los archivos originales.
  if (deleteFiles && !server.imported) fs.rmSync(server.dir, { recursive: true, force: true });
  store.deleteServer(id);
}

function updateProperties(id, properties) {
  const server = store.getServer(id);
  if (!server) throw new Error('Servidor no encontrado');
  server.properties = normalizedProperties({ ...server.properties, ...properties });
  const port = Number(server.properties['server-port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('El puerto debe estar entre 1 y 65535.');
  }
  fs.writeFileSync(path.join(server.dir, 'server.properties'), buildServerProperties(server.properties));
  store.saveServer(server);
  return server;
}

/**
 * Memoria del proceso Java: máxima (-Xmx) y, opcionalmente, mínima (-Xms).
 * Sin mínima se usa 1 GB (o la máxima si es menor).
 */
function updateMemory(id, memoryMb, minMb) {
  const server = store.getServer(id);
  if (!server) throw new Error('Servidor no encontrado');
  const memory = Number(memoryMb);
  if (!Number.isInteger(memory) || memory < 512) {
    throw new Error('La memoria máxima debe ser un número entero de al menos 512 MB.');
  }
  let min = null;
  if (minMb !== undefined && minMb !== null && minMb !== '') {
    min = Number(minMb);
    if (!Number.isInteger(min) || min < 256) throw new Error('La memoria mínima debe ser un número entero de al menos 256 MB.');
    if (min > memory) throw new Error('La memoria mínima no puede ser mayor que la máxima.');
  }
  server.memory = memory;
  server.memoryMin = min;
  store.saveServer(server);
  // user_jvm_args.txt se pone al día ya (no solo al arrancar), conservando lo demás que tenga.
  const argsFile = path.join(server.dir, 'user_jvm_args.txt');
  if (fs.existsSync(argsFile)) {
    const { mergeUserJvmArgs } = require('./jvmFlags');
    fs.writeFileSync(argsFile, mergeUserJvmArgs(fs.readFileSync(argsFile, 'utf-8'), memory, server.optimizeJvm !== false, min));
  }
  return server;
}

/** Lo que pone ahora mismo en user_jvm_args.txt (por si se ha editado a mano). */
function readJvmArgsFile(id) {
  const server = store.getServer(id);
  if (!server) throw new Error('Servidor no encontrado');
  const file = path.join(server.dir, 'user_jvm_args.txt');
  if (!fs.existsSync(file)) return { exists: false, maxMb: null, minMb: null };
  return { exists: true, ...require('./jvmFlags').parseMemoryArgs(fs.readFileSync(file, 'utf-8')) };
}

function updateOptimizeJvm(id, enabled) {
  const server = store.getServer(id);
  if (!server) throw new Error('Servidor no encontrado');
  server.optimizeJvm = Boolean(enabled);
  store.saveServer(server);
  return server;
}

function updateAutoRestart(id, enabled) {
  const server = store.getServer(id);
  if (!server) throw new Error('Servidor no encontrado');
  server.autoRestart = Boolean(enabled);
  store.saveServer(server);
  return server;
}

function updateAutoBackup(id, settings) {
  const server = store.getServer(id);
  if (!server) throw new Error('Servidor no encontrado');
  server.autoBackup = {
    onStop: Boolean(settings.onStop),
    everyHours: settings.everyHours ? Number(settings.everyHours) : 0,
  };
  store.saveServer(server);
  return server;
}

// Ajustes de server.properties que suelen ayudar más al rendimiento en servidores
// modded, sin cambiar dificultad, modo de juego ni nada que afecte al gameplay.
const PERFORMANCE_PROPERTIES_PRESET = {
  'view-distance': 8,
  'simulation-distance': 6,
  'sync-chunk-writes': false,
  'entity-broadcast-range-percentage': 75,
  'max-tick-time': 60000,
};

function applyPerformancePreset(id) {
  const server = store.getServer(id);
  if (!server) throw new Error('Servidor no encontrado');
  server.properties = { ...server.properties, ...PERFORMANCE_PROPERTIES_PRESET };
  fs.writeFileSync(path.join(server.dir, 'server.properties'), buildServerProperties(server.properties));
  store.saveServer(server);
  return server;
}

// ---------------------------------------------------------------------------
// Importar un servidor ya existente en disco (no creado por esta app)
// ---------------------------------------------------------------------------

function parseServerProperties(content) {
  const props = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    props[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return props;
}

function normalizeDetectedProperties(raw) {
  const merged = { ...DEFAULTS };
  const numericKeys = new Set([
    'max-players',
    'server-port',
    'view-distance',
    'simulation-distance',
    'spawn-protection',
  ]);
  for (const [key, value] of Object.entries(raw)) {
    if (value === 'true') merged[key] = true;
    else if (value === 'false') merged[key] = false;
    else if (numericKeys.has(key) && value !== '' && !isNaN(Number(value))) merged[key] = Number(value);
    else merged[key] = value;
  }
  return merged;
}

/**
 * Inspecciona una carpeta que ya contiene un servidor instalado (a mano, con otro
 * launcher, etc.) y devuelve la mejor información que se puede deducir sin
 * ejecutar nada: forma de arranque, loader probable, versión de Minecraft (si
 * se puede), estado del EULA y de server.properties.
 *
 * La detección de versión de Minecraft es una aproximación (no siempre es
 * posible sin decompilar el jar), así que la UI debe dejar que el usuario la
 * confirme o corrija a mano.
 */
function detectExistingServer(folderPath) {
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error('La carpeta indicada no existe.');
  }

  const files = fs.readdirSync(folderPath);
  const hasRunSh = files.includes('run.sh');
  const hasRunBat = files.includes('run.bat');

  let launch = null;
  let loaderGuess = 'vanilla';

  if (hasRunSh || hasRunBat) {
    launch = { type: 'script', value: os.platform() === 'win32' ? 'run.bat' : 'run.sh' };
    if (!fs.existsSync(path.join(folderPath, launch.value))) {
      // El script del SO actual no existe pero sí el del otro SO: usamos el que haya
      launch.value = hasRunSh ? 'run.sh' : 'run.bat';
    }
    const librariesDir = path.join(folderPath, 'libraries', 'net');
    if (fs.existsSync(path.join(librariesDir, 'neoforged'))) loaderGuess = 'neoforge';
    else if (fs.existsSync(path.join(librariesDir, 'minecraftforge'))) loaderGuess = 'forge';
    else loaderGuess = 'forge';
  } else {
    const jar =
      files.find((f) => /^server\.jar$/i.test(f)) ||
      files.find((f) => /forge.*\.jar$/i.test(f)) ||
      files.find((f) => /neoforge.*\.jar$/i.test(f)) ||
      files.find((f) => f.toLowerCase().endsWith('.jar'));
    if (jar) {
      launch = { type: 'jar', value: jar };
      if (/neoforge/i.test(jar)) loaderGuess = 'neoforge';
      else if (/forge/i.test(jar)) loaderGuess = 'forge';
      else loaderGuess = 'vanilla';
    }
  }

  let mcVersionGuess = '';
  try {
    const versionJsonPath = path.join(folderPath, 'version.json');
    if (fs.existsSync(versionJsonPath)) {
      const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
      mcVersionGuess = versionJson.inheritsFrom || '';
    }
  } catch (e) {
    // Si el fichero no es parseable simplemente no hay pista de versión
  }
  if (!mcVersionGuess && loaderGuess === 'vanilla') {
    const jarMatch = files.join(' ').match(/(\d+\.\d+(?:\.\d+)?)/);
    if (jarMatch) mcVersionGuess = jarMatch[1];
  }

  const eulaPath = path.join(folderPath, 'eula.txt');
  const hasEula = fs.existsSync(eulaPath);
  const eulaAccepted = hasEula && /eula\s*=\s*true/i.test(fs.readFileSync(eulaPath, 'utf-8'));

  let properties = {};
  const propsPath = path.join(folderPath, 'server.properties');
  if (fs.existsSync(propsPath)) {
    properties = parseServerProperties(fs.readFileSync(propsPath, 'utf-8'));
  }

  const hasModsFolder = fs.existsSync(path.join(folderPath, 'mods'));

  return { launch, loaderGuess, mcVersionGuess, hasEula, eulaAccepted, properties, hasModsFolder };
}

/**
 * options: { folderPath, name, loader, mcVersion, loaderVersion, memory, acceptEula }
 */
function importServer(options) {
  const detection = detectExistingServer(options.folderPath);
  if (!detection.launch) {
    throw new Error('No se ha encontrado server.jar ni un script run.sh/run.bat en esa carpeta.');
  }

  if (options.acceptEula) {
    fs.writeFileSync(path.join(options.folderPath, 'eula.txt'), 'eula=true\n');
  } else if (!detection.eulaAccepted) {
    throw new Error('El EULA no está aceptado en esa carpeta. Marca la casilla para aceptarlo o acéptalo tú mismo en eula.txt.');
  }

  const properties = normalizeDetectedProperties(detection.properties);

  const server = {
    id: newId(),
    name: options.name,
    loader: options.loader || detection.loaderGuess,
    mcVersion: options.mcVersion || detection.mcVersionGuess || 'desconocida',
    loaderVersion: options.loaderVersion || null,
    dir: options.folderPath,
    memory: options.memory || 2048,
    optimizeJvm: options.optimizeJvm !== false,
    autoRestart: false,
    autoBackup: { onStop: false, everyHours: 0 },
    properties,
    launch: detection.launch,
    imported: true,
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.join(server.dir, 'mods'), { recursive: true });
  store.saveServer(server);
  return server;
}

// ---------------------------------------------------------------------------
// Importar un mundo ya existente dentro de un servidor (nuevo o importado)
// ---------------------------------------------------------------------------

/**
 * Copia una carpeta de mundo (la que contiene level.dat) dentro de la carpeta
 * del servidor, sustituyendo el mundo actual si ya existiera uno con ese
 * nombre. No se puede hacer con el servidor en marcha.
 */
function importWorld(serverId, worldSourcePath) {
  const server = store.getServer(serverId);
  if (!server) throw new Error('Servidor no encontrado.');
  if (javaProcess.isRunning(serverId)) {
    throw new Error('Detén el servidor antes de importar un mundo.');
  }
  if (!fs.existsSync(worldSourcePath) || !fs.statSync(worldSourcePath).isDirectory()) {
    throw new Error('La carpeta indicada no existe.');
  }
  if (!fs.existsSync(path.join(worldSourcePath, 'level.dat'))) {
    throw new Error('Esa carpeta no parece un mundo válido: no contiene level.dat.');
  }

  const levelName = server.properties['level-name'] || 'world';
  if (
    typeof levelName !== 'string' ||
    !levelName ||
    levelName !== path.basename(levelName) ||
    levelName === '.' ||
    levelName === '..'
  ) {
    throw new Error('El valor level-name debe ser un nombre de carpeta simple.');
  }
  const destPath = path.join(server.dir, levelName);
  const relativeDestination = path.relative(server.dir, destPath);
  if (relativeDestination.startsWith('..') || path.isAbsolute(relativeDestination)) {
    throw new Error('La carpeta de destino del mundo no es válida.');
  }

  if (fs.existsSync(destPath)) {
    fs.rmSync(destPath, { recursive: true, force: true });
  }
  fs.cpSync(worldSourcePath, destPath, { recursive: true });

  return { destPath, levelName };
}

/**
 * Tras restaurar un backup completo, server.properties del disco vuelve a ser el
 * de ese momento: se recarga en la app para que la configuración que se ve
 * coincida. El puerto se mantiene el actual (puede que ya se lo hayas dado a
 * otro servidor o que esté redirigido en playit/router).
 */
function reloadPropertiesFromDisk(id) {
  const server = store.getServer(id);
  if (!server) throw new Error('Servidor no encontrado');
  const propsPath = path.join(server.dir, 'server.properties');
  if (!fs.existsSync(propsPath)) return server;
  const currentPort = server.properties && server.properties['server-port'];
  const fromDisk = normalizeDetectedProperties(parseServerProperties(fs.readFileSync(propsPath, 'utf-8')));
  server.properties = normalizedProperties({ ...fromDisk, 'server-port': currentPort || fromDisk['server-port'] });
  if (String(fromDisk['server-port']) !== String(server.properties['server-port'])) {
    fs.writeFileSync(propsPath, buildServerProperties(server.properties));
  }
  store.saveServer(server);
  return server;
}

module.exports = {
  reloadPropertiesFromDisk,
  createServer,
  deleteServer,
  updateProperties,
  updateMemory,
  readJvmArgsFile,
  updateOptimizeJvm,
  updateAutoRestart,
  updateAutoBackup,
  applyPerformancePreset,
  checkJava,
  detectExistingServer,
  importServer,
  importWorld,
};
