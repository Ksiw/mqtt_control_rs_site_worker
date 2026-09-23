import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { Env, User, Organization, Workspace, Device, DashboardItem } from './types';
import { generateDeviceKey, sha256Hex } from './crypto';

export const cabinetRouter = new Hono<{ Bindings: Env }>();

import { Context } from 'hono';

/**
 * Получение текущего авторизованного пользователя по сессии
 */
async function getCurrentUser(c: Context<{ Bindings: Env }>): Promise<User | null> {
  const sessionToken = getCookie(c, 'session');
  if (!sessionToken) return null;

  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare(`
    SELECT u.* FROM users u
    JOIN user_sessions s ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
    LIMIT 1
  `).bind(sessionToken, now).first<User>();

  return row || null;
}

/**
 * Главный экран диспетчерской:
 * GET / и GET /cabinet
 */
const handleCabinet = async (c: Context<{ Bindings: Env }>) => {
  const user = await getCurrentUser(c);

  // 1. Если не авторизован — показываем чистый экран входа
  if (!user) {
    return c.html(`
      <!DOCTYPE html>
      <html lang="ru">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Управление | MQTT Control RS</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
          body { background: #0f1217; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
          .login-card { background: #181d26; border: 1px solid #283141; border-radius: 12px; padding: 40px; width: 100%; max-width: 440px; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,0.4); }
          .logo { font-size: 20px; font-weight: 700; letter-spacing: 0.5px; color: #38bdf8; margin-bottom: 12px; }
          h1 { font-size: 24px; font-weight: 600; margin-bottom: 24px; }
          .btn-google { display: inline-flex; align-items: center; justify-content: center; gap: 12px; width: 100%; background: #222938; color: #f8fafc; border: 1px solid #3b475d; padding: 12px 20px; border-radius: 8px; font-size: 15px; font-weight: 500; text-decoration: none; transition: background 0.15s, border-color 0.15s; }
          .btn-google:hover { background: #2c364a; border-color: #38bdf8; }
          .footer { margin-top: 24px; font-size: 12px; color: #64748b; }
          .footer a { color: #94a3b8; text-decoration: none; }
          .footer a:hover { color: #38bdf8; }
        </style>
      </head>
      <body>
        <div class="login-card">
          <div class="logo">MQTT Control RS</div>
          <h1>Управление</h1>
          <a href="/auth/google" class="btn-google">
            <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.36 24 12 24z"/><path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 9.99 0 12s.45 3.82 1.25 5.42l4.03-3.15z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.36 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"/></svg>
            Войти через Google
          </a>
          <div class="footer">
            <a href="https://mqtt-control-rs.pages.dev/">← Вернуться на главный сайт</a>
          </div>
        </div>
      </body>
      </html>
    `);
  }

  // 2. Если авторизован — запрашиваем список организаций, пространств, узлов и дашбордов
  const orgs = await c.env.DB.prepare(`
    SELECT o.* FROM organizations o
    JOIN organization_members m ON m.org_id = o.id
    WHERE m.user_id = ?
  `).bind(user.id).all<Organization>();

  const orgList = orgs.results || [];

  // Получаем рабочие пространства для первой активной организации
  const currentOrg = orgList[0];
  let workspaces: Workspace[] = [];
  let devices: Device[] = [];
  let dashboards: any[] = [];

  if (currentOrg) {
    const wsRes = await c.env.DB.prepare(
      'SELECT * FROM workspaces WHERE org_id = ?'
    ).bind(currentOrg.id).all<Workspace>();
    workspaces = wsRes.results || [];

    if (workspaces.length > 0) {
      const wsIds = workspaces.map(w => `'${w.id}'`).join(',');
      
      const devRes = await c.env.DB.prepare(
        `SELECT * FROM devices WHERE workspace_id IN (${wsIds})`
      ).all<Device>();
      devices = devRes.results || [];

      const dashRes = await c.env.DB.prepare(
        `SELECT d.*, w.slug as ws_slug, o.slug as org_slug 
         FROM dashboards d 
         JOIN workspaces w ON d.workspace_id = w.id
         JOIN organizations o ON w.org_id = o.id
         WHERE d.workspace_id IN (${wsIds})`
      ).all();
      dashboards = dashRes.results || [];
    }
  }

  return c.html(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Управление | ${user.name || user.email}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
        body { background: #0b0e14; color: #e2e8f0; min-height: 100vh; display: flex; flex-direction: column; }
        .header { background: #131720; border-bottom: 1px solid #222938; padding: 14px 28px; display: flex; align-items: center; justify-content: space-between; }
        .header-brand { display: flex; align-items: center; gap: 12px; font-weight: 700; color: #38bdf8; font-size: 17px; }
        .header-user { display: flex; align-items: center; gap: 16px; font-size: 14px; }
        .user-email { color: #94a3b8; }
        .btn-logout { background: #1e2430; border: 1px solid #333d4e; color: #cbd5e1; padding: 6px 14px; border-radius: 6px; text-decoration: none; font-size: 13px; }
        .btn-logout:hover { background: #283141; color: #fff; }
        
        .container { max-width: 1100px; margin: 32px auto; padding: 0 20px; width: 100%; flex: 1; }
        .section-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; }
        
        .card { background: #131720; border: 1px solid #222938; border-radius: 10px; padding: 20px; margin-bottom: 24px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
        
        .dash-card { background: #181d28; border: 1px solid #283141; border-radius: 8px; padding: 18px; display: flex; flex-direction: column; justify-content: space-between; gap: 14px; }
        .dash-name { font-size: 16px; font-weight: 600; color: #f8fafc; }
        .dash-meta { font-size: 12px; color: #64748b; margin-top: 4px; }
        .badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 8px; border-radius: 9999px; }
        .badge-online { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
        .badge-offline { background: rgba(148, 163, 184, 0.1); color: #94a3b8; border: 1px solid #334155; }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
        
        .btn-open { display: inline-flex; align-items: center; justify-content: center; background: #0284c7; color: #fff; text-decoration: none; padding: 8px 16px; border-radius: 6px; font-size: 14px; font-weight: 500; }
        .btn-open:hover { background: #0369a1; }
        .btn-secondary { background: #1e2430; border: 1px solid #333d4e; color: #cbd5e1; padding: 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; }
        .btn-secondary:hover { background: #283141; }
        
        table { width: 100%; border-collapse: collapse; font-size: 14px; text-align: left; }
        th { color: #64748b; font-weight: 500; padding: 10px 14px; border-bottom: 1px solid #222938; }
        td { padding: 12px 14px; border-bottom: 1px solid #1a202c; }
        
        .empty-state { text-align: center; padding: 32px; color: #64748b; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="header-brand">
          <span>⚡ MQTT Control RS</span>
          <span style="color:#64748b; font-weight:400; font-size:14px;">/ Управление</span>
        </div>
        <div class="header-user">
          <span class="user-email">${user.name || user.email}</span>
          <a href="/auth/logout" class="btn-logout">Выйти</a>
        </div>
      </div>

      <div class="container">
        <!-- Блок доступных дашбордов -->
        <div class="section-title">
          <span>Мои дашборды и мнемосхемы</span>
        </div>

        <div class="card">
          ${dashboards.length === 0 ? `
            <div class="empty-state">
              Пока нет зарегистрированных экранов.<br>
              Подключите экземпляр настольной программы <code>mqtt_control_rs</code> ниже, и экраны появятся здесь автоматически.
            </div>
          ` : `
            <div class="grid">
              ${dashboards.map(d => `
                <div class="dash-card">
                  <div>
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
                      <span class="badge badge-online"><span class="dot"></span> Доступен</span>
                      <span class="dash-meta">${d.ws_slug}</span>
                    </div>
                    <div class="dash-name">${d.name}</div>
                  </div>
                    <div style="display:flex; gap:8px;">
                      <a href="/view/${d.org_slug}/${d.ws_slug}/${d.id}" target="_blank" class="btn-open" style="flex:1;">
                        Открыть мнемосхему ↗
                      </a>
                      <button onclick="showQr('/view/${d.org_slug}/${d.ws_slug}/${d.id}', '${d.name}')" class="btn-secondary" title="QR-код для смартфона">
                        📱 QR
                      </button>
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <!-- Модальное окно QR-кода -->
        <div id="qrModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:1000; align-items:center; justify-content:center;">
          <div style="background:#181d28; border:1px solid #334155; border-radius:12px; padding:28px; text-align:center; max-width:360px; width:90%;">
            <h3 id="qrTitle" style="color:#f8fafc; font-size:16px; margin-bottom:12px;">Мнемосхема</h3>
            <p style="color:#94a3b8; font-size:13px; margin-bottom:18px;">Наведите камеру смартфона для быстрого входа:</p>
            <div id="qrContainer" style="background:#fff; padding:12px; border-radius:8px; display:inline-block; margin-bottom:18px;">
              <img id="qrImage" src="" alt="QR" style="display:block; width:200px; height:200px;">
            </div>
            <div>
              <button onclick="closeQr()" class="btn-secondary" style="width:100%;">Закрыть</button>
            </div>
          </div>
        </div>

        <!-- Блок подключённых устройств -->
        <div class="section-title">
          <span>Подключённые узлы (ПК диспетчера / Серверы)</span>
          <button class="btn-secondary" onclick="addDevice('${workspaces[0]?.id || ''}')">+ Добавить узел</button>
        </div>

        <div class="card" style="padding:0; overflow:hidden;">
          ${devices.length === 0 ? `
            <div class="empty-state">
              Нет привязанных устройств. Нажмите «+ Добавить узел», чтобы получить ключ для программы.
            </div>
          ` : `
            <table>
              <thead>
                <tr>
                  <th>Имя узла</th>
                  <th>Роль</th>
                  <th>Статус</th>
                  <th>Префикс ключа</th>
                  <th>Версия</th>
                </tr>
              </thead>
              <tbody>
                ${devices.map(dev => `
                  <tr>
                    <td style="font-weight:500;">${dev.name}</td>
                    <td><span style="font-size:12px; color:#94a3b8; text-transform:uppercase;">${dev.role}</span></td>
                    <td>
                      ${dev.is_online === 1 
                        ? '<span class="badge badge-online"><span class="dot"></span> Онлайн</span>' 
                        : '<span class="badge badge-offline"><span class="dot"></span> Оффлайн</span>'}
                    </td>
                    <td><code>${dev.key_prefix}****</code></td>
                    <td style="color:#64748b;">${dev.app_version || '—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `}
        </div>
      </div>

      <script>
        async function addDevice(wsId) {
          const name = prompt('Введите название для нового узла (например, «АРМ Диспетчера»):');
          if (!name) return;

          const res = await fetch('/api/v1/devices/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspace_id: wsId, name: name, role: 'primary' })
          });

          const data = await res.json();
          if (data.status === 'ok') {
            alert('Узел создан! Скопируйте секретный ключ в настройки программы mqtt_control_rs:\\n\\n' + data.device_key + '\\n\\n(Ключ отображается только один раз)');
            location.reload();
          } else {
            alert('Ошибка создания: ' + (data.message || 'неизвестная ошибка'));
          }
        }

        function showQr(path, title) {
          const fullUrl = window.location.origin + path;
          document.getElementById('qrTitle').textContent = title;
          // Генерация QR-кода через публичный безопасный API
          document.getElementById('qrImage').src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(fullUrl);
          document.getElementById('qrModal').style.display = 'flex';
        }

        function closeQr() {
          document.getElementById('qrModal').style.display = 'none';
        }
      </script>
    </body>
    </html>
  `);
};

cabinetRouter.get('/', handleCabinet);
cabinetRouter.get('/cabinet', handleCabinet);

/**
 * API выпуска нового ключа устройства
 * POST /api/v1/devices/create
 */
cabinetRouter.post('/api/v1/devices/create', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ status: 'error', message: 'Требуется авторизация' }, 401);
  }

  const { workspace_id, name, role } = await c.req.json() as {
    workspace_id: string;
    name: string;
    role?: 'primary' | 'standby';
  };

  if (!workspace_id || !name) {
    return c.json({ status: 'error', message: 'Не указаны обязательные поля' }, 400);
  }

  const devId = `dev_${crypto.randomUUID().replace(/-/g, '').substring(0, 10)}`;
  const { prefix, fullKey } = generateDeviceKey();
  const keyHash = await sha256Hex(fullKey);
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(`
    INSERT INTO devices (id, workspace_id, name, role, priority, key_hash, key_prefix, routing_mode, is_online, created_at)
    VALUES (?, ?, ?, ?, 100, ?, ?, 'proxy', 0, ?)
  `).bind(devId, workspace_id, name, role || 'primary', keyHash, prefix, now).run();

  return c.json({
    status: 'ok',
    device_id: devId,
    device_key: fullKey
  });
});
