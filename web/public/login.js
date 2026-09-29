(function () {
  const form = document.getElementById('loginForm');
  const errorEl = document.getElementById('loginError');
  const okEl = document.getElementById('loginOk');
  const submit = document.getElementById('loginSubmit');
  const repeatWrap = document.getElementById('repeatWrap');
  let mode = 'login';

  function setMode(next) {
    mode = next;
    const register = mode === 'register';
    document.getElementById('formTitle').textContent = register ? 'Crear cuenta' : 'Iniciar sesión';
    submit.textContent = register ? 'Crear cuenta' : 'Entrar';
    repeatWrap.hidden = !register;
    document.getElementById('password').autocomplete = register ? 'new-password' : 'current-password';
    document.getElementById('switchText').textContent = register ? '¿Ya tienes cuenta?' : '¿No tienes cuenta?';
    document.getElementById('switchMode').textContent = register ? 'Inicia sesión' : 'Crear una';
    errorEl.hidden = true;
  }

  document.getElementById('switchMode').addEventListener('click', () => {
    okEl.hidden = true;
    setMode(mode === 'login' ? 'register' : 'login');
  });

  async function post(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Algo ha fallado. Inténtalo otra vez.');
    return data;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    okEl.hidden = true;
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (mode === 'register' && password !== document.getElementById('password2').value) {
      errorEl.textContent = 'Las contraseñas no coinciden.';
      errorEl.hidden = false;
      return;
    }

    submit.disabled = true;
    try {
      if (mode === 'register') {
        await post('/api/register', { username, password });
        setMode('login');
        document.getElementById('password').value = '';
        document.getElementById('password2').value = '';
        okEl.textContent = 'Cuenta creada. Podrás entrar cuando el administrador la apruebe.';
        okEl.hidden = false;
      } else {
        await post('/api/login', { username, password });
        window.location.href = '/';
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      if (mode === 'login') {
        document.getElementById('password').value = '';
        document.getElementById('password').focus();
      }
    } finally {
      submit.disabled = false;
    }
  });
})();
