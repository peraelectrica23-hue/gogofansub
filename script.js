// ════════════════════════════════════════════
//  ⚙️ CONFIGURACIÓN — PROXY CLOUDFLARE
//  Las credenciales de Supabase viven en las
//  variables de entorno de Cloudflare Pages,
//  nunca expuestas al navegador.
// ════════════════════════════════════════════
const API_BASE = '/api/query';

// ════════════════════════════════════════════
//  ADMINS — gestionados en Supabase via RPC
//  (ya no hay credenciales hardcodeadas aquí)
// ════════════════════════════════════════════

// ════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════
let S = {
  currentUser: null,
  novelId: null,
  chapterId: null,
  fontSize: 18,
  fontFamily: 'serif',
  readerWidth: 680,
  lineHeight: 1.95,
  fontNames: ['serif', 'source', 'sans'],
  fontLabels: ['Crimson', 'Serif 4', 'Sans'],
  admin: false,
  editingNovelId: null,
  editingChapterId: null,
  chImages: [],
  novels: [],
  readMap: {},
  continueMap: {},
  favorites: [],
  displayName: null,
  avatar: null,
  // avatar temporal en prefs (antes de guardar)
  pendingAvatar: undefined,
  adminPendingAvatar: undefined,
  // reporte en curso
  reportSelection: '',
};

// ════════════════════════════════════════════
//  SUPABASE CLIENT (vía proxy Cloudflare)
// ════════════════════════════════════════════
const sb = {
  async query(path, opts = {}) {
    const url = API_BASE + '?path=' + encodeURIComponent(path);
    const headers = { 'Content-Type': 'application/json' };
    if (opts.headers) {
      // Pasar headers extra como Prefer al proxy
      Object.assign(headers, opts.headers);
    }

    let res;
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (netErr) {
      throw new Error(`Error de red: no se pudo conectar al servidor proxy (/api/query). Detalle: ${netErr.message}`);
    }

    if (!res.ok) {
      let errMsg = '';
      try {
        const text = await res.text();
        try {
          const json = JSON.parse(text);
          errMsg = json.error || json.message || JSON.stringify(json);
        } catch {
          errMsg = text && text.trim() ? text.trim().substring(0, 100) : `Error HTTP ${res.status} ${res.statusText || ''}`;
        }
      } catch (errRead) {
        errMsg = `Error HTTP ${res.status} ${res.statusText || ''}`;
      }
      throw new Error(errMsg);
    }

    try {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (parseErr) {
      throw new Error(`Respuesta no válida del servidor: ${parseErr.message}`);
    }
  },
  async getAll(table) {
    return await this.query(table + '?select=*&order=updated_at.asc') || [];
  },
  async upsert(table, data) {
    return await this.query(table, {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: data
    });
  },
  async delete(table, id) {
    return await this.query(table + '?id=eq.' + id, { method: 'DELETE' });
  },
  async getOne(table, id) {
    const rows = await this.query(table + '?id=eq.' + id + '&select=*') || [];
    return rows[0] || null;
  },
  async getWhere(table, col, val) {
    return await this.query(table + '?' + col + '=eq.' + encodeURIComponent(val) + '&select=*') || [];
  },
  async rpc(fn, params = {}) {
    let res;
    try {
      res = await fetch(API_BASE + '?path=' + encodeURIComponent('rpc/' + fn), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
    } catch (netErr) {
      throw new Error(`Error de red: no se pudo conectar al servidor proxy (/api/query). Detalle: ${netErr.message}`);
    }

    let text = '';
    try {
      text = await res.text();
    } catch (errRead) {
      // Ignorar fallo al leer cuerpo vacío
    }

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        // No es JSON, data se queda como null
      }
    }

    if (!res.ok) {
      const errMsg = (data && (data.error || data.message)) || text || `Error HTTP ${res.status} ${res.statusText || ''}`;
      throw new Error(errMsg);
    }
    return data;
  }
};

// ════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════
async function init() {
  // Verificar que el proxy responde (si no hay variables en Cloudflare, fallará aquí)
  if (localStorage.getItem('nt_dark') === '1') {
    S.dark = true; document.body.classList.add('dark');
  }

  const savedSession = localStorage.getItem('nt_session');
  if (savedSession) {
    // Intentar restaurar sesión admin via RPC
    const savedAdminPwd = sessionStorage.getItem('nt_admin_pwd');
    if (savedAdminPwd) {
      try {
        const result = await sb.rpc('login_admin', { p_username: savedSession, p_password: savedAdminPwd });
        if (result && result.success) {
          S.currentUser = { username: result.username, role: 'admin', id: 'admin_' + result.username, avatar: result.avatar };
          S.admin = true;
          loadLocalPrefs();
          updateNavUser(); updateAdminUI();
        } else {
          sessionStorage.removeItem('nt_admin_pwd');
          localStorage.removeItem('nt_session');
        }
      } catch (e) {
        sessionStorage.removeItem('nt_admin_pwd');
        localStorage.removeItem('nt_session');
      }
    } else if (savedSession === 'guest') {
      // Restaurar sesión de invitado (no requiere Supabase auth, lee de localStorage local)
      S.currentUser = { username: 'guest', role: 'user', id: null };
      S.displayName = null;
      S.avatar = null;
      loadLocalPrefs();
      updateNavUser();
    } else {
      // Usuario registrado — buscar en Supabase
      try {
        const rows = await sb.getWhere('users', 'username', savedSession);
        if (rows.length > 0) {
          S.currentUser = { username: rows[0].username, role: 'user', id: rows[0].id };
          S.displayName = rows[0].display_name || null;
          S.avatar = rows[0].avatar || null;
          await loadUserData();
        } else {
          localStorage.removeItem('nt_session');
        }
      } catch (e) { localStorage.removeItem('nt_session'); }
      updateNavUser();
    }
  }

  if (!S.currentUser) {
    document.getElementById('loadingOverlay').style.display = 'none';
    document.getElementById('appContainer').style.display = 'none';
    document.getElementById('page-landing').style.display = 'flex';
    // Mantenemos la landing page libre de popups pre-cargados al inicio
    document.getElementById('authGate').classList.remove('open');
    return;
  }

  document.getElementById('appContainer').style.display = 'block';
  document.getElementById('page-landing').style.display = 'none';

  try { await loadData(); } catch (e) { toast('Error conectando a Supabase: ' + e.message, 4000); }

  document.getElementById('loadingOverlay').style.display = 'none';
  renderHome();

  if (S.admin) updateAdminBadge();

  window.addEventListener('scroll', updateProgressBar);
  document.addEventListener('click', e => {
    if (!e.target.closest('#userDropdown') && !e.target.closest('#navUserBtn')) {
      document.getElementById('userDropdown').classList.remove('open');
    }
    // Cerrar ctx menu
    if (!e.target.closest('#ctxMenu')) {
      document.getElementById('ctxMenu').classList.remove('open');
    }
  });

  // Context menu en lector
  document.addEventListener('contextmenu', handleContextMenu);
}

// ════════════════════════════════════════════
//  AUTH — TABS
// ════════════════════════════════════════════
function switchAuthTab(tab) {
  document.getElementById('loginForm').style.display = tab === 'login' ? '' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('tabLoginBtn').classList.toggle('active', tab === 'login');
  document.getElementById('tabRegisterBtn').classList.toggle('active', tab === 'register');
  document.getElementById('loginError').textContent = '';
  document.getElementById('registerError').textContent = '';
}

// ════════════════════════════════════════════
//  AUTH — LOGIN
// ════════════════════════════════════════════
async function doLogin() {
  const username = document.getElementById('loginUser').value.trim().toLowerCase();
  const pwd = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  if (!username || !pwd) { errEl.textContent = 'Completá los campos.'; return; }

  errEl.textContent = 'Verificando...';

  // Intentar login como admin primero (via RPC seguro)
  try {
    const result = await sb.rpc('login_admin', { p_username: username, p_password: hashPwd(pwd) });
    if (result && result.success) {
      // Guardar contraseña hasheada en sessionStorage para restaurar sesión al recargar
      sessionStorage.setItem('nt_admin_pwd', hashPwd(pwd));
      S.currentUser = { username: result.username, role: 'admin', id: 'admin_' + result.username, avatar: result.avatar };
      await loginSuccess(username, 'admin', 'admin_' + username);
      return;
    }
    // Si el RPC responde success:false con "Usuario no encontrado", no es admin → intentar como user
    if (result && result.message === 'Usuario no encontrado') {
      // Continuar al login de usuario normal
    } else if (result && !result.success) {
      errEl.textContent = result.message || 'Contraseña incorrecta.';
      return;
    }
  } catch (e) {
    // Si el RPC falla totalmente, continuar al login de usuario normal
  }

  // Usuario registrado
  try {
    const rows = await sb.getWhere('users', 'username', username);
    if (rows.length === 0) { errEl.textContent = 'Usuario no encontrado.'; return; }
    const user = rows[0];
    // Usuarios registrados usan hash simple (mismo sistema de antes)
    if (user.password_hash !== hashPwd(pwd)) { errEl.textContent = 'Contraseña incorrecta.'; return; }
    S.displayName = user.display_name || null;
    S.avatar = user.avatar || null;
    await loginSuccess(username, 'user', user.id);
  } catch (e) { errEl.textContent = 'Error al conectar: ' + e.message; }
}

// Hash simple para usuarios regulares (no admins)
function hashPwdSync(pwd) {
  let h = 0;
  for (let i = 0; i < pwd.length; i++) {
    h = (Math.imul(31, h) + pwd.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
function hashPwd(pwd) {
  return 'h' + hashPwdSync(pwd).toString(36);
}

// ════════════════════════════════════════════
//  AUTH — REGISTRO
// ════════════════════════════════════════════
async function doRegister() {
  const username = document.getElementById('regUser').value.trim().toLowerCase();
  const pwd = document.getElementById('regPass').value;
  const pwd2 = document.getElementById('regPass2').value;
  const errEl = document.getElementById('registerError');

  if (!username || !pwd) { errEl.textContent = 'Completá todos los campos.'; return; }
  if (username.length < 3) { errEl.textContent = 'El usuario debe tener al menos 3 caracteres.'; return; }
  if (username === 'guest' || username === 'invitado') { errEl.textContent = 'Nombre de usuario reservado o no permitido.'; return; }
  if (pwd.length < 4) { errEl.textContent = 'La contraseña debe tener al menos 4 caracteres.'; return; }
  if (pwd !== pwd2) { errEl.textContent = 'Las contraseñas no coinciden.'; return; }
  // Verificar que no sea un nombre de admin reservado
  try {
    const adminCheck = await sb.rpc('login_admin', { p_username: username, p_password: '___invalid___' });
    if (adminCheck && adminCheck.message !== 'Usuario no encontrado') {
      errEl.textContent = 'Ese nombre de usuario no está disponible.'; return;
    }
  } catch (e) { /* ignorar */ }

  errEl.textContent = 'Creando cuenta...';
  try {
    const existing = await sb.getWhere('users', 'username', username);
    if (existing.length > 0) { errEl.textContent = 'Ese nombre de usuario ya existe.'; return; }

    const id = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const displayName = document.getElementById('regDisplayName').value.trim() || null;
    await sb.upsert('users', { id, username, password_hash: hashPwd(pwd), display_name: displayName });
    S.displayName = displayName;
    // Crear user_data inicial
    await sb.upsert('user_data', { user_id: id, favorites: [], read_map: {}, continue_map: {} });
    toast('✓ Cuenta creada. Iniciando sesión...');
    await loginSuccess(username, 'user', id);
  } catch (e) { errEl.textContent = 'Error: ' + e.message; }
}

async function loginSuccess(username, role, id) {
  S.currentUser = { username, role, id };
  localStorage.setItem('nt_session', username);
  document.getElementById('authGate').classList.remove('open');
  document.getElementById('page-landing').style.display = 'none';
  document.getElementById('appContainer').style.display = 'block';
  if (role === 'admin') {
    S.admin = true;
    loadLocalPrefs();
    updateNavUser(); updateAdminUI();
    toast('✓ Bienvenido, ' + username + ' (admin)');
  } else {
    // Limpiar cualquier token admin residual
    sessionStorage.removeItem('nt_admin_pwd');
    await loadUserData();
    updateNavUser();
    toast('✓ Bienvenido, ' + username);
  }
  document.getElementById('loadingOverlay').style.display = 'flex';
  await loadData();
  document.getElementById('loadingOverlay').style.display = 'none';
  renderHome();
  if (S.admin) updateAdminBadge();
}

function logoutUser() {
  if (S.currentUser && S.currentUser.role !== 'admin' && S.currentUser.id === null) {
    // guest: guardar en localStorage
    localStorage.setItem('nt_read', JSON.stringify(S.readMap));
    localStorage.setItem('nt_continue', JSON.stringify(S.continueMap));
    localStorage.setItem('nt_favorites', JSON.stringify(S.favorites));
  }
  if (S.admin) persistLocalPrefs();
  sessionStorage.removeItem('nt_admin_pwd');
  S.currentUser = null; S.admin = false; S.readMap = {}; S.continueMap = {}; S.favorites = [];
  localStorage.removeItem('nt_session');
  closeUserMenu(); updateNavUser(); updateAdminUI(); renderHome();
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginError').textContent = '';
  switchAuthTab('login');
  document.getElementById('appContainer').style.display = 'none';
  document.getElementById('page-landing').style.display = 'flex';
  document.getElementById('authGate').classList.add('open');
}

// ════════════════════════════════════════════
//  USER DATA (Supabase para registrados)
// ════════════════════════════════════════════
async function loadUserData() {
  if (!S.currentUser || !S.currentUser.id || S.currentUser.id === null) return;
  if (S.currentUser.role === 'admin') { loadLocalPrefs(); return; }
  try {
    const rows = await sb.getWhere('user_data', 'user_id', S.currentUser.id);
    if (rows.length > 0) {
      const d = rows[0];
      S.readMap = d.read_map || {};
      S.continueMap = d.continue_map || {};
      S.favorites = d.favorites || [];
    }
    // Preferencias visuales siguen en localStorage
    const p = JSON.parse(localStorage.getItem('nt_prefs_' + S.currentUser.username) || '{}');
    if (p.fontSize) S.fontSize = p.fontSize;
    if (p.fontFamily) S.fontFamily = p.fontFamily;
    if (p.readerWidth) S.readerWidth = p.readerWidth;
    if (p.lineHeight) S.lineHeight = p.lineHeight;
    if (p.dark !== undefined) { S.dark = p.dark; document.body.classList.toggle('dark', S.dark); localStorage.setItem('nt_dark', S.dark ? '1' : '0'); }
  } catch (e) { console.warn('No se pudo cargar user_data', e); }
}

async function saveUserData() {
  if (!S.currentUser || !S.currentUser.id) return;
  if (S.currentUser.id === null) {
    // Guest: localStorage
    localStorage.setItem('nt_read', JSON.stringify(S.readMap));
    localStorage.setItem('nt_continue', JSON.stringify(S.continueMap));
    localStorage.setItem('nt_favorites', JSON.stringify(S.favorites));
    return;
  }
  if (S.currentUser.role === 'admin') { persistLocalPrefs(); return; }
  try {
    await sb.upsert('user_data', {
      user_id: S.currentUser.id,
      favorites: S.favorites,
      read_map: S.readMap,
      continue_map: S.continueMap
    });
    // Prefs visuales en localStorage
    persistLocalPrefs();
  } catch (e) { console.warn('No se pudo guardar user_data', e); }
}

// ════════════════════════════════════════════
//  LOCAL PREFS (solo preferencias visuales)
// ════════════════════════════════════════════
function loadLocalPrefs() {
  if (!S.currentUser) return;
  const p = JSON.parse(localStorage.getItem('nt_prefs_' + S.currentUser.username) || '{}');
  if (p.fontSize) S.fontSize = p.fontSize;
  if (p.fontFamily) S.fontFamily = p.fontFamily;
  if (p.readerWidth) S.readerWidth = p.readerWidth;
  if (p.lineHeight) S.lineHeight = p.lineHeight;
  if (p.dark !== undefined) { S.dark = p.dark; document.body.classList.toggle('dark', S.dark); localStorage.setItem('nt_dark', S.dark ? '1' : '0'); }
  // Admins guardan todo en local
  if (S.currentUser.role === 'admin') {
    const adm = JSON.parse(localStorage.getItem('nt_admin_' + S.currentUser.username) || '{}');
    if (adm.readMap) S.readMap = adm.readMap;
    if (adm.continueMap) S.continueMap = adm.continueMap;
    if (adm.favorites) S.favorites = adm.favorites;
  }
}
function persistLocalPrefs() {
  if (!S.currentUser) return;
  localStorage.setItem('nt_prefs_' + S.currentUser.username, JSON.stringify({
    fontSize: S.fontSize, fontFamily: S.fontFamily,
    readerWidth: S.readerWidth, lineHeight: S.lineHeight, dark: S.dark
  }));
  if (S.currentUser.role === 'admin') {
    localStorage.setItem('nt_admin_' + S.currentUser.username, JSON.stringify({
      readMap: S.readMap, continueMap: S.continueMap, favorites: S.favorites
    }));
  }
}

function updateNavUser() {
  const av = document.getElementById('navAvatar');
  const nm = document.getElementById('navUserName');
  const ddName = document.getElementById('ddName');
  const ddRole = document.getElementById('ddRole');
  if (S.currentUser) {
    const u = S.currentUser.username;
    const displayLabel = (S.displayName && u !== 'guest') ? S.displayName : (u === 'guest' ? 'Invitado' : u);
    // Avatar: imagen si tiene, sino inicial
    const avatarSrc = S.currentUser.avatar || S.avatar;
    if (avatarSrc) {
      av.innerHTML = `<img src="${avatarSrc}" alt="">`;
    } else {
      av.textContent = u === 'guest' ? '?' : u.charAt(0).toUpperCase();
      av.innerHTML = u === 'guest' ? '?' : u.charAt(0).toUpperCase();
    }
    nm.textContent = displayLabel;
    ddName.textContent = displayLabel;
    ddRole.textContent = S.currentUser.role === 'admin' ? '⭐ Administrador' : (u === 'guest' ? 'Invitado' : 'Lector');
    av.style.background = avatarSrc ? 'transparent' : (S.currentUser.role === 'admin' ? 'var(--accent)' : (u === 'guest' ? '#888' : '#5a8a6a'));
  } else {
    av.textContent = '?'; nm.textContent = 'Entrar';
    ddName.textContent = '–'; ddRole.textContent = '–';
    av.style.background = '';
  }
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = S.admin ? 'inline-flex' : 'none';
  });
}

function toggleUserMenu() {
  if (!S.currentUser) { document.getElementById('authGate').classList.add('open'); return; }
  document.getElementById('userDropdown').classList.toggle('open');
}
function closeUserMenu() { document.getElementById('userDropdown').classList.remove('open'); }

// ════════════════════════════════════════════
//  PERFIL DE USUARIO
// ════════════════════════════════════════════
function openUserProfile() {
  closeUserMenu();
  if (!S.currentUser) return;
  if (S.currentUser.username === 'guest') { toast('Creá una cuenta para tener perfil'); return; }
  const displayLabel = S.displayName || S.currentUser.username;
  document.getElementById('profileTitle').textContent = '👤 ' + displayLabel;
  // Pre-cargar campos de configuración
  document.getElementById('profileDisplayName').value = S.displayName || '';
  document.getElementById('profileOldPwd').value = '';
  document.getElementById('profileNewPwd').value = '';
  document.getElementById('profileNewPwd2').value = '';
  document.getElementById('profileConfirmPwd').value = '';
  // Avatar preview
  S.pendingAvatar = undefined;
  renderProfileAvatarPreview();
  renderProfileStats();
  switchProfileTab('stats');
  openModal('modalProfile');
}

function switchProfileTab(tab) {
  const tabs = ['stats', 'favorites', 'history', 'settings'];
  document.querySelectorAll('#modalProfile .modal-tab').forEach((b, i) => b.classList.toggle('active', tabs[i] === tab));
  document.querySelectorAll('#modalProfile .modal-tab-panel').forEach((p, i) => p.classList.toggle('active', tabs[i] === tab));
  // Ocultar footer por defecto en tab settings (tiene su propio footer)
  const defFooter = document.getElementById('profileDefaultFooter');
  if (defFooter) defFooter.style.display = tab === 'settings' ? 'none' : '';
  if (tab === 'favorites') renderProfileFavorites();
  if (tab === 'history') renderProfileHistory();
  if (tab === 'stats') renderProfileStats();
}

function renderProfileStats() {
  const readCount = Object.keys(S.readMap).filter(k => S.readMap[k]).length;
  const favCount = S.favorites.length;
  const novelsStarted = S.novels.filter(n => (n.chapters || []).some(c => S.readMap[c.id])).length;
  const displayLabel = S.displayName || S.currentUser.username;
  document.getElementById('profileStats').innerHTML = `
    <div style="margin-bottom:1rem">
      <div class="profile-stat"><span>Usuario</span><span>${esc(S.currentUser.username)}</span></div>
      ${S.displayName ? `<div class="profile-stat"><span>Nombre visible</span><span>${esc(S.displayName)}</span></div>` : ''}
      <div class="profile-stat"><span>Capítulos leídos</span><span>${readCount}</span></div>
      <div class="profile-stat"><span>Novelas iniciadas</span><span>${novelsStarted}</span></div>
      <div class="profile-stat"><span>Favoritos</span><span>${favCount}</span></div>
      <div class="profile-stat"><span>Tipo de cuenta</span><span>${S.currentUser.role === 'admin' ? '⭐ Admin' : 'Lector'}</span></div>
    </div>`;
}

function renderProfileFavorites() {
  const el = document.getElementById('profileFavorites');
  const favNovels = S.novels.filter(n => S.favorites.includes(n.id));
  if (!favNovels.length) { el.innerHTML = '<p style="color:var(--text3);font-size:.85rem;font-style:italic;grid-column:1/-1">Sin favoritos aún.</p>'; return; }
  el.innerHTML = favNovels.map(n => novelMiniCard(n)).join('');
}

function renderProfileHistory() {
  const el = document.getElementById('profileHistory');
  const started = S.novels.filter(n => (n.chapters || []).some(c => S.readMap[c.id]));
  if (!started.length) { el.innerHTML = '<p style="color:var(--text3);font-size:.85rem;font-style:italic;grid-column:1/-1">Sin historial aún.</p>'; return; }
  el.innerHTML = started.map(n => {
    const readChs = (n.chapters || []).filter(c => S.readMap[c.id]).length;
    const total = (n.chapters || []).length;
    return novelMiniCard(n, `${readChs}/${total} caps.`);
  }).join('');
}

function novelMiniCard(n, subtitle) {
  return `<div class="profile-novel-card" onclick="closeModal('modalProfile');openNovel('${n.id}')">
    <div class="novel-cover">
      ${n.cover ? `<img src="${n.cover}" alt="${esc(n.title)}" loading="lazy">` : `<div class="novel-cover-ph">${n.title.charAt(0)}</div>`}
    </div>
    <div class="pnc-title">${esc(n.title)}</div>
    ${subtitle ? `<div class="pnc-progress">${subtitle}</div>` : ''}
  </div>`;
}

// ════════════════════════════════════════════
//  FAVORITOS
// ════════════════════════════════════════════
function toggleFavorite() {
  if (!S.currentUser || S.currentUser.username === 'guest') { toast('Iniciá sesión para guardar favoritos'); return; }
  const idx = S.favorites.indexOf(S.novelId);
  if (idx === -1) { S.favorites.push(S.novelId); toast('♥ Agregado a favoritos'); }
  else { S.favorites.splice(idx, 1); toast('Quitado de favoritos'); }
  saveUserData();
  updateFavBtn();
  renderHome();
}

function updateFavBtn() {
  const btn = document.getElementById('favBtn');
  if (!btn) return;
  const isFav = S.favorites.includes(S.novelId);
  btn.classList.toggle('active', isFav);
  btn.textContent = isFav ? '♥ Favorito' : '♡ Favorito';
}

// ════════════════════════════════════════════
//  ADMIN PANEL
// ════════════════════════════════════════════
function openAdminPanel() {
  closeUserMenu();
  switchAdminTab('backup');
  openModal('modalAdmin');
}

function switchAdminTab(tab) {
  const tabs = ['backup', 'reports', 'admins'];
  document.querySelectorAll('#modalAdmin .modal-tab').forEach((b, i) => b.classList.toggle('active', tabs[i] === tab));
  document.querySelectorAll('#modalAdmin .modal-tab-panel').forEach((p, i) => p.classList.toggle('active', tabs[i] === tab));
  if (tab === 'reports') loadReports();
  if (tab === 'admins') { loadAdminsList(); clearAddAdminForm(); }
}

async function loadAdminsList() {
  const list = document.getElementById('adminsList');
  list.innerHTML = '<li style="color:var(--text3);font-size:.85rem;font-style:italic">Cargando...</li>';
  try {
    const pwd = sessionStorage.getItem('nt_admin_pwd');
    if (!pwd || !S.currentUser) { list.innerHTML = '<li style="color:var(--danger);font-size:.85rem">Sesión no disponible.</li>'; return; }
    const rows = await sb.rpc('list_admins', { p_admin_username: S.currentUser.username, p_admin_password: pwd });
    if (!rows || !rows.length) { list.innerHTML = '<li style="color:var(--text3);font-size:.85rem;font-style:italic">Sin admins.</li>'; return; }

    list.innerHTML = rows.map(a => {
      const isSelf = a.username.toLowerCase() === S.currentUser.username.toLowerCase();
      const actionBtn = isSelf ? '' : `
        <button class="btn btn-danger btn-sm" style="padding: 3px 8px; font-size: 0.7rem; margin-left: auto; border-radius: 6px; line-height: 1.2;" onclick="demoteAdmin('${esc(a.username)}')">✕ Degradar</button>
      `;
      return `
        <li class="user-list-item" style="display: flex; align-items: center; width: 100%; gap: 10px; margin-bottom: 8px;">
          <span>${esc(a.username)}</span>
          <span class="user-badge badge-admin" style="margin-left: 4px; font-size: 0.72rem; padding: 2px 6px;">${esc(a.role)}</span>
          ${actionBtn}
        </li>`;
    }).join('');
  } catch (e) {
    list.innerHTML = '<li style="color:var(--danger);font-size:.85rem">Error: ' + esc(e.message) + '</li>';
  }
}

async function updateAdminBadge() {
  try {
    const rows = await sb.query('error_reports?resolved=eq.false&select=id') || [];
    const count = rows.length;
    ['adminBadge', 'adminBadgeModal'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = count;
      el.classList.toggle('show', count > 0);
    });
  } catch (e) { }
}

async function loadReports() {
  const container = document.getElementById('reportsContainer');
  container.innerHTML = '<p style="color:var(--text3);font-size:.85rem;font-style:italic">Cargando...</p>';
  try {
    const rows = await sb.query('error_reports?order=created_at.desc&select=*') || [];
    await updateAdminBadge();
    if (!rows.length) { container.innerHTML = '<p style="color:var(--text3);font-size:.85rem;font-style:italic">No hay reportes todavía.</p>'; return; }
    container.innerHTML = rows.map(r => `
      <div class="report-item ${r.resolved ? 'report-resolved' : ''}" id="report-${r.id}">
        <div class="report-item-header">
          <div>
            <div class="report-item-title">${esc(r.novel_title || 'Novela')} — Cap. ${r.chapter_num || '?'}</div>
            <div class="report-item-meta">Por ${esc(r.reporter || 'invitado')} · ${r.created_at ? new Date(r.created_at).toLocaleDateString('es-PY') : ''} ${r.resolved ? '· ✓ Resuelto' : ''}</div>
          </div>
        </div>
        ${r.selected_text ? `<div class="report-item-text">"${esc(r.selected_text)}"</div>` : ''}
        ${r.comment ? `<div class="report-item-comment">💬 ${esc(r.comment)}</div>` : ''}
        <div class="report-item-actions">
          <button class="btn btn-secondary btn-sm" onclick="goToReport('${r.novel_id}','${r.chapter_id}')">→ Ir al capítulo</button>
          ${!r.resolved ? `<button class="btn btn-sm" style="background:var(--success-bg);color:var(--success);border:1px solid rgba(45,106,79,.2)" onclick="resolveReport('${r.id}')">✓ Marcar resuelto</button>` : ''}
          <button class="btn btn-danger btn-sm" onclick="deleteReport('${r.id}')">✕</button>
        </div>
      </div>`).join('');
  } catch (e) { container.innerHTML = '<p style="color:var(--danger);font-size:.85rem">Error cargando reportes: ' + e.message + '</p>'; }
}

async function resolveReport(id) {
  try {
    await sb.query('error_reports?id=eq.' + id, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: { resolved: true }
    });
    loadReports();
    toast('✓ Marcado como resuelto');
  } catch (e) { toast('Error: ' + e.message, 3000); }
}

async function deleteReport(id) {
  openConfirm('¿Eliminar este reporte?', async () => {
    await sb.delete('error_reports', id);
    loadReports();
    toast('Reporte eliminado');
  });
}

function goToReport(novelId, chapterId) {
  closeModal('modalAdmin');
  openChapter(novelId, chapterId);
}

// ════════════════════════════════════════════
//  CONTEXT MENU — REPORTAR ERROR
// ════════════════════════════════════════════
function handleContextMenu(e) {
  const menu = document.getElementById('ctxMenu');
  menu.classList.remove('open');

  // Solo en el reader
  if (!document.getElementById('page-reader').classList.contains('active')) return;

  const selection = window.getSelection();
  const selectedText = selection ? selection.toString().trim() : '';
  if (!selectedText) return;

  e.preventDefault();
  S.reportSelection = selectedText;

  // Posicionar el menú
  const x = Math.min(e.clientX, window.innerWidth - 200);
  const y = Math.min(e.clientY, window.innerHeight - 80);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.add('open');
}

// ════════════════════════════════════════════
//  BOTÓN FLOTANTE — SELECCIÓN DE TEXTO
// ════════════════════════════════════════════
(function setupFloatReportBtn() {
  const floatBtn = document.getElementById('reportFloatBtn');
  let hideTimer = null;

  function showFloatBtn(rect, text) {
    S.reportSelection = text;
    const btnW = 160;
    const btnH = 36;
    // Centrar encima de la selección
    let x = rect.left + rect.width / 2 - btnW / 2 + window.scrollX;
    let y = rect.top + window.scrollY - btnH - 10;
    // Evitar que se salga de la pantalla
    x = Math.max(8, Math.min(x, window.innerWidth - btnW - 8));
    if (y < window.scrollY + 8) y = rect.bottom + window.scrollY + 10;
    floatBtn.style.left = x + 'px';
    floatBtn.style.top = y + 'px';
    floatBtn.classList.add('visible');
  }

  function hideFloatBtn() {
    floatBtn.classList.remove('visible');
  }

  document.addEventListener('mouseup', () => {
    // Solo en el reader
    if (!document.getElementById('page-reader').classList.contains('active')) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const selection = window.getSelection();
      const text = selection ? selection.toString().trim() : '';
      if (!text || text.length < 2) { hideFloatBtn(); return; }
      // Verificar que la selección esté dentro del contenido del lector
      const range = selection.getRangeAt(0);
      const readerBody = document.getElementById('readerBody');
      if (!readerBody || !readerBody.contains(range.commonAncestorContainer)) { hideFloatBtn(); return; }
      const rect = range.getBoundingClientRect();
      showFloatBtn(rect, text);
    }, 50);
  });

  // En touch: mostrar tras soltar
  document.addEventListener('selectionchange', () => {
    if (!document.getElementById('page-reader').classList.contains('active')) return;
    clearTimeout(hideTimer);
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : '';
    if (!text || text.length < 2) { hideFloatBtn(); return; }
  });

  document.addEventListener('touchend', () => {
    if (!document.getElementById('page-reader').classList.contains('active')) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const selection = window.getSelection();
      const text = selection ? selection.toString().trim() : '';
      if (!text || text.length < 2) { hideFloatBtn(); return; }
      try {
        const range = selection.getRangeAt(0);
        const readerBody = document.getElementById('readerBody');
        if (!readerBody || !readerBody.contains(range.commonAncestorContainer)) { hideFloatBtn(); return; }
        const rect = range.getBoundingClientRect();
        showFloatBtn(rect, text);
      } catch (e) { hideFloatBtn(); }
    }, 200);
  });

  // Ocultar al hacer click en cualquier otro lado
  document.addEventListener('mousedown', e => {
    if (e.target !== floatBtn) {
      hideTimer = setTimeout(hideFloatBtn, 100);
    }
  });
})();

function openReportModal() {
  document.getElementById('ctxMenu').classList.remove('open');
  if (!S.reportSelection) return;
  // Truncar si es muy largo
  const display = S.reportSelection.length > 200 ? S.reportSelection.slice(0, 200) + '…' : S.reportSelection;
  document.getElementById('reportSelectedText').textContent = display;
  document.getElementById('reportComment').value = '';
  openModal('modalReport');
}

async function submitReport() {
  if (!S.chapterId || !S.novelId) return;
  const novel = S.novels.find(n => n.id === S.novelId);
  const chMeta = novel ? (novel.chapters || []).find(c => c.id === S.chapterId) : null;
  const report = {
    id: 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2),
    novel_id: S.novelId,
    novel_title: novel ? novel.title : '',
    chapter_id: S.chapterId,
    chapter_num: chMeta ? chMeta.num : null,
    selected_text: S.reportSelection.slice(0, 500),
    comment: document.getElementById('reportComment').value.trim(),
    reporter: S.currentUser ? (S.displayName || S.currentUser.username) : 'invitado',
    resolved: false
  };
  try {
    await sb.upsert('error_reports', report);
    closeModal('modalReport');
    toast('✓ Reporte enviado, gracias');
    S.reportSelection = '';
  } catch (e) { toast('Error enviando reporte: ' + e.message, 3000); }
}

// ════════════════════════════════════════════
//  DATA — SUPABASE
// ════════════════════════════════════════════
async function loadData() {
  const isGuest = !S.currentUser || S.currentUser.username === 'guest';
  const path = isGuest
    ? 'novels?select=*&premium=neq.true&order=updated_at.asc'
    : 'novels?select=*&order=updated_at.asc';

  const rows = await sb.query(path) || [];
  S.novels = rows.map(r => {
    const d = r.data || {};
    d.premium = r.premium !== undefined ? r.premium : (d.premium !== undefined ? d.premium : true);
    return d;
  });
}

async function saveNovelToDb(novel) {
  const meta = { ...novel };
  const premiumVal = meta.premium !== undefined ? meta.premium : true;
  if (meta.chapters) {
    meta.chapters = meta.chapters.map(c => ({
      id: c.id, num: c.num, title: c.title,
      date: c.date, hasImages: c.hasImages || false
    }));
  }
  await sb.upsert('novels', {
    id: novel.id,
    data: meta,
    premium: premiumVal,
    updated_at: new Date().toISOString()
  });
}

async function saveChapterToDb(chapter) {
  await sb.upsert('chapters', { id: chapter.id, novel_id: chapter.novelId, data: chapter, updated_at: new Date().toISOString() });
}

async function loadChapterContent(chId) {
  const novel = S.novels.find(n => (n.chapters || []).find(c => c.id === chId));
  if (!novel) return null;
  const ch = novel.chapters.find(c => c.id === chId);
  if (ch && ch.text !== undefined) return ch;
  const row = await sb.getOne('chapters', chId);
  if (row && row.data && ch) { Object.assign(ch, row.data); }
  return ch || (row && row.data) || null;
}

// ════════════════════════════════════════════
//  EXPORT / IMPORT
// ════════════════════════════════════════════
async function exportData() {
  toast('Exportando...', 1500);
  try {
    const novelsWithChapters = [];
    for (const novel of S.novels) {
      const fullNovel = { ...novel, chapters: [] };
      for (const ch of (novel.chapters || [])) {
        const row = await sb.getOne('chapters', ch.id);
        fullNovel.chapters.push(row ? row.data : ch);
      }
      novelsWithChapters.push(fullNovel);
    }
    const blob = new Blob([JSON.stringify({ novels: novelsWithChapters }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gogofansub_backup_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    toast('✓ Exportado correctamente');
  } catch (e) { toast('Error exportando: ' + e.message, 4000); }
}

async function importData(input) {
  if (!input.files[0]) return;
  const text = await input.files[0].text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { toast('Archivo JSON inválido', 3000); return; }
  const novels = parsed.novels || [];
  if (!novels.length) { toast('No se encontraron novelas', 3000); return; }
  openConfirm(`¿Importar ${novels.length} novela(s)?`, async () => {
    toast('Importando...', 3000);
    try {
      for (const novel of novels) {
        const chapters = novel.chapters || [];
        const meta = { ...novel, chapters: chapters.map(c => ({ id: c.id, num: c.num, title: c.title, date: c.date, hasImages: c.hasImages || false })) };
        await sb.upsert('novels', { id: novel.id, data: meta, updated_at: new Date().toISOString() });
        for (const ch of chapters) { await saveChapterToDb({ ...ch, novelId: novel.id }); }
      }
      await loadData(); renderHome();
      toast('✓ Importado: ' + novels.length + ' novela(s)');
    } catch (e) { toast('Error importando: ' + e.message, 5000); }
  });
  input.value = '';
}

// ════════════════════════════════════════════
//  PAGES
// ════════════════════════════════════════════
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  window.scrollTo(0, 0);
}

// ════════════════════════════════════════════
//  DARK / THEME
// ════════════════════════════════════════════
function toggleDark() {
  S.dark = !S.dark;
  document.body.classList.toggle('dark', S.dark);
  localStorage.setItem('nt_dark', S.dark ? '1' : '0');
  persistLocalPrefs();
}

// ════════════════════════════════════════════
//  ADMIN UI
// ════════════════════════════════════════════
function updateAdminUI() {
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = S.admin ? 'inline-flex' : 'none';
  });
  const sec = document.getElementById('chapterSection');
  if (sec) { if (S.admin) sec.classList.add('admin-active'); else sec.classList.remove('admin-active'); }
}

// ════════════════════════════════════════════
//  HOME
// ════════════════════════════════════════════
let _filteredNovels = null;
function renderHome() {
  let novels = _filteredNovels || S.novels;
  if (!S.currentUser || S.currentUser.username === 'guest') {
    novels = novels.filter(n => n.premium !== true);
  }
  const grid = document.getElementById('novelsGrid');
  document.getElementById('novelCount').textContent = novels.length + (novels.length === 1 ? ' novela' : ' novelas');
  updateAdminUI();
  if (novels.length === 0) {
    grid.innerHTML = `<div class="empty-state"><p>${_filteredNovels ? 'Sin resultados.' : 'Aún no hay novelas.'}</p></div>`;
    return;
  }
  grid.innerHTML = novels.map(n => {
    const chCount = (n.chapters || []).length;
    const continueId = S.continueMap[n.id];
    const lastCh = continueId ? (n.chapters || []).find(c => c.id === continueId) : null;
    const statusClass = { 'En traducción': 'status-active', 'Completada': 'status-done', 'Pausada': 'status-paused', 'Abandonada': 'status-drop' }[n.status] || '';
    const isFav = S.favorites.includes(n.id);
    return `
    <div class="novel-card" onclick="openNovel('${n.id}')">
      <div class="novel-cover">
        ${n.cover ? `<img src="${n.cover}" alt="${esc(n.title)}" loading="lazy">` : `<div class="novel-cover-ph">${n.title.charAt(0)}</div>`}
        ${lastCh ? `<div class="continue-badge">Cap. ${lastCh.num}</div>` : ''}
        ${isFav ? `<div class="fav-badge">♥</div>` : ''}
      </div>
      <div class="novel-card-title">${esc(n.title)}</div>
      <div class="novel-card-meta">
        <span class="status-pill ${statusClass}">${esc(n.status || '')}</span>${chCount} cap.
      </div>
      ${n.tags ? `<div>${n.tags.split(',').slice(0, 3).map(t => `<span class="tag">${esc(t.trim())}</span>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
}

function filterNovels(q) {
  if (!q.trim()) { _filteredNovels = null; }
  else {
    const lq = q.toLowerCase();
    _filteredNovels = S.novels.filter(n => n.title.toLowerCase().includes(lq) || (n.tags || '').toLowerCase().includes(lq) || (n.author || '').toLowerCase().includes(lq));
  }
  renderHome();
}

// ════════════════════════════════════════════
//  NOVEL PAGE
// ════════════════════════════════════════════
async function openNovel(id) {
  const novel = S.novels.find(n => n.id === id);
  if (novel && novel.premium === true && (!S.currentUser || S.currentUser.username === 'guest')) {
    return;
  }
  S.novelId = id; await renderNovelPage(id); showPage('novel');
}
async function renderNovelPage(id) {
  const novel = S.novels.find(n => n.id === id);
  if (!novel) return;
  const chapters = (novel.chapters || []).sort((a, b) => a.num - b.num);
  const covEl = document.getElementById('ndCover');
  if (novel.cover) {
    covEl.innerHTML = `<img src="${novel.cover}" alt="">`;
  } else {
    covEl.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-family:'Crimson Pro',serif;font-size:3rem;color:var(--text3);font-style:italic">${esc(novel.title.charAt(0))}</div>`;
  }
  document.getElementById('ndTitle').textContent = novel.title;
  document.getElementById('ndAuthor').textContent = novel.author ? 'Autor: ' + novel.author : '';
  document.getElementById('ndSynopsis').textContent = novel.synopsis || '';
  document.getElementById('ndTags').innerHTML = novel.tags ? novel.tags.split(',').map(t => `<span class="tag">${esc(t.trim())}</span>`).join('') : '';
  document.getElementById('ndChCount').textContent = chapters.length;
  document.getElementById('ndStatus').textContent = novel.status || '';
  if (novel.createdAt) { document.getElementById('ndDate').style.display = ''; document.getElementById('ndDateVal').textContent = novel.createdAt; }
  updateFavBtn();
  updateAdminUI();
  const sec = document.getElementById('chapterSection');
  if (S.admin) sec.classList.add('admin-active'); else sec.classList.remove('admin-active');
  const cont = document.getElementById('chapterListContainer');
  if (chapters.length === 0) {
    cont.innerHTML = `<p style="color:var(--text3);font-style:italic;padding:.8rem 0">No hay capítulos aún.</p>`;
  } else {
    cont.innerHTML = chapters.map(ch => {
      const isRead = S.readMap[ch.id];
      return `
      <div class="chapter-item" onclick="openChapter('${novel.id}','${ch.id}')">
        <div class="ch-left">
          <span class="ch-num">${ch.num}</span>
          <span class="ch-title">${esc(ch.title || 'Sin título')}</span>
        </div>
        <div class="ch-right">
          ${ch.hasImages ? `<span class="ch-imgs">🖼</span>` : ''}
          <span class="ch-date">${ch.date || ''}</span>
          <span class="ch-read ${isRead ? 'done' : ''}" title="${isRead ? 'Leído' : 'No leído'}"></span>
          <div class="ch-admin-btns">
            <button class="ch-edit" onclick="event.stopPropagation();editChapter('${novel.id}','${ch.id}')">✏</button>
            <button class="ch-del" onclick="event.stopPropagation();confirmDeleteChapter('${novel.id}','${ch.id}')">✕</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }
}

// ════════════════════════════════════════════
//  READER
// ════════════════════════════════════════════
async function openChapter(novelId, chapterId) {
  const novel = S.novels.find(n => n.id === novelId);
  if (novel && novel.premium === true && (!S.currentUser || S.currentUser.username === 'guest')) {
    return;
  }
  S.novelId = novelId; S.chapterId = chapterId;
  S.continueMap[novelId] = chapterId;
  saveUserData();
  await renderReader(); showPage('reader');
}
async function renderReader() {
  const novel = S.novels.find(n => n.id === S.novelId);
  if (!novel) return;
  const chapters = (novel.chapters || []).sort((a, b) => a.num - b.num);
  const ch = await loadChapterContent(S.chapterId);
  if (!ch) return;
  S.readMap[ch.id] = true;
  saveUserData();
  document.getElementById('rNovelTitle').textContent = novel.title;
  document.getElementById('rChTitle').textContent = ch.title ? `Capítulo ${ch.num}: ${ch.title}` : `Capítulo ${ch.num}`;
  document.getElementById('rChNum').textContent = ch.num;
  document.getElementById('fontSizeDisplay').textContent = S.fontSize;
  updateFontFamilyBtn();
  const body = document.getElementById('readerBody');
  body.className = 'reader-body font-' + S.fontFamily;
  body.style.fontSize = S.fontSize + 'px';
  body.style.lineHeight = S.lineHeight;
  document.getElementById('readerContent').style.maxWidth = S.readerWidth + 'px';
  document.getElementById('readerNav').style.maxWidth = S.readerWidth + 'px';
  let html = parseText(ch.text || '', ch.images || []);
  if (ch.notes) { html += `<div class="translator-note"><strong>Nota del traductor</strong>${esc(ch.notes).replace(/\n/g, '<br>')}</div>`; }
  body.innerHTML = html;
  const idx = chapters.findIndex(c => c.id === S.chapterId);
  document.getElementById('prevBtn').disabled = idx <= 0;
  document.getElementById('nextBtn').disabled = idx >= chapters.length - 1;
  document.getElementById('progressBar').style.width = '0%';
}
function parseText(text, images) {
  return text.split(/\n\n+/).filter(p => p.trim()).map(para => {
    let line = para.replace(/\n/g, '<br>');
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/_(.+?)_/g, '<em>$1</em>');
    line = line.replace(/\[img:(\d+)\]/g, (_, i) => {
      const src = images[parseInt(i) - 1];
      return src ? `<img src="${src}" alt="Imagen ${i}">` : '';
    });
    return `<p>${line}</p>`;
  }).join('');
}
async function navigateChapter(dir) {
  const novel = S.novels.find(n => n.id === S.novelId);
  if (!novel) return;
  const chapters = (novel.chapters || []).sort((a, b) => a.num - b.num);
  const idx = chapters.findIndex(c => c.id === S.chapterId);
  const next = chapters[idx + dir];
  if (next) { S.chapterId = next.id; S.continueMap[S.novelId] = next.id; saveUserData(); await renderReader(); window.scrollTo(0, 0); }
}
function goBackToNovel() { showPage('novel'); renderNovelPage(S.novelId); }
function updateProgressBar() {
  if (!document.getElementById('page-reader').classList.contains('active')) return;
  const pct = document.body.scrollHeight - window.innerHeight > 0
    ? Math.round((window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100) : 0;
  document.getElementById('progressBar').style.width = pct + '%';
}
async function openChPicker() {
  const novel = S.novels.find(n => n.id === S.novelId);
  if (!novel) return;
  const chapters = (novel.chapters || []).sort((a, b) => a.num - b.num);
  document.getElementById('chSelectorList').innerHTML = chapters.map(ch => `
    <li class="ch-selector-item ${ch.id === S.chapterId ? 'current' : ''} ${S.readMap[ch.id] ? 'read-ch' : ''}"
        onclick="selectChapter('${ch.id}')">
      <span style="font-size:.73rem;color:var(--text3);min-width:32px">Cap. ${ch.num}</span>
      <span>${esc(ch.title || 'Sin título')}</span>
    </li>`).join('');
  openModal('modalChPicker');
}
async function selectChapter(id) {
  S.chapterId = id; closeModal('modalChPicker'); await renderReader(); window.scrollTo(0, 0);
}

// ════════════════════════════════════════════
//  READER SETTINGS
// ════════════════════════════════════════════
function cycleFontFamily() {
  const idx = S.fontNames.indexOf(S.fontFamily);
  S.fontFamily = S.fontNames[(idx + 1) % S.fontNames.length];
  updateFontFamilyBtn(); applyReaderStyles(); persistLocalPrefs();
}
function updateFontFamilyBtn() {
  const idx = S.fontNames.indexOf(S.fontFamily);
  const btn = document.getElementById('fontFamilyBtn');
  if (btn) btn.textContent = S.fontLabels[idx] || 'Fuente';
}
function applyReaderStyles() {
  const body = document.getElementById('readerBody');
  if (!body) return;
  body.className = 'reader-body font-' + S.fontFamily;
  body.style.fontSize = S.fontSize + 'px';
  body.style.lineHeight = S.lineHeight;
  document.getElementById('readerContent').style.maxWidth = S.readerWidth + 'px';
  document.getElementById('readerNav').style.maxWidth = S.readerWidth + 'px';
}
function changeFontSize(d) {
  S.fontSize = Math.max(12, Math.min(32, S.fontSize + d));
  document.getElementById('fontSizeDisplay').textContent = S.fontSize;
  document.getElementById('readerBody').style.fontSize = S.fontSize + 'px';
  persistLocalPrefs();
}
function toggleReaderSettings() {
  const panel = document.getElementById('readerSettingsPanel');
  const btn = document.getElementById('settingsToggleBtn');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : '';
  btn.classList.toggle('active', !visible);
  if (!visible) {
    document.getElementById('widthSlider').value = S.readerWidth;
    document.getElementById('widthVal').textContent = S.readerWidth + 'px';
    document.getElementById('lineSlider').value = Math.round(S.lineHeight * 100);
    document.getElementById('lineVal').textContent = S.lineHeight.toFixed(2);
  }
}
function changeReaderWidth(val) {
  S.readerWidth = parseInt(val);
  document.getElementById('widthVal').textContent = val + 'px';
  document.getElementById('readerContent').style.maxWidth = val + 'px';
  document.getElementById('readerNav').style.maxWidth = val + 'px';
  persistLocalPrefs();
}
function changeLineHeight(val) {
  S.lineHeight = val / 100;
  document.getElementById('lineVal').textContent = S.lineHeight.toFixed(2);
  document.getElementById('readerBody').style.lineHeight = S.lineHeight;
  persistLocalPrefs();
}
function toggleFullscreen() {
  const wrap = document.getElementById('readerWrap');
  const btn = document.getElementById('fullscreenBtn');
  const isFs = wrap.classList.toggle('fullscreen-reader');
  btn.textContent = isFs ? '✕ Salir pantalla completa' : '⛶ Pantalla completa';
  btn.classList.toggle('active', isFs);
  if (isFs) wrap.scrollTop = 0;
}

// ════════════════════════════════════════════
//  NOVEL FORM
// ════════════════════════════════════════════
function openAddNovel() {
  S.editingNovelId = null; clearNovelForm();
  document.getElementById('novelModalH').textContent = 'Nueva Novela';
  openModal('modalNovel');
}
function openEditNovel() {
  const novel = S.novels.find(n => n.id === S.novelId);
  if (!novel) return;
  S.editingNovelId = novel.id;
  document.getElementById('novelModalH').textContent = 'Editar Novela';
  document.getElementById('nTitle').value = novel.title || '';
  document.getElementById('nAuthor').value = novel.author || '';
  document.getElementById('nSynopsis').value = novel.synopsis || '';
  document.getElementById('nTags').value = novel.tags || '';
  document.getElementById('nNotes').value = novel.notes || '';
  document.getElementById('nStatus').value = novel.status || 'En traducción';
  document.getElementById('nPremium').checked = novel.premium === true;
  if (novel.cover && novel.cover.startsWith('data:')) {
    document.getElementById('coverPreviewImg').src = novel.cover;
    document.getElementById('coverPreview').style.display = 'block';
  } else { document.getElementById('coverPreview').style.display = 'none'; }
  openModal('modalNovel');
}
function clearNovelForm() {
  ['nTitle', 'nAuthor', 'nSynopsis', 'nTags', 'nNotes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('nStatus').value = 'En traducción';
  document.getElementById('nPremium').checked = false;
  document.getElementById('novelCoverInput').value = '';
  document.getElementById('coverPreview').style.display = 'none';
  document.getElementById('coverPreviewImg').src = '';
}
function previewCover(input) {
  if (!input.files[0]) return;
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('coverPreviewImg').src = e.target.result; document.getElementById('coverPreview').style.display = 'block'; };
  reader.readAsDataURL(input.files[0]);
}
async function saveNovel() {
  const title = document.getElementById('nTitle').value.trim();
  if (!title) { toast('El título es obligatorio', 2500); return; }
  const img = document.getElementById('coverPreviewImg');
  let cover = (img.src && img.src.startsWith('data:')) ? img.src : '';
  const premium = document.getElementById('nPremium').checked;
  if (S.editingNovelId) {
    const novel = S.novels.find(n => n.id === S.editingNovelId);
    novel.title = title; novel.author = document.getElementById('nAuthor').value.trim();
    novel.synopsis = document.getElementById('nSynopsis').value.trim();
    novel.tags = document.getElementById('nTags').value.trim();
    novel.notes = document.getElementById('nNotes').value.trim();
    novel.status = document.getElementById('nStatus').value;
    novel.premium = premium;
    if (cover) novel.cover = cover;
    await saveNovelToDb(novel);
    closeModal('modalNovel'); renderNovelPage(S.editingNovelId); renderHome(); toast('✓ Novela actualizada');
  } else {
    const id = 'n_' + Date.now();
    const novel = {
      id, title, author: document.getElementById('nAuthor').value.trim(),
      synopsis: document.getElementById('nSynopsis').value.trim(), tags: document.getElementById('nTags').value.trim(),
      notes: document.getElementById('nNotes').value.trim(), status: document.getElementById('nStatus').value,
      premium, cover, chapters: [], createdAt: new Date().toLocaleDateString('es-PY')
    };
    S.novels.push(novel);
    await saveNovelToDb(novel);
    closeModal('modalNovel'); renderHome(); toast('✓ Novela agregada');
  }
}
function confirmDeleteNovel() {
  openConfirm('¿Eliminar esta novela y todos sus capítulos?', async () => {
    const novel = S.novels.find(n => n.id === S.novelId);
    if (novel) { for (const ch of (novel.chapters || [])) { await sb.delete('chapters', ch.id); } await sb.delete('novels', S.novelId); }
    S.novels = S.novels.filter(n => n.id !== S.novelId);
    showPage('home'); renderHome(); toast('Novela eliminada');
  });
}

// ════════════════════════════════════════════
//  CHAPTER FORM
// ════════════════════════════════════════════
function openAddChapter() {
  S.editingChapterId = null; S.chImages = [];
  document.getElementById('chModalH').textContent = 'Nuevo Capítulo';
  document.getElementById('cTitle').value = '';
  document.getElementById('chapterTextArea').value = '';
  document.getElementById('cNotes').value = '';
  document.getElementById('imgThumbs').innerHTML = '';
  document.getElementById('chImgInput').value = '';
  document.getElementById('previewSection').style.display = 'none';
  const novel = S.novels.find(n => n.id === S.novelId);
  if (novel && novel.chapters && novel.chapters.length > 0) {
    document.getElementById('cNum').value = Math.max(...novel.chapters.map(c => c.num)) + 1;
  } else { document.getElementById('cNum').value = 1; }
  openModal('modalChapter');
}
async function editChapter(novelId, chId) {
  S.editingChapterId = chId;
  const ch = await loadChapterContent(chId);
  if (!ch) return;
  document.getElementById('chModalH').textContent = 'Editar Capítulo ' + ch.num;
  document.getElementById('cNum').value = ch.num;
  document.getElementById('cTitle').value = ch.title || '';
  document.getElementById('chapterTextArea').value = ch.text || '';
  document.getElementById('cNotes').value = ch.notes || '';
  S.chImages = ch.images ? [...ch.images] : [];
  renderImgThumbs();
  document.getElementById('previewSection').style.display = 'none';
  openModal('modalChapter');
}
function loadChImages(input) {
  Array.from(input.files).forEach(file => {
    const r = new FileReader();
    r.onload = e => { S.chImages.push(e.target.result); renderImgThumbs(); };
    r.readAsDataURL(file);
  });
}
function renderImgThumbs() {
  document.getElementById('imgThumbs').innerHTML = S.chImages.map((src, i) => `
    <div class="img-thumb">
      <img src="${src.startsWith('data:') ? src : ''}" alt="">
      <button class="rm-img" onclick="S.chImages.splice(${i},1);renderImgThumbs()">×</button>
    </div>`).join('');
}
function ins(open, close) {
  const ta = document.getElementById('chapterTextArea');
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.substring(0, s) + open + ta.value.substring(s, e) + close + ta.value.substring(e);
  ta.focus(); ta.setSelectionRange(s + open.length, e + open.length);
}
function insBreak() {
  const ta = document.getElementById('chapterTextArea');
  const p = ta.selectionStart;
  ta.value = ta.value.substring(0, p) + '\n\n' + ta.value.substring(p);
  ta.focus(); ta.setSelectionRange(p + 2, p + 2);
}
function insImgTag() {
  const n = S.chImages.length + 1;
  const ta = document.getElementById('chapterTextArea');
  const p = ta.selectionStart;
  const tag = `[img:${n}]`;
  ta.value = ta.value.substring(0, p) + tag + ta.value.substring(p);
  ta.focus(); ta.setSelectionRange(p + tag.length, p + tag.length);
}
function togglePreview() {
  const sec = document.getElementById('previewSection');
  if (sec.style.display === 'none') {
    document.getElementById('previewBox').innerHTML = parseText(document.getElementById('chapterTextArea').value, S.chImages) || '<em style="color:var(--text3)">Sin texto</em>';
    sec.style.display = 'block';
  } else { sec.style.display = 'none'; }
}
async function saveChapter() {
  const num = parseInt(document.getElementById('cNum').value);
  const text = document.getElementById('chapterTextArea').value.trim();
  if (!num || !text) { toast('Número y texto son obligatorios', 2500); return; }
  const novel = S.novels.find(n => n.id === S.novelId);
  if (!novel) return;
  if (!novel.chapters) novel.chapters = [];
  const savedImages = [...S.chImages];
  toast('Guardando...', 1500);
  if (S.editingChapterId) {
    const ch = novel.chapters.find(c => c.id === S.editingChapterId);
    if (ch) {
      ch.num = num; ch.title = document.getElementById('cTitle').value.trim();
      ch.text = text; ch.notes = document.getElementById('cNotes').value.trim();
      ch.images = savedImages; ch.hasImages = savedImages.length > 0;
      await saveChapterToDb({ ...ch, novelId: novel.id });
      await saveNovelToDb(novel);
      closeModal('modalChapter'); renderNovelPage(S.novelId); toast('✓ Capítulo actualizado');
    }
  } else {
    const id = 'c_' + Date.now();
    const ch = {
      id, num, title: document.getElementById('cTitle').value.trim(),
      text, notes: document.getElementById('cNotes').value.trim(),
      images: savedImages, hasImages: savedImages.length > 0,
      date: new Date().toLocaleDateString('es-PY'), novelId: novel.id
    };
    novel.chapters.push(ch);
    await saveChapterToDb(ch);
    await saveNovelToDb(novel);
    closeModal('modalChapter'); renderNovelPage(S.novelId); renderHome(); toast('✓ Capítulo agregado');
  }
}
function confirmDeleteChapter(novelId, chId) {
  openConfirm('¿Eliminar este capítulo?', async () => {
    const novel = S.novels.find(n => n.id === novelId);
    if (!novel) return;
    novel.chapters = novel.chapters.filter(c => c.id !== chId);
    await sb.delete('chapters', chId);
    await saveNovelToDb(novel);
    renderNovelPage(novelId); toast('Capítulo eliminado');
  });
}

// ════════════════════════════════════════════
//  PERFIL DE USUARIO — AVATAR Y CONFIGURACIÓN
// ════════════════════════════════════════════
function renderProfileAvatarPreview() {
  const el = document.getElementById('profileAvatarPreview');
  if (!el) return;
  const src = S.pendingAvatar !== undefined ? S.pendingAvatar : S.avatar;
  if (src) {
    el.innerHTML = `<img src="${src}" alt="">`;
    el.style.background = 'transparent';
  } else {
    el.textContent = S.currentUser ? S.currentUser.username.charAt(0).toUpperCase() : '?';
    el.style.background = '#5a8a6a';
  }
}

function loadProfileAvatar(input) {
  if (!input.files[0]) return;
  const r = new FileReader();
  r.onload = e => { S.pendingAvatar = e.target.result; renderProfileAvatarPreview(); };
  r.readAsDataURL(input.files[0]);
}

function removeProfileAvatar() {
  S.pendingAvatar = null;
  document.getElementById('profileAvatarInput').value = '';
  renderProfileAvatarPreview();
}

async function saveUserProfile() {
  if (!S.currentUser || !S.currentUser.id) return;
  const confirmPwd = document.getElementById('profileConfirmPwd').value;
  if (!confirmPwd) { toast('Ingresá tu contraseña para guardar cambios', 2500); return; }
  const displayName = document.getElementById('profileDisplayName').value.trim();
  const avatarToSave = S.pendingAvatar !== undefined ? S.pendingAvatar : (S.currentUser.avatar || S.avatar);
  toast('Guardando...', 1500);
  try {
    const result = await sb.rpc('update_user_profile', {
      p_user_id: S.currentUser.id,
      p_password: hashPwd(confirmPwd),
      p_display_name: displayName || null,
      p_avatar: avatarToSave
    });
    if (!result || !result.success) { toast(result?.message || 'Error al guardar', 3000); return; }
    S.displayName = displayName || null;
    S.avatar = avatarToSave;
    if (S.currentUser) {
      S.currentUser.avatar = avatarToSave;
      S.currentUser.displayName = displayName || null;
    }
    S.pendingAvatar = undefined;
    updateNavUser();
    document.getElementById('profileTitle').textContent = '👤 ' + (S.displayName || S.currentUser.username);
    toast('✓ Perfil actualizado');
    closeModal('modalProfile');
  } catch (e) { toast('Error: ' + e.message, 3000); }
}

async function changeUserPassword() {
  if (!S.currentUser || !S.currentUser.id) return;
  const oldPwd = document.getElementById('profileOldPwd').value;
  const newPwd = document.getElementById('profileNewPwd').value;
  const newPwd2 = document.getElementById('profileNewPwd2').value;
  if (!oldPwd || !newPwd) { toast('Completá todos los campos de contraseña', 2500); return; }
  if (newPwd.length < 4) { toast('La nueva contraseña debe tener al menos 4 caracteres', 2500); return; }
  if (newPwd !== newPwd2) { toast('Las nuevas contraseñas no coinciden', 2500); return; }
  toast('Cambiando contraseña...', 1500);
  try {
    const result = await sb.rpc('change_user_password', {
      p_user_id: S.currentUser.id,
      p_old_password: hashPwd(oldPwd),
      p_new_password: hashPwd(newPwd)
    });
    if (!result || !result.success) { toast(result?.message || 'Error', 3000); return; }
    document.getElementById('profileOldPwd').value = '';
    document.getElementById('profileNewPwd').value = '';
    document.getElementById('profileNewPwd2').value = '';
    toast('✓ Contraseña cambiada con éxito');
  } catch (e) { toast('Error: ' + e.message, 3000); }
}

// ════════════════════════════════════════════
//  PREFERENCIAS DE ADMIN
// ════════════════════════════════════════════
function openAdminPrefs() {
  if (!S.currentUser || !S.admin) return;
  S.adminPendingAvatar = undefined;
  document.getElementById('adminDisplayName').value = S.displayName || '';
  document.getElementById('adminOldPwd').value = '';
  document.getElementById('adminNewPwd').value = '';
  document.getElementById('adminNewPwd2').value = '';
  renderAdminAvatarPreview();
  openModal('modalAdminPrefs');
}

function renderAdminAvatarPreview() {
  const el = document.getElementById('adminAvatarPreview');
  if (!el) return;
  const src = S.adminPendingAvatar !== undefined ? S.adminPendingAvatar : (S.currentUser?.avatar || S.avatar);
  if (src) {
    el.innerHTML = `<img src="${src}" alt="">`;
    el.style.background = 'transparent';
  } else {
    el.textContent = S.currentUser ? S.currentUser.username.charAt(0).toUpperCase() : '?';
    el.style.background = 'var(--accent)';
  }
}

function loadAdminAvatar(input) {
  if (!input.files[0]) return;
  const r = new FileReader();
  r.onload = e => { S.adminPendingAvatar = e.target.result; renderAdminAvatarPreview(); };
  r.readAsDataURL(input.files[0]);
}

function removeAdminAvatar() {
  S.adminPendingAvatar = null;
  document.getElementById('adminAvatarInput').value = '';
  renderAdminAvatarPreview();
}

async function saveAdminProfile() {
  if (!S.currentUser || !S.admin) return;
  const pwd = sessionStorage.getItem('nt_admin_pwd');
  if (!pwd) { toast('Sesión expirada, volvé a iniciar sesión', 3000); return; }
  const displayName = document.getElementById('adminDisplayName').value.trim();
  const avatarToSave = S.adminPendingAvatar !== undefined ? S.adminPendingAvatar : (S.currentUser.avatar || S.avatar);
  toast('Guardando...', 1500);
  try {
    const result = await sb.rpc('update_admin_profile', {
      p_username: S.currentUser.username,
      p_password: pwd,
      p_display_name: displayName || null,
      p_avatar: avatarToSave
    });
    if (!result || !result.success) { toast(result?.message || 'Error al guardar', 3000); return; }
    S.displayName = displayName || null;
    S.avatar = avatarToSave;
    if (S.currentUser) {
      S.currentUser.avatar = avatarToSave;
      S.currentUser.displayName = displayName || null;
    }
    S.adminPendingAvatar = undefined;
    updateNavUser();
    toast('✓ Preferencias guardadas');
    closeModal('modalAdminPrefs');
  } catch (e) { toast('Error: ' + e.message, 3000); }
}

async function changeAdminPassword() {
  if (!S.currentUser || !S.admin) return;
  const oldPwd = document.getElementById('adminOldPwd').value;
  const newPwd = document.getElementById('adminNewPwd').value;
  const newPwd2 = document.getElementById('adminNewPwd2').value;
  if (!oldPwd || !newPwd) { toast('Completá todos los campos', 2500); return; }
  if (newPwd.length < 4) { toast('La nueva contraseña debe tener al menos 4 caracteres', 2500); return; }
  if (newPwd !== newPwd2) { toast('Las nuevas contraseñas no coinciden', 2500); return; }
  const sessionPwd = sessionStorage.getItem('nt_admin_pwd');
  if (sessionPwd !== hashPwd(oldPwd)) { toast('La contraseña actual no es correcta', 2500); return; }
  toast('Cambiando contraseña...', 1500);
  try {
    const result = await sb.rpc('change_admin_password', {
      p_username: S.currentUser.username,
      p_old_password: hashPwd(oldPwd),
      p_new_password: hashPwd(newPwd)
    });
    if (!result || !result.success) { toast(result?.message || 'Error', 3000); return; }
    sessionStorage.setItem('nt_admin_pwd', hashPwd(newPwd));
    document.getElementById('adminOldPwd').value = '';
    document.getElementById('adminNewPwd').value = '';
    document.getElementById('adminNewPwd2').value = '';
    toast('✓ Contraseña de admin cambiada con éxito');
  } catch (e) { toast('Error: ' + e.message, 3000); }
}

// ════════════════════════════════════════════
//  REGISTRAR NUEVO ADMIN
// ════════════════════════════════════════════
function clearAddAdminForm() {
  const fields = ['newAdminUser', 'newAdminPass', 'newAdminConfirmPwd'];
  fields.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

async function registerNewAdmin() {
  const newUser = document.getElementById('newAdminUser').value.trim().toLowerCase();
  const newPass = document.getElementById('newAdminPass').value;
  if (!newUser || !newPass) { toast('Completá todos los campos', 2500); return; }
  if (newUser.length < 3) { toast('El usuario debe tener al menos 3 caracteres', 2500); return; }
  if (newPass.length < 4) { toast('La contraseña debe tener al menos 4 caracteres', 2500); return; }
  const sessionPwd = sessionStorage.getItem('nt_admin_pwd');
  if (!sessionPwd || !S.currentUser) { toast('Sesión no disponible', 2500); return; }
  toast('Registrando admin...', 1500);
  try {
    const result = await sb.rpc('create_new_admin', {
      p_admin_username: S.currentUser.username,
      p_admin_password: sessionPwd,
      p_new_username: newUser,
      p_new_password: hashPwd(newPass)
    });
    if (!result || !result.success) { toast(result?.message || 'Error al registrar', 3000); return; }
    clearAddAdminForm();
    await loadAdminsList();
    toast('✓ Admin "' + newUser + '" registrado con éxito');
  } catch (e) { toast('Error: ' + e.message, 3000); }
}

function openAuthFromLanding(tab) {
  switchAuthTab(tab);
  openModal('authGate');
}

async function promoteLectorToAdmin() {
  const targetUser = document.getElementById('promoteUserTarget').value.trim().toLowerCase();
  if (!targetUser) { toast('Completá todos los campos', 2500); return; }

  const sessionPwd = sessionStorage.getItem('nt_admin_pwd');
  if (!sessionPwd || !S.currentUser) { toast('Sesión no disponible', 2500); return; }

  toast('Promoviendo usuario...', 1500);
  try {
    const result = await sb.rpc('change_user_role', {
      p_admin_username: S.currentUser.username,
      p_admin_password: sessionPwd,
      p_target_username: targetUser,
      p_new_role: 'admin'
    });
    if (!result || !result.success) { toast(result?.message || 'Error al cambiar rol', 3000); return; }
    document.getElementById('promoteUserTarget').value = '';
    await loadAdminsList();
    toast('✓ ' + (result.message || 'Usuario promovido a Admin con éxito'), 4000);
  } catch (e) { toast('Error: ' + e.message, 3000); }
}

async function demoteAdmin(targetUser) {
  openConfirm(`¿Estás seguro de que querés DEGRADAR al administrador "${targetUser}" a lector normal?`, async () => {
    const sessionPwd = sessionStorage.getItem('nt_admin_pwd');
    if (!sessionPwd || !S.currentUser) { toast('Sesión no disponible', 2500); return; }

    toast('Degradando administrador...', 1500);
    try {
      const result = await sb.rpc('change_user_role', {
        p_admin_username: S.currentUser.username,
        p_admin_password: sessionPwd,
        p_target_username: targetUser.toLowerCase(),
        p_new_role: 'user'
      });
      if (!result || !result.success) { toast(result?.message || 'Error al cambiar rol', 3000); return; }
      await loadAdminsList();
      toast('✓ ' + (result.message || 'Administrador degradado a Lector con éxito'));
    } catch (e) { toast('Error: ' + e.message, 3000); }
  });
}

// ════════════════════════════════════════════
//  MODALS
// ════════════════════════════════════════════
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openConfirm(msg, cb) {
  document.getElementById('confirmMsg').textContent = msg;
  document.getElementById('confirmOkBtn').onclick = () => { closeModal('modalConfirm'); cb(); };
  openModal('modalConfirm');
}
document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); });
});

// ════════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════════
let _tt = null;
function toast(msg, dur = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  if (_tt) clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.remove('show'), dur);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function continueAsGuest() {
  S.currentUser = { username: 'guest', role: 'user', id: null };
  localStorage.setItem('nt_session', 'guest');

  // Limpiar credenciales administrativas activas en sesión
  sessionStorage.removeItem('nt_admin_pwd');
  S.admin = false;

  document.getElementById('page-landing').style.display = 'none';
  document.getElementById('appContainer').style.display = 'block';
  updateNavUser();
  updateAdminUI();

  document.getElementById('loadingOverlay').style.display = 'flex';
  try {
    await loadData();
  } catch (e) {
    console.warn('Error al cargar datos:', e);
  }
  document.getElementById('loadingOverlay').style.display = 'none';

  renderHome();
}

init();
