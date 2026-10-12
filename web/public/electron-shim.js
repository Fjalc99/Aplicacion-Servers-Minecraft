/**
 * "Electron" simulado para el navegador.
 *
 * preload.js hace require('electron') y usa contextBridge + ipcRenderer. Aquí
 * se ofrece un sustituto con la misma forma:
 *   - ipcRenderer.invoke(canal, arg)  -> POST /api/invoke
 *   - ipcRenderer.on(canal, listener) -> mensajes del WebSocket /ws
 *   - contextBridge.exposeInMainWorld -> window[nombre] = api
 *
 * Así preload.js se ejecuta sin cambios y la interfaz (renderer.js) ve el mismo
 * window.api que en la app de escritorio.
 */
(function () {
  const listeners = new Map(); // canal -> Set<listener>

  // ---------- WebSocket con reconexión automática ----------

  let socket = null;
  let reconnectDelay = 1000;

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/ws`);

    socket.onopen = () => {
      reconnectDelay = 1000;
      setConnectionBanner(false);
    };

    socket.onmessage = (message) => {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch (e) {
        return;
      }
      if (data.channel === 'app:notify') {
        showNotification(data.payload);
        return;
      }
      const set = listeners.get(data.channel);
      if (!set) return;
      for (const listener of set) {
        try {
          listener({ sender: null }, data.payload);
        } catch (err) {
          console.error(err);
        }
      }
    };

    socket.onclose = async () => {
      // Si se ha cerrado porque la sesión ya no vale, al login.
      try {
        const me = await fetch('/api/me');
        if (me.status === 401) {
          goToLogin();
          return;
        }
      } catch (e) {
        // Servidor caído: se sigue reintentando.
      }
      setConnectionBanner(true);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    };
  }

  function goToLogin() {
    window.location.href = '/login';
  }

  function setConnectionBanner(visible) {
    let banner = document.getElementById('webConnectionBanner');
    if (!banner && visible) {
      banner = document.createElement('div');
      banner.id = 'webConnectionBanner';
      banner.textContent = 'Sin conexión con el servidor web. Reintentando…';
      banner.style.cssText =
        'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:9999;' +
        'background:#c1554a;color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;';
      document.body.appendChild(banner);
    }
    if (banner) banner.hidden = !visible;
  }

  // ---------- Notificaciones del navegador ----------

  function showNotification({ title, body }) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  }

  // El navegador solo deja pedir permiso tras una acción del usuario.
  document.addEventListener(
    'click',
    () => {
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    },
    { once: true }
  );

  // ---------- Operaciones que en escritorio usan diálogos nativos ----------

  const FOLDER_PROMPTS = {
    'servers:pickImportFolder': 'Ruta completa de la carpeta del servidor existente:',
    'worlds:pickFolder': 'Ruta completa de la carpeta del mundo (la que contiene level.dat):',
    'mods:pickFolder': 'Ruta completa de la carpeta de mods del cliente:',
  };

  function pickFolderInBrowser(channel) {
    const value = window.prompt(
      `${FOLDER_PROMPTS[channel]}\n\n(Es una ruta del equipo donde se está ejecutando el servidor web.)`
    );
    return value && value.trim() ? value.trim().replace(/^"(.*)"$/, '$1') : null;
  }

  function triggerDownload(url) {
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // ---------- ipcRenderer simulado ----------

  const ipcRenderer = {
    async invoke(channel, arg) {
      if (FOLDER_PROMPTS[channel]) return pickFolderInBrowser(channel);

      const response = await fetch('/api/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, arg }),
      });

      let data = null;
      try {
        data = await response.json();
      } catch (e) {
        data = null;
      }

      if (response.status === 401) {
        goToLogin();
        throw new Error((data && data.error) || 'Sesión caducada');
      }
      if (!response.ok) {
        throw new Error((data && data.error) || `Error ${response.status}`);
      }

      const result = data ? data.result : null;

      // Qué tipo de acceso tiene este usuario al servidor seleccionado (propio o
      // compartido): roles.css lo usa para mostrar u ocultar controles.
      if (channel === 'servers:get' && result && result.access) {
        document.body.dataset.serverAccess = result.access;
      }

      // En escritorio el ZIP se guarda con "Guardar como"; aquí se descarga.
      if ((channel === 'mods:exportZip' || channel === 'servers:downloadBackup') && result && result.ok && result.downloadUrl) {
        triggerDownload(result.downloadUrl);
      }

      return result;
    },

    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
      return ipcRenderer;
    },

    removeAllListeners(channel) {
      listeners.delete(channel);
      return ipcRenderer;
    },
  };

  const contextBridge = {
    exposeInMainWorld(name, api) {
      window[name] = api;
    },
  };

  window.__msmRequire = function (name) {
    if (name === 'electron') return { contextBridge, ipcRenderer };
    throw new Error(`Módulo no disponible en la versión web: ${name}`);
  };

  connect();
})();
