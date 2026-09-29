(function () {
  const form = document.getElementById('setupForm');
  const errorEl = document.getElementById('setupError');
  const submit = document.getElementById('setupSubmit');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    const password = document.getElementById('password').value;
    if (password !== document.getElementById('password2').value) {
      errorEl.textContent = 'Las contraseñas no coinciden.';
      errorEl.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: document.getElementById('code').value,
          username: document.getElementById('username').value.trim(),
          password,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'No se pudo crear el administrador.');
      window.location.href = '/';
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
})();
