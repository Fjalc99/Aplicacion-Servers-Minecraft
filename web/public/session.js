// Etiqueta de sesión: quién ha entrado, cambiar la contraseña y cerrar sesión.
(function () {
  const body = document.body;
  const box = document.createElement('div');
  box.className = 'web-session';

  const who = document.createElement('span');
  const name = document.createElement('strong');
  name.textContent = body.dataset.user || '';
  who.append(name, document.createTextNode(body.dataset.role === 'admin' ? ' · admin' : ' · amigo'));

  const change = document.createElement('button');
  change.type = 'button';
  change.textContent = 'Cambiar contraseña';
  change.addEventListener('click', openPasswordDialog);

  const logout = document.createElement('button');
  logout.type = 'button';
  logout.textContent = 'Cerrar sesión';
  logout.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  box.append(who, change, logout);
  body.appendChild(box);

  function field(labelText, id) {
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'password';
    input.id = id;
    input.autocomplete = id === 'pwCurrent' ? 'current-password' : 'new-password';
    return [label, input];
  }

  function openPasswordDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'pw-overlay';
    const dialog = document.createElement('form');
    dialog.className = 'pw-dialog';
    const title = document.createElement('h3');
    title.textContent = 'Cambiar contraseña';
    const message = document.createElement('p');
    message.className = 'pw-message';
    const actions = document.createElement('div');
    actions.className = 'pw-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost';
    cancel.textContent = 'Cancelar';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'btn btn-accent';
    save.textContent = 'Guardar';
    actions.append(cancel, save);

    dialog.append(
      title,
      ...field('Contraseña actual', 'pwCurrent'),
      ...field('Contraseña nueva (mínimo 8 caracteres)', 'pwNext'),
      ...field('Repite la nueva', 'pwRepeat'),
      message,
      actions
    );
    overlay.appendChild(dialog);
    body.appendChild(overlay);
    dialog.querySelector('#pwCurrent').focus();

    const close = () => overlay.remove();
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });

    dialog.addEventListener('submit', async (event) => {
      event.preventDefault();
      const current = dialog.querySelector('#pwCurrent').value;
      const next = dialog.querySelector('#pwNext').value;
      if (next !== dialog.querySelector('#pwRepeat').value) {
        message.textContent = 'Las contraseñas nuevas no coinciden.';
        return;
      }
      save.disabled = true;
      try {
        await window.api.changeMyPassword(current, next);
        // Cambiar la contraseña cierra todas las sesiones, también esta.
        message.textContent = 'Contraseña cambiada. Vuelve a entrar con la nueva.';
        setTimeout(() => { window.location.href = '/login'; }, 1500);
      } catch (error) {
        message.textContent = error.message;
        save.disabled = false;
      }
    });
  }
})();
