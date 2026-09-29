
const state = {
  servers: [],
  selectedId: null,
  currentTab: 'overview',
  consoleBoundId: null,
  wizard: null,
  // serverId -> [{ cpuPercent, memoryMb, memoryLimitMb, timestamp }]
  usageHistory: new Map(),
};

const USAGE_POLL_MS = 2000;
const USAGE_MAX_POINTS = 90; // 3 minutos a 2 s por punto

const ICONS = {
  create: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L21 7V17L12 22L3 17V7L12 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 11V17M9 14H15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  import: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 7a1 1 0 0 1 1-1h4l2 2h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 10V16M9 13H15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  vanilla: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="16" height="16" rx="1.5" stroke="currentColor" stroke-width="1.5"/></svg>',
  forge: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M12 3V6M12 18V21M3 12H6M18 12H21M5.6 5.6L7.8 7.8M16.2 16.2L18.4 18.4M5.6 18.4L7.8 16.2M16.2 7.8L18.4 5.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
ICONS.neoforge = ICONS.forge;

// ---------------------------------------------------------------------------
// Inicialización
// ---------------------------------------------------------------------------

async function init() {
  document.getElementById('newServerBtn').addEventListener('click', openWizard);
  document.getElementById('wizardClose').addEventListener('click', closeWizard);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.getElementById('wizardOverlay').hidden) {
      closeWizard();
    }
  });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('btnStart').addEventListener('click', onStart);
  document.getElementById('btnStop').addEventListener('click', onStop);
  document.getElementById('btnOpenFolder').addEventListener('click', () =>
    window.api.openServerFolder(state.selectedId)
  );
  document.getElementById('btnDelete').addEventListener('click', onDelete);

  document.getElementById('consoleSend').addEventListener('click', sendConsoleCommand);
  document.getElementById('consoleInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendConsoleCommand();
  });

  try {
    const java = await window.api.checkJava();
    document.getElementById('javaStatusText').textContent = java.ok
      ? `Java detectado: ${java.message}`
      : java.message;
    document.getElementById('javaStatus').classList.toggle('error', !java.ok);
  } catch (error) {
    document.getElementById('javaStatusText').textContent = 'No se pudo comprobar Java.';
    document.getElementById('javaStatus').classList.add('error');
    showNotice(error.message);
  }

  try {
    await refreshServerList();
  } catch (error) {
    showNotice(`No se pudo cargar la lista de servidores: ${error.message}`);
  }

  setInterval(pollResourceUsage, USAGE_POLL_MS);
  window.addEventListener('resize', () => drawUsageCharts());
}

function showNotice(message) {
  const notice = document.getElementById('appNotice');
  notice.textContent = message;
  notice.hidden = false;
}

function clearNotice() {
  document.getElementById('appNotice').hidden = true;
}

async function refreshServerList() {
  state.servers = await window.api.listServers();
  renderSidebar();
}

function renderSidebar() {
  const list = document.getElementById('serverList');
  list.innerHTML = '';
  if (state.servers.length === 0) {
    list.innerHTML = '<div class="server-list-empty">Todavía no hay servidores.</div>';
    return;
  }
  for (const server of state.servers) {
    const el = document.createElement('div');
    el.className = 'server-item' + (server.id === state.selectedId ? ' active' : '');
    el.innerHTML = `
      <div class="name-row">
        <span class="dot" data-status-dot></span>
        <span class="name">${escapeHtml(server.name)}</span>
      </div>
      <div class="chip-row">
        <span class="chip chip-accent">${labelForLoader(server.loader)}</span>
        <span class="chip">${escapeHtml(server.mcVersion)}</span>
        ${server.access === 'owner' ? '<span class="chip">tuyo</span>' : server.owner ? `<span class="chip">de ${escapeHtml(server.owner)}</span>` : ''}
      </div>
    `;
    el.addEventListener('click', () => selectServer(server.id));
    list.appendChild(el);
    window.api.isRunning(server.id).then((running) => {
      const dot = el.querySelector('[data-status-dot]');
      if (dot) dot.classList.toggle('running', running);
    });
  }
}

function labelForLoader(loader) {
  return { vanilla: 'Vanilla', forge: 'Forge', neoforge: 'NeoForge' }[loader] || loader;
}

function formatSeconds(s) {
  if (s < 1) return '<1s';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/**
 * Pinta (o actualiza) una barra de progreso dentro de container a partir de un
 * evento { doneBytes, totalBytes, doneCount, totalCount } y calcula un tiempo
 * restante aproximado según lo que se lleva tardado hasta ahora.
 */
function renderProgressBar(container, info, startTime) {
  const fraction = info.totalBytes > 0
    ? info.doneBytes / info.totalBytes
    : (info.totalCount > 0 ? info.doneCount / info.totalCount : 0);
  const pct = Math.min(100, Math.round(fraction * 100));
  const elapsed = (Date.now() - startTime) / 1000;
  let etaText = '';
  if (fraction > 0.05 && fraction < 1) {
    const remaining = Math.max(0, elapsed / fraction - elapsed);
    etaText = ` · ~${formatSeconds(remaining)} restantes`;
  }
  container.innerHTML = `
    <div class="progress-bar-wrap">
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
      <span class="progress-bar-label">${pct}% (${info.doneCount}/${info.totalCount})${etaText}</span>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// Selección de servidor y pestañas
// ---------------------------------------------------------------------------

async function selectServer(id) {
  state.selectedId = id;
  renderSidebar();

  document.getElementById('emptyState').hidden = true;
  document.getElementById('settingsView').hidden = true;
  document.getElementById('serverView').hidden = false;

  const server = await window.api.getServer(id);
  document.getElementById('svName').textContent = server.name;
  document.getElementById('svMeta').innerHTML = `
    <span class="chip chip-accent">${labelForLoader(server.loader)}</span>
    <span class="chip">Minecraft ${escapeHtml(server.mcVersion)}</span>
    ${server.loaderVersion ? `<span class="chip">${escapeHtml(server.loaderVersion)}</span>` : ''}
  `;

  await refreshStatus(server);
  bindConsole(server);
  switchTab('home', server);
}

async function refreshStatus(server) {
  const running = await window.api.isRunning(server.id);
  document.getElementById('statusDot').className = 'status-dot ' + (running ? 'running' : 'stopped');
  document.getElementById('statusLabel').textContent = running ? 'En ejecución' : 'Detenido';
  document.getElementById('btnStart').disabled = running;
  document.getElementById('btnStop').disabled = !running;
  document.getElementById('consoleInput').disabled = !running;
  document.getElementById('consoleSend').disabled = !running;

  const sidebarItem = [...document.querySelectorAll('.server-item .name')].find(
    (el) => el.textContent === server.name
  )?.closest('.server-item');
  const dot = sidebarItem?.querySelector('[data-status-dot]');
  if (dot) dot.classList.toggle('running', running);
}

async function switchTab(tabName, serverArg) {
  state.currentTab = tabName;
  document.getElementById('serverView').dataset.tab = tabName;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  ['home', 'overview', 'config', 'mods', 'console'].forEach((t) => {
    document.getElementById(`tab-${t}`).hidden = t !== tabName;
  });
  if (tabName !== 'home') stopHomePolling();

  const server = serverArg || (await window.api.getServer(state.selectedId));
  if (tabName === 'home') renderHome(server);
  if (tabName === 'overview') renderOverview(server);
  if (tabName === 'config') renderConfig(server);
  if (tabName === 'mods') renderMods(server);
}

// ---------------------------------------------------------------------------
// Inicio (página estilo Aternos: estado, botón grande y dirección)
// ---------------------------------------------------------------------------

const HOME_STATES = {
  offline: { label: 'Apagado', button: 'Iniciar', action: 'start' },
  starting: { label: 'Iniciando…', button: 'Detener', action: 'stop' },
  online: { label: 'En línea', button: 'Detener', action: 'stop' },
  stopping: { label: 'Deteniendo…', button: 'Deteniendo…', action: null },
  queued: { label: 'En cola', button: 'Salir de la cola', action: 'leave' },
};

let homePollTimer = null;
let homeTickTimer = null;
let homeServerId = null;
let homeBusy = false;
// Último estado recibido, para que el reloj avance cada segundo entre consultas.
let homeClock = null;

function stopHomePolling() {
  if (homePollTimer) clearInterval(homePollTimer);
  if (homeTickTimer) clearInterval(homeTickTimer);
  homePollTimer = null;
  homeTickTimer = null;
  homeServerId = null;
  homeClock = null;
}

/** "3:05", "12:40" o "1:02:30". */
function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Pinta la cuenta atrás y los tiempos con la hora del PC servidor (corrigiendo la del navegador). */
function renderHomeClock() {
  const box = document.getElementById('homeCountdown');
  const subline = document.getElementById('homeSubline');
  if (!box || !subline || !homeClock) return;
  const now = Date.now() + homeClock.offset;
  const { status, shownState } = homeClock;

  const counting = status.state === 'online' && status.autoStopAt;
  box.hidden = !counting;
  if (counting) {
    const remaining = status.autoStopAt - now;
    document.getElementById('homeCountdownTime').textContent = remaining > 0 ? formatClock(remaining) : '0:00';
    box.classList.toggle('urgent', remaining <= 60000);
  }

  let text;
  if (shownState === 'queued') {
    text = `Posición ${status.queuePosition} en la cola. El PC no tiene memoria libre ahora mismo: se encenderá solo en cuanto se apague otro servidor.`;
  } else if (counting) {
    text = status.autoStopAt - now > 0 ? 'No hay nadie conectado.' : 'No hay nadie conectado: apagando…';
  } else if (status.state === 'online' && status.readyAt) {
    text = `En línea desde hace ${formatDuration(now - status.readyAt)}`;
  } else if (status.state === 'starting' && status.startedAt) {
    text = `Arrancando desde hace ${formatDuration(now - status.startedAt)}. Los servidores con muchos mods tardan varios minutos.`;
  } else if (status.state === 'stopping') {
    text = 'Guardando el mundo antes de apagarse…';
  } else {
    text = 'Pulsa Iniciar cuando quieras jugar.';
  }
  subline.textContent = text;
}

function isLocalHostname(host) {
  return !host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Qué dirección dar a los amigos: la pública configurada; si no hay y estamos
 * en la web abierta desde un dominio, ese mismo dominio; si no, la IP de la red
 * local (solo sirve para quien esté en tu misma WiFi).
 */
function resolveJoinHost(info) {
  if (info && info.publicAddress) return { host: info.publicAddress, scope: 'public' };
  const inBrowser = window.location.protocol.startsWith('http');
  if (inBrowser && !isLocalHostname(window.location.hostname)) {
    return { host: window.location.hostname, scope: 'public' };
  }
  if (info && info.lanIp) return { host: info.lanIp, scope: 'lan' };
  return { host: 'localhost', scope: 'local' };
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'menos de un minuto';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // Sin permiso de portapapeles (p. ej. web sin HTTPS): método clásico.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

async function renderHome(server) {
  const el = document.getElementById('tab-home');
  el.innerHTML = `
    <div class="home-hero" data-state="offline">
      <div class="home-state"><span class="home-dot"></span><span id="homeStateLabel">…</span></div>
      <button id="homeToggle" type="button" class="home-button">…</button>
      <div id="homeCountdown" class="home-countdown" hidden>
        <span class="home-countdown-time" id="homeCountdownTime">--:--</span>
        <span class="home-countdown-label">para el apagado automático si no entra nadie</span>
      </div>
      <p id="homeSubline" class="home-subline"></p>

      <div class="home-address">
        <span class="home-address-label">Dirección para conectarse</span>
        <div class="home-address-row">
          <code id="homeAddress">…</code>
          <button id="homeCopy" type="button" class="btn btn-ghost">Copiar</button>
        </div>
        <p id="homeAddressHint" class="hint"></p>
        <button id="homeEditAddress" type="button" class="home-link">Configurar dirección (playit.gg)</button>
      </div>

      <div class="home-stats">
        <div><span class="home-stat-value" id="homePlayers">0 / 0</span><span class="home-stat-label">jugadores</span></div>
        <div><span class="home-stat-value">${escapeHtml(labelForLoader(server.loader))}</span><span class="home-stat-label">software</span></div>
        <div><span class="home-stat-value">${escapeHtml(server.mcVersion)}</span><span class="home-stat-label">versión</span></div>
      </div>
    </div>

    <div class="card home-console-card">
      <div class="home-console-head">
        <h3>Consola</h3>
        <button id="homeOpenConsole" type="button" class="home-link">Ver consola completa</button>
      </div>
      <pre id="homeConsole" class="home-console"></pre>
    </div>
  `;

  document.getElementById('homeOpenConsole').addEventListener('click', () => switchTab('console'));
  document.getElementById('homeToggle').addEventListener('click', () => onHomeToggle(server));
  document.getElementById('homeCopy').addEventListener('click', async () => {
    const button = document.getElementById('homeCopy');
    const ok = await copyText(document.getElementById('homeAddress').textContent);
    button.textContent = ok ? '¡Copiada!' : 'No se pudo copiar';
    setTimeout(() => { if (document.getElementById('homeCopy')) button.textContent = 'Copiar'; }, 1500);
  });
  document.getElementById('homeEditAddress').addEventListener('click', openSettings);

  updateHomeConsole();
  stopHomePolling();
  homeServerId = server.id;
  await refreshHome(server);
  homePollTimer = setInterval(() => refreshHome(server), 2000);
  homeTickTimer = setInterval(renderHomeClock, 1000);
}

async function refreshHome(server) {
  if (homeServerId !== server.id) return;
  if (state.selectedId !== server.id) {
    stopHomePolling();
    return;
  }
  const hero = document.querySelector('#tab-home .home-hero');
  if (!hero) return;

  let status;
  let info;
  try {
    [status, info] = await Promise.all([
      window.api.getServerStatus(server.id),
      window.api.getConnectionInfo().catch(() => null),
    ]);
  } catch (error) {
    return; // p. ej. servidor borrado o sin conexión: el siguiente refresco lo reintenta
  }
  if (homeServerId !== server.id) return;

  const shownState = status.state === 'offline' && status.queuePosition ? 'queued' : status.state;
  const view = HOME_STATES[shownState] || HOME_STATES.offline;
  hero.dataset.state = shownState;
  document.getElementById('homeStateLabel').textContent = view.label;

  const button = document.getElementById('homeToggle');
  button.textContent = view.button;
  button.dataset.action = view.action || '';
  button.disabled = !view.action || homeBusy;

  homeClock = {
    status,
    shownState,
    offset: typeof status.now === 'number' ? status.now - Date.now() : 0,
  };
  renderHomeClock();

  document.getElementById('homePlayers').textContent = `${status.players.length} / ${status.maxPlayers}`;

  let { host, scope } = resolveJoinHost(info);
  let address = status.port === 25565 ? host : `${host}:${status.port}`;
  if (status.joinAddress) {
    // Dirección del túnel de playit de este servidor: ya lleva su propio puerto si hace falta.
    address = status.joinAddress;
    scope = 'public';
  }
  document.getElementById('homeAddress').textContent = address;
  document.getElementById('homeAddressHint').textContent =
    scope === 'public'
      ? 'En Minecraft: Multijugador → Añadir servidor, y pega esta dirección.'
      : scope === 'lan'
        ? 'Esta dirección solo funciona para quien esté en tu misma red. Para jugar desde fuera, configura la dirección pública.'
        : 'Solo funciona en este mismo equipo. Configura la dirección pública para tus amigos.';

  // El punto de estado de la lista y los botones de la cabecera, al día.
  refreshStatus(server);
}

async function onHomeToggle(server) {
  const button = document.getElementById('homeToggle');
  const action = button.dataset.action;
  if (!action || homeBusy) return;
  homeBusy = true;
  button.disabled = true;
  try {
    if (action === 'start') await onStart();
    else if (action === 'leave') await window.api.leaveStartQueue(server.id);
    else await onStop();
  } finally {
    homeBusy = false;
    setTimeout(() => refreshHome(server), 300);
  }
}

/** Últimas líneas de la consola en la página de inicio. */
function updateHomeConsole() {
  const target = document.getElementById('homeConsole');
  if (!target) return;
  const full = document.getElementById('consoleLog').textContent;
  const lines = full.slice(-6000).split('\n').filter((l) => l.trim() !== '');
  target.textContent = lines.length ? lines.slice(-12).join('\n') : 'Todavía no hay nada en la consola.';
  target.scrollTop = target.scrollHeight;
}

// ---------------------------------------------------------------------------
// Ajustes (dirección pública y DuckDNS)
// ---------------------------------------------------------------------------

function openSettings() {
  clearNotice();
  stopHomePolling();
  document.getElementById('emptyState').hidden = true;
  document.getElementById('serverView').hidden = true;
  document.getElementById('wizardOverlay').hidden = true;
  document.getElementById('settingsView').hidden = false;
  renderSettings();
}

function closeSettings() {
  document.getElementById('settingsView').hidden = true;
  if (state.selectedId) selectServer(state.selectedId);
  else document.getElementById('emptyState').hidden = false;
}

const IS_WEB = window.location.protocol.startsWith('http');

async function renderSettings() {
  const el = document.getElementById('settingsView');
  let info = null;
  let duck = { configured: false };
  let playitStatus = { running: false };
  let servers = [];
  try {
    [info, duck, playitStatus, servers] = await Promise.all([
      window.api.getConnectionInfo(),
      window.api.getDuckDns(),
      window.api.getPlayitStatus().catch(() => ({ running: false })),
      window.api.listServers(),
    ]);
  } catch (error) {
    el.innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`;
    return;
  }

  let duckStatus = '<span class="hint">Sin configurar.</span>';
  if (duck.configured && duck.lastError) {
    duckStatus = `<span class="settings-status bad">✕ ${escapeHtml(duck.lastError)}</span>`;
  } else if (duck.configured && duck.lastUpdate) {
    duckStatus = `<span class="settings-status good">✓ Funcionando: ${escapeHtml(duck.domain)} apunta a tu conexión (comprobado hace ${formatDuration(Date.now() - duck.lastUpdate)}).</span>`;
  }

  const tunnelRows = servers.map((srv) => {
    const port = Number((srv.properties || {})['server-port']) || 25565;
    return `
      <tr>
        <td>${escapeHtml(srv.name)}${srv.owner ? ` <span class="hint">(de ${escapeHtml(srv.owner)})</span>` : ''}</td>
        <td><code>127.0.0.1:${port}</code></td>
        <td><input type="text" class="tunnel-input" data-id="${escapeHtml(srv.id)}" placeholder="algo.joinmc.link" value="${escapeHtml(srv.joinAddress || '')}" /></td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="settings-head">
      <h1>Ajustes</h1>
      <button id="settingsClose" type="button" class="btn btn-ghost">Volver</button>
    </div>

    ${IS_WEB ? '<div class="card" id="webTunnelCard"><h3>Enlace de la web para tus amigos</h3><p class="hint">Cargando…</p></div>' : ''}

    <div class="card">
      <h3>Enlace para jugar: playit.gg (sin abrir puertos y sin mostrar tu IP)</h3>
      <p class="settings-line">${playitStatus.running
        ? '<span class="settings-status good">✓ El programa de playit está en marcha en este PC.</span>'
        : '<span class="settings-status bad">✕ No se detecta el programa de playit en este PC.</span>'}</p>
      <ol class="settings-steps">
        <li>Descarga e instala el programa desde <strong>playit.gg/download</strong> y ábrelo.</li>
        <li>La primera vez te dará un enlace de <em>claim</em>: ábrelo, crea tu cuenta (gratis) y vincula este PC.</li>
        <li>En el panel de playit, pulsa <em>Add tunnel</em>, elige <strong>Minecraft Java</strong> y como destino la dirección local del servidor que ves abajo.</li>
        <li>Copia la dirección que te da playit (algo como <code>xxxx.joinmc.link</code>) y pégala en su fila. Es la que verán tus amigos en Inicio.</li>
      </ol>
      <p class="hint">El plan gratis permite <strong>4 túneles</strong>, así que como mucho 4 servidores con dirección de playit. Deja el programa de playit abierto mientras se juega: si se cierra, el túnel se corta.</p>
      ${servers.length ? `
      <div class="tunnel-table-wrap">
        <table class="mods-table tunnel-table">
          <thead><tr><th>Servidor</th><th>Destino del túnel en playit</th><th>Dirección que te da playit</th></tr></thead>
          <tbody>${tunnelRows}</tbody>
        </table>
      </div>
      <div class="settings-actions"><button id="tunnelsSave" type="button" class="btn btn-accent">Guardar direcciones</button></div>
      <p id="tunnelsStatus" class="settings-line"></p>` : '<p class="hint">Todavía no hay servidores.</p>'}
    </div>

    ${IS_WEB ? '<div class="card" id="usersCard"><h3>Usuarios</h3><p class="hint">Cargando…</p></div>' : ''}

    <details class="card settings-alt">
      <summary><h3>Alternativa: abrir puertos en el router + DuckDNS</h3></summary>
      <p class="hint">Si prefieres no usar playit: reenvía en el router el puerto 25565 (y 25566–25599 para servidores de amigos) y usa DuckDNS para dar un nombre en vez de tu IP. Ojo: con este método tu IP sí se puede averiguar.</p>
      <div class="form-grid">
        <div class="field">
          <label for="duckSubdomain">Subdominio de DuckDNS</label>
          <input type="text" id="duckSubdomain" placeholder="miserver" value="${escapeHtml(duck.subdomain || '')}" autocomplete="off" />
        </div>
        <div class="field">
          <label for="duckToken">Token</label>
          <input type="password" id="duckToken" autocomplete="off" placeholder="${duck.configured ? `Guardado (${escapeHtml(duck.tokenHint)})` : 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'}" />
          ${duck.configured ? '<span class="hint">Déjalo vacío para mantener el guardado.</span>' : ''}
        </div>
      </div>
      <div class="settings-actions">
        <button id="duckSave" type="button" class="btn btn-ghost">Guardar y comprobar</button>
        ${duck.configured ? '<button id="duckUpdate" type="button" class="btn btn-ghost">Actualizar ahora</button><button id="duckRemove" type="button" class="btn btn-ghost">Quitar DuckDNS</button>' : ''}
      </div>
      <p id="duckStatus" class="settings-line">${duckStatus}</p>
      <div class="settings-actions">
        <input type="text" id="publicAddressInput" placeholder="Dirección general (tuservidor.duckdns.org)" value="${escapeHtml((info && info.publicAddress) || '')}" />
        <button id="publicAddressSave" type="button" class="btn btn-ghost">Guardar dirección general</button>
      </div>
      <p id="publicAddressStatus" class="settings-line"></p>
    </details>
  `;

  document.getElementById('settingsClose').addEventListener('click', closeSettings);

  // ---- Túneles de playit
  const tunnelsSave = document.getElementById('tunnelsSave');
  if (tunnelsSave) tunnelsSave.addEventListener('click', async () => {
    const line = document.getElementById('tunnelsStatus');
    try {
      for (const input of document.querySelectorAll('.tunnel-input')) {
        await window.api.setServerJoinAddress(input.dataset.id, input.value);
      }
      line.innerHTML = '<span class="settings-status good">✓ Guardado. Tus amigos ya ven estas direcciones en Inicio.</span>';
    } catch (error) {
      line.innerHTML = `<span class="settings-status bad">✕ ${escapeHtml(error.message)}</span>`;
    }
  });

  // ---- DuckDNS (alternativa)
  const status = document.getElementById('duckStatus');
  document.getElementById('duckSave').addEventListener('click', async (event) => {
    event.target.disabled = true;
    status.innerHTML = '<span class="hint">Comprobando con DuckDNS…</span>';
    try {
      await window.api.setDuckDns(document.getElementById('duckSubdomain').value, document.getElementById('duckToken').value);
      renderSettings();
    } catch (error) {
      status.innerHTML = `<span class="settings-status bad">✕ ${escapeHtml(error.message)}</span>`;
      event.target.disabled = false;
    }
  });
  const updateBtn = document.getElementById('duckUpdate');
  if (updateBtn) updateBtn.addEventListener('click', async () => {
    updateBtn.disabled = true;
    await window.api.updateDuckDnsNow().catch(() => {});
    renderSettings();
  });
  const removeBtn = document.getElementById('duckRemove');
  if (removeBtn) removeBtn.addEventListener('click', async () => {
    if (!confirm('¿Quitar DuckDNS? La app dejará de actualizar tu dominio.')) return;
    await window.api.removeDuckDns();
    renderSettings();
  });
  document.getElementById('publicAddressSave').addEventListener('click', async () => {
    const line = document.getElementById('publicAddressStatus');
    try {
      const saved = await window.api.setPublicAddress(document.getElementById('publicAddressInput').value);
      line.innerHTML = `<span class="settings-status good">✓ ${saved ? `Guardada: ${escapeHtml(saved)}` : 'Quitada'}</span>`;
    } catch (error) {
      line.innerHTML = `<span class="settings-status bad">✕ ${escapeHtml(error.message)}</span>`;
    }
  });

  if (IS_WEB) {
    renderWebTunnelCard();
    renderUsersCard();
  }
}

/** Enlace público de la web con Cloudflare (solo versión web). */
async function renderWebTunnelCard(preset) {
  const card = document.getElementById('webTunnelCard');
  if (!card) return;
  let tunnel = preset;
  try {
    if (!tunnel) tunnel = await window.api.getWebTunnel();
  } catch (error) {
    card.innerHTML = `<h3>Enlace de la web para tus amigos</h3><p class="error-text">${escapeHtml(error.message)}</p>`;
    return;
  }

  let body;
  if (tunnel.phase === 'running') {
    body = `
      <p class="settings-line"><span class="settings-status good">✓ Activo. Pásales este enlace a tus amigos:</span></p>
      <div class="settings-actions">
        <code class="tunnel-url" id="webTunnelUrl">${escapeHtml(tunnel.url)}</code>
        <button id="webTunnelCopy" type="button" class="btn btn-accent">Copiar</button>
        <button id="webTunnelStop" type="button" class="btn btn-ghost">Desactivar</button>
      </div>
      <p class="hint">Este enlace <strong>cambia cada vez que reinicias la web</strong> o desactivas el túnel: tendrás que volver a pasarlo.</p>`;
  } else if (tunnel.phase === 'starting') {
    body = '<p class="settings-line"><span class="hint">Pidiendo un enlace a Cloudflare… (puede tardar unos segundos)</span></p>';
  } else {
    body = `
      ${tunnel.error ? `<p class="settings-line"><span class="settings-status bad">✕ ${escapeHtml(tunnel.error)}</span></p>` : ''}
      ${tunnel.installed === false ? `
        <p class="hint">Primero instala el programa de Cloudflare (gratis, sin cuenta). En Windows, en una terminal:</p>
        <p><code>winget install --id Cloudflare.cloudflared</code></p>
        <p class="hint">Después cierra y vuelve a abrir <code>npm run web</code> para que lo encuentre.</p>` : ''}
      <div class="settings-actions">
        <button id="webTunnelStart" type="button" class="btn btn-accent">Activar enlace público</button>
      </div>`;
  }

  card.innerHTML = `
    <h3>Enlace de la web para tus amigos (Cloudflare)</h3>
    <p class="hint">Crea una dirección <code>https://….trycloudflare.com</code> para que tus amigos entren a esta web desde su casa, se registren y enciendan los mundos. Es gratis, va con HTTPS y <strong>no muestra tu IP</strong>. No hay que abrir puertos.</p>
    ${body}
    <label class="user-check settings-line"><input type="checkbox" id="webTunnelAuto" ${tunnel.autoStart ? 'checked' : ''} /> Activarlo solo cada vez que arranque la web</label>
    <p class="hint">Cualquiera con el enlace puede ver la pantalla de entrar, pero nadie puede usar la web sin una cuenta que tú hayas aprobado.</p>
  `;

  const startBtn = document.getElementById('webTunnelStart');
  if (startBtn) startBtn.addEventListener('click', async () => {
    renderWebTunnelCard({ ...tunnel, phase: 'starting', error: null });
    try {
      renderWebTunnelCard(await window.api.startWebTunnel());
    } catch (error) {
      renderWebTunnelCard({ ...tunnel, phase: 'error', error: error.message });
    }
  });
  const stopBtn = document.getElementById('webTunnelStop');
  if (stopBtn) stopBtn.addEventListener('click', async () => {
    if (!confirm('¿Desactivar el enlace público? Tus amigos no podrán entrar, y al activarlo de nuevo el enlace será otro.')) return;
    renderWebTunnelCard(await window.api.stopWebTunnel());
  });
  const copyBtn = document.getElementById('webTunnelCopy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const ok = await copyText(tunnel.url);
    copyBtn.textContent = ok ? '¡Copiado!' : 'No se pudo copiar';
    setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 1500);
  });
  document.getElementById('webTunnelAuto').addEventListener('change', async (event) => {
    await window.api.setWebTunnelAutostart(event.target.checked);
  });
}

/** Gestión de cuentas (solo versión web): aprobar registros, roles, comandos, contraseñas. */
async function renderUsersCard() {
  const card = document.getElementById('usersCard');
  if (!card) return;
  let users;
  try {
    users = await window.api.listUsers();
  } catch (error) {
    card.innerHTML = `<h3>Usuarios</h3><p class="error-text">${escapeHtml(error.message)}</p>`;
    return;
  }
  const me = document.body.dataset.user || '';
  const pending = users.filter((u) => u.status === 'pendiente');
  const active = users.filter((u) => u.status !== 'pendiente');

  const pendingHtml = pending.length
    ? pending.map((u) => `
      <div class="user-row pending">
        <span class="user-name">${escapeHtml(u.username)}</span>
        <span class="hint">se registró ${new Date(u.createdAt).toLocaleString()}</span>
        <span class="user-actions">
          <button type="button" class="btn btn-accent" data-user-action="approve" data-user="${escapeHtml(u.username)}">Aprobar</button>
          <button type="button" class="btn btn-ghost" data-user-action="reject" data-user="${escapeHtml(u.username)}">Rechazar</button>
        </span>
      </div>`).join('')
    : '<p class="hint">No hay cuentas esperando aprobación.</p>';

  const activeHtml = active.map((u) => {
    const isMe = u.username.toLowerCase() === me.toLowerCase();
    return `
      <div class="user-row">
        <span class="user-name">${escapeHtml(u.username)}${isMe ? ' <span class="hint">(tú)</span>' : ''}</span>
        <select data-user-action="role" data-user="${escapeHtml(u.username)}" ${isMe ? 'disabled' : ''}>
          <option value="amigo" ${u.role === 'amigo' ? 'selected' : ''}>Amigo</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option>
        </select>
        ${u.role === 'amigo' ? `<label class="user-check"><input type="checkbox" data-user-action="commands" data-user="${escapeHtml(u.username)}" ${u.canSendCommands ? 'checked' : ''} /> Puede escribir comandos en tus servidores</label>` : '<span></span>'}
        <span class="user-actions">
          <button type="button" class="btn btn-ghost" data-user-action="reset" data-user="${escapeHtml(u.username)}">Nueva contraseña</button>
          ${isMe ? '' : `<button type="button" class="btn btn-ghost" data-user-action="delete" data-user="${escapeHtml(u.username)}">Borrar</button>`}
        </span>
      </div>`;
  }).join('');

  card.innerHTML = `
    <h3>Usuarios</h3>
    <p class="hint">Quien quiera entrar se crea la cuenta en la pantalla de inicio de sesión ("Crear una") y aparece aquí para que la apruebes.</p>
    <h4 class="users-subtitle">Pendientes de aprobar${pending.length ? ` (${pending.length})` : ''}</h4>
    ${pendingHtml}
    <h4 class="users-subtitle">Cuentas activas</h4>
    ${activeHtml}
    <p id="usersStatus" class="settings-line"></p>
  `;

  const say = (html) => { document.getElementById('usersStatus').innerHTML = html; };
  const fail = (error) => say(`<span class="settings-status bad">✕ ${escapeHtml(error.message)}</span>`);

  card.querySelectorAll('button[data-user-action]').forEach((btn) => btn.addEventListener('click', async () => {
    const { userAction, user } = btn.dataset;
    try {
      if (userAction === 'approve') await window.api.approveUser(user);
      if (userAction === 'reject') {
        if (!confirm(`¿Rechazar y borrar la solicitud de "${user}"?`)) return;
        await window.api.rejectUser(user);
      }
      if (userAction === 'delete') {
        if (!confirm(`¿Borrar la cuenta de "${user}"? Sus servidores no se borran.`)) return;
        await window.api.deleteUser(user);
      }
      if (userAction === 'reset') {
        if (!confirm(`¿Crear una contraseña nueva para "${user}"? La actual dejará de funcionar.`)) return;
        const temporary = await window.api.resetUserPassword(user);
        await renderUsersCard();
        say(`<span class="settings-status good">Contraseña temporal de <strong>${escapeHtml(user)}</strong>: <code>${escapeHtml(temporary)}</code>. Pásasela por privado; podrá cambiarla con "Cambiar contraseña" abajo a la derecha. Solo se muestra esta vez.</span>`);
        return;
      }
      await renderUsersCard();
    } catch (error) {
      fail(error);
    }
  }));

  card.querySelectorAll('select[data-user-action="role"]').forEach((select) => select.addEventListener('change', async () => {
    try {
      await window.api.setUserRole(select.dataset.user, select.value);
      await renderUsersCard();
    } catch (error) {
      fail(error);
      await renderUsersCard();
    }
  }));

  card.querySelectorAll('input[data-user-action="commands"]').forEach((box) => box.addEventListener('change', async () => {
    try {
      await window.api.setUserCommands(box.dataset.user, box.checked);
    } catch (error) {
      fail(error);
    }
  }));
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------

function renderOverview(server) {
  const el = document.getElementById('tab-overview');
  el.innerHTML = `
    <div class="card">
      <h3>Rendimiento en vivo</h3>
      <div class="usage-grid">
        <div class="usage-chart">
          <div class="usage-chart-head"><span>CPU</span><strong id="usageCpuValue">—</strong></div>
          <canvas id="usageCpuCanvas" height="120"></canvas>
        </div>
        <div class="usage-chart">
          <div class="usage-chart-head"><span>RAM</span><strong id="usageRamValue">—</strong></div>
          <canvas id="usageRamCanvas" height="120"></canvas>
        </div>
      </div>
      <p class="hint" id="usageHint">Servidor detenido.</p>
    </div>
    <div class="card">
      <h3>Información general</h3>
      <div class="kv-grid">
        <div class="kv"><span class="k">Tipo</span><span class="v">${labelForLoader(server.loader)}</span></div>
        <div class="kv"><span class="k">Versión de Minecraft</span><span class="v">${escapeHtml(server.mcVersion)}</span></div>
        <div class="kv"><span class="k">Versión del loader</span><span class="v">${escapeHtml(server.loaderVersion || '—')}</span></div>
        <div class="kv"><span class="k">Puerto</span><span class="v">${server.properties['server-port'] || 25565}</span></div>
        <div class="kv"><span class="k">Memoria asignada</span><span class="v">${server.memory} MB</span></div>
        <div class="kv"><span class="k">Carpeta</span><span class="v">${escapeHtml(server.dir)}</span></div>
      </div>
    </div>
    <div class="card">
      <h3>Reglas del mundo</h3>
      <div class="kv-grid">
        <div class="kv"><span class="k">Dificultad</span><span class="v">${server.properties.difficulty}</span></div>
        <div class="kv"><span class="k">Modo de juego</span><span class="v">${server.properties.gamemode}</span></div>
        <div class="kv"><span class="k">Jugadores máx.</span><span class="v">${server.properties['max-players']}</span></div>
        <div class="kv"><span class="k">PvP</span><span class="v">${server.properties.pvp ? 'Activado' : 'Desactivado'}</span></div>
        <div class="kv"><span class="k">Whitelist</span><span class="v">${server.properties['white-list'] ? 'Activada' : 'Desactivada'}</span></div>
      </div>
    </div>
    <div class="card">
      <h3>Mundo</h3>
      <p class="hint" style="margin-top:0;">Carpeta actual: <strong>${escapeHtml(server.properties['level-name'] || 'world')}</strong>. Importar un mundo sustituye el actual si existe.</p>
      <button id="importWorldBtn" class="btn btn-accent">Importar mundo desde carpeta</button>
      <div id="importWorldMsg" class="hint" style="margin-top:8px;"></div>
    </div>
    <div class="card">
      <h3>Copias de seguridad</h3>
      <p class="hint" style="margin-top:0;">Comprime la carpeta del mundo tal cual está ahora. Se guardan en <code>backups/</code> dentro de la carpeta del servidor (se conservan las 10 más recientes).</p>
      <button id="backupNowBtn" class="btn btn-accent">Backup ahora</button>
      <div id="backupNowMsg" class="hint" style="margin-top:8px;"></div>
      <div id="backupsList" style="margin-top:14px;"><p class="hint">Cargando…</p></div>
    </div>
    <div class="card">
      <h3>Usar como plantilla</h3>
      <p class="hint" style="margin-top:0;">Crea un servidor nuevo con la misma configuración (tipo, versión, memoria, flags de JVM y server.properties). No se copian el mundo ni los mods. Podrás revisar y cambiar todo antes de crearlo.</p>
      <button id="cloneServerBtn" class="btn btn-ghost">Clonar como plantilla</button>
    </div>
  `;

  refreshBackupsList(server);
  drawUsageCharts();

  document.getElementById('cloneServerBtn').addEventListener('click', () => openCloneWizard(server));

  document.getElementById('backupNowBtn').addEventListener('click', async () => {
    const btn = document.getElementById('backupNowBtn');
    const msg = document.getElementById('backupNowMsg');
    btn.disabled = true;
    msg.innerHTML = '<div class="progress-bar-wrap"><div class="progress-bar-track"><div class="progress-bar-fill" style="width:0%"></div></div><span class="progress-bar-label">Preparando…</span></div>';

    const startTime = Date.now();
    window.api.onBackupProgress(server.id, (info) => renderProgressBar(msg, info, startTime));

    const result = await window.api.createBackup(server.id);
    window.api.removeBackupProgressListeners(server.id);
    btn.disabled = false;
    if (!result.ok) {
      msg.innerHTML = `<span class="error-text">Error: ${escapeHtml(result.error)}</span>`;
      return;
    }
    const mb = (result.size / 1024 / 1024).toFixed(1);
    msg.textContent = `Backup creado (${mb} MB).`;
    refreshBackupsList(server);
  });

  document.getElementById('importWorldBtn').addEventListener('click', async () => {
    const folder = await window.api.pickWorldFolder();
    if (!folder) return;
    const running = await window.api.isRunning(server.id);
    if (running) {
      alert('Detén el servidor antes de importar un mundo.');
      return;
    }
    const confirmImport = confirm(
      'Esto sustituirá el mundo actual del servidor (si existe) por el que has elegido. ¿Continuar?'
    );
    if (!confirmImport) return;

    const btn = document.getElementById('importWorldBtn');
    const msg = document.getElementById('importWorldMsg');
    btn.disabled = true;
    msg.textContent = 'Importando…';

    const result = await window.api.importWorld(server.id, folder);
    btn.disabled = false;
    msg.textContent = result.ok
      ? `Mundo importado en "${result.levelName}".`
      : `Error: ${result.error}`;
  });
}

async function refreshBackupsList(server) {
  const el = document.getElementById('backupsList');
  if (!el) return;

  let backups;
  try {
    backups = await window.api.listBackups(server.id);
  } catch (error) {
    el.innerHTML = `<span class="error-text">Error al listar backups: ${escapeHtml(error.message)}</span>`;
    return;
  }

  if (backups.length === 0) {
    el.innerHTML = '<p class="hint">Todavía no hay ninguna copia de seguridad.</p>';
    return;
  }

  el.innerHTML = `
    <table class="mods-table">
      <thead><tr><th>Fecha</th><th>Tamaño</th><th></th></tr></thead>
      <tbody>
        ${backups
          .map(
            (b) => `
          <tr>
            <td>${new Date(b.createdAt).toLocaleString()}</td>
            <td>${(b.size / 1024 / 1024).toFixed(1)} MB</td>
            <td style="display:flex; gap:6px;">
              <button class="btn btn-ghost" data-action="restore" data-file="${escapeHtml(b.fileName)}">Restaurar</button>
              <button class="btn btn-ghost" data-action="delete" data-file="${escapeHtml(b.fileName)}">Eliminar</button>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;

  el.querySelectorAll('button[data-action="restore"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const running = await window.api.isRunning(server.id);
      if (running) {
        alert('Detén el servidor antes de restaurar un backup.');
        return;
      }
      const ok = confirm(
        'Esto sustituirá el mundo actual por el del backup. El mundo actual no se borra, se renombra por seguridad. ¿Continuar?'
      );
      if (!ok) return;
      const result = await window.api.restoreBackup(server.id, btn.dataset.file);
      if (!result.ok) {
        alert('Error: ' + result.error);
        return;
      }
      alert('Backup restaurado correctamente.');
    });
  });

  el.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = confirm('¿Eliminar este backup? No se puede deshacer.');
      if (!ok) return;
      await window.api.deleteBackup(server.id, btn.dataset.file);
      refreshBackupsList(server);
    });
  });
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

async function renderConfig(server) {
  const p = server.properties;
  const el = document.getElementById('tab-config');
  const sysMem = await window.api.getSystemMemory();
  const recommendedMax = Math.floor((sysMem.totalMb * 0.7) / 256) * 256;

  el.innerHTML = `
    <div class="card">
      <h3>Memoria del proceso Java</h3>
      <div class="form-grid">
        <div class="field">
          <label>Memoria asignada (MB)</label>
          <input type="number" id="cfgMemory" min="512" step="256" value="${server.memory}" />
        </div>
      </div>
      <p class="hint">Tu PC tiene ${(sysMem.totalMb / 1024).toFixed(1)} GB de RAM en total. Como orientación, no conviene pasar de ~${(recommendedMax / 1024).toFixed(1)} GB para este servidor si también vas a jugar en la misma máquina a la vez.</p>
    </div>
    <div class="card">
      <h3>Rendimiento</h3>
      <div class="field field-inline">
        <input type="checkbox" id="cfgOptimizeJvm" ${server.optimizeJvm !== false ? 'checked' : ''} />
        <label for="cfgOptimizeJvm">Usar flags de JVM optimizados (Aikar's flags) para reducir lag por recolección de basura</label>
      </div>
      <p class="hint">Ajusta el recolector de basura de Java (G1GC) con una configuración muy usada en servidores de Minecraft para evitar tirones. No cambia el gameplay, solo cómo Java gestiona la memoria. Se aplica la próxima vez que inicies el servidor.</p>
      <button id="cfgApplyPreset" class="btn btn-ghost" style="margin-top:10px;">Aplicar ajustes de rendimiento recomendados</button>
      <p class="hint">Reduce distancia de visión/simulación y otros parámetros de <code>server.properties</code> a valores que suelen aliviar bastante la carga en servidores modded, sin tocar dificultad ni modo de juego.</p>
    </div>
    <div class="card">
      <h3>Fiabilidad</h3>
      <div class="field field-inline">
        <input type="checkbox" id="cfgAutoStop" ${server.autoStop && server.autoStop.enabled === false ? '' : 'checked'} />
        <label for="cfgAutoStop">Apagar solo si no hay nadie jugando durante</label>
        <input type="number" id="cfgAutoStopMinutes" min="1" max="240" step="1" style="width:80px;" value="${(server.autoStop && server.autoStop.minutes) || 10}" />
        <span>minutos</span>
      </div>
      <p class="hint">Como en Aternos: la cuenta atrás empieza cuando el servidor termina de cargar y no hay nadie conectado, y se cancela en cuanto entra alguien. Así un servidor olvidado no se queda ocupando memoria.</p>
      <p id="cfgAutoStopStatus" class="hint"></p>

      <div class="field field-inline" style="margin-top:14px;">
        <input type="checkbox" id="cfgAutoRestart" ${server.autoRestart ? 'checked' : ''} />
        <label for="cfgAutoRestart">Reiniciar automáticamente si el servidor se cae solo</label>
      </div>
      <p class="hint">Si el proceso termina sin que tú hayas pulsado "Detener" (un crash), se reinicia solo a los 5 segundos.</p>

      <div class="field field-inline" style="margin-top:14px;">
        <input type="checkbox" id="cfgAutoBackupStop" ${server.autoBackup && server.autoBackup.onStop ? 'checked' : ''} />
        <label for="cfgAutoBackupStop">Hacer backup automático cada vez que se detiene el servidor</label>
      </div>
      <div class="field" style="margin-top:10px; max-width:260px;">
        <label>Backup automático cada X horas mientras está en marcha (0 = desactivado)</label>
        <input type="number" id="cfgAutoBackupHours" min="0" step="1" value="${(server.autoBackup && server.autoBackup.everyHours) || 0}" />
      </div>
      <button id="cfgSaveReliability" class="btn btn-ghost" style="margin-top:12px;">Guardar</button>
      <span id="cfgReliabilitySaved" class="hint" style="margin-left:10px;"></span>
    </div>
    <div class="card">
      <h3>server.properties</h3>
      <div class="form-grid">
        <div class="field">
          <label>Dificultad</label>
          <select id="cfgDifficulty">
            ${['peaceful', 'easy', 'normal', 'hard'].map((d) => `<option value="${d}" ${p.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Modo de juego</label>
          <select id="cfgGamemode">
            ${['survival', 'creative', 'adventure', 'spectator'].map((g) => `<option value="${g}" ${p.gamemode === g ? 'selected' : ''}>${g}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Jugadores máximos</label>
          <input type="number" id="cfgMaxPlayers" min="1" value="${p['max-players']}" />
        </div>
        <div class="field">
          <label>Puerto</label>
          <input type="number" id="cfgPort" value="${p['server-port']}" />
        </div>
        <div class="field">
          <label>MOTD</label>
          <input type="text" id="cfgMotd" value="${escapeHtml(p.motd)}" />
        </div>
        <div class="field">
          <label>Semilla del mundo</label>
          <input type="text" id="cfgSeed" value="${escapeHtml(p['level-seed'] || '')}" />
        </div>
        <div class="field">
          <label>Distancia de visión</label>
          <input type="number" id="cfgViewDistance" value="${p['view-distance']}" />
        </div>
        <div class="field field-inline">
          <input type="checkbox" id="cfgPvp" ${p.pvp ? 'checked' : ''} />
          <label for="cfgPvp">PvP activado</label>
        </div>
        <div class="field field-inline">
          <input type="checkbox" id="cfgWhitelist" ${p['white-list'] ? 'checked' : ''} />
          <label for="cfgWhitelist">Whitelist activada</label>
        </div>
        <div class="field field-inline">
          <input type="checkbox" id="cfgOnlineMode" ${p['online-mode'] ? 'checked' : ''} />
          <label for="cfgOnlineMode">Modo online (cuentas premium)</label>
        </div>
        <div class="field field-inline">
          <input type="checkbox" id="cfgCommandBlock" ${p['enable-command-block'] ? 'checked' : ''} />
          <label for="cfgCommandBlock">Bloques de comandos</label>
        </div>
      </div>
      <p class="hint">Los cambios se aplican al reiniciar el servidor.</p>
      <button id="cfgSave" class="btn btn-accent" style="margin-top:12px;">Guardar cambios</button>
      <span id="cfgSaved" class="hint" style="margin-left:10px;"></span>
    </div>
  `;

  document.getElementById('cfgOptimizeJvm').addEventListener('change', async (e) => {
    try {
      await window.api.updateOptimizeJvm(server.id, e.target.checked);
    } catch (error) {
      showNotice(`No se pudo guardar la preferencia de JVM: ${error.message}`);
    }
  });

  const saveAutoStop = async () => {
    const line = document.getElementById('cfgAutoStopStatus');
    try {
      const saved = await window.api.updateAutoStop(
        server.id,
        document.getElementById('cfgAutoStop').checked,
        Number(document.getElementById('cfgAutoStopMinutes').value)
      );
      line.textContent = saved.enabled ? `Guardado: se apagará tras ${saved.minutes} min sin jugadores.` : 'Guardado: el apagado automático está desactivado.';
    } catch (error) {
      line.textContent = error.message;
    }
  };
  document.getElementById('cfgAutoStop').addEventListener('change', saveAutoStop);
  document.getElementById('cfgAutoStopMinutes').addEventListener('change', saveAutoStop);

  document.getElementById('cfgAutoRestart').addEventListener('change', async (e) => {
    try {
      await window.api.updateAutoRestart(server.id, e.target.checked);
    } catch (error) {
      showNotice(`No se pudo guardar la preferencia de reinicio automático: ${error.message}`);
    }
  });

  document.getElementById('cfgSaveReliability').addEventListener('click', async () => {
    try {
      const onStop = document.getElementById('cfgAutoBackupStop').checked;
      const everyHours = Number(document.getElementById('cfgAutoBackupHours').value) || 0;
      await window.api.updateAutoBackup(server.id, onStop, everyHours);
      document.getElementById('cfgReliabilitySaved').textContent = 'Guardado.';
      setTimeout(() => (document.getElementById('cfgReliabilitySaved').textContent = ''), 2000);
    } catch (error) {
      showNotice(`No se pudieron guardar los ajustes de backup automático: ${error.message}`);
    }
  });

  document.getElementById('cfgApplyPreset').addEventListener('click', async () => {
    try {
      await window.api.applyPerformancePreset(server.id);
      document.getElementById('cfgSaved').textContent = 'Ajustes de rendimiento aplicados.';
      const updated = await window.api.getServer(server.id);
      renderConfig(updated);
    } catch (error) {
      showNotice(`No se pudieron aplicar los ajustes de rendimiento: ${error.message}`);
    }
  });

  document.getElementById('cfgSave').addEventListener('click', async () => {
    try {
      const memory = Number(document.getElementById('cfgMemory').value);
      await window.api.updateMemory(server.id, memory);
      const properties = {
        difficulty: document.getElementById('cfgDifficulty').value,
        gamemode: document.getElementById('cfgGamemode').value,
        'max-players': Number(document.getElementById('cfgMaxPlayers').value),
        'server-port': Number(document.getElementById('cfgPort').value),
        motd: document.getElementById('cfgMotd').value,
        'level-seed': document.getElementById('cfgSeed').value,
        'view-distance': Number(document.getElementById('cfgViewDistance').value),
        pvp: document.getElementById('cfgPvp').checked,
        'white-list': document.getElementById('cfgWhitelist').checked,
        'online-mode': document.getElementById('cfgOnlineMode').checked,
        'enable-command-block': document.getElementById('cfgCommandBlock').checked,
      };
      await window.api.updateProperties(server.id, properties);
      document.getElementById('cfgSaved').textContent = 'Guardado.';
      setTimeout(() => (document.getElementById('cfgSaved').textContent = ''), 2000);
    } catch (error) {
      document.getElementById('cfgSaved').textContent = `Error: ${error.message}`;
      showNotice(`No se pudo guardar la configuración: ${error.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------

let lastModAnalysis = [];

function renderMods(server) {
  const el = document.getElementById('tab-mods');
  const isVanilla = server.loader === 'vanilla';
  el.innerHTML = `
    ${isVanilla ? '<p class="hint">Este servidor es Vanilla: no admite mods. Puedes usarlo con datapacks manualmente.</p>' : ''}
    <div class="mods-toolbar">
      <button id="pickModsBtn" class="btn btn-accent" ${isVanilla ? 'disabled' : ''}>Elegir carpeta de mods del cliente</button>
      <span id="modsFolderLabel" class="hint"></span>
    </div>
    <div id="modsResult"></div>
  `;
  if (isVanilla) return;

  document.getElementById('pickModsBtn').addEventListener('click', async () => {
    const folder = await window.api.pickModsFolder();
    if (!folder) return;
    document.getElementById('modsFolderLabel').textContent = folder;
    document.getElementById('modsResult').innerHTML = '<p class="hint">Analizando mods contra Modrinth…</p>';
    const res = await window.api.analyzeMods(folder, server.id);
    if (!res.ok) {
      document.getElementById('modsResult').innerHTML = `<p class="error-text">${escapeHtml(res.error)}</p>`;
      return;
    }
    lastModAnalysis = res.results;
    renderModsTable(server);
  });
}

function renderModsTable(server) {
  const container = document.getElementById('modsResult');
  if (lastModAnalysis.length === 0) {
    container.innerHTML = '<p class="hint">No se han encontrado archivos .jar en esa carpeta.</p>';
    return;
  }

  const badge = (status) => {
    if (status === 'needed') return '<span class="badge badge-needed">Necesario en servidor</span>';
    if (status === 'client-only') return '<span class="badge badge-client">Solo cliente</span>';
    return '<span class="badge badge-unknown">No identificado</span>';
  };

  const serverStateBadge = (serverState) => {
    if (serverState === 'new') return '<span class="badge badge-unknown">Nuevo</span>';
    if (serverState === 'different') return '<span class="badge badge-needed">Actualización</span>';
    if (serverState === 'same') return '<span class="badge">Ya está igual</span>';
    return '';
  };

  const row = (m, i, checkClass) => {
    // Si ya sabemos que en el servidor está exactamente igual, no hace falta
    // volver a copiarlo: se desmarca por defecto (el usuario puede marcarlo si quiere).
    const defaultChecked = m.serverState !== 'same';
    return `
      <tr>
        <td><input type="checkbox" class="${checkClass}" data-i="${i}" ${defaultChecked ? 'checked' : ''} /></td>
        <td>${escapeHtml(m.name)}</td>
        <td>${badge(m.status)}</td>
        <td>${serverStateBadge(m.serverState)}</td>
        <td>${m.modrinthUrl ? `<a href="${m.modrinthUrl}" target="_blank">Modrinth</a>` : '—'}</td>
      </tr>`;
  };

  const serverRows = lastModAnalysis
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.status !== 'client-only')
    .map(({ m, i }) => row(m, i, 'modCheckServer'))
    .join('');

  const clientRows = lastModAnalysis
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.status === 'client-only')
    .map(({ m, i }) => row(m, i, 'modCheckClient'))
    .join('');

  container.innerHTML = `
    <h3 style="margin-top:0;">Mods para el servidor (${serverRows ? serverRows.split('<tr>').length - 1 : 0})</h3>
    ${serverRows ? `
    <table class="mods-table">
      <thead><tr><th>Copiar</th><th>Mod</th><th>Estado</th><th>En el servidor</th><th></th></tr></thead>
      <tbody>${serverRows}</tbody>
    </table>
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
      <button id="applyModsBtn" class="btn btn-accent">Copiar seleccionados a la carpeta mods del servidor</button>
      <button id="exportServerZipBtn" class="btn btn-ghost">Generar ZIP con los seleccionados</button>
    </div>
    ` : '<p class="hint">Ninguno de los mods analizados hace falta en el servidor.</p>'}

    <h3 style="margin-top:26px;">Mods solo de cliente (${clientRows ? clientRows.split('<tr>').length - 1 : 0})</h3>
    ${clientRows ? `
    <p class="hint" style="margin-top:0;">Estos mods no van al servidor (son de interfaz/gráficos/etc. y el servidor los rechazaría o los ignoraría). Aquí los tienes aparte por si quieres, por ejemplo, generar el pack de cliente para tus amigos.</p>
    <table class="mods-table">
      <thead><tr><th>Incluir</th><th>Mod</th><th>Estado</th><th>En el servidor</th><th></th></tr></thead>
      <tbody>${clientRows}</tbody>
    </table>
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
      <button id="exportClientZipBtn" class="btn btn-ghost">Generar ZIP con los mods de cliente</button>
    </div>
    ` : '<p class="hint">No se ha detectado ningún mod exclusivo de cliente en esta carpeta.</p>'}

    <div id="applyModsResult" class="hint" style="margin-top:14px;"></div>
  `;

  const applyModsBtn = document.getElementById('applyModsBtn');
  if (applyModsBtn) applyModsBtn.addEventListener('click', async () => {
    try {
      const checked = [...document.querySelectorAll('.modCheckServer')]
        .filter((c) => c.checked)
        .map((c) => lastModAnalysis[Number(c.dataset.i)]);
      const result = await window.api.applyMods(server.id, checked, true);

      if (!result.ok) {
        document.getElementById('applyModsResult').innerHTML = `<span class="error-text">Error: ${escapeHtml(result.error)}</span>`;
        return;
      }

      const parts = [
        `${result.copiedNew.length} nuevos`,
        result.copiedOverwritten.length ? `${result.copiedOverwritten.length} ya existían (sobrescritos)` : null,
        result.skipped.length ? `${result.skipped.length} omitidos` : null,
        result.failed.length ? `${result.failed.length} fallaron` : null,
      ].filter(Boolean);

      let html = `<strong>Carpeta destino:</strong> ${escapeHtml(result.destination)}<br>${parts.join(' · ')}`;

      if (result.failed.length) {
        html += `<br><span class="error-text">No se pudieron dejar en el servidor: ${result.failed.map((f) => escapeHtml(f.fileName)).join(', ')}. Si desaparecen justo después de copiarse, revisa que el antivirus no los esté bloqueando (algunos marcan los .jar de mods como sospechosos) y añade esa carpeta como excepción.</span>`;
      } else if (result.copiedNew.length === 0 && result.copiedOverwritten.length > 0) {
        html += `<br><span class="hint">Todos los seleccionados ya estaban en esa carpeta con el mismo nombre: por eso no ves cambios al abrirla.</span>`;
      }

      document.getElementById('applyModsResult').innerHTML = html;
    } catch (error) {
      document.getElementById('applyModsResult').innerHTML = `<span class="error-text">Error: ${escapeHtml(error.message)}</span>`;
      showNotice(`No se pudieron copiar los mods: ${error.message}`);
    }
  });

  async function exportZip(checkboxClass, destinationHint) {
    const resultEl = document.getElementById('applyModsResult');
    try {
      const checked = [...document.querySelectorAll(`.${checkboxClass}`)]
        .filter((c) => c.checked)
        .map((c) => lastModAnalysis[Number(c.dataset.i)]);

      if (checked.length === 0) {
        resultEl.innerHTML = '<span class="error-text">No has seleccionado ningún mod.</span>';
        return;
      }

      resultEl.textContent = 'Elige dónde guardar el ZIP…';
      const startTime = Date.now();
      window.api.onModsExportProgress((info) => renderProgressBar(resultEl, info, startTime));

      const result = await window.api.exportModsZip(server.id, checked);
      window.api.removeModsExportProgressListeners();

      if (result.canceled) {
        resultEl.textContent = '';
        return;
      }
      if (!result.ok) {
        resultEl.innerHTML = `<span class="error-text">Error: ${escapeHtml(result.error)}</span>`;
        return;
      }

      const mb = (result.size / 1024 / 1024).toFixed(1);
      resultEl.innerHTML = `
        ZIP creado con ${result.count} mods (${mb} MB):<br>
        <strong>${escapeHtml(result.zipPath)}</strong><br>
        <span class="hint">${destinationHint}</span>
        <br><button id="showZipBtn" class="btn btn-ghost" style="margin-top:8px;">Mostrar en la carpeta</button>
      `;
      document.getElementById('showZipBtn').addEventListener('click', () => {
        window.api.showInFolder(result.zipPath);
      });
    } catch (error) {
      window.api.removeModsExportProgressListeners();
      resultEl.innerHTML = `<span class="error-text">Error: ${escapeHtml(error.message)}</span>`;
      showNotice(`No se pudo generar el ZIP: ${error.message}`);
    }
  }

  const exportServerZipBtn = document.getElementById('exportServerZipBtn');
  if (exportServerZipBtn) exportServerZipBtn.addEventListener('click', () =>
    exportZip('modCheckServer', 'Descomprímelo y copia su contenido dentro de la carpeta mods de tu servidor.')
  );

  const exportClientZipBtn = document.getElementById('exportClientZipBtn');
  if (exportClientZipBtn) exportClientZipBtn.addEventListener('click', () =>
    exportZip('modCheckClient', 'Este ZIP es para el pack de cliente (repártelo a tus amigos), no va en la carpeta mods del servidor.')
  );
}

// ---------------------------------------------------------------------------
// Consola
// ---------------------------------------------------------------------------

function bindConsole(server) {
  if (state.consoleBoundId === server.id) {
    refreshPlayers(server.id);
    refreshPlayerListPanel(server);
    return;
  }
  if (state.consoleBoundId) window.api.removeLogListeners(state.consoleBoundId);
  state.consoleBoundId = server.id;
  document.getElementById('consoleLog').textContent = '';

  window.api.onLog(server.id, (line) => appendConsole(line));
  window.api.onExit(server.id, ({ code, crashed, diagnosis }) => {
    if (crashed) {
      appendConsole(`\n[El servidor se cayó inesperadamente (código ${code})]\n[Diagnóstico automático: ${diagnosis}]\n`);
      showNotice(`"${server.name}" se ha caído: ${diagnosis}`);
    } else {
      appendConsole('\n[Proceso finalizado]\n');
    }
    refreshStatus(server);
    renderPlayers([]);
  });
  window.api.onPlayersChange(server.id, (players) => renderPlayers(players));

  refreshPlayers(server.id);
  bindPlayerListTabs(server);
}

// ---------------------------------------------------------------------------
// Whitelist / operadores / baneados
// ---------------------------------------------------------------------------

const PLAYER_LIST_LABELS = {
  whitelist: { empty: 'La whitelist está vacía.', kind: 'whitelist' },
  ops: { empty: 'No hay operadores.', kind: 'ops' },
  bans: { empty: 'No hay nadie baneado.', kind: 'bans' },
};

let currentPlayerListKind = 'whitelist';

function bindPlayerListTabs(server) {
  document.querySelectorAll('.mini-tab').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.mini-tab').forEach((b) => b.classList.toggle('active', b === btn));
      currentPlayerListKind = btn.dataset.list;
      refreshPlayerListPanel(server);
    };
  });
  refreshPlayerListPanel(server);
}

async function refreshPlayerListPanel(server) {
  const panel = document.getElementById('playerListPanel');
  if (!panel) return;
  const kind = currentPlayerListKind;
  panel.innerHTML = '<p class="hint">Cargando…</p>';

  try {
    const list = await window.api.readPlayerList(server.id, kind);
    if (!list || list.length === 0) {
      panel.innerHTML = `<p class="hint">${PLAYER_LIST_LABELS[kind].empty}</p>`;
      return;
    }
    panel.innerHTML = list
      .map((entry) => {
        const name = entry.name || '(sin nombre)';
        const extra = kind === 'ops' ? ` · nivel ${entry.level ?? '?'}` : kind === 'bans' && entry.reason ? ` · ${escapeHtml(entry.reason)}` : '';
        return `
          <div class="plist-row">
            <span>${escapeHtml(name)}${extra}</span>
            <button type="button" class="btn btn-ghost" data-remove="${escapeHtml(name)}">Quitar</button>
          </div>`;
      })
      .join('');

    panel.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const result = await window.api.removeFromPlayerList(server.id, kind, btn.dataset.remove);
          if (!result.ok) {
            showNotice(`No se pudo quitar: ${result.error}`);
            btn.disabled = false;
            return;
          }
          refreshPlayerListPanel(server);
        } catch (error) {
          showNotice(error.message);
          btn.disabled = false;
        }
      });
    });
  } catch (error) {
    panel.innerHTML = `<p class="error-text">Error: ${escapeHtml(error.message)}</p>`;
  }
}

async function refreshPlayers(serverId) {
  try {
    const running = await window.api.isRunning(serverId);
    if (!running) {
      renderPlayers(null);
      return;
    }
    const players = await window.api.getPlayers(serverId);
    renderPlayers(players);
  } catch (error) {
    renderPlayers(null);
  }
}

function renderPlayers(players) {
  const el = document.getElementById('playersList');
  if (!el) return;

  if (players === null) {
    el.innerHTML = '<p class="hint">Servidor detenido.</p>';
    return;
  }
  if (players.length === 0) {
    el.innerHTML = '<p class="hint">Nadie conectado ahora mismo.</p>';
    return;
  }

  el.innerHTML = players
    .map(
      (name) => `
      <div class="player-row">
        <div class="player-name">${escapeHtml(name)}</div>
        <div class="player-actions">
          <button class="btn btn-ghost" data-action="op" data-player="${escapeHtml(name)}">OP</button>
          <button class="btn btn-ghost" data-action="kick" data-player="${escapeHtml(name)}">Kick</button>
          <button class="btn btn-danger" data-action="ban" data-player="${escapeHtml(name)}">Ban</button>
        </div>
      </div>`
    )
    .join('');

  el.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { action, player } = btn.dataset;
      const commands = { op: `op ${player}`, kick: `kick ${player}`, ban: `ban ${player}` };
      appendConsole(`\n> ${commands[action]}\n`);
      try {
        await window.api.sendCommand(state.selectedId, commands[action]);
      } catch (error) {
        showNotice(error.message);
      }
    });
  });
}

const CONSOLE_MAX_CHARS = 250000; // ~250 KB de log en pantalla; evita que la ventana crezca sin límite en sesiones largas

function appendConsole(text) {
  const log = document.getElementById('consoleLog');
  log.textContent += text;
  if (log.textContent.length > CONSOLE_MAX_CHARS) {
    const excess = log.textContent.length - CONSOLE_MAX_CHARS;
    const cutAt = log.textContent.indexOf('\n', excess);
    log.textContent = log.textContent.slice(cutAt === -1 ? excess : cutAt + 1);
  }
  log.scrollTop = log.scrollHeight;
  if (state.currentTab === 'home') updateHomeConsole();
}

async function sendConsoleCommand() {
  const input = document.getElementById('consoleInput');
  const command = input.value.trim();
  if (!command) return;
  appendConsole(`\n> ${command}\n`);
  input.value = '';
  try {
    await window.api.sendCommand(state.selectedId, command);
  } catch (error) {
    appendConsole(`\n[ERROR] ${error.message}\n`);
    showNotice(error.message);
  }
}

// ---------------------------------------------------------------------------
// Acciones de servidor
// ---------------------------------------------------------------------------

async function onStart() {
  try {
    state.usageHistory.set(state.selectedId, []);
    const result = await window.api.startServer(state.selectedId);
    // En Inicio la propia tarjeta ya lo explica; el aviso es para las demás pestañas.
    if (result && result.queued && state.currentTab !== 'home') {
      showNotice(`El PC no tiene memoria libre ahora mismo. Tu servidor está en la cola (posición ${result.position}) y se encenderá solo en cuanto se apague otro.`);
    }
    const server = await window.api.getServer(state.selectedId);
    await refreshStatus(server);
    renderPlayers([]);
  } catch (error) {
    showNotice(`No se pudo iniciar el servidor: ${error.message}`);
  }
}

async function onStop() {
  try {
    await window.api.stopServer(state.selectedId, false);
    setTimeout(async () => {
      const server = await window.api.getServer(state.selectedId);
      if (server) await refreshStatus(server);
    }, 500);
  } catch (error) {
    showNotice(`No se pudo detener el servidor: ${error.message}`);
  }
}

async function onDelete() {
  try {
    const server = await window.api.getServer(state.selectedId);
    if (!server) return;
    const deleteFiles = !server.imported;
    const message = server.imported
      ? `¿Quitar "${server.name}" de la aplicación? La carpeta original no se borrará.`
      : `¿Eliminar "${server.name}"? También se borrarán los ficheros del servidor creados por la aplicación.`;
    const confirmDelete = confirm(message);
    if (!confirmDelete) return;
    await window.api.deleteServer(server.id, deleteFiles);
    state.selectedId = null;
    document.getElementById('serverView').hidden = true;
    document.getElementById('emptyState').hidden = false;
    await refreshServerList();
  } catch (error) {
    showNotice(`No se pudo eliminar el servidor: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Asistente de creación de servidor
// ---------------------------------------------------------------------------

function defaultWizardData() {
  return {
    name: '',
    loader: 'vanilla',
    mcVersion: '',
    loaderVersion: '',
    memory: 2048,
    optimizeJvm: true,
    worldImportPath: null,
    properties: {
      difficulty: 'normal',
      gamemode: 'survival',
      'max-players': 20,
      pvp: true,
      motd: 'Servidor de Minecraft',
      'white-list': false,
      'online-mode': true,
      'server-port': 25565,
      'view-distance': 10,
    },
  };
}

function defaultImportData() {
  return {
    folderPath: '',
    name: '',
    loader: 'forge',
    mcVersion: '',
    loaderVersion: '',
    memory: 2048,
    acceptEula: true,
    detection: null,
  };
}

function openWizard() {
  clearNotice();
  state.wizard = {
    mode: null,
    stepStack: ['entry'],
    data: defaultWizardData(),
    importData: defaultImportData(),
    versionsCache: {},
  };
  document.getElementById('emptyState').hidden = true;
  document.getElementById('serverView').hidden = true;
  document.getElementById('settingsView').hidden = true;
  document.getElementById('wizardOverlay').hidden = false;
  renderWizardEntry();
}

/**
 * Abre el asistente de creación normal, pero con los datos de un servidor
 * existente ya rellenados. Reutiliza todo el flujo de creación (descarga,
 * instalador, EULA, server.properties…); el mundo y los mods no se copian.
 */
function openCloneWizard(server) {
  openWizard();
  const data = defaultWizardData();
  data.name = `${server.name} (copia)`;
  data.loader = ['vanilla', 'forge', 'neoforge'].includes(server.loader) ? server.loader : 'vanilla';
  // Los servidores importados pueden tener versión "desconocida": que la elija el usuario
  data.mcVersion = /^\d+\.\d+/.test(server.mcVersion || '') ? server.mcVersion : '';
  data.loaderVersion = data.loader === 'vanilla' ? '' : server.loaderVersion || '';
  data.memory = server.memory || 2048;
  data.optimizeJvm = server.optimizeJvm !== false;
  data.properties = { ...data.properties, ...(server.properties || {}) };
  // Mismo puerto que el original = no podrían estar los dos encendidos a la vez
  const port = Number(data.properties['server-port']) || 25565;
  data.properties['server-port'] = port < 65535 ? port + 1 : port - 1;

  state.wizard.mode = 'create';
  state.wizard.data = data;
  state.wizard.stepStack = ['basics'];
  state.wizard.cloneOf = server.name;
  safeRenderWizardStep();
}

function closeWizard() {
  const overlay = document.getElementById('wizardOverlay');
  if (!overlay) return;
  overlay.hidden = true;
  state.wizard = null;
  const hasSelectedServer = Boolean(state.selectedId);
  document.getElementById('emptyState').hidden = hasSelectedServer;
  document.getElementById('serverView').hidden = !hasSelectedServer;
}

function currentStep() {
  const stack = state.wizard.stepStack;
  return stack[stack.length - 1];
}

function goToStep(name) {
  state.wizard.stepStack.push(name);
  safeRenderWizardStep();
}

function goBack() {
  const stack = state.wizard.stepStack;
  if (stack.length <= 1) return closeWizard();
  stack.pop();
  safeRenderWizardStep();
}

function safeRenderWizardStep() {
  void renderWizardStep().catch((error) => {
    const body = document.getElementById('wizardBody');
    body.innerHTML = `<p class="error-text">No se pudo cargar este paso: ${escapeHtml(error.message)}</p>`;
    const backBtn = document.getElementById('wizardBack');
    backBtn.hidden = false;
    backBtn.textContent = 'Volver';
    backBtn.onclick = goBack;
    document.getElementById('wizardNext').hidden = true;
  });
}

function renderWizardEntry() {
  const body = document.getElementById('wizardBody');
  const nextBtn = document.getElementById('wizardNext');
  const backBtn = document.getElementById('wizardBack');

  document.getElementById('wizardTitle').textContent = 'Nuevo servidor';
  nextBtn.hidden = true;
  nextBtn.disabled = false;
  backBtn.hidden = false;
  backBtn.textContent = 'Cancelar';
  backBtn.onclick = closeWizard;
  body.innerHTML = `
    <div class="loader-options">
      <div class="loader-card" data-mode="create">
        ${ICONS.create}
        <div class="title">Crear servidor nuevo</div>
        <div class="sub">Vanilla, Forge o NeoForge desde cero</div>
      </div>
      <div class="loader-card" data-mode="import">
        ${ICONS.import}
        <div class="title">Importar servidor existente</div>
        <div class="sub">Ya tienes la carpeta del servidor en tu PC</div>
      </div>
    </div>
  `;
  body.querySelectorAll('.loader-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.wizard.mode = card.dataset.mode;
      goToStep(card.dataset.mode === 'create' ? 'basics' : 'importPick');
    });
  });
}

async function renderWizardStep() {
  if (!state.wizard) return;
  const wizardAtStart = state.wizard;
  const step = currentStep();
  const body = document.getElementById('wizardBody');
  const nextBtn = document.getElementById('wizardNext');
  const backBtn = document.getElementById('wizardBack');

  nextBtn.textContent = 'Siguiente';
  nextBtn.onclick = () => advanceWizard();
  nextBtn.disabled = false;
  nextBtn.hidden = false;
  backBtn.hidden = false;
  backBtn.textContent = state.wizard.stepStack.length <= 1 ? 'Cancelar' : 'Atrás';
  backBtn.onclick = goBack;

  const titleEl = document.getElementById('wizardTitle');
  if (step === 'entry') titleEl.textContent = 'Nuevo servidor';
  else if (state.wizard.mode === 'import') titleEl.textContent = 'Importar servidor existente';
  else if (state.wizard.cloneOf) titleEl.textContent = `Clonar "${state.wizard.cloneOf}"`;
  else titleEl.textContent = 'Crear servidor nuevo';

  if (step === 'entry') {
    renderWizardEntry();
    return;
  }

  if (step === 'basics') {
    body.innerHTML = `
      <div class="field" style="margin-bottom:18px;">
        <label>Nombre del servidor</label>
        <input type="text" id="wName" value="${escapeHtml(state.wizard.data.name)}" placeholder="Mi servidor" />
      </div>
      <div class="field">
        <label>Tipo de servidor</label>
        <div class="loader-options">
          ${['vanilla', 'forge', 'neoforge'].map((l) => `
            <div class="loader-card ${state.wizard.data.loader === l ? 'selected' : ''}" data-loader="${l}">
              ${ICONS[l]}
              <div class="title">${labelForLoader(l)}</div>
              <div class="sub">${l === 'vanilla' ? 'Sin mods' : 'Soporta mods'}</div>
            </div>`).join('')}
        </div>
      </div>
    `;
    body.querySelectorAll('.loader-card').forEach((card) => {
      card.addEventListener('click', () => {
        state.wizard.data.loader = card.dataset.loader;
        safeRenderWizardStep();
      });
    });
  }

  if (step === 'mcversion') {
    body.innerHTML = `<p class="hint">Cargando versiones de Minecraft…</p>`;
    try {
      const versions = state.wizard.versionsCache.vanilla || (await window.api.listVanillaVersions());
      if (state.wizard !== wizardAtStart || currentStep() !== step) return;
      if (!Array.isArray(versions) || versions.length === 0) {
        throw new Error('No hay versiones de Minecraft disponibles.');
      }
      state.wizard.versionsCache.vanilla = versions;
      if (!versions.some((v) => v.id === state.wizard.data.mcVersion)) {
        state.wizard.data.mcVersion = versions[0].id;
        state.wizard.data.loaderVersion = '';
      }
      body.innerHTML = `
        <div class="field">
          <label>Versión de Minecraft</label>
          <select id="wMcVersion">
            ${versions.map((v) => `<option value="${v.id}" ${state.wizard.data.mcVersion === v.id ? 'selected' : ''}>${v.id}</option>`).join('')}
          </select>
        </div>
      `;
      document.getElementById('wMcVersion').addEventListener('change', (e) => {
        state.wizard.data.mcVersion = e.target.value;
        state.wizard.data.loaderVersion = '';
      });
    } catch (error) {
      if (state.wizard !== wizardAtStart) return;
      body.innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`;
      nextBtn.disabled = true;
    }
  }

  if (step === 'loaderversion') {
    body.innerHTML = `<p class="hint">Buscando versiones de ${labelForLoader(state.wizard.data.loader)} para ${state.wizard.data.mcVersion}…</p>`;
    try {
      let versions = [];
      if (state.wizard.data.loader === 'forge') {
        versions = await window.api.listForgeVersions(state.wizard.data.mcVersion);
      } else {
        versions = await window.api.listNeoForgeVersions(state.wizard.data.mcVersion);
      }
      if (state.wizard !== wizardAtStart || currentStep() !== step) return;
      if (versions.length === 0) {
        body.innerHTML = `<p class="error-text">No se han encontrado versiones de ${labelForLoader(state.wizard.data.loader)} para Minecraft ${state.wizard.data.mcVersion}. Prueba otra versión de Minecraft.</p>`;
        return;
      }
      if (!versions.includes(state.wizard.data.loaderVersion)) state.wizard.data.loaderVersion = versions[0];
      body.innerHTML = `
        <div class="field">
          <label>Versión de ${labelForLoader(state.wizard.data.loader)}</label>
          <select id="wLoaderVersion">
            ${versions.map((v) => `<option value="${v}" ${state.wizard.data.loaderVersion === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
      `;
      document.getElementById('wLoaderVersion').addEventListener('change', (e) => {
        state.wizard.data.loaderVersion = e.target.value;
      });
    } catch (err) {
      if (state.wizard !== wizardAtStart) return;
      body.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
      nextBtn.disabled = true;
    }
  }

  if (step === 'settings') {
    const p = state.wizard.data.properties;
    body.innerHTML = `
      <div class="form-grid">
        <div class="field">
          <label>Dificultad</label>
          <select id="wDifficulty">
            ${['peaceful', 'easy', 'normal', 'hard'].map((d) => `<option value="${d}" ${p.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Modo de juego</label>
          <select id="wGamemode">
            ${['survival', 'creative', 'adventure', 'spectator'].map((g) => `<option value="${g}" ${p.gamemode === g ? 'selected' : ''}>${g}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Jugadores máximos</label>
          <input type="number" id="wMaxPlayers" min="1" value="${p['max-players']}" />
        </div>
        <div class="field">
          <label>Puerto</label>
          <input type="number" id="wPort" value="${p['server-port']}" />
        </div>
        <div class="field">
          <label>MOTD</label>
          <input type="text" id="wMotd" value="${escapeHtml(p.motd)}" />
        </div>
        <div class="field">
          <label>Memoria (MB)</label>
          <input type="number" id="wMemory" min="512" step="256" value="${state.wizard.data.memory}" />
        </div>
        <div class="field field-inline">
          <input type="checkbox" id="wPvp" ${p.pvp ? 'checked' : ''} />
          <label for="wPvp">PvP activado</label>
        </div>
        <div class="field field-inline">
          <input type="checkbox" id="wWhitelist" ${p['white-list'] ? 'checked' : ''} />
          <label for="wWhitelist">Whitelist activada</label>
        </div>
        <div class="field field-inline">
          <input type="checkbox" id="wOnlineMode" ${p['online-mode'] ? 'checked' : ''} />
          <label for="wOnlineMode">Modo online (cuentas premium)</label>
        </div>
        <div class="field field-inline">
          <input type="checkbox" id="wOptimizeJvm" ${state.wizard.data.optimizeJvm ? 'checked' : ''} />
          <label for="wOptimizeJvm">Flags de JVM optimizados (recomendado, reduce lag)</label>
        </div>
      </div>
      <div class="field" style="margin-top:16px;">
        <label>Mundo existente (opcional)</label>
        <div>
          <button type="button" id="wPickWorld" class="btn btn-ghost">Elegir carpeta de mundo</button>
        </div>
        <span class="hint" id="wWorldLabel">${state.wizard.data.worldImportPath ? escapeHtml(state.wizard.data.worldImportPath) : 'Si no eliges nada, se generará un mundo nuevo.'}</span>
      </div>
    `;
    document.getElementById('wPickWorld').addEventListener('click', async () => {
      const folder = await window.api.pickWorldFolder();
      if (!folder) return;
      state.wizard.data.worldImportPath = folder;
      document.getElementById('wWorldLabel').textContent = folder;
    });
  }

  if (step === 'review') {
    const d = state.wizard.data;
    body.innerHTML = `
      <div class="card">
        <h3>Revisión</h3>
        <div class="kv-grid">
          <div class="kv"><span class="k">Nombre</span><span class="v">${escapeHtml(d.name)}</span></div>
          <div class="kv"><span class="k">Tipo</span><span class="v">${labelForLoader(d.loader)}</span></div>
          <div class="kv"><span class="k">Minecraft</span><span class="v">${d.mcVersion}</span></div>
          ${d.loader !== 'vanilla' ? `<div class="kv"><span class="k">Loader</span><span class="v">${d.loaderVersion}</span></div>` : ''}
          <div class="kv"><span class="k">Memoria</span><span class="v">${d.memory} MB</span></div>
          <div class="kv"><span class="k">Dificultad</span><span class="v">${d.properties.difficulty}</span></div>
        </div>
      </div>
      <p class="hint">Al crear el servidor se descargarán los ficheros necesarios y se aceptará el EULA automáticamente.</p>
    `;
    nextBtn.textContent = 'Crear servidor';
  }

  if (step === 'creating') {
    nextBtn.hidden = true;
    backBtn.hidden = true;
    body.innerHTML = `<div class="progress-log" id="creationLog">Preparando…\n</div>`;
    runCreation();
  }

  // ---- Flujo de importar servidor existente ----

  if (step === 'importPick') {
    const imp = state.wizard.importData;
    body.innerHTML = `
      <div class="field" style="margin-bottom:14px;">
        <button type="button" id="iPickFolder" class="btn btn-accent">Elegir carpeta del servidor</button>
        <div class="hint" id="iFolderLabel" style="margin-top:8px;">${imp.folderPath ? escapeHtml(imp.folderPath) : 'Selecciona la carpeta donde ya tienes el servidor instalado (la que contiene server.jar o run.sh/run.bat).'}</div>
      </div>
      <div id="iDetection"></div>
    `;
    nextBtn.disabled = !(imp.detection && imp.detection.launch);

    document.getElementById('iPickFolder').addEventListener('click', async () => {
      const folder = await window.api.pickServerFolder();
      if (!folder) return;
      imp.folderPath = folder;
      document.getElementById('iFolderLabel').textContent = folder;
      document.getElementById('iDetection').innerHTML = '<p class="hint">Analizando la carpeta…</p>';
      nextBtn.disabled = true;

      const detection = await window.api.detectExistingServer(folder);
      if (!detection.ok) {
        document.getElementById('iDetection').innerHTML = `<p class="error-text">${escapeHtml(detection.error)}</p>`;
        return;
      }
      imp.detection = detection.result;
      imp.loader = detection.result.loaderGuess;
      imp.mcVersion = detection.result.mcVersionGuess || '';
      if (!imp.name) {
        const parts = folder.split(/[\\/]/).filter(Boolean);
        imp.name = parts[parts.length - 1] || 'Servidor importado';
      }
      renderImportDetection(imp);
      nextBtn.disabled = !detection.result.launch;
    });
  }

  if (step === 'importDetails') {
    const imp = state.wizard.importData;
    body.innerHTML = `
      <div class="form-grid">
        <div class="field">
          <label>Nombre del servidor</label>
          <input type="text" id="iName" value="${escapeHtml(imp.name)}" />
        </div>
        <div class="field">
          <label>Tipo</label>
          <select id="iLoader">
            ${['vanilla', 'forge', 'neoforge'].map((l) => `<option value="${l}" ${imp.loader === l ? 'selected' : ''}>${labelForLoader(l)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Versión de Minecraft</label>
          <input type="text" id="iMcVersion" placeholder="p. ej. 1.20.1" value="${escapeHtml(imp.mcVersion || '')}" />
        </div>
        <div class="field">
          <label>Versión del loader (opcional)</label>
          <input type="text" id="iLoaderVersion" value="${escapeHtml(imp.loaderVersion || '')}" />
        </div>
        <div class="field">
          <label>Memoria (MB)</label>
          <input type="number" id="iMemory" min="512" step="256" value="${imp.memory}" />
        </div>
        ${!imp.detection.eulaAccepted ? `
        <div class="field field-inline">
          <input type="checkbox" id="iAcceptEula" ${imp.acceptEula ? 'checked' : ''} />
          <label for="iAcceptEula">Aceptar el EULA automáticamente</label>
        </div>` : ''}
      </div>
      <p class="hint">La versión de Minecraft no siempre se puede detectar automáticamente: revísala antes de continuar.</p>
    `;
  }

  if (step === 'importReview') {
    const imp = state.wizard.importData;
    body.innerHTML = `
      <div class="card">
        <h3>Revisión</h3>
        <div class="kv-grid">
          <div class="kv"><span class="k">Carpeta</span><span class="v">${escapeHtml(imp.folderPath)}</span></div>
          <div class="kv"><span class="k">Nombre</span><span class="v">${escapeHtml(imp.name)}</span></div>
          <div class="kv"><span class="k">Tipo</span><span class="v">${labelForLoader(imp.loader)}</span></div>
          <div class="kv"><span class="k">Minecraft</span><span class="v">${escapeHtml(imp.mcVersion)}</span></div>
          <div class="kv"><span class="k">Memoria</span><span class="v">${imp.memory} MB</span></div>
        </div>
      </div>
      <p class="hint">No se modificará el mundo ni los mods que ya tenga esa carpeta.</p>
    `;
    nextBtn.textContent = 'Importar servidor';
  }

  if (step === 'importing') {
    nextBtn.hidden = true;
    backBtn.hidden = true;
    body.innerHTML = `<div class="progress-log" id="importLog">Importando…\n</div>`;
    runImport();
  }
}

function renderImportDetection(imp) {
  const d = imp.detection;
  document.getElementById('iDetection').innerHTML = `
    <div class="card">
      <h3>Detectado automáticamente</h3>
      <div class="kv-grid">
        <div class="kv"><span class="k">Arranque</span><span class="v">${d.launch ? d.launch.value : 'No encontrado'}</span></div>
        <div class="kv"><span class="k">Loader probable</span><span class="v">${labelForLoader(d.loaderGuess)}</span></div>
        <div class="kv"><span class="k">Versión de Minecraft</span><span class="v">${d.mcVersionGuess || 'No detectada'}</span></div>
        <div class="kv"><span class="k">EULA</span><span class="v">${d.eulaAccepted ? 'Ya aceptado' : d.hasEula ? 'Presente, no aceptado' : 'No encontrado'}</span></div>
        <div class="kv"><span class="k">Carpeta de mods</span><span class="v">${d.hasModsFolder ? 'Sí' : 'No'}</span></div>
      </div>
      ${!d.launch ? '<p class="error-text">No se ha encontrado server.jar ni run.sh/run.bat. Comprueba que sea la carpeta correcta.</p>' : ''}
    </div>
  `;
}

function collectSettingsStep() {
  const d = state.wizard.data;
  d.properties.difficulty = document.getElementById('wDifficulty').value;
  d.properties.gamemode = document.getElementById('wGamemode').value;
  d.properties['max-players'] = Number(document.getElementById('wMaxPlayers').value);
  d.properties['server-port'] = Number(document.getElementById('wPort').value);
  d.properties.motd = document.getElementById('wMotd').value;
  d.properties.pvp = document.getElementById('wPvp').checked;
  d.properties['white-list'] = document.getElementById('wWhitelist').checked;
  d.properties['online-mode'] = document.getElementById('wOnlineMode').checked;
  d.memory = Number(document.getElementById('wMemory').value);
  d.optimizeJvm = document.getElementById('wOptimizeJvm').checked;
}

function advanceWizard() {
  const step = currentStep();

  if (step === 'basics') {
    const name = document.getElementById('wName').value.trim();
    if (!name) { alert('Ponle un nombre al servidor.'); return; }
    state.wizard.data.name = name;
    return goToStep('mcversion');
  }

  if (step === 'mcversion') {
    if (state.wizard.data.loader === 'vanilla') return goToStep('settings');
    return goToStep('loaderversion');
  }

  if (step === 'loaderversion') return goToStep('settings');

  if (step === 'settings') {
    collectSettingsStep();
    return goToStep('review');
  }

  if (step === 'review') return goToStep('creating');

  if (step === 'importPick') return goToStep('importDetails');

  if (step === 'importDetails') {
    collectImportDetails();
    const imp = state.wizard.importData;
    if (!imp.name.trim()) { alert('Ponle un nombre al servidor.'); return; }
    if (!imp.mcVersion.trim()) { alert('Indica la versión de Minecraft (no se ha podido detectar sola).'); return; }
    return goToStep('importReview');
  }

  if (step === 'importReview') return goToStep('importing');
}

function collectImportDetails() {
  const imp = state.wizard.importData;
  imp.name = document.getElementById('iName').value.trim();
  imp.loader = document.getElementById('iLoader').value;
  imp.mcVersion = document.getElementById('iMcVersion').value.trim();
  imp.loaderVersion = document.getElementById('iLoaderVersion').value.trim();
  imp.memory = Number(document.getElementById('iMemory').value);
  const eulaCheckbox = document.getElementById('iAcceptEula');
  if (eulaCheckbox) imp.acceptEula = eulaCheckbox.checked;
}

async function runImport() {
  const log = (msg) => {
    const el = document.getElementById('importLog');
    if (el) { el.textContent += msg; el.scrollTop = el.scrollHeight; }
  };

  const imp = state.wizard.importData;
  log(`Registrando "${imp.name}"…\n`);

  let result;
  try {
    result = await window.api.importServer({
      folderPath: imp.folderPath,
      name: imp.name,
      loader: imp.loader,
      mcVersion: imp.mcVersion,
      loaderVersion: imp.loaderVersion || null,
      memory: imp.memory,
      acceptEula: imp.detection.eulaAccepted ? false : imp.acceptEula,
    });
  } catch (error) {
    result = { ok: false, error: error.message };
  }

  if (!result.ok) {
    log(`\n[ERROR] ${result.error}\n`);
    const backBtn = document.getElementById('wizardBack');
    backBtn.hidden = false;
    backBtn.textContent = 'Cerrar';
    backBtn.onclick = closeWizard;
    return;
  }

  log('\nServidor importado correctamente.\n');
  await refreshServerList();
  closeWizard();
  selectServer(result.server.id);
}

async function runCreation() {
  const log = (msg) => {
    const el = document.getElementById('creationLog');
    if (el) { el.textContent += msg; el.scrollTop = el.scrollHeight; }
  };

  window.api.removeCreateProgressListeners();
  window.api.onCreateProgress((progress) => {
    if (progress.phase === 'log') log(progress.message + '\n');
    if (progress.phase === 'download' && progress.total) {
      const pct = Math.round((progress.received / progress.total) * 100);
      log(`\rDescargando… ${pct}%`);
    }
  });

  const d = state.wizard.data;
  let result;
  try {
    result = await window.api.createServer({
      name: d.name,
      loader: d.loader,
      mcVersion: d.mcVersion,
      loaderVersion: d.loaderVersion,
      memory: d.memory,
      optimizeJvm: d.optimizeJvm,
      properties: d.properties,
    });
  } catch (error) {
    result = { ok: false, error: error.message };
  }

  if (!result.ok) {
    log(`\n[ERROR] ${result.error}\n`);
    document.getElementById('wizardBack').hidden = false;
    document.getElementById('wizardBack').textContent = 'Cerrar';
    document.getElementById('wizardBack').onclick = closeWizard;
    return;
  }

  if (d.worldImportPath) {
    log('\nImportando el mundo elegido…\n');
    const worldResult = await window.api.importWorld(result.server.id, d.worldImportPath);
    log(worldResult.ok ? 'Mundo importado correctamente.\n' : `[AVISO] No se pudo importar el mundo: ${worldResult.error}\n`);
  }

  log('\nListo. Abriendo el servidor…\n');
  await refreshServerList();
  closeWizard();
  selectServer(result.server.id);
}

// ---------------------------------------------------------------------------
// Rendimiento en vivo (CPU / RAM)
// ---------------------------------------------------------------------------

let usagePollInFlight = false;

async function pollResourceUsage() {
  const id = state.selectedId;
  if (!id || usagePollInFlight || document.hidden) return;
  usagePollInFlight = true;
  try {
    const running = await window.api.isRunning(id);
    if (!running) {
      updateUsageLabels(id, false);
      return;
    }
    const sample = await window.api.getResourceUsage(id);
    if (sample) {
      const history = state.usageHistory.get(id) || [];
      history.push(sample);
      if (history.length > USAGE_MAX_POINTS) history.splice(0, history.length - USAGE_MAX_POINTS);
      state.usageHistory.set(id, history);
    }
    if (id === state.selectedId) {
      updateUsageLabels(id, true, !sample);
      drawUsageCharts();
    }
  } catch (e) {
    // Un fallo puntual del sondeo no debe molestar al usuario
  } finally {
    usagePollInFlight = false;
  }
}

function updateUsageLabels(id, running, locating = false) {
  const hint = document.getElementById('usageHint');
  if (!hint) return;
  const history = state.usageHistory.get(id) || [];
  const last = history[history.length - 1];
  const cpuEl = document.getElementById('usageCpuValue');
  const ramEl = document.getElementById('usageRamValue');

  if (!running) {
    hint.textContent = history.length ? 'Servidor detenido. Se muestran los últimos datos registrados.' : 'Servidor detenido.';
    cpuEl.textContent = '—';
    ramEl.textContent = '—';
    return;
  }
  if (!last || locating) {
    hint.textContent = 'Localizando el proceso de Java…';
    if (!last) return;
  } else {
    hint.textContent = `Proceso Java PID ${last.pid}. CPU relativa al total del equipo; la RAM puede superar un poco el máximo asignado (-Xmx) por la memoria propia de la JVM.`;
  }
  cpuEl.textContent = `${last.cpuPercent.toFixed(1)} %`;
  ramEl.textContent = `${Math.round(last.memoryMb)} / ${last.memoryLimitMb} MB`;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function drawUsageCharts() {
  const cpuCanvas = document.getElementById('usageCpuCanvas');
  const ramCanvas = document.getElementById('usageRamCanvas');
  if (!cpuCanvas || !ramCanvas || !state.selectedId) return;

  const history = state.usageHistory.get(state.selectedId) || [];
  const limit = history.length ? history[history.length - 1].memoryLimitMb : 0;
  const maxRam = Math.max(limit, ...history.map((h) => h.memoryMb), 1) * 1.1;

  drawLineChart(cpuCanvas, history.map((h) => h.cpuPercent), 100, {
    color: cssVar('--accent', '#e8963f'),
    formatY: (v) => `${Math.round(v)}%`,
  });
  drawLineChart(ramCanvas, history.map((h) => h.memoryMb), maxRam, {
    color: cssVar('--ok', '#6fa85a'),
    formatY: (v) => (v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`),
    limitLine: limit || null,
  });
}

/**
 * Gráfica de líneas mínima sobre <canvas>, sin librerías. Ajusta la resolución
 * al devicePixelRatio para que no se vea borrosa en pantallas HiDPI.
 */
function drawLineChart(canvas, values, maxValue, { color, formatY, limitLine = null }) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 300;
  const cssHeight = canvas.clientHeight || 120;
  if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padLeft = 52;
  const padRight = 8;
  const padTop = 8;
  const padBottom = 8;
  const w = cssWidth - padLeft - padRight;
  const h = cssHeight - padTop - padBottom;
  const yFor = (v) => padTop + h - (Math.min(v, maxValue) / maxValue) * h;

  // Rejilla y etiquetas del eje Y
  ctx.font = `11px ${cssVar('--font', 'sans-serif')}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = (maxValue / 4) * i;
    const y = yFor(v);
    ctx.strokeStyle = cssVar('--border', '#2f333e');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, Math.round(y) + 0.5);
    ctx.lineTo(padLeft + w, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = cssVar('--text-faint', '#5c6273');
    ctx.fillText(formatY(v), padLeft - 6, y);
  }

  // Línea del máximo asignado (-Xmx)
  if (limitLine) {
    const y = yFor(limitLine);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = cssVar('--text-muted', '#8a90a0');
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + w, y);
    ctx.stroke();
    ctx.restore();
  }

  if (values.length < 2) {
    ctx.fillStyle = cssVar('--text-faint', '#5c6273');
    ctx.textAlign = 'center';
    ctx.fillText('Esperando datos…', padLeft + w / 2, padTop + h / 2);
    return;
  }

  // Los puntos se alinean a la derecha: el más reciente siempre en el borde
  const step = w / (USAGE_MAX_POINTS - 1);
  const xFor = (i) => padLeft + w - (values.length - 1 - i) * step;

  ctx.beginPath();
  values.forEach((v, i) => (i === 0 ? ctx.moveTo(xFor(i), yFor(v)) : ctx.lineTo(xFor(i), yFor(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Relleno suave bajo la línea
  ctx.lineTo(xFor(values.length - 1), padTop + h);
  ctx.lineTo(xFor(0), padTop + h);
  ctx.closePath();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

init();
