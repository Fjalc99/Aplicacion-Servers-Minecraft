
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
    // ↑ / ↓: comandos anteriores, como en una consola de verdad
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const h = consoleHistory;
      if (h.items.length === 0) return;
      e.preventDefault();
      if (h.index === -1) h.draft = e.target.value;
      if (e.key === 'ArrowUp') h.index = h.index === -1 ? h.items.length - 1 : Math.max(0, h.index - 1);
      else h.index = h.index === -1 ? -1 : h.index + 1;
      if (h.index >= h.items.length) h.index = -1;
      e.target.value = h.index === -1 ? h.draft : h.items[h.index];
      const end = e.target.value.length;
      e.target.setSelectionRange(end, end);
    }
  });
  // Si subes para leer algo, la consola deja de saltar al final con cada línea nueva
  document.getElementById('consoleLog').addEventListener('scroll', () => {
    if (consoleAtBottom()) document.getElementById('consoleJump').hidden = true;
  });
  document.getElementById('consoleJump').addEventListener('click', () => {
    const log = document.getElementById('consoleLog');
    log.scrollTop = log.scrollHeight;
    document.getElementById('consoleJump').hidden = true;
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
  if (tabName === 'console') {
    // Al entrar en la consola: al final del todo y listo para escribir
    const log = document.getElementById('consoleLog');
    log.scrollTop = log.scrollHeight;
    document.getElementById('consoleJump').hidden = true;
    const input = document.getElementById('consoleInput');
    if (!input.disabled) input.focus();
  }
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
  let cf = { configured: false };
  try {
    [info, duck, playitStatus, servers, cf] = await Promise.all([
      window.api.getConnectionInfo(),
      window.api.getDuckDns(),
      window.api.getPlayitStatus().catch(() => ({ running: false })),
      window.api.listServers(),
      window.api.getCurseForge().catch(() => ({ configured: false })),
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

    <div class="card">
      <h3>Analizar mods: CurseForge</h3>
      <p class="hint" style="margin-top:0;">Los mods se buscan primero en Modrinth (no necesita nada). Para buscar también en CurseForge los que no están en Modrinth, hace falta una clave de API gratuita: entra en <strong>console.curseforge.com</strong>, inicia sesión, ve a <strong>API keys</strong> y cópiala aquí. Se guarda solo en este PC y no se muestra nunca.</p>
      <div class="settings-actions">
        <input type="password" id="cfKey" aria-label="Clave de API de CurseForge" autocomplete="off" placeholder="${cf.configured ? `Clave guardada (${escapeHtml(cf.keyHint || '')}); pega otra para cambiarla` : 'Pega aquí tu clave de API de CurseForge'}" />
        <button id="cfSave" type="button" class="btn btn-ghost">Guardar y comprobar</button>
        ${cf.configured && cf.source === 'settings' ? '<button id="cfRemove" type="button" class="btn btn-ghost">Quitar clave</button>' : ''}
      </div>
      <p id="cfStatus" class="settings-line">${cf.configured
        ? '<span class="settings-status good">✓ CurseForge activado: se usará al analizar mods.</span>'
        : '<span class="hint">Sin configurar: solo se busca en Modrinth y en la ficha de cada .jar.</span>'}</p>
    </div>

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

  // ---- CurseForge
  const cfStatus = document.getElementById('cfStatus');
  document.getElementById('cfSave').addEventListener('click', async (event) => {
    const value = document.getElementById('cfKey').value.trim();
    if (!value) {
      cfStatus.innerHTML = '<span class="settings-status bad">✕ Pega primero la clave.</span>';
      return;
    }
    event.target.disabled = true;
    cfStatus.innerHTML = '<span class="hint">Comprobando con CurseForge…</span>';
    try {
      await window.api.setCurseForge(value);
      renderSettings();
    } catch (error) {
      // En la app de escritorio el error llega como "Error invoking remote method '...': Error: <mensaje>"
      const message = String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
      cfStatus.innerHTML = `<span class="settings-status bad">✕ ${escapeHtml(message)}</span>`;
      event.target.disabled = false;
    }
  });
  const cfRemove = document.getElementById('cfRemove');
  if (cfRemove) cfRemove.addEventListener('click', async () => {
    if (!confirm('¿Quitar la clave de CurseForge?')) return;
    await window.api.removeCurseForge();
    renderSettings();
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
      <div class="world-local">
        <h4>Jugar este mundo como partida local</h4>
        <p class="hint" style="margin-top:0;">Copia el mundo a tu Minecraft como partida de un jugador (para jugar solo o abrirla con e4mc), con tu inventario, tu posición y la configuración de los mods. Luego puedes traerla de vuelta al servidor. No juguéis a la vez en las dos copias.</p>
        <div class="backup-actions">
          <button id="exportLocalBtn" class="btn btn-ghost">Exportar a partida local</button>
          <button id="importLocalBtn" class="btn btn-ghost">Traer partida local al servidor</button>
        </div>
        <div id="localWorldPanel"></div>
      </div>
    </div>
    <div class="card">
      <h3>Copias de seguridad</h3>
      <p class="hint" style="margin-top:0;">
        <strong>Backup del mundo</strong>: solo la carpeta del mundo; rápido, ideal para hacerlo a menudo (se conservan los 10 más recientes).<br>
        <strong>Backup completo</strong>: la carpeta entera del servidor (mods, config, server.properties, mundo, jugadores, librerías…), sin logs ni backups anteriores. Ocupa más; se conservan los 3 más recientes.<br>
        Se guardan en <code>backups/</code> dentro de la carpeta del servidor. Si está encendido, se pausa el guardado del mundo mientras se copia.
      </p>
      <div class="backup-actions">
        <button id="backupNowBtn" class="btn btn-accent">Backup del mundo</button>
        <button id="fullBackupBtn" class="btn btn-ghost">Backup completo</button>
      </div>
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

  document.getElementById('backupNowBtn').addEventListener('click', () => runBackup(server, 'world'));
  document.getElementById('fullBackupBtn').addEventListener('click', () => runBackup(server, 'full'));

  document.getElementById('exportLocalBtn').addEventListener('click', () => openLocalWorldPanel(server, 'export'));
  document.getElementById('importLocalBtn').addEventListener('click', () => openLocalWorldPanel(server, 'import'));

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

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function progressPlaceholder(text) {
  return `<div class="progress-bar-wrap"><div class="progress-bar-track"><div class="progress-bar-fill" style="width:0%"></div></div><span class="progress-bar-label">${escapeHtml(text)}</span></div>`;
}

function setBackupButtonsDisabled(disabled) {
  for (const el of document.querySelectorAll('#backupNowBtn, #fullBackupBtn, #backupsList button')) {
    el.disabled = disabled;
  }
}

/** Avisa de ficheros que no se pudieron copiar (bloqueados por otro programa). */
function skippedNote(skipped) {
  if (!skipped || skipped.length === 0) return '';
  const names = skipped.slice(0, 3).map((f) => escapeHtml(f.name)).join(', ');
  const more = skipped.length > 3 ? ` y ${skipped.length - 3} más` : '';
  return `<br><span class="hint">No se pudieron copiar ${skipped.length} archivo(s) que estaban en uso: ${names}${more}. Si son importantes, repite el backup con el servidor apagado.</span>`;
}

/** kind: 'world' (solo el mundo) o 'full' (carpeta entera del servidor). */
async function runBackup(server, kind) {
  const msg = document.getElementById('backupNowMsg');
  setBackupButtonsDisabled(true);
  msg.innerHTML = progressPlaceholder(kind === 'full' ? 'Preparando backup completo…' : 'Preparando…');

  const startTime = Date.now();
  window.api.onBackupProgress(server.id, (info) => renderProgressBar(msg, info, startTime));
  try {
    const result = kind === 'full'
      ? await window.api.createFullBackup(server.id)
      : await window.api.createBackup(server.id);
    if (!result.ok) {
      msg.innerHTML = `<span class="error-text">Error: ${escapeHtml(result.error)}</span>`;
      return;
    }
    const label = kind === 'full' ? 'Backup completo creado' : 'Backup del mundo creado';
    msg.innerHTML = `${label} (${formatSize(result.size)}).${skippedNote(result.skipped)}`;
  } catch (error) {
    msg.innerHTML = `<span class="error-text">Error: ${escapeHtml(error.message)}</span>`;
  } finally {
    window.api.removeBackupProgressListeners(server.id);
    setBackupButtonsDisabled(false);
    refreshBackupsList(server);
  }
}

// ---------------------------------------------------------------------------
// Partida local (un jugador) <-> servidor
// ---------------------------------------------------------------------------

async function openLocalWorldPanel(server, mode) {
  const panel = document.getElementById('localWorldPanel');
  panel.innerHTML = '<p class="hint">Buscando tus instancias de Minecraft…</p>';
  let info;
  try {
    info = await window.api.getLocalWorldInfo(server.id);
  } catch (error) {
    info = { ok: false, error: error.message };
  }
  if (!info.ok) {
    panel.innerHTML = `<p class="error-text">${escapeHtml(info.error)}</p>`;
    return;
  }
  const isExport = mode === 'export';
  if (info.players.length === 0) {
    panel.innerHTML = '<p class="error-text">Este mundo todavía no tiene datos de ningún jugador: entra al menos una vez al servidor antes.</p>';
    return;
  }

  const instanceOptions = info.instances
    .map((i) => `<option value="${escapeHtml(i.path)}">${escapeHtml(i.label)}${i.mods ? ` · ${i.mods} mods` : ''}</option>`)
    .join('');
  const playerOptions = info.players
    .map((p) => `<option value="${escapeHtml(p.uuid)}">${escapeHtml(p.name)}${p.op ? ' (OP)' : ''}</option>`)
    .join('');

  panel.innerHTML = `
    <div class="local-panel">
      <div class="form-grid">
        <div class="field">
          <label for="lwInstance">Tu Minecraft (instancia)</label>
          <select id="lwInstance">${instanceOptions}<option value="__otra">Otra carpeta…</option></select>
        </div>
        <div class="field">
          <label for="lwPlayer">Tú eres</label>
          <select id="lwPlayer">${playerOptions}</select>
        </div>
        ${isExport
          ? `<div class="field">
               <label for="lwName">Nombre de la partida</label>
               <input type="text" id="lwName" value="${escapeHtml(server.name)}" maxlength="60" />
             </div>`
          : `<div class="field">
               <label for="lwSave">Partida a traer</label>
               <select id="lwSave"><option value="">Cargando…</option></select>
             </div>`}
      </div>
      ${isExport ? `
      <div class="field field-inline" style="margin-top:10px;">
        <input type="checkbox" id="lwConfig" checked />
        <label for="lwConfig">Copiar también la configuración de los mods del servidor (tus archivos de cliente no se tocan y los que se sustituyen se guardan aparte)</label>
      </div>` : ''}
      <div class="backup-actions" style="margin-top:12px;">
        <button id="lwGo" class="btn btn-accent">${isExport ? 'Exportar' : 'Traer al servidor'}</button>
        <button id="lwCancel" class="btn btn-ghost">Cancelar</button>
      </div>
      <div id="lwResult" class="hint" style="margin-top:10px;"></div>
    </div>`;

  const instanceSel = document.getElementById('lwInstance');
  const result = document.getElementById('lwResult');
  let lastInstance = instanceSel.value;
  document.getElementById('lwCancel').addEventListener('click', () => { panel.innerHTML = ''; });

  async function loadSaves() {
    const saveSel = document.getElementById('lwSave');
    if (!saveSel || instanceSel.value === '__otra') return;
    saveSel.innerHTML = '<option value="">Cargando…</option>';
    const res = await window.api.listLocalSaves(instanceSel.value).catch((e) => ({ ok: false, error: e.message }));
    if (!res.ok) {
      saveSel.innerHTML = '<option value="">—</option>';
      result.innerHTML = `<span class="error-text">${escapeHtml(res.error)}</span>`;
      return;
    }
    result.textContent = '';
    if (res.saves.length === 0) {
      saveSel.innerHTML = '<option value="">No hay partidas en esa instancia</option>';
      return;
    }
    saveSel.innerHTML = res.saves
      .map((sv) => {
        const from = sv.exported
          ? ` · exportada de "${sv.exported.serverName}" el ${new Date(sv.exported.exportedAt).toLocaleString()}`
          : '';
        return `<option value="${escapeHtml(sv.folder)}" data-uuid="${escapeHtml((sv.exported && sv.exported.uuid) || '')}">${escapeHtml(sv.name)}${escapeHtml(from)}</option>`;
      })
      .join('');
    const syncPlayer = () => {
      const uuid = saveSel.selectedOptions[0] && saveSel.selectedOptions[0].dataset.uuid;
      if (uuid && [...document.getElementById('lwPlayer').options].some((o) => o.value === uuid)) {
        document.getElementById('lwPlayer').value = uuid;
      }
    };
    saveSel.onchange = syncPlayer;
    syncPlayer();
  }

  instanceSel.addEventListener('change', async () => {
    if (instanceSel.value === '__otra') {
      const folder = await window.api.pickInstanceFolder();
      if (!folder) {
        instanceSel.value = lastInstance;
        return;
      }
      const option = document.createElement('option');
      option.value = folder;
      option.textContent = folder;
      instanceSel.insertBefore(option, instanceSel.lastElementChild);
      instanceSel.value = folder;
    }
    lastInstance = instanceSel.value;
    loadSaves();
  });
  if (!instanceOptions) {
    result.innerHTML = 'No he encontrado tu Minecraft automáticamente: elige "Otra carpeta…" y busca la de tu instancia (la que tiene dentro <code>mods</code> y <code>saves</code>).';
    instanceSel.value = '__otra';
  } else if (!isExport) {
    loadSaves();
  }

  const go = document.getElementById('lwGo');
  go.addEventListener('click', async () => {
    const instanceDir = instanceSel.value;
    if (!instanceDir || instanceDir === '__otra') {
      result.innerHTML = '<span class="error-text">Elige la carpeta de tu Minecraft.</span>';
      return;
    }
    const uuid = document.getElementById('lwPlayer').value;
    go.disabled = true;
    try {
      if (isExport) {
        result.textContent = 'Copiando el mundo… (si el servidor está encendido, se pausa el guardado mientras tanto)';
        const res = await window.api.exportWorldToLocal(server.id, {
          instanceDir,
          uuid,
          saveName: document.getElementById('lwName').value,
          copyConfig: document.getElementById('lwConfig').checked,
        });
        if (!res.ok) {
          result.innerHTML = `<span class="error-text">${escapeHtml(res.error)}</span>`;
          return;
        }
        let html = `<span class="settings-status good">✓ Hecho.</span> En Minecraft → <strong>Un jugador</strong> verás la partida <strong>${escapeHtml(res.saveFolder)}</strong>.`;
        html += res.playerApplied ? ' Apareces con tu inventario y en tu sitio.' : ' (No había datos de ese jugador: aparecerás en el spawn.)';
        if (res.config) {
          html += `<br>Configuración de mods: ${res.config.copied} nuevos, ${res.config.replaced} sustituidos.`;
          if (res.config.backupDir) html += ` Los tuyos están en <code>${escapeHtml(res.config.backupDir)}</code>.`;
        }
        html += '<br>Recuerda: si jugáis en local, no juguéis a la vez en el servidor; cuando acabéis, usa "Traer partida local al servidor".';
        result.innerHTML = html;
      } else {
        const saveFolder = document.getElementById('lwSave').value;
        if (!saveFolder) {
          result.innerHTML = '<span class="error-text">Elige qué partida traer.</span>';
          return;
        }
        if (await window.api.isRunning(server.id)) {
          result.innerHTML = '<span class="error-text">Detén el servidor antes de traer la partida.</span>';
          return;
        }
        if (!confirm('El mundo del servidor se sustituirá por esa partida. El mundo actual no se borra: se guarda aparte. Cierra Minecraft antes. ¿Continuar?')) return;
        result.textContent = 'Copiando la partida al servidor…';
        let res = await window.api.importWorldFromLocal(server.id, { instanceDir, saveFolder, uuid });
        if (res.ok && res.needsConfirm) {
          if (!confirm(`${res.reason}\n\n¿Traerla igualmente?`)) {
            result.textContent = 'Cancelado; no se ha tocado nada.';
            return;
          }
          res = await window.api.importWorldFromLocal(server.id, { instanceDir, saveFolder, uuid, force: true });
        }
        if (!res.ok) {
          result.innerHTML = `<span class="error-text">${escapeHtml(res.error)}</span>`;
          return;
        }
        let html = '<span class="settings-status good">✓ La partida ya es el mundo del servidor.</span>';
        html += res.playerRestored ? ' Tu inventario y tu posición están en su sitio.' : '';
        if (res.previousWorldSavedAs) html += `<br>El mundo anterior está guardado como <code>${escapeHtml(res.previousWorldSavedAs)}</code> en la carpeta del servidor.`;
        result.innerHTML = html;
      }
    } catch (error) {
      result.innerHTML = `<span class="error-text">${escapeHtml(error.message)}</span>`;
    } finally {
      go.disabled = false;
    }
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
    <table class="mods-table backups-table">
      <thead><tr><th>Tipo</th><th>Fecha</th><th>Tamaño</th><th></th></tr></thead>
      <tbody>
        ${backups
          .map(
            (b) => `
          <tr>
            <td>${b.kind === 'full'
              ? '<span class="badge badge-full">Completo</span>'
              : '<span class="badge badge-world">Mundo</span>'}</td>
            <td>${new Date(b.createdAt).toLocaleString()}</td>
            <td>${formatSize(b.size)}</td>
            <td><div class="backup-row-actions">
              <button class="btn btn-ghost" data-action="restore" data-kind="${b.kind}" data-file="${escapeHtml(b.fileName)}">Restaurar</button>
              <button class="btn btn-ghost" data-action="download" data-file="${escapeHtml(b.fileName)}">Descargar</button>
              <button class="btn btn-ghost" data-action="delete" data-file="${escapeHtml(b.fileName)}">Eliminar</button>
            </div></td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;

  const msg = document.getElementById('backupNowMsg');

  el.querySelectorAll('button[data-action="restore"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const running = await window.api.isRunning(server.id);
      if (running) {
        alert('Detén el servidor antes de restaurar un backup.');
        return;
      }
      const full = btn.dataset.kind === 'full';
      const ok = confirm(
        full
          ? 'Esto devolverá TODA la carpeta del servidor (mods, config, mundo, jugadores…) a como estaba en ese backup.\n\n' +
              'Lo que hay ahora no se borra: se mueve entero a backups/antes-de-restaurar-completo-<fecha>.\n\n¿Continuar?'
          : 'Esto sustituirá el mundo actual por el del backup. El mundo actual no se borra, se renombra por seguridad. ¿Continuar?'
      );
      if (!ok) return;

      setBackupButtonsDisabled(true);
      msg.innerHTML = progressPlaceholder('Restaurando…');
      const startTime = Date.now();
      window.api.onBackupProgress(server.id, (info) => renderProgressBar(msg, info, startTime));
      try {
        const result = await window.api.restoreBackup(server.id, btn.dataset.file);
        if (!result.ok) {
          msg.innerHTML = `<span class="error-text">Error: ${escapeHtml(result.error)}</span>`;
          return;
        }
        if (result.kind === 'full') {
          msg.innerHTML = `Backup completo restaurado. Tu versión anterior está en <code>${escapeHtml(result.previousSavedAs)}</code>; bórrala cuando compruebes que todo va bien.`;
          if (result.server) {
            const i = state.servers.findIndex((s) => s.id === server.id);
            if (i !== -1) state.servers[i] = { ...state.servers[i], ...result.server };
          }
        } else {
          msg.textContent = 'Backup del mundo restaurado.';
        }
      } catch (error) {
        msg.innerHTML = `<span class="error-text">Error: ${escapeHtml(error.message)}</span>`;
      } finally {
        window.api.removeBackupProgressListeners(server.id);
        setBackupButtonsDisabled(false);
        refreshBackupsList(server);
      }
    });
  });

  el.querySelectorAll('button[data-action="download"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const result = await window.api.downloadBackup(server.id, btn.dataset.file);
        if (result.canceled) return;
        if (!result.ok) {
          msg.innerHTML = `<span class="error-text">Error: ${escapeHtml(result.error)}</span>`;
          return;
        }
        if (result.savedTo) {
          msg.innerHTML = `Copia guardada en <strong>${escapeHtml(result.savedTo)}</strong>
            <button id="showBackupCopyBtn" class="btn btn-ghost" style="margin-left:8px;">Mostrar en la carpeta</button>`;
          document.getElementById('showBackupCopyBtn').addEventListener('click', () => window.api.showInFolder(result.savedTo));
        } else {
          msg.textContent = 'Descarga iniciada.';
        }
      } catch (error) {
        msg.innerHTML = `<span class="error-text">Error: ${escapeHtml(error.message)}</span>`;
      }
    });
  });

  el.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = confirm('¿Eliminar este backup? No se puede deshacer.');
      if (!ok) return;
      const result = await window.api.deleteBackup(server.id, btn.dataset.file);
      if (result && result.ok === false) msg.innerHTML = `<span class="error-text">Error: ${escapeHtml(result.error)}</span>`;
      refreshBackupsList(server);
    });
  });
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const LOADER_LABEL = { vanilla: 'Minecraft', forge: 'Forge', neoforge: 'NeoForge' };

/** Tarjeta de memoria: mínima y máxima con su propio botón de guardar. */
function bindMemoryCard(server) {
  const maxEl = document.getElementById('cfgMemory');
  const minEl = document.getElementById('cfgMemoryMin');
  const saved = document.getElementById('cfgMemorySaved');
  const gb = (mb) => (Number(mb) > 0 ? `≈ ${(Number(mb) / 1024).toFixed(1)} GB` : '');
  const refreshGb = () => {
    document.getElementById('cfgMemoryGb').textContent = gb(maxEl.value);
    document.getElementById('cfgMemoryMinGb').textContent = gb(minEl.value);
    saved.textContent = '';
  };
  maxEl.addEventListener('input', refreshGb);
  minEl.addEventListener('input', refreshGb);
  refreshGb();

  async function save(max, min) {
    saved.textContent = '';
    if (!Number.isInteger(max) || max < 512) {
      saved.innerHTML = '<span class="settings-status bad">✕ La máxima tiene que ser de al menos 512 MB.</span>';
      return;
    }
    if (!Number.isInteger(min) || min < 256 || min > max) {
      saved.innerHTML = '<span class="settings-status bad">✕ La mínima tiene que ser de al menos 256 MB y no mayor que la máxima.</span>';
      return;
    }
    try {
      const updated = await window.api.updateMemory(server.id, max, min);
      Object.assign(server, updated);
      maxEl.value = updated.memory;
      minEl.value = updated.memoryMin || Math.min(updated.memory, 1024);
      refreshGb();
      const running = await window.api.isRunning(server.id);
      saved.innerHTML = `<span class="settings-status good">✓ Guardado (${(max / 1024).toFixed(1)} GB máx. · ${(min / 1024).toFixed(1)} GB mín.).${running ? ' Reinicia el servidor para aplicarlo.' : ''}</span>`;
      checkJvmFile();
    } catch (error) {
      const message = String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
      saved.innerHTML = `<span class="settings-status bad">✕ ${escapeHtml(message)}</span>`;
    }
  }

  document.getElementById('cfgMemorySave').addEventListener('click', () => save(Number(maxEl.value), Number(minEl.value)));

  // Si user_jvm_args.txt dice otra cosa (lo has editado a mano), se avisa y se ofrece usarlo.
  async function checkJvmFile() {
    const note = document.getElementById('cfgJvmFileNote');
    if (!note) return;
    let file;
    try {
      file = await window.api.readJvmArgsFile(server.id);
    } catch (error) {
      return;
    }
    const appMin = server.memoryMin || Math.min(server.memory, 1024);
    const differs = file.exists && ((file.maxMb && file.maxMb !== server.memory) || (file.minMb && file.minMb !== appMin));
    if (!differs) {
      note.innerHTML = '';
      return;
    }
    const fileMax = file.maxMb || server.memory;
    const fileMin = Math.min(file.minMb || appMin, fileMax);
    note.innerHTML = `<span class="settings-status warn">user_jvm_args.txt tiene ${fileMax} MB máx. / ${fileMin} MB mín., distinto de lo de aquí. Al arrancar, la app lo cambiaría por lo de arriba.</span> <button type="button" class="btn btn-ghost btn-small" id="cfgUseJvmFile">Usar los del archivo</button>`;
    document.getElementById('cfgUseJvmFile').addEventListener('click', () => save(fileMax, fileMin));
  }
  checkJvmFile();
}

/** Tarjeta "Versión del servidor": ver la versión instalada y cambiarla. */
async function renderVersionCard(server) {
  const card = document.getElementById('versionCard');
  if (!card) return;
  const label = LOADER_LABEL[server.loader] || server.loader;
  let info;
  try {
    info = await window.api.getVersionInfo(server.id);
  } catch (error) {
    info = { ok: false, error: error.message };
  }
  if (!document.body.contains(card)) return; // se cambió de pestaña mientras tanto
  if (!info.ok) {
    card.innerHTML = `<h3>Versión del servidor</h3><p class="error-text">No se pudieron consultar las versiones: ${escapeHtml(info.error)}</p>`;
    return;
  }

  const isVanilla = info.loader === 'vanilla';
  const currentText = isVanilla
    ? `Minecraft <strong>${escapeHtml(info.current)}</strong>`
    : `${label} <strong>${escapeHtml(info.current || 'desconocida')}</strong> · Minecraft ${escapeHtml(info.mcVersion)}`;

  const options = info.versions
    .filter((v) => v.version !== info.current)
    .map((v) => {
      const tags = [
        v.version === info.latest ? 'última' : null,
        v.recommended ? 'recomendada' : null,
        v.prerelease ? 'beta' : null,
        !v.newer ? 'anterior' : null,
      ].filter(Boolean);
      const selected = v.version === info.latest ? ' selected' : '';
      return `<option value="${escapeHtml(v.version)}"${selected}>${escapeHtml(v.version)}${tags.length ? ` (${tags.join(', ')})` : ''}</option>`;
    })
    .join('');

  let status;
  if (info.upToDate) status = '<span class="settings-status good">✓ Estás en la última versión.</span>';
  else if (info.unknownCurrent) status = '<span class="hint">No he podido saber qué versión exacta tiene instalada.</span>';
  else if (info.latest) status = `<span class="settings-status warn">Hay una versión más nueva: ${escapeHtml(info.latest)}</span>`;
  else status = '';

  const explain = isVanilla
    ? 'Sube el servidor a una versión más nueva de Minecraft. El mundo se convierte al arrancar y <strong>no se puede volver a una versión anterior</strong> (salvo restaurando el backup).'
    : `Cambia la versión de ${label} sin cambiar la de Minecraft (${escapeHtml(info.mcVersion)}), así tus mods siguen funcionando. Conviene mirar antes si algún mod pide una versión concreta. Para pasar a otra versión de Minecraft, crea un servidor nuevo con "Usar como plantilla".`;

  card.innerHTML = `
    <h3>Versión del servidor</h3>
    <p style="margin:0 0 6px;">${currentText}</p>
    <p class="settings-line" style="margin:0 0 10px;">${status}</p>
    <p class="hint" style="margin-top:0;">${explain} Antes de cambiar nada se hace un <strong>backup completo</strong> automáticamente.</p>
    ${options ? `
    <div class="settings-actions">
      <select id="versionSelect" aria-label="Versión a instalar">${options}</select>
      <button id="versionUpdateBtn" type="button" class="btn btn-accent">${isVanilla ? 'Actualizar Minecraft' : `Cambiar versión de ${label}`}</button>
    </div>` : '<p class="hint">No hay otras versiones disponibles.</p>'}
    <div id="versionProgress" class="hint" style="margin-top:10px;"></div>
    <pre id="versionLog" class="version-log" hidden></pre>
  `;

  const btn = document.getElementById('versionUpdateBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const target = document.getElementById('versionSelect').value;
    if (await window.api.isRunning(server.id)) {
      alert('Detén el servidor antes de cambiar su versión.');
      return;
    }
    const chosen = info.versions.find((v) => v.version === target) || {};
    const lines = [
      isVanilla
        ? `Se actualizará el servidor de Minecraft ${info.current} a ${target}.`
        : `Se cambiará ${label} de ${info.current || 'la versión actual'} a ${target} (Minecraft ${info.mcVersion}).`,
      '',
      'Antes se hará un backup completo (puede tardar unos minutos con muchos mods).',
    ];
    if (isVanilla) lines.push('', 'Al arrancar, el mundo se convertirá a la nueva versión y ya no podrá abrirse con la anterior.');
    if (chosen.newer === false) lines.push('', 'Ojo: es una versión ANTERIOR a la que tienes. Algunos mods pueden no funcionar.');
    if (chosen.prerelease) lines.push('', 'Ojo: es una versión beta.');
    lines.push('', '¿Continuar?');
    if (!confirm(lines.join('\n'))) return;

    const progressEl = document.getElementById('versionProgress');
    const logEl = document.getElementById('versionLog');
    btn.disabled = true;
    document.getElementById('versionSelect').disabled = true;
    logEl.hidden = false;
    logEl.textContent = '';
    progressEl.innerHTML = progressPlaceholder('Haciendo backup completo…');
    const startTime = Date.now();
    let phase = 'backup';

    window.api.onUpdateProgress(server.id, (p) => {
      if (p.phase === 'backup') {
        renderProgressBar(progressEl, p, startTime);
      } else if (p.phase === 'download') {
        if (phase !== 'download') phase = 'download';
        const pct = p.total ? Math.round((p.received / p.total) * 100) : null;
        progressEl.textContent = pct !== null ? `Descargando… ${pct}%` : `Descargando… ${(p.received / 1024 / 1024).toFixed(1)} MB`;
      } else if (p.phase === 'install') {
        phase = 'install';
        progressEl.textContent = 'Instalando (descarga librerías; puede tardar un par de minutos)…';
      } else if (p.phase === 'log' && p.text) {
        logEl.textContent = (logEl.textContent + p.text).slice(-20000);
        logEl.scrollTop = logEl.scrollHeight;
      }
    });

    try {
      const result = await window.api.updateVersion(server.id, target);
      if (!result.ok) {
        progressEl.innerHTML = `<span class="error-text">No se pudo actualizar: ${escapeHtml(result.error)}</span><br><span class="hint">Si se llegó a tocar algo, tienes el backup completo en la pestaña Resumen → Copias de seguridad.</span>`;
        return;
      }
      const i = state.servers.findIndex((s) => s.id === server.id);
      if (i !== -1) state.servers[i] = { ...state.servers[i], ...result.server };
      Object.assign(server, result.server);
      renderSidebar();
      await renderVersionCard(server);
      const done = document.getElementById('versionProgress');
      if (done) {
        done.innerHTML = `<span class="settings-status good">✓ Actualizado a ${escapeHtml(target)}.</span> Backup previo: <code>${escapeHtml(result.backupFileName)}</code>. Ya puedes iniciar el servidor; la primera vez tarda un poco más.`;
      }
    } catch (error) {
      progressEl.innerHTML = `<span class="error-text">Error: ${escapeHtml(error.message)}</span>`;
    } finally {
      window.api.removeUpdateProgressListeners(server.id);
      const b = document.getElementById('versionUpdateBtn');
      if (b) b.disabled = false;
      const sel = document.getElementById('versionSelect');
      if (sel) sel.disabled = false;
    }
  });
}

async function renderConfig(server) {
  const p = server.properties;
  const el = document.getElementById('tab-config');
  const sysMem = await window.api.getSystemMemory();
  const recommendedMax = Math.floor((sysMem.totalMb * 0.7) / 256) * 256;

  el.innerHTML = `
    <div class="card" id="versionCard">
      <h3>Versión del servidor</h3>
      <p class="hint">Consultando versiones disponibles…</p>
    </div>
    <div class="card" id="memoryCard">
      <h3>Memoria del proceso Java</h3>
      <div class="form-grid">
        <div class="field">
          <label for="cfgMemory">Máxima (-Xmx), en MB</label>
          <input type="number" id="cfgMemory" min="512" step="256" value="${server.memory}" />
          <span class="hint" id="cfgMemoryGb"></span>
        </div>
        <div class="field">
          <label for="cfgMemoryMin">Mínima (-Xms), en MB</label>
          <input type="number" id="cfgMemoryMin" min="256" step="256" value="${server.memoryMin || Math.min(server.memory, 1024)}" />
          <span class="hint" id="cfgMemoryMinGb"></span>
        </div>
      </div>
      <p class="hint">Tu PC tiene ${(sysMem.totalMb / 1024).toFixed(1)} GB de RAM en total. Como orientación, no conviene pasar de ~${(recommendedMax / 1024).toFixed(1)} GB para este servidor si también vas a jugar en la misma máquina a la vez. La mínima es lo que Java reserva nada más arrancar; dejarla en 1–2 GB está bien (ponerla igual que la máxima evita que vaya pidiendo memoria, pero la ocupa entera desde el principio).</p>
      <div class="settings-actions">
        <button id="cfgMemorySave" type="button" class="btn btn-accent">Guardar memoria</button>
        <span id="cfgMemorySaved" class="hint"></span>
      </div>
      <p class="hint" id="cfgJvmFileNote"></p>
      <p class="hint" style="margin-bottom:0;">Se aplica la próxima vez que inicies el servidor. La app escribe estos valores en <code>user_jvm_args.txt</code> al arrancar: cámbialos aquí, no en el archivo (las demás opciones que añadas a ese archivo se conservan).</p>
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

  renderVersionCard(server);
  bindMemoryCard(server);

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
let lastModAnalysisInfo = {};

// Estado de la pestaña Mods (se reinicia al cambiar de servidor)
const modsUi = {
  serverId: null,
  view: 'list', // 'list' | 'sync' | 'add'
  filter: 'all',
  search: '',
  selected: new Set(),
  open: null,
  data: null, // resultado de listServerMods
  busy: false,
};

// serverId -> { at, result }: la comprobación de actualizaciones se hace como mucho una vez por hora.
const modUpdateCache = {};

const MOD_SIDE_LABEL = { both: 'Servidor y cliente', server: 'Solo servidor', client: 'Solo cliente', unknown: 'Sin dato' };

const ICON_PALETTE = ['#5b8def', '#e8963f', '#6fa85a', '#b07cd8', '#d4b14a', '#4fb3bf', '#d9707a'];
function modIcon(name, size = 32, faded = false) {
  const color = ICON_PALETTE[String(name).length % ICON_PALETTE.length];
  return `<span class="mod-icon${faded ? ' faded' : ''}" style="width:${size}px;height:${size}px;flex:0 0 ${size}px;font-size:${Math.round(size / 2.3)}px;background:${color}" aria-hidden="true">${escapeHtml(String(name).charAt(0).toUpperCase())}</span>`;
}

function renderMods(server) {
  const el = document.getElementById('tab-mods');
  if (modsUi.serverId !== server.id) {
    Object.assign(modsUi, { serverId: server.id, view: 'list', filter: 'all', search: '', selected: new Set(), open: null, data: null });
  }
  if (server.loader === 'vanilla') {
    if (modsUi.view === 'config') return renderConfigView(server);
    el.innerHTML = '<p class="hint">Este servidor es Vanilla: no admite mods. Puedes usarlo con datapacks manualmente.</p><button type="button" class="btn btn-ghost" id="modsRulesVanilla" style="margin-top:12px;">Cambiar las reglas del mundo</button>';
    document.getElementById('modsRulesVanilla').addEventListener('click', () => { modsUi.view = 'config'; renderMods(server); });
    return;
  }
  if (modsUi.view === 'sync') return renderSyncView(server);
  if (modsUi.view === 'add') return renderAddModsView(server);
  if (modsUi.view === 'config') return renderConfigView(server);
  return renderServerModsView(server);
}

// ---------------------------------------------------------------------------
// Pantalla 1: mods del servidor
// ---------------------------------------------------------------------------

async function renderServerModsView(server) {
  const el = document.getElementById('tab-mods');
  el.innerHTML = `
    <div class="mods-head">
      <div>
        <h2 class="mods-title">Mods del servidor</h2>
        <div class="hint" id="modsCountLine">Cargando…</div>
      </div>
      <div class="mods-head-actions">
        <button type="button" id="modsCheckUpdates" class="btn btn-ghost">Buscar actualizaciones</button>
        <button type="button" id="modsAdd" class="btn btn-ghost">Añadir mods</button>
        <button type="button" id="modsConfig" class="btn btn-ghost">Configurar mods</button>
        <button type="button" id="modsSync" class="btn btn-accent">Pasar mods con mi Minecraft</button>
      </div>
    </div>
    <div class="mods-filters">
      <label class="mods-search">
        <span class="visually-hidden">Buscar mod</span>
        <input type="search" id="modsSearch" placeholder="Buscar por nombre o archivo…" value="${escapeHtml(modsUi.search)}" />
      </label>
      <div role="group" aria-label="Filtrar" id="modsFilterChips" class="mods-chips"></div>
    </div>
    <div id="modsStatus" class="hint"></div>
    <div class="mods-layout">
      <section class="mods-list-card" aria-label="Lista de mods">
        <div class="mods-list-scroll"><div id="modsRows" class="mods-rows"><p class="hint" style="padding:16px;">Leyendo la carpeta mods…</p></div></div>
      </section>
      <aside class="mods-detail" id="modsDetail" aria-label="Detalle del mod"></aside>
    </div>
    <div id="modsSelectionBar"></div>
  `;
  document.getElementById('modsAdd').addEventListener('click', () => { modsUi.view = 'add'; renderMods(server); });
  document.getElementById('modsConfig').addEventListener('click', () => { modsUi.view = 'config'; renderMods(server); });
  document.getElementById('modsSync').addEventListener('click', () => { modsUi.view = 'sync'; renderMods(server); });
  document.getElementById('modsCheckUpdates').addEventListener('click', () => checkServerModUpdates(server, { force: true }));
  document.getElementById('modsSearch').addEventListener('input', (e) => {
    modsUi.search = e.target.value;
    renderServerModsBody(server);
  });

  await loadServerMods(server);
  checkServerModUpdates(server, { force: false });
}

async function loadServerMods(server) {
  let res;
  try {
    res = await window.api.listServerMods(server.id);
  } catch (error) {
    res = { ok: false, error: error.message };
  }
  if (state.selectedId !== server.id || modsUi.view !== 'list') return;
  if (!res.ok) {
    document.getElementById('modsRows').innerHTML = `<p class="error-text" style="padding:16px;">${escapeHtml(res.error)}</p>`;
    return;
  }
  modsUi.data = res;
  const names = new Set(res.mods.map((m) => m.fileName));
  modsUi.selected = new Set([...modsUi.selected].filter((f) => names.has(f)));
  if (!modsUi.open || !names.has(modsUi.open)) modsUi.open = res.mods[0] ? res.mods[0].fileName : null;
  renderServerModsBody(server);
}

function modUpdatesFor(server) {
  const cached = modUpdateCache[server.id];
  const map = new Map();
  if (cached) for (const u of cached.result.updates) map.set(u.fileName, u);
  return map;
}

async function checkServerModUpdates(server, { force, quiet = false }) {
  const cached = modUpdateCache[server.id];
  if (!force && cached && Date.now() - cached.at < 60 * 60 * 1000) {
    renderServerModsBody(server);
    return;
  }
  // quiet: comprobar sin tapar el mensaje que haya (p. ej. "✓ 3 mods actualizados")
  const status = quiet ? null : document.getElementById('modsStatus');
  const btn = document.getElementById('modsCheckUpdates');
  if (status) status.textContent = 'Buscando actualizaciones en Modrinth y CurseForge…';
  if (btn) btn.disabled = true;
  try {
    const result = await window.api.checkModUpdates(server.id, false);
    if (!result.ok) {
      if (status && force) status.innerHTML = `<span class="error-text">${escapeHtml(result.error)}</span>`;
      else if (status) status.textContent = '';
      return;
    }
    modUpdateCache[server.id] = { at: Date.now(), result };
    if (state.selectedId !== server.id || modsUi.view !== 'list') return;
    const n = result.updates.length;
    if (status) {
      status.innerHTML = n
        ? `Hay <strong>${n}</strong> mod(s) con versión nueva para tu ${escapeHtml(LOADER_LABEL[result.loader] || result.loader)} ${escapeHtml(result.mcVersion)}.`
        : '<span class="settings-status good">✓ Todos los mods que se pueden comprobar están al día.</span>';
      if ((result.warnings || []).includes('curseforge-sin-clave')) {
        status.innerHTML += ' <span class="hint">(Sin clave de CurseForge, los mods que solo están allí no se comprueban.)</span>';
      }
    }
    if (force && n) modsUi.filter = 'updates';
    renderServerModsBody(server);
  } catch (error) {
    if (status) status.textContent = '';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function modStatus(m, update) {
  if (m.problem) return { text: m.problem, cls: 'bad' };
  if (m.disabled) return { text: 'Desactivado', cls: 'muted' };
  if (update) return { text: `→ ${update.newVersion}`, cls: 'warn' };
  if (m.source === 'Sin identificar') return { text: 'No comprobable', cls: 'muted' };
  return { text: 'Al día', cls: 'ok' };
}

function renderServerModsBody(server) {
  const data = modsUi.data;
  const rowsEl = document.getElementById('modsRows');
  if (!data || !rowsEl) return;
  const updates = modUpdatesFor(server);
  const mods = data.mods;
  const counts = {
    all: mods.length,
    updates: mods.filter((m) => updates.has(m.fileName) && !m.disabled).length,
    problems: mods.filter((m) => m.problem).length,
    disabled: mods.filter((m) => m.disabled).length,
  };
  document.getElementById('modsCountLine').innerHTML = `${mods.length} mods en <code>${escapeHtml(data.dir)}</code>`;

  const chips = [['all', 'Todos'], ['updates', 'Con actualización'], ['problems', 'Problemas'], ['disabled', 'Desactivados']];
  const chipsEl = document.getElementById('modsFilterChips');
  chipsEl.innerHTML = chips
    .map(([id, label]) => `<button type="button" class="mods-chip${modsUi.filter === id ? ' on' : ''}" data-filter="${id}" aria-pressed="${modsUi.filter === id}">${label} <span class="mods-chip-count">${counts[id]}</span></button>`)
    .join('');
  chipsEl.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => { modsUi.filter = b.dataset.filter; renderServerModsBody(server); })
  );

  const q = modsUi.search.trim().toLowerCase();
  const visible = mods.filter((m) => {
    if (q && !m.name.toLowerCase().includes(q) && !m.fileName.toLowerCase().includes(q)) return false;
    if (modsUi.filter === 'updates') return updates.has(m.fileName) && !m.disabled;
    if (modsUi.filter === 'problems') return Boolean(m.problem);
    if (modsUi.filter === 'disabled') return m.disabled;
    return true;
  });

  rowsEl.innerHTML = `
    <div class="mods-row mods-row-head"><span></span><span>Mod</span><span>Versión</span><span>Va en</span><span>Estado</span><span class="right">Activo</span></div>
    ${visible.length === 0 ? '<p class="hint" style="padding:16px;">No hay mods con ese filtro.</p>' : ''}
    ${visible
      .map((m, i) => {
        const st = modStatus(m, updates.get(m.fileName));
        const open = modsUi.open === m.fileName;
        const sel = modsUi.selected.has(m.fileName);
        return `
        <div class="mods-row${open ? ' open' : ''}${sel ? ' selected' : ''}">
          <span class="center"><input type="checkbox" data-sel="${i}" ${sel ? 'checked' : ''} aria-label="Seleccionar ${escapeHtml(m.name)}" /></span>
          <button type="button" class="mods-name-btn" data-open="${i}">
            ${modIcon(m.name, 32, m.disabled)}
            <span class="mods-name-text">
              <span class="mods-name${m.disabled ? ' off' : ''}">${escapeHtml(m.name)}</span>
              <span class="mod-file">${escapeHtml(m.fileName)}</span>
            </span>
          </button>
          <span class="mono">${escapeHtml(m.version || '—')}</span>
          <span class="mods-side side-${m.side}">${MOD_SIDE_LABEL[m.side] || ''}</span>
          <span><span class="mods-status ${st.cls}">${escapeHtml(st.text)}</span></span>
          <span class="right">
            <button type="button" role="switch" class="mods-switch${m.disabled ? '' : ' on'}" aria-checked="${!m.disabled}" aria-label="${m.disabled ? 'Activar' : 'Desactivar'} ${escapeHtml(m.name)}" data-toggle="${i}"><span></span></button>
          </span>
        </div>`;
      })
      .join('')}
    <div class="mods-foot hint">Mostrando ${visible.length} de ${mods.length} · los desactivados se renombran a <code>.jar.disabled</code> y el servidor no los carga</div>
  `;

  rowsEl.querySelectorAll('[data-sel]').forEach((box) =>
    box.addEventListener('change', () => {
      const m = visible[Number(box.dataset.sel)];
      if (box.checked) modsUi.selected.add(m.fileName);
      else modsUi.selected.delete(m.fileName);
      renderServerModsBody(server);
    })
  );
  rowsEl.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => { modsUi.open = visible[Number(b.dataset.open)].fileName; renderServerModsBody(server); })
  );
  rowsEl.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = visible[Number(b.dataset.toggle)];
      setModsEnabledUi(server, [m.fileName], m.disabled);
    })
  );

  renderModDetail(server, updates);
  renderModsSelectionBar(server, updates);
}

function renderModDetail(server, updates) {
  const el = document.getElementById('modsDetail');
  const m = modsUi.data.mods.find((x) => x.fileName === modsUi.open);
  if (!m) {
    el.innerHTML = '<p class="hint">Elige un mod de la lista para ver su detalle.</p>';
    return;
  }
  const update = updates.get(m.fileName);
  const dependents = m.dependents.length ? m.dependents.map(escapeHtml).join(', ') : 'Ningún otro mod';
  let note = m.note ? `<p class="mods-note-box bad">${escapeHtml(m.note)}</p>` : '';
  if (!note && update && update.missingDeps && update.missingDeps.length) {
    note = `<p class="mods-note-box warn">La versión nueva necesita también: ${update.missingDeps.map(escapeHtml).join(', ')}.</p>`;
  }
  if (!note && m.disabled && m.dependents.length) {
    note = `<p class="mods-note-box bad">Está desactivado y lo necesitan otros mods: el servidor no arrancará así.</p>`;
  }
  el.innerHTML = `
    <div class="mods-detail-head">
      ${modIcon(m.name, 44, m.disabled)}
      <div style="min-width:0;">
        <h3>${escapeHtml(m.name)}</h3>
        <span class="hint">${escapeHtml(m.source)}</span>
      </div>
    </div>
    <div class="mods-detail-file">${escapeHtml(m.fileName)}</div>
    <dl class="mods-detail-dl">
      <dt>Instalada</dt><dd>${escapeHtml(m.version || '—')}</dd>
      <dt>Última</dt><dd class="${update ? 'warn' : 'ok'}">${escapeHtml(update ? update.newVersion : m.source === 'Sin identificar' ? '—' : 'Es la última')}</dd>
      <dt>Va en</dt><dd>${MOD_SIDE_LABEL[m.side] || '—'}</dd>
      <dt>Lo necesitan</dt><dd>${dependents}</dd>
    </dl>
    ${note}
    <div class="mods-detail-actions">
      ${update && update.canDownload && !m.disabled ? `<button type="button" class="btn btn-accent" id="detailUpdate">Actualizar a ${escapeHtml(update.newVersion)}</button>` : ''}
      <div class="mods-detail-row">
        ${m.url ? `<a class="btn btn-ghost" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">Ver su página</a>` : ''}
        <button type="button" class="btn btn-ghost" id="detailToggle">${m.disabled ? 'Activar' : 'Desactivar'}</button>
        <button type="button" class="btn btn-ghost danger-ghost" id="detailRemove">Quitar</button>
      </div>
    </div>
    <div id="detailMsg" class="hint"></div>
  `;
  const upd = document.getElementById('detailUpdate');
  if (upd) upd.addEventListener('click', () => updateModsUi(server, [m.fileName]));
  document.getElementById('detailToggle').addEventListener('click', () => setModsEnabledUi(server, [m.fileName], m.disabled));
  document.getElementById('detailRemove').addEventListener('click', () => removeModsUi(server, [m.fileName]));
}

function renderModsSelectionBar(server, updates) {
  const bar = document.getElementById('modsSelectionBar');
  const chosen = modsUi.data.mods.filter((m) => modsUi.selected.has(m.fileName));
  if (chosen.length === 0) {
    bar.innerHTML = '';
    return;
  }
  const updatable = chosen.filter((m) => updates.has(m.fileName) && updates.get(m.fileName).canDownload && !m.disabled);
  const allDisabled = chosen.every((m) => m.disabled);
  bar.innerHTML = `
    <div class="mods-selection" role="region" aria-label="Acciones con los seleccionados">
      <strong>${chosen.length} seleccionados</strong>
      <div class="mods-head-actions">
        ${updatable.length ? `<button type="button" class="btn btn-accent" id="selUpdate">Actualizar (${updatable.length})</button>` : ''}
        <button type="button" class="btn btn-ghost" id="selToggle">${allDisabled ? 'Activar' : 'Desactivar'}</button>
        <button type="button" class="btn btn-ghost" id="selZip">ZIP</button>
        <button type="button" class="btn btn-ghost danger-ghost" id="selRemove">Quitar</button>
        <button type="button" class="btn btn-ghost" id="selClear">Cancelar</button>
      </div>
    </div>`;
  const su = document.getElementById('selUpdate');
  if (su) su.addEventListener('click', () => updateModsUi(server, updatable.map((m) => m.fileName)));
  document.getElementById('selToggle').addEventListener('click', () => setModsEnabledUi(server, chosen.map((m) => m.fileName), allDisabled));
  document.getElementById('selRemove').addEventListener('click', () => removeModsUi(server, chosen.map((m) => m.fileName)));
  document.getElementById('selClear').addEventListener('click', () => { modsUi.selected.clear(); renderServerModsBody(server); });
  document.getElementById('selZip').addEventListener('click', async () => {
    const status = document.getElementById('modsStatus');
    status.textContent = IS_WEB ? 'Preparando el ZIP…' : 'Elige dónde guardar el ZIP…';
    try {
      const result = await window.api.exportModsZip(server.id, chosen.map((m) => ({ file: m.file, fileName: m.fileName })));
      if (result.canceled) { status.textContent = ''; return; }
      status.innerHTML = result.ok
        ? `ZIP creado con ${result.count} mods (${(result.size / 1024 / 1024).toFixed(1)} MB).`
        : `<span class="error-text">${escapeHtml(result.error)}</span>`;
    } catch (error) {
      status.innerHTML = `<span class="error-text">${escapeHtml(error.message)}</span>`;
    }
  });
}

async function serverStoppedOrWarn(server, action) {
  if (await window.api.isRunning(server.id)) {
    document.getElementById('modsStatus').innerHTML = `<span class="error-text">Detén el servidor antes de ${action}.</span>`;
    return false;
  }
  return true;
}

async function setModsEnabledUi(server, fileNames, enabled) {
  if (!(await serverStoppedOrWarn(server, enabled ? 'activar mods' : 'desactivar mods'))) return;
  if (!enabled) {
    const needed = modsUi.data.mods.filter((m) => fileNames.includes(m.fileName) && m.dependents.length);
    if (needed.length && !confirm(`${needed.map((m) => `${m.name} lo necesitan: ${m.dependents.join(', ')}`).join('\n')}\n\nSi lo desactivas, esos mods no arrancarán. ¿Desactivar igualmente?`)) return;
  }
  const res = await window.api.setModsEnabled(server.id, fileNames, enabled);
  const status = document.getElementById('modsStatus');
  if (!res.ok) {
    status.innerHTML = `<span class="error-text">${escapeHtml(res.error)}</span>`;
    return;
  }
  // Los nombres cambian (.jar <-> .jar.disabled): se mantienen selección y detalle
  for (const c of res.changed) {
    if (modsUi.selected.delete(c.fileName)) modsUi.selected.add(c.newFileName);
    if (modsUi.open === c.fileName) modsUi.open = c.newFileName;
  }
  status.innerHTML = res.failed.length
    ? `<span class="error-text">No se pudo con: ${res.failed.map((f) => `${escapeHtml(f.fileName)} (${escapeHtml(f.error)})`).join(', ')}</span>`
    : `${res.changed.length} mod(s) ${enabled ? 'activados' : 'desactivados'}. Se nota al arrancar el servidor.`;
  await loadServerMods(server);
}

async function removeModsUi(server, fileNames) {
  if (!(await serverStoppedOrWarn(server, 'quitar mods'))) return;
  const needed = modsUi.data.mods.filter((m) => fileNames.includes(m.fileName) && m.dependents.length);
  let msg = `Se quitarán ${fileNames.length} mod(s) del servidor. No se borran: van a una carpeta mods-quitados-<fecha>.`;
  if (needed.length) msg += `\n\nOjo, otros mods los necesitan:\n${needed.map((m) => `${m.name}: ${m.dependents.join(', ')}`).join('\n')}`;
  if (!confirm(`${msg}\n\n¿Continuar?`)) return;
  const res = await window.api.removeServerMods(server.id, fileNames);
  const status = document.getElementById('modsStatus');
  if (!res.ok) {
    status.innerHTML = `<span class="error-text">${escapeHtml(res.error)}</span>`;
    return;
  }
  fileNames.forEach((f) => modsUi.selected.delete(f));
  status.innerHTML = `${res.removed.length} mod(s) quitados.${res.asideDir ? ` Están en <code>${escapeHtml(res.asideDir)}</code>.` : ''}`;
  await loadServerMods(server);
}

async function updateModsUi(server, fileNames) {
  if (!(await serverStoppedOrWarn(server, 'actualizar mods'))) return;
  const updates = modUpdatesFor(server);
  const withDeps = fileNames.map((f) => updates.get(f)).filter((u) => u && u.missingDeps && u.missingDeps.length);
  let msg = `Se actualizarán ${fileNames.length} mod(s). Antes se hará un backup completo del servidor y las versiones viejas se guardan en mods-antiguos-<fecha>.`;
  if (withDeps.length) msg += `\n\nOjo: ${withDeps.map((u) => `${u.name} necesita ${u.missingDeps.join(', ')}`).join('; ')}.`;
  if (!confirm(`${msg}\n\n¿Continuar?`)) return;
  const status = document.getElementById('modsStatus');
  const startTime = Date.now();
  status.innerHTML = progressPlaceholder('Haciendo backup completo…');
  window.api.onModUpdateProgress(server.id, (p) => {
    if (p.phase === 'backup') renderProgressBar(status, p, startTime);
    else if (p.phase === 'download') status.textContent = `Descargando ${p.index} de ${p.total}: ${p.name}…`;
  });
  try {
    const res = await window.api.applyModUpdates(server.id, fileNames, { fullBackup: true });
    if (!res.ok) {
      status.innerHTML = `<span class="error-text">${escapeHtml(res.error)}</span>`;
      return;
    }
    let html = `<span class="settings-status good">✓ ${res.updated.length} mod(s) actualizados.</span>`;
    if (res.failed.length) html += ` <span class="error-text">Fallaron: ${res.failed.map((f) => `${escapeHtml(f.name)} (${escapeHtml(f.error)})`).join('; ')}</span>`;
    html += ' Arranca el servidor para comprobarlo y que tus amigos actualicen con "Pasar mods con mi Minecraft".';
    status.innerHTML = html;
    for (const u of res.updated) {
      if (modsUi.selected.delete(u.fileName)) modsUi.selected.add(u.newFileName);
      if (modsUi.open === u.fileName) modsUi.open = u.newFileName;
    }
    delete modUpdateCache[server.id];
    await loadServerMods(server);
    checkServerModUpdates(server, { force: false, quiet: true });
  } catch (error) {
    status.innerHTML = `<span class="error-text">${escapeHtml(error.message)}</span>`;
  } finally {
    window.api.removeModUpdateProgressListeners(server.id);
  }
}

// ---------------------------------------------------------------------------
// "Añadir mods": analizar una carpeta (lo que antes era "Preparar el servidor")
// ---------------------------------------------------------------------------

function renderAddModsView(server) {
  const el = document.getElementById('tab-mods');
  el.innerHTML = `
    <div class="mods-head">
      <div style="display:flex; align-items:center; gap:12px;">
        <button type="button" class="btn btn-ghost" id="modsBack" aria-label="Volver a los mods del servidor">←</button>
        <div>
          <h2 class="mods-title">Añadir mods al servidor</h2>
          <div class="hint">Elige una carpeta <code>mods</code> (la de tu Minecraft, un modpack descargado…) y te digo cuáles van en el servidor y cuáles son solo de cliente.</div>
        </div>
      </div>
    </div>
    <div class="mods-toolbar">
      <button id="pickModsBtn" class="btn btn-accent">Elegir carpeta de mods</button>
      <span id="modsFolderLabel" class="hint"></span>
    </div>
    <div id="modsResult"></div>
  `;
  document.getElementById('modsBack').addEventListener('click', () => { modsUi.view = 'list'; renderMods(server); });
  document.getElementById('pickModsBtn').addEventListener('click', async () => {
    const folder = await window.api.pickModsFolder();
    if (!folder) return;
    const btn = document.getElementById('pickModsBtn');
    const resultEl = document.getElementById('modsResult');
    document.getElementById('modsFolderLabel').textContent = folder;
    resultEl.innerHTML = '<p class="hint">Analizando mods en Modrinth y CurseForge… (con muchos mods puede tardar un poco)</p>';
    btn.disabled = true;
    try {
      const res = await window.api.analyzeMods(folder, server.id);
      if (!res.ok) {
        resultEl.innerHTML = `<p class="error-text">${escapeHtml(res.error)}</p>`;
        return;
      }
      lastModAnalysis = res.results;
      lastModAnalysisInfo = res;
      renderModsTable(server);
    } catch (error) {
      resultEl.innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Pantalla 2: pasar mods entre el servidor y tu Minecraft
// ---------------------------------------------------------------------------

const syncUi = { folder: null, label: null, original: null, rows: null, ops: [], showSame: false, instances: null, applied: null };

const SYNC_KIND = {
  missing: { text: 'Te falta', tone: 'warn', order: 0 },
  missingOptional: { text: 'Te falta · opcional', tone: 'muted', order: 1 },
  different: { text: 'Otra versión', tone: 'warn', order: 2 },
  extra: { text: 'El servidor no lo tiene', tone: 'bad', order: 3 },
  serverOnlyInClient: { text: 'Solo servidor: te sobra', tone: 'bad', order: 4 },
  clientInServer: { text: 'Solo cliente: sobra en el servidor', tone: 'bad', order: 4 },
  fineClient: { text: 'Solo cliente · bien', tone: 'muted', order: 6 },
  fineServer: { text: 'Solo servidor · bien', tone: 'muted', order: 6 },
  same: { text: 'Igual', tone: 'ok', order: 7 },
};

async function renderSyncView(server) {
  const el = document.getElementById('tab-mods');
  el.innerHTML = `
    <div class="mods-head">
      <div style="display:flex; align-items:center; gap:12px;">
        <button type="button" class="btn btn-ghost" id="modsBack" aria-label="Volver a los mods del servidor">←</button>
        <div>
          <h2 class="mods-title">Pasar mods entre el servidor y tu Minecraft</h2>
          <div class="hint">Cada fila es un mod; a cada lado, si está en esa carpeta y en qué versión. No se toca nada hasta que pulses Aplicar.</div>
        </div>
      </div>
      <div class="mods-head-actions">
        <button type="button" class="btn btn-ghost" id="syncCopyAll">Copiar a mi Minecraft todo lo que falta</button>
        <button type="button" class="btn btn-ghost" id="syncToggleSame"></button>
        <button type="button" class="btn btn-ghost" id="syncPackZip">ZIP para tus amigos</button>
      </div>
    </div>
    <div class="sync-grid sync-sides">
      <div class="sync-side-card">
        <div class="sync-side-title"><strong>Servidor · ${escapeHtml(server.name)}</strong><span class="hint" id="syncServerCount"></span></div>
        <span class="mod-file" id="syncServerPath"></span>
      </div>
      <div class="sync-arrows" aria-hidden="true">⇄</div>
      <div class="sync-side-card">
        <div class="sync-side-title">
          <label for="syncClientPick"><strong>Tu Minecraft</strong></label>
          <select id="syncClientPick"><option value="">Buscando instancias…</option></select>
          <span class="hint" id="syncClientCount"></span>
        </div>
        <span class="mod-file" id="syncClientPath"></span>
      </div>
    </div>
    <div class="mods-chips" id="syncSummary" style="margin-top:12px;"></div>
    <div id="syncRows" class="sync-rows"><p class="hint">Elige tu Minecraft arriba.</p></div>
    <div class="sync-pending" id="syncPending"></div>
  `;
  document.getElementById('modsBack').addEventListener('click', () => { modsUi.view = 'list'; renderMods(server); });
  document.getElementById('syncCopyAll').addEventListener('click', () => syncCopyAllMissing(server));
  document.getElementById('syncToggleSame').addEventListener('click', () => { syncUi.showSame = !syncUi.showSame; renderSyncRows(server); });
  document.getElementById('syncPackZip').addEventListener('click', () => syncPackZip(server));

  const pick = document.getElementById('syncClientPick');
  if (!syncUi.instances) {
    try {
      const info = await window.api.getLocalWorldInfo(server.id);
      syncUi.instances = info.ok ? info.instances : [];
    } catch (error) {
      syncUi.instances = [];
    }
  }
  // Separador de rutas del propio PC donde están las carpetas (no del navegador)
  const join = (base, name) => `${base}${base.includes('\\') ? '\\' : '/'}${name}`;
  const options = syncUi.instances.map((i) => ({ value: join(i.path, 'mods'), label: `${i.label}${i.mods ? ` · ${i.mods} mods` : ''}` }));
  if (syncUi.folder && !options.some((o) => o.value === syncUi.folder)) options.unshift({ value: syncUi.folder, label: syncUi.label || syncUi.folder });
  pick.innerHTML = options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('') + '<option value="__otra">Otra carpeta…</option>';
  if (!syncUi.folder && options[0]) syncUi.folder = options[0].value;
  if (syncUi.folder) pick.value = syncUi.folder;
  pick.addEventListener('change', async () => {
    if (pick.value === '__otra') {
      const folder = await window.api.pickModsFolder();
      if (!folder) { pick.value = syncUi.folder || ''; return; }
      syncUi.folder = folder;
      syncUi.label = folder;
      renderSyncView(server);
      return;
    }
    syncUi.folder = pick.value;
    syncUi.label = pick.selectedOptions[0].textContent;
    loadSync(server);
  });
  if (syncUi.folder) loadSync(server);
  else document.getElementById('syncRows').innerHTML = '<p class="hint">No he encontrado tu Minecraft automáticamente: elige "Otra carpeta…" y busca la carpeta <code>mods</code> de tu instancia.</p>';
}

async function loadSync(server) {
  const rowsEl = document.getElementById('syncRows');
  document.getElementById('syncClientPath').textContent = syncUi.folder;
  rowsEl.innerHTML = '<p class="hint">Comparando las dos carpetas… (con muchos mods tarda un poco)</p>';
  let res;
  try {
    res = await window.api.compareClientMods(syncUi.folder, server.id);
  } catch (error) {
    res = { ok: false, error: error.message };
  }
  if (state.selectedId !== server.id || modsUi.view !== 'sync') return;
  if (!res.ok) {
    rowsEl.innerHTML = `<p class="error-text">${escapeHtml(res.error)}</p>`;
    return;
  }
  syncUi.original = res.rows.map((r) => ({ ...r }));
  syncUi.rows = res.rows.map((r) => ({ ...r }));
  syncUi.ops = [];
  syncUi.applied = null;
  syncUi.warnings = res.warnings || [];
  document.getElementById('syncServerPath').textContent = res.serverModsDir;
  renderSyncRows(server);
}

function syncChange(server, key, patch, op) {
  syncUi.rows = syncUi.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)).filter((r) => r.server || r.client);
  syncUi.ops.push(op);
  syncUi.applied = null;
  renderSyncRows(server);
}

function syncActionsFor(server, r) {
  const actions = [];
  const name = r.name;
  if (r.kind === 'missing' || r.kind === 'missingOptional') {
    actions.push({ dir: 'toClient', label: `Copiar a tu Minecraft ${name}`, run: () => syncChange(server, r.key, { client: { ...r.server }, kind: 'same' }, { type: 'copy', file: r.server.fileName, text: `Copiar ${name} a tu Minecraft` }) });
  }
  if (r.kind === 'different') {
    actions.push({ dir: 'toServer', label: `Poner en el servidor tu versión de ${name}`, run: () => syncChange(server, r.key, { server: { ...r.client }, kind: 'same' }, { type: 'toServerReplace', clientFile: r.client.fileName, serverFile: r.server.fileName, text: `${name}: servidor ${r.server.version || ''} → ${r.client.version || 'tu versión'}` }) });
    actions.push({ dir: 'toClient', label: `Poner en tu Minecraft la versión del servidor de ${name}`, run: () => syncChange(server, r.key, { client: { ...r.server }, kind: 'same' }, { type: 'replace', client: r.client.fileName, server: r.server.fileName, text: `${name}: tu ${r.client.version || ''} → ${r.server.version || 'la del servidor'}` }) });
  }
  if (r.kind === 'extra') {
    actions.push({ dir: 'toServer', label: `Copiar al servidor ${name}`, run: () => syncChange(server, r.key, { server: { ...r.client }, kind: 'same' }, { type: 'toServer', file: r.client.fileName, text: `Copiar ${name} al servidor` }) });
  }
  if (r.kind === 'extra' || r.kind === 'serverOnlyInClient') {
    actions.push({ dir: 'removeClient', label: `Quitar de tu Minecraft ${name}`, run: () => syncChange(server, r.key, { client: null, kind: r.server ? 'fineServer' : r.kind }, { type: 'remove', file: r.client.fileName, text: `Quitar ${name} de tu Minecraft` }) });
  }
  if (r.kind === 'clientInServer') {
    actions.push({ dir: 'removeServer', label: `Quitar del servidor ${name}`, run: () => syncChange(server, r.key, { server: null, kind: r.client ? 'fineClient' : r.kind }, { type: 'removeServer', file: r.server.fileName, text: `Quitar ${name} del servidor` }) });
  }
  return actions;
}

const SYNC_ICONS = {
  toClient: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>',
  toServer: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"></path></svg>',
  removeClient: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>',
};
SYNC_ICONS.removeServer = SYNC_ICONS.removeClient;

function syncCell(sideData, name, emptyText, highlight) {
  if (!sideData) return `<div class="sync-cell empty"><span class="hint">${emptyText}</span></div>`;
  return `<div class="sync-cell${highlight ? ` ${highlight}` : ''}">
      <span class="sync-cell-top"><span class="sync-cell-name">${escapeHtml(name)}</span>${sideData.version ? `<span class="sync-ver">${escapeHtml(sideData.version)}</span>` : ''}</span>
      <span class="mod-file">${escapeHtml(sideData.fileName)}</span>
    </div>`;
}

function renderSyncRows(server) {
  const rowsEl = document.getElementById('syncRows');
  if (!rowsEl || !syncUi.rows) return;
  const rows = syncUi.rows;
  const count = (k) => rows.filter((r) => r.kind === k).length;
  document.getElementById('syncServerCount').textContent = `${rows.filter((r) => r.server).length} mods`;
  document.getElementById('syncClientCount').textContent = `${rows.filter((r) => r.client).length} mods`;
  document.getElementById('syncToggleSame').textContent = syncUi.showSame ? 'Ocultar los iguales' : 'Mostrar también los iguales';

  const summary = [
    [`${count('missing')} te faltan`, count('missing') ? 'warn' : 'muted'],
    [`${count('different')} en otra versión`, count('different') ? 'warn' : 'muted'],
    [`${count('extra') + count('serverOnlyInClient')} te sobran`, count('extra') + count('serverOnlyInClient') ? 'bad' : 'muted'],
    [`${count('clientInServer')} sobran en el servidor`, count('clientInServer') ? 'bad' : 'muted'],
    [`${count('same')} iguales`, 'ok'],
  ];
  document.getElementById('syncSummary').innerHTML =
    summary.map(([t, tone]) => `<span class="mods-status ${tone} big">${escapeHtml(t)}</span>`).join('') +
    (syncUi.warnings && syncUi.warnings.includes('curseforge-sin-clave') ? '<span class="hint">Sin clave de CurseForge, algunos mods salen sin identificar.</span>' : '');

  const visible = rows
    .filter((r) => syncUi.showSame || r.kind !== 'same')
    .sort((a, b) => SYNC_KIND[a.kind].order - SYNC_KIND[b.kind].order || a.name.localeCompare(b.name));
  const hiddenSame = syncUi.showSame ? 0 : count('same');

  rowsEl.innerHTML = visible.length === 0 && !hiddenSame
    ? '<p class="hint">No hay mods en ninguna de las dos carpetas.</p>'
    : visible
        .map((r, i) => {
          const kind = SYNC_KIND[r.kind];
          const diff = r.kind === 'different';
          const actions = syncActionsFor(server, r);
          return `
          <div class="sync-grid sync-row">
            ${syncCell(r.server, r.name, 'No está en el servidor', r.kind === 'missing' || diff ? 'accent' : r.kind === 'clientInServer' ? 'danger' : '')}
            <div class="sync-mid">
              <span class="mods-status ${kind.tone}">${escapeHtml(kind.text)}${r.needUnknown && r.kind === 'missing' ? ' (revisar)' : ''}</span>
              <div class="sync-buttons">
                ${actions.map((a, j) => `<button type="button" class="sync-btn ${a.dir}" data-row="${i}" data-act="${j}" aria-label="${escapeHtml(a.label)}" title="${escapeHtml(a.label)}">${SYNC_ICONS[a.dir]}</button>`).join('')}
              </div>
            </div>
            ${syncCell(r.client, r.name, 'No está en tu Minecraft', diff ? 'accent' : r.kind === 'extra' || r.kind === 'serverOnlyInClient' ? 'danger' : '')}
          </div>`;
        })
        .join('') +
      (hiddenSame ? `<button type="button" class="sync-show-same" id="syncShowSame">+ ${hiddenSame} mods iguales en los dos lados</button>` : '');

  rowsEl.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', () => syncActionsFor(server, visible[Number(b.dataset.row)])[Number(b.dataset.act)].run())
  );
  const showSame = document.getElementById('syncShowSame');
  if (showSame) showSame.addEventListener('click', () => { syncUi.showSame = true; renderSyncRows(server); });
  renderSyncPending(server);
}

function renderSyncPending(server) {
  const el = document.getElementById('syncPending');
  const n = syncUi.ops.length;
  const title = syncUi.applied ? syncUi.applied : n ? `${n} cambio(s) pendiente(s)` : 'Sin cambios pendientes';
  const detail = n
    ? syncUi.ops.map((o) => o.text).join(' · ')
    : syncUi.applied
      ? 'Cierra y abre Minecraft para que coja los cambios.'
      : 'Usa las flechas para pasar un mod de un lado a otro, o la ✕ para quitarlo.';
  el.innerHTML = `
    <div class="sync-pending-text"><strong>${title}</strong><span class="hint">${escapeHtml(detail)}</span></div>
    <div class="mods-head-actions">
      <button type="button" class="btn btn-ghost" id="syncUndo" ${n ? '' : 'disabled'}>Deshacer todo</button>
      <button type="button" class="btn btn-accent" id="syncApply" ${n ? '' : 'disabled'}>Aplicar cambios</button>
    </div>`;
  document.getElementById('syncUndo').addEventListener('click', () => {
    syncUi.rows = syncUi.original.map((r) => ({ ...r }));
    syncUi.ops = [];
    renderSyncRows(server);
  });
  document.getElementById('syncApply').addEventListener('click', () => applySync(server));
}

function syncCopyAllMissing(server) {
  if (!syncUi.rows) return;
  for (const r of [...syncUi.rows]) {
    if (r.kind === 'missing') syncActionsFor(server, r)[0].run();
    else if (r.kind === 'different') syncActionsFor(server, r).find((a) => a.dir === 'toClient').run();
  }
}

async function applySync(server) {
  const changes = { copy: [], replace: [], remove: [], toServer: [], removeServer: [] };
  for (const o of syncUi.ops) {
    if (o.type === 'copy') changes.copy.push(o.file);
    else if (o.type === 'replace') changes.replace.push({ client: o.client, server: o.server });
    else if (o.type === 'remove') changes.remove.push(o.file);
    else if (o.type === 'toServer') changes.toServer.push(o.file);
    else if (o.type === 'toServerReplace') { changes.toServer.push(o.clientFile); changes.removeServer.push(o.serverFile); }
    else if (o.type === 'removeServer') changes.removeServer.push(o.file);
  }
  const touchesServer = changes.toServer.length || changes.removeServer.length;
  if (touchesServer && (await window.api.isRunning(server.id))) {
    alert('Hay cambios en el servidor: detenlo antes de aplicar.');
    return;
  }
  if (!confirm(`Se aplicarán ${syncUi.ops.length} cambio(s). Lo que se quita o se sustituye no se borra: se mueve a una carpeta mods-quitados-<fecha>.\n\nCierra Minecraft antes. ¿Continuar?`)) return;
  const btn = document.getElementById('syncApply');
  btn.disabled = true;
  let res;
  try {
    res = await window.api.applyClientSync(syncUi.folder, server.id, changes);
  } catch (error) {
    res = { ok: false, error: error.message };
  }
  if (!res.ok) {
    alert(`No se pudo aplicar: ${res.error}`);
    btn.disabled = false;
    return;
  }
  const parts = [`✓ Hecho`];
  if (res.failed.length) parts.push(`(fallaron ${res.failed.length}: ${res.failed.map((f) => f.fileName).join(', ')})`);
  const where = [res.asideDir, res.serverAsideDir].filter(Boolean);
  if (where.length) parts.push(`· lo quitado está en ${where.join(' y ')}`);
  delete modUpdateCache[server.id];
  await loadSync(server);
  syncUi.applied = parts.join(' ');
  renderSyncPending(server);
}

async function syncPackZip(server) {
  if (!syncUi.rows) return;
  const needed = syncUi.original.filter((r) => r.server && ['same', 'missing', 'different'].includes(r.kind));
  const files = needed.map((r) => ({ file: r.server.file, fileName: r.server.fileName }));
  const el = document.getElementById('syncPending');
  try {
    const result = await window.api.exportModsZip(server.id, files);
    if (result.canceled) return;
    alert(result.ok
      ? `ZIP creado con ${result.count} mods (${(result.size / 1024 / 1024).toFixed(1)} MB): todos los mods del servidor que hacen falta para jugar. Tus amigos lo descomprimen en su carpeta mods.`
      : `Error: ${result.error}`);
  } catch (error) {
    if (el) alert(`Error: ${error.message}`);
  }
}

function renderModsTable(server) {
  const container = document.getElementById('modsResult');
  if (lastModAnalysis.length === 0) {
    container.innerHTML = '<p class="hint">No se han encontrado archivos .jar en esa carpeta.</p>';
    return;
  }
  const info = lastModAnalysisInfo || {};
  const isServerFolder = Boolean(info.isServerModsFolder);

  const sourceText = (m) =>
    m.source === 'curseforge' ? ' (según CurseForge)' : m.source === 'jar' ? ' (según el propio mod)' : '';

  const badge = (m) => {
    if (m.status === 'needed') return `<span class="badge badge-needed" title="Necesario en servidor${sourceText(m)}">Necesario en servidor</span>`;
    if (m.status === 'client-only') return `<span class="badge badge-client" title="Solo cliente${sourceText(m)}">Solo cliente</span>`;
    if (m.curseforgeUrl) return '<span class="badge badge-unknown" title="Está en CurseForge, pero su autor no indica si va en cliente o servidor">Lado sin indicar</span>';
    return '<span class="badge badge-unknown">No identificado</span>';
  };

  const serverStateBadge = (serverState) => {
    if (serverState === 'new') return '<span class="badge badge-unknown">Nuevo</span>';
    if (serverState === 'different') return '<span class="badge badge-needed">Actualización</span>';
    if (serverState === 'same') return '<span class="badge">Ya está igual</span>';
    return '';
  };

  const links = (m) => {
    const out = [];
    if (m.modrinthUrl) out.push(`<a href="${escapeHtml(m.modrinthUrl)}" target="_blank" rel="noopener">Modrinth</a>`);
    if (m.curseforgeUrl) out.push(`<a href="${escapeHtml(m.curseforgeUrl)}" target="_blank" rel="noopener">CurseForge</a>`);
    return out.join(' · ') || '—';
  };

  const row = (m, i, checkClass) => {
    // Todos salen marcados: los que ya están iguales en el servidor también (para
    // el ZIP hacen falta). Al copiar, esos se saltan solos sin volver a escribirlos.
    // Solo se desmarcan las versiones sobrantes de un mod repetido.
    return `
      <tr>
        <td><input type="checkbox" class="${checkClass}" data-i="${i}" ${m.duplicateOf && !m.keepDuplicate ? '' : 'checked'} /></td>
        <td>${escapeHtml(m.name)}${m.name !== m.fileName ? `<br><span class="hint mod-file">${escapeHtml(m.fileName)}</span>` : ''}${m.duplicateOf
          ? `<br><span class="badge badge-client" title="Otra versión del mismo mod: ${escapeHtml(m.duplicateOf.join(', '))}">${m.keepDuplicate ? 'Duplicado: se deja este' : 'Duplicado: desmarcado'}</span>`
          : ''}</td>
        <td>${badge(m)}</td>
        ${isServerFolder ? '' : `<td>${serverStateBadge(m.serverState)}</td>`}
        <td>${links(m)}</td>
      </tr>`;
  };

  const indexed = lastModAnalysis.map((m, i) => ({ m, i }));
  const serverList = indexed.filter(({ m }) => m.status !== 'client-only');
  const clientList = indexed.filter(({ m }) => m.status === 'client-only');
  const serverRows = serverList.map(({ m, i }) => row(m, i, 'modCheckServer')).join('');
  const clientRows = clientList.map(({ m, i }) => row(m, i, 'modCheckClient')).join('');
  const head = (first) =>
    `<thead><tr><th>${first}</th><th>Mod</th><th>Estado</th>${isServerFolder ? '' : '<th>En el servidor</th>'}<th></th></tr></thead>`;
  const selectBar = (cls) => `
    <div class="mods-select-bar">
      <button type="button" class="btn btn-ghost btn-small" data-select-all="${cls}">Marcar todos</button>
      <button type="button" class="btn btn-ghost btn-small" data-select-none="${cls}">Desmarcar todos</button>
      <span class="hint" data-count="${cls}"></span>
    </div>`;

  // Avisos: CurseForge sin clave, fallos de conexión, carpeta del propio servidor...
  const notes = [];
  const unknownCount = lastModAnalysis.filter((m) => m.status === 'unknown').length;
  for (const w of info.warnings || []) {
    if (w === 'curseforge-sin-clave') {
      notes.push(`<p class="hint mods-note">Hay mods que no están en Modrinth. Para buscarlos también en CurseForge, pon tu clave de API de CurseForge en <a href="#" id="modsOpenSettings">Ajustes</a>.</p>`);
    } else {
      notes.push(`<p class="error-text mods-note">${escapeHtml(w)}</p>`);
    }
  }
  if (isServerFolder) {
    notes.push('<p class="hint mods-note">Estás analizando la carpeta <code>mods</code> del propio servidor. Aquí lo útil es ver qué mods son <strong>solo de cliente</strong> (sobran en el servidor y a veces lo hacen fallar) y generar los ZIP.</p>');
  }
  const dupes = lastModAnalysis.filter((m) => m.duplicateOf && !m.keepDuplicate);
  if (dupes.length > 0) {
    notes.push(`<p class="error-text mods-note">Hay mods repetidos en varias versiones (el servidor no arranca con dos versiones del mismo mod). He dejado marcada una de cada y desmarcado: ${dupes.map((m) => escapeHtml(m.fileName)).join(', ')}. Revísalo y, si sobran, bórralos también de la carpeta.</p>`);
  }
  if (unknownCount > 0) {
    notes.push(`<p class="hint mods-note">${unknownCount} mod(s) sin dato claro de cliente/servidor: van en la lista del servidor por si acaso. Revísalos con el enlace si tienes dudas.</p>`);
  }

  container.innerHTML = `
    ${notes.join('')}
    <h3 style="margin-top:14px;">Mods para el servidor (${serverList.length})</h3>
    ${serverRows ? `
    ${selectBar('modCheckServer')}
    <table class="mods-table">
      ${head(isServerFolder ? 'Incluir' : 'Copiar')}
      <tbody>${serverRows}</tbody>
    </table>
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
      ${isServerFolder ? '' : '<button id="applyModsBtn" class="btn btn-accent">Copiar seleccionados a la carpeta mods del servidor</button>'}
      <button id="exportServerZipBtn" class="btn ${isServerFolder ? 'btn-accent' : 'btn-ghost'}">Generar ZIP con los seleccionados</button>
    </div>
    ` : '<p class="hint">Ninguno de los mods analizados hace falta en el servidor.</p>'}

    <h3 style="margin-top:26px;">Mods solo de cliente (${clientList.length})</h3>
    ${clientRows ? `
    <p class="hint" style="margin-top:0;">${isServerFolder
      ? 'Estos mods están en la carpeta del servidor pero son solo de cliente: puedes quitarlos de ahí. Si quieres, genera antes un ZIP con ellos para el pack de tus amigos.'
      : 'Estos mods no van al servidor (son de interfaz/gráficos/etc. y el servidor los rechazaría o los ignoraría). Aquí los tienes aparte por si quieres, por ejemplo, generar el pack de cliente para tus amigos.'}</p>
    ${selectBar('modCheckClient')}
    <table class="mods-table">
      ${head('Incluir')}
      <tbody>${clientRows}</tbody>
    </table>
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
      <button id="exportClientZipBtn" class="btn btn-ghost">Generar ZIP con los mods de cliente</button>
    </div>
    ` : '<p class="hint">No se ha detectado ningún mod exclusivo de cliente en esta carpeta.</p>'}

    <div id="applyModsResult" class="hint" style="margin-top:14px;"></div>
  `;

  const settingsLink = document.getElementById('modsOpenSettings');
  if (settingsLink) settingsLink.addEventListener('click', (event) => { event.preventDefault(); openSettings(); });

  // Marcar / desmarcar todos y contador de seleccionados
  const updateCount = (cls) => {
    const boxes = [...container.querySelectorAll(`.${cls}`)];
    const label = container.querySelector(`[data-count="${cls}"]`);
    if (label) label.textContent = `${boxes.filter((b) => b.checked).length} de ${boxes.length} marcados`;
  };
  for (const cls of ['modCheckServer', 'modCheckClient']) {
    container.querySelectorAll(`.${cls}`).forEach((box) => box.addEventListener('change', () => updateCount(cls)));
    updateCount(cls);
  }
  container.querySelectorAll('[data-select-all], [data-select-none]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cls = btn.dataset.selectAll || btn.dataset.selectNone;
      const value = Boolean(btn.dataset.selectAll);
      container.querySelectorAll(`.${cls}`).forEach((box) => { box.checked = value; });
      updateCount(cls);
    });
  });

  const applyModsBtn = document.getElementById('applyModsBtn');
  if (applyModsBtn) applyModsBtn.addEventListener('click', async () => {
    try {
      const checked = [...document.querySelectorAll('.modCheckServer')]
        .filter((c) => c.checked)
        .map((c) => lastModAnalysis[Number(c.dataset.i)]);
      if (checked.length === 0) {
        document.getElementById('applyModsResult').innerHTML = '<span class="error-text">No hay ningún mod marcado. Pulsa "Marcar todos".</span>';
        return;
      }
      const result = await window.api.applyMods(server.id, checked, true);

      if (!result.ok) {
        document.getElementById('applyModsResult').innerHTML = `<span class="error-text">Error: ${escapeHtml(result.error)}</span>`;
        return;
      }

      const parts = [
        `${result.copiedNew.length} nuevos`,
        result.copiedOverwritten.length ? `${result.copiedOverwritten.length} actualizados` : null,
        result.alreadySame && result.alreadySame.length ? `${result.alreadySame.length} ya estaban iguales` : null,
        result.skipped.length ? `${result.skipped.length} omitidos` : null,
        result.failed.length ? `${result.failed.length} fallaron` : null,
      ].filter(Boolean);

      let html = `<strong>Carpeta destino:</strong> ${escapeHtml(result.destination)}<br>${parts.join(' · ')}`;

      if (result.failed.length) {
        html += `<br><span class="error-text">No se pudieron dejar en el servidor: ${result.failed.map((f) => escapeHtml(f.fileName)).join(', ')}. Si desaparecen justo después de copiarse, revisa que el antivirus no los esté bloqueando (algunos marcan los .jar de mods como sospechosos) y añade esa carpeta como excepción.</span>`;
      } else if (result.copiedNew.length === 0 && result.copiedOverwritten.length === 0) {
        html += `<br><span class="hint">Todos los seleccionados ya estaban iguales en el servidor: no hacía falta copiar nada.</span>`;
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
        resultEl.innerHTML = '<span class="error-text">No hay ningún mod marcado en esa lista. Pulsa "Marcar todos".</span>';
        return;
      }

      resultEl.textContent = IS_WEB ? 'Preparando el ZIP…' : 'Elige dónde guardar el ZIP…';
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

const consoleHistory = { items: [], index: -1, draft: '' };

function consoleAtBottom() {
  const log = document.getElementById('consoleLog');
  return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
}

function appendConsole(text) {
  const log = document.getElementById('consoleLog');
  const stick = consoleAtBottom();
  log.textContent += text;
  if (log.textContent.length > CONSOLE_MAX_CHARS) {
    const excess = log.textContent.length - CONSOLE_MAX_CHARS;
    const cutAt = log.textContent.indexOf('\n', excess);
    log.textContent = log.textContent.slice(cutAt === -1 ? excess : cutAt + 1);
  }
  if (stick) log.scrollTop = log.scrollHeight;
  else document.getElementById('consoleJump').hidden = false;
  if (state.currentTab === 'home') updateHomeConsole();
}

async function sendConsoleCommand() {
  const input = document.getElementById('consoleInput');
  const command = input.value.trim();
  if (!command) return;
  if (consoleHistory.items[consoleHistory.items.length - 1] !== command) consoleHistory.items.push(command);
  if (consoleHistory.items.length > 100) consoleHistory.items.shift();
  consoleHistory.index = -1;
  consoleHistory.draft = '';
  // Al enviar un comando se vuelve al final para ver la respuesta
  const log = document.getElementById('consoleLog');
  log.scrollTop = log.scrollHeight;
  appendConsole(`\n> ${command}\n`);
  input.value = '';
  input.focus();
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

// ---------------------------------------------------------------------------
// Pantalla 3: configurar mods y reglas del mundo
// ---------------------------------------------------------------------------

const RULES_ID = '__rules__';
const cfgUi = {
  serverId: null,
  groups: null,
  worldExists: true,
  running: false,
  selected: RULES_ID,
  navSearch: '',
  showClient: false,
  fileRel: null,
  file: null, // resultado de readConfig
  rules: null, // resultado de getGameRules
  edits: {}, // id -> valor nuevo (solo del archivo o de las reglas abiertas)
  search: '',
  textMode: false,
  textDraft: null,
  message: null, // { kind: 'ok' | 'error' | 'info', text }
  busy: false,
};

function humanizeKey(key) {
  const last = String(key).split('.').pop();
  const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function cfgSame(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cfgHasPending() {
  return Object.keys(cfgUi.edits).length > 0 || (cfgUi.textMode && cfgUi.file && cfgUi.textDraft !== null && cfgUi.textDraft !== cfgUi.file.content);
}

function cfgConfirmLeave() {
  return !cfgHasPending() || confirm('Tienes cambios sin guardar. ¿Descartarlos?');
}

/** Opciones abiertas ahora mismo, en un formato común (archivo .toml o reglas del mundo). */
function cfgOptions() {
  if (cfgUi.selected === RULES_ID) {
    if (!cfgUi.rules) return [];
    const groups = [];
    for (const r of cfgUi.rules.rules) {
      let g = groups.find((x) => x.title === r.group);
      if (!g) groups.push((g = { title: r.group, options: [] }));
      g.options.push({
        id: r.key,
        key: r.key,
        label: r.label === r.key ? humanizeKey(r.key) : r.label,
        help: r.help,
        type: r.type,
        value: r.value,
        default: r.default,
        range: r.min !== undefined || r.max !== undefined ? { min: r.min, max: r.max } : null,
        unit: r.unit || '',
        showKey: true,
      });
    }
    return groups;
  }
  if (!cfgUi.file || cfgUi.file.kind !== 'toml') return [];
  return cfgUi.file.sections.map((s) => ({
    title: s.title || 'General',
    help: s.help,
    readOnly: s.readOnly,
    options: s.options.map((o) => ({ ...o, label: humanizeKey(o.key), showKey: true, unit: '' })),
  }));
}

function cfgCurrent(o) {
  return Object.prototype.hasOwnProperty.call(cfgUi.edits, o.id) ? cfgUi.edits[o.id] : o.value;
}

function cfgFormat(o, v) {
  if (v === null || v === undefined) return '—';
  if (o.type === 'bool') return v ? 'Sí' : 'No';
  if (o.type === 'list') return v.length ? v.join(', ') : '(vacía)';
  if (o.type === 'string') return v === '' ? '(vacío)' : `"${v}"`;
  return `${v}${o.unit || ''}`;
}

async function renderConfigView(server) {
  const el = document.getElementById('tab-mods');
  if (cfgUi.serverId !== server.id) {
    Object.assign(cfgUi, { serverId: server.id, groups: null, selected: RULES_ID, fileRel: null, file: null, rules: null, edits: {}, search: '', navSearch: '', textMode: false, textDraft: null, message: null });
  }
  el.innerHTML = `
    <div class="mods-head">
      <div style="display:flex; align-items:center; gap:12px;">
        <button type="button" class="btn btn-ghost" id="cfgBack" aria-label="Volver a los mods del servidor">←</button>
        <div>
          <h2 class="mods-title">Configurar mods</h2>
          <div class="hint">Las opciones de cada mod y las reglas del mundo, como un formulario. No se toca ningún archivo hasta que pulses Guardar.</div>
        </div>
      </div>
      <div class="mods-head-actions">
        <button type="button" class="btn btn-ghost" id="cfgReload">Volver a leer</button>
      </div>
    </div>
    <div class="cfg-layout">
      <nav class="cfg-nav" aria-label="Mods con configuración">
        <label class="mods-search cfg-nav-search">
          <span class="visually-hidden">Buscar mod</span>
          <input type="search" id="cfgNavSearch" placeholder="Buscar mod…" value="${escapeHtml(cfgUi.navSearch)}" />
        </label>
        <div id="cfgNavList" class="cfg-nav-list"><p class="hint" style="padding:8px;">Buscando configuraciones…</p></div>
        <label class="field-inline cfg-nav-client"><input type="checkbox" id="cfgShowClient" ${cfgUi.showClient ? 'checked' : ''} /> Ver también las de solo cliente</label>
      </nav>
      <main class="cfg-main" id="cfgMain" aria-live="polite"></main>
      <aside class="cfg-pending" id="cfgPending" aria-label="Cambios sin guardar"></aside>
    </div>
  `;
  document.getElementById('cfgBack').addEventListener('click', () => {
    if (!cfgConfirmLeave()) return;
    cfgUi.edits = {};
    cfgUi.textDraft = null;
    modsUi.view = 'list';
    renderMods(server);
  });
  document.getElementById('cfgReload').addEventListener('click', () => {
    if (!cfgConfirmLeave()) return;
    cfgUi.edits = {};
    cfgUi.textDraft = null;
    cfgUi.message = null;
    cfgLoadList(server);
    cfgOpen(server, cfgUi.selected, cfgUi.fileRel);
  });
  document.getElementById('cfgNavSearch').addEventListener('input', (e) => {
    cfgUi.navSearch = e.target.value;
    cfgRenderNav(server);
  });
  document.getElementById('cfgShowClient').addEventListener('change', (e) => {
    cfgUi.showClient = e.target.checked;
    cfgRenderNav(server);
  });
  bindConfigMain(server);
  cfgRenderMain(server);
  cfgRenderPending(server);
  await cfgLoadList(server);
  if (!cfgUi.rules && cfgUi.selected === RULES_ID) cfgOpen(server, RULES_ID);
}

async function cfgLoadList(server) {
  let res;
  try {
    res = await window.api.listConfigs(server.id);
  } catch (error) {
    res = { ok: false, error: error.message };
  }
  if (state.selectedId !== server.id || modsUi.view !== 'config') return;
  if (!res.ok) {
    document.getElementById('cfgNavList').innerHTML = `<p class="error-text" style="padding:8px;">${escapeHtml(res.error)}</p>`;
    return;
  }
  cfgUi.groups = res.groups;
  cfgUi.worldExists = res.worldExists;
  cfgUi.running = res.running;
  cfgRenderNav(server);
}

function cfgRenderNav(server) {
  const box = document.getElementById('cfgNavList');
  if (!box) return;
  const q = cfgUi.navSearch.trim().toLowerCase();
  const groups = (cfgUi.groups || []).filter((g) => (cfgUi.showClient || g.serverRelevant) && (!q || g.name.toLowerCase().includes(q) || g.id.includes(q)));
  const item = (id, name, sub, iconName) => `
    <button type="button" class="cfg-nav-item${cfgUi.selected === id ? ' on' : ''}" data-cfg-pick="${escapeHtml(id)}" ${cfgUi.selected === id ? 'aria-current="page"' : ''}>
      ${modIcon(iconName, 28)}
      <span class="cfg-nav-text"><span class="cfg-nav-name">${escapeHtml(name)}</span><span class="cfg-nav-sub">${escapeHtml(sub)}</span></span>
    </button>`;
  const showRules = !q || 'minecraft reglas del mundo gamerule'.includes(q);
  box.innerHTML = `
    ${showRules ? `<div class="cfg-nav-label">Del juego</div>${item(RULES_ID, 'Minecraft (reglas del mundo)', 'Sin mods · /gamerule', 'Minecraft')}` : ''}
    <div class="cfg-nav-label">Mods${cfgUi.groups ? ` (${groups.length})` : ''}</div>
    ${cfgUi.groups === null ? '<p class="hint" style="padding:8px;">Buscando configuraciones…</p>' : groups.length ? groups.map((g) => item(g.id, g.name, `${g.files.length} archivo${g.files.length === 1 ? '' : 's'}${g.installed ? '' : ' · sin mod instalado'}`, g.name)).join('') : '<p class="hint" style="padding:8px;">No hay configuraciones que coincidan.</p>'}
  `;
  box.querySelectorAll('[data-cfg-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.cfgPick;
      if (id === cfgUi.selected) return;
      if (!cfgConfirmLeave()) return;
      cfgOpen(server, id);
    });
  });
}

async function cfgOpen(server, groupId, rel) {
  cfgUi.selected = groupId;
  cfgUi.edits = {};
  cfgUi.search = '';
  cfgUi.textMode = false;
  cfgUi.textDraft = null;
  cfgUi.message = null;
  cfgRenderNav(server);
  if (groupId === RULES_ID) {
    cfgUi.fileRel = null;
    cfgUi.file = null;
    cfgUi.rules = null;
    cfgRenderMain(server);
    cfgRenderPending(server);
    let res;
    try {
      res = await window.api.getGameRules(server.id);
    } catch (error) {
      res = { ok: false, error: error.message };
    }
    if (state.selectedId !== server.id || cfgUi.selected !== RULES_ID) return;
    if (!res.ok) cfgUi.message = { kind: 'error', text: res.error };
    else {
      cfgUi.rules = res;
      cfgUi.running = res.running;
    }
    cfgRenderMain(server);
    cfgRenderPending(server);
    return;
  }
  const group = (cfgUi.groups || []).find((g) => g.id === groupId);
  if (!group) return;
  const file = group.files.find((f) => f.rel === rel) || group.files[0];
  cfgUi.fileRel = file.rel;
  cfgUi.file = null;
  cfgRenderMain(server);
  cfgRenderPending(server);
  let res;
  try {
    res = await window.api.readConfig(server.id, file.rel);
  } catch (error) {
    res = { ok: false, error: error.message };
  }
  if (state.selectedId !== server.id || cfgUi.fileRel !== file.rel) return;
  if (!res.ok) cfgUi.message = { kind: 'error', text: res.error };
  else {
    cfgUi.file = res;
    if (res.kind !== 'toml') cfgUi.textMode = true;
    if (res.warning) cfgUi.message = { kind: 'info', text: res.warning };
  }
  cfgRenderMain(server);
  cfgRenderPending(server);
}

function cfgControl(o, v) {
  const id = escapeHtml(o.id);
  const label = escapeHtml(o.label);
  if (o.readOnly) return `<span class="cfg-readonly">${escapeHtml(o.type === 'raw' ? String(v) : cfgFormat(o, v))}</span>`;
  switch (o.type) {
    case 'bool':
      return `<button type="button" role="switch" class="cfg-switch${v ? ' on' : ''}" aria-checked="${v ? 'true' : 'false'}" aria-label="${label}" data-act="toggle" data-opt="${id}"><span></span></button>`;
    case 'int':
    case 'float': {
      const r = o.range || {};
      const hasSlider = r.min !== undefined && r.max !== undefined && Number.isFinite(r.min) && Number.isFinite(r.max) && r.max > r.min && (o.type === 'float' || r.max - r.min <= 1000);
      const step = o.type === 'int' ? 1 : (r.max - r.min) / 100 || 'any';
      return `${hasSlider ? `<input type="range" min="${r.min}" max="${r.max}" step="${step}" value="${escapeHtml(String(v))}" aria-label="${label}" data-act="num" data-opt="${id}" class="cfg-range" />` : ''}
        <input type="number" value="${escapeHtml(String(v))}" ${r.min !== undefined ? `min="${r.min}"` : ''} ${r.max !== undefined ? `max="${r.max}"` : ''} step="${o.type === 'int' ? 1 : 'any'}" aria-label="${label}" data-act="num" data-opt="${id}" class="cfg-number" />${o.unit ? `<span class="hint cfg-unit">${escapeHtml(o.unit.trim())}</span>` : ''}`;
    }
    case 'enum':
      if (o.choices.length <= 4) {
        return `<div class="cfg-seg" role="radiogroup" aria-label="${label}">${o.choices.map((c) => `<button type="button" role="radio" aria-checked="${c === v ? 'true' : 'false'}" class="${c === v ? 'on' : ''}" data-act="choice" data-opt="${id}" data-value="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}</div>`;
      }
      return `<select aria-label="${label}" data-act="select" data-opt="${id}">${o.choices.map((c) => `<option value="${escapeHtml(c)}" ${c === v ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>`;
    case 'string':
      return `<input type="text" class="cfg-text" value="${escapeHtml(v)}" aria-label="${label}" data-act="text" data-opt="${id}" />`;
    case 'list':
      return `<textarea class="cfg-list" rows="${Math.min(8, Math.max(2, v.length + 1))}" aria-label="${label} (uno por línea)" data-act="list" data-opt="${id}">${escapeHtml(v.join('\n'))}</textarea>`;
    case 'raw':
      return `<input type="text" class="cfg-text cfg-mono" value="${escapeHtml(String(v))}" aria-label="${label}" data-act="raw" data-opt="${id}" />`;
    default:
      return `<span class="cfg-readonly">${escapeHtml(String(v))}</span>`;
  }
}

function cfgRow(o) {
  const v = cfgCurrent(o);
  const changed = Object.prototype.hasOwnProperty.call(cfgUi.edits, o.id);
  const hasDefault = o.default !== null && o.default !== undefined;
  const notDefault = hasDefault && !cfgSame(v, o.default);
  return `
    <div class="cfg-row${changed ? ' changed' : ''}" data-row="${escapeHtml(o.id)}">
      <div class="cfg-row-info">
        <div class="cfg-row-title">
          <span class="cfg-row-label">${escapeHtml(o.label)}</span>
          ${changed ? '<span class="cfg-badge">sin guardar</span>' : ''}
          ${o.showKey ? `<span class="cfg-key">${escapeHtml(o.key)}</span>` : ''}
        </div>
        ${o.help ? `<div class="cfg-help">${escapeHtml(o.help)}</div>` : ''}
        ${hasDefault ? `<div class="cfg-default">Por defecto: ${escapeHtml(cfgFormat(o, o.default))}</div>` : ''}
      </div>
      <div class="cfg-row-control">
        ${cfgControl(o, v)}
        ${notDefault && !o.readOnly ? `<button type="button" class="btn btn-ghost btn-small" data-act="reset" data-opt="${escapeHtml(o.id)}" title="Volver al valor por defecto">Por defecto</button>` : ''}
      </div>
    </div>`;
}

function cfgRenderMain(server) {
  const main = document.getElementById('cfgMain');
  if (!main) return;
  const msg = cfgUi.message ? `<p class="cfg-msg ${cfgUi.message.kind}">${escapeHtml(cfgUi.message.text)}</p>` : '';
  if (cfgUi.selected === RULES_ID) {
    const rules = cfgUi.rules;
    const notice = !rules
      ? ''
      : !rules.worldExists
        ? '<p class="cfg-msg info">El mundo todavía no se ha creado: arranca el servidor una vez y podrás cambiar sus reglas.</p>'
        : rules.running
          ? '<p class="cfg-msg info">El servidor está encendido: al guardar, la app manda los /gamerule y se aplican al momento.</p>'
          : '<p class="cfg-msg info">Son las reglas de Minecraft de este mundo (se guardan en level.dat, con copia antes). No hace falta ningún mod.</p>';
    main.innerHTML = `
      <div class="cfg-title-row"><h3 class="cfg-title">Minecraft (reglas del mundo)</h3></div>
      ${notice}${msg}
      ${rules ? cfgSearchBox() + '<div id="cfgSections"></div>' : '<p class="hint">Leyendo las reglas del mundo…</p>'}`;
    cfgRenderSections(server);
    return;
  }
  const group = (cfgUi.groups || []).find((g) => g.id === cfgUi.selected);
  if (!group) {
    main.innerHTML = msg || '<p class="hint">Elige un mod a la izquierda.</p>';
    return;
  }
  const fileInfo = group.files.find((f) => f.rel === cfgUi.fileRel) || group.files[0];
  const chips = group.files
    .map((f) => `<button type="button" class="cfg-file${f.rel === cfgUi.fileRel ? ' on' : ''}" data-cfg-file="${escapeHtml(f.rel)}" title="${escapeHtml(f.note || '')}">${escapeHtml(f.rel)}${f.scope === 'serverconfig' && group.files.length > 1 ? ' · manda este' : ''}</button>`)
    .join('');
  const file = cfgUi.file;
  const canForm = file && file.kind === 'toml';
  main.innerHTML = `
    <div class="cfg-title-row">
      <h3 class="cfg-title">${escapeHtml(group.name)}</h3>
      ${canForm ? `<button type="button" class="btn btn-ghost btn-small" id="cfgTextToggle">${cfgUi.textMode ? 'Ver como formulario' : 'Editar como texto'}</button>` : ''}
    </div>
    <div class="cfg-files">${chips}</div>
    ${fileInfo && fileInfo.note ? `<p class="cfg-msg info">${escapeHtml(fileInfo.note)}.</p>` : ''}
    ${msg}
    ${!file ? '<p class="hint">Leyendo el archivo…</p>' : cfgUi.textMode ? `
      <textarea id="cfgTextArea" class="cfg-textarea" spellcheck="false" aria-label="Contenido de ${escapeHtml(file.name)}">${escapeHtml(cfgUi.textDraft !== null ? cfgUi.textDraft : file.content)}</textarea>
      <p class="hint">Se comprueba que el formato sea válido antes de guardar.</p>` : file.count === 0 ? '<p class="hint">Este archivo no tiene opciones.</p>' : cfgSearchBox() + '<div id="cfgSections"></div>'}`;
  main.querySelectorAll('[data-cfg-file]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.cfgFile === cfgUi.fileRel) return;
      if (!cfgConfirmLeave()) return;
      cfgOpen(server, cfgUi.selected, btn.dataset.cfgFile);
    });
  });
  const toggle = document.getElementById('cfgTextToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      if (!cfgConfirmLeave()) return;
      cfgUi.edits = {};
      cfgUi.textDraft = null;
      cfgUi.textMode = !cfgUi.textMode;
      cfgRenderMain(server);
      cfgRenderPending(server);
    });
  }
  const area = document.getElementById('cfgTextArea');
  if (area) {
    area.addEventListener('input', () => {
      cfgUi.textDraft = area.value;
      cfgRenderPending(server);
    });
  }
  if (!cfgUi.textMode) cfgRenderSections(server);
}

function cfgSearchBox() {
  return `<label class="mods-search cfg-search">
      <span class="visually-hidden">Buscar opción</span>
      <input type="search" id="cfgSearch" placeholder="Buscar una opción…" value="${escapeHtml(cfgUi.search)}" />
    </label>`;
}

function cfgRenderSections(server) {
  const box = document.getElementById('cfgSections');
  if (!box) return;
  const q = cfgUi.search.trim().toLowerCase();
  const sections = cfgOptions()
    .map((s) => ({ ...s, options: s.options.filter((o) => !q || `${o.label} ${o.key} ${o.help || ''}`.toLowerCase().includes(q)) }))
    .filter((s) => s.options.length);
  box.innerHTML = sections.length
    ? sections
        .map((s) => `
      <section class="cfg-section">
        <h4>${escapeHtml(s.title)}${s.readOnly ? ' <span class="hint">(solo lectura: edítalo como texto)</span>' : ''}</h4>
        ${s.help ? `<p class="cfg-help cfg-section-help">${escapeHtml(s.help)}</p>` : ''}
        ${s.options.map(cfgRow).join('')}
      </section>`)
        .join('')
    : '<p class="hint">Ninguna opción coincide con la búsqueda.</p>';
  const search = document.getElementById('cfgSearch');
  if (search && !search.dataset.bound) {
    search.dataset.bound = '1';
    search.addEventListener('input', () => {
      cfgUi.search = search.value;
      cfgRenderSections(server);
    });
  }
}

function cfgFindOption(id) {
  for (const s of cfgOptions()) for (const o of s.options) if (o.id === id) return o;
  return null;
}

function cfgSetValue(o, value) {
  if (cfgSame(value, o.value)) delete cfgUi.edits[o.id];
  else cfgUi.edits[o.id] = value;
  if (cfgUi.message && cfgUi.message.kind !== 'error') cfgUi.message = null;
}

/** Repinta una fila sin perder el foco del control que se está usando. */
function cfgRefreshRow(server, id, { keepFocus = true } = {}) {
  const row = document.querySelector(`#cfgSections [data-row="${CSS.escape(id)}"]`);
  const o = cfgFindOption(id);
  if (!row || !o) return;
  const active = document.activeElement;
  const typing = keepFocus && active && row.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
  if (typing) {
    // Solo actualizar lo de alrededor (marca "sin guardar", botón por defecto, el otro control numérico).
    const tmp = document.createElement('div');
    tmp.innerHTML = cfgRow(o);
    const fresh = tmp.firstElementChild;
    row.className = fresh.className;
    row.querySelector('.cfg-row-info').replaceWith(fresh.querySelector('.cfg-row-info'));
    const v = cfgCurrent(o);
    row.querySelectorAll('[data-act="num"]').forEach((input) => {
      if (input !== active) input.value = String(v);
    });
    const oldReset = row.querySelector('[data-act="reset"]');
    const newReset = fresh.querySelector('[data-act="reset"]');
    if (oldReset && !newReset) oldReset.remove();
    if (!oldReset && newReset) row.querySelector('.cfg-row-control').appendChild(newReset);
  } else {
    const tmp = document.createElement('div');
    tmp.innerHTML = cfgRow(o);
    const fresh = tmp.firstElementChild;
    row.replaceWith(fresh);
    if (keepFocus && active && active.dataset && active.dataset.opt === id) {
      const same = fresh.querySelector(`[data-act="${active.dataset.act}"]${active.dataset.value ? `[data-value="${CSS.escape(active.dataset.value)}"]` : ''}`);
      if (same) same.focus();
    }
  }
  cfgRenderPending(server);
}

function bindConfigMain(server) {
  const main = document.getElementById('cfgMain');
  main.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !main.contains(btn)) return;
    const o = cfgFindOption(btn.dataset.opt);
    if (!o) return;
    const act = btn.dataset.act;
    if (act === 'toggle') cfgSetValue(o, !cfgCurrent(o));
    else if (act === 'choice') cfgSetValue(o, btn.dataset.value);
    else if (act === 'reset') cfgSetValue(o, o.default);
    else return;
    cfgRefreshRow(server, o.id, { keepFocus: act !== 'reset' });
  });
  const onInput = (e) => {
    const input = e.target;
    const act = input.dataset && input.dataset.act;
    if (!['num', 'text', 'list', 'raw', 'select'].includes(act)) return;
    const o = cfgFindOption(input.dataset.opt);
    if (!o) return;
    let value = input.value;
    if (act === 'num') {
      const n = Number(String(value).replace(',', '.'));
      value = value.trim() === '' || !Number.isFinite(n) ? value : n;
    } else if (act === 'list') {
      value = value.split('\n').map((x) => x.trim()).filter(Boolean);
    }
    cfgSetValue(o, value);
    cfgRefreshRow(server, o.id);
  };
  main.addEventListener('input', onInput);
  main.addEventListener('change', (e) => {
    if (e.target.dataset && e.target.dataset.act === 'select') onInput(e);
  });
}

function cfgRenderPending(server) {
  const box = document.getElementById('cfgPending');
  if (!box) return;
  const items = [];
  for (const [id, value] of Object.entries(cfgUi.edits)) {
    const o = cfgFindOption(id);
    if (o) items.push({ label: o.label, key: o.key, from: cfgFormat(o, o.value), to: cfgFormat(o, value) });
  }
  const textChanged = cfgUi.textMode && cfgUi.file && cfgUi.textDraft !== null && cfgUi.textDraft !== cfgUi.file.content;
  const pending = items.length + (textChanged ? 1 : 0);
  const rules = cfgUi.selected === RULES_ID;
  const live = rules && cfgUi.rules && cfgUi.rules.running;
  box.innerHTML = `
    <h3 class="cfg-pending-title">${pending ? `${pending} cambio${pending === 1 ? '' : 's'} sin guardar` : 'Sin cambios'}</h3>
    ${items.length ? `<ul class="cfg-pending-list">${items.map((i) => `
      <li>
        <span class="cfg-pending-label">${escapeHtml(i.label)}</span>
        <span class="cfg-key">${escapeHtml(i.key)}</span>
        <span class="cfg-pending-values"><s>${escapeHtml(i.from)}</s> → <strong>${escapeHtml(i.to)}</strong></span>
      </li>`).join('')}</ul>` : ''}
    ${textChanged ? '<p class="hint">Has cambiado el texto del archivo.</p>' : ''}
    ${!pending ? '<p class="hint">Cambia cualquier opción y aparecerá aquí.</p>' : ''}
    <div class="cfg-pending-actions">
      <button type="button" class="btn btn-accent btn-block" id="cfgSave" ${!pending || cfgUi.busy ? 'disabled' : ''}>${cfgUi.busy ? 'Guardando…' : live ? 'Aplicar ahora' : 'Guardar cambios'}</button>
      <button type="button" class="btn btn-ghost btn-block" id="cfgDiscard" ${!pending || cfgUi.busy ? 'disabled' : ''}>Descartar</button>
    </div>
    <div class="cfg-pending-notes hint">
      ${rules
        ? '<span>• Con el servidor encendido se aplican al momento. Apagado, se guardan en el mundo (con copia antes).</span>'
        : `<span>• Antes de guardar se hace una copia del archivo en <code>config-copias</code>.</span>
           <span>• Solo cambian los valores: los comentarios y el orden se conservan.</span>
           <span>• Los cambios se aplican al reiniciar el servidor${cfgUi.running ? ' (ahora está encendido)' : ''}.</span>`}
    </div>`;
  document.getElementById('cfgSave').addEventListener('click', () => cfgSave(server));
  document.getElementById('cfgDiscard').addEventListener('click', () => {
    cfgUi.edits = {};
    cfgUi.textDraft = null;
    cfgUi.message = null;
    cfgRenderMain(server);
    cfgRenderPending(server);
  });
}

async function cfgSave(server) {
  if (cfgUi.busy) return;
  cfgUi.busy = true;
  cfgRenderPending(server);
  let res;
  try {
    if (cfgUi.selected === RULES_ID) {
      res = await window.api.setGameRules(server.id, cfgUi.edits);
    } else if (cfgUi.textMode) {
      res = await window.api.saveConfig(server.id, cfgUi.fileRel, cfgUi.file.hash, { content: cfgUi.textDraft });
    } else {
      res = await window.api.saveConfig(server.id, cfgUi.fileRel, cfgUi.file.hash, { changes: cfgUi.edits });
    }
  } catch (error) {
    res = { ok: false, error: error.message };
  }
  cfgUi.busy = false;
  if (state.selectedId !== server.id || modsUi.view !== 'config') return;
  if (!res.ok) {
    cfgUi.message = { kind: 'error', text: res.error };
    cfgRenderMain(server);
    cfgRenderPending(server);
    return;
  }
  const isRules = cfgUi.selected === RULES_ID;
  const text = isRules
    ? res.live
      ? '✓ Aplicado: las reglas ya están cambiadas en el servidor.'
      : `✓ Guardado en el mundo. Copia de level.dat en ${res.backupDir}.`
    : res.changed === false
      ? 'No había nada distinto que guardar.'
      : `✓ Guardado. Copia del archivo anterior en ${res.backupDir}. ${res.running ? 'Reinicia el servidor para aplicarlo.' : 'Se aplicará la próxima vez que enciendas el servidor.'}`;
  const keepText = cfgUi.textMode;
  await cfgOpen(server, cfgUi.selected, cfgUi.fileRel);
  if (keepText && cfgUi.file) cfgUi.textMode = true;
  cfgUi.message = { kind: 'ok', text };
  cfgRenderMain(server);
  cfgRenderPending(server);
}
