import { Device, Organization, User, Workspace } from './types';

export function renderLoginHtml(): string {
  return `
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
  `;
}

interface CabinetViewProps {
  user: User;
  currentOrg: Organization;
  workspaces: Workspace[];
  devices: Device[];
  dashboards: any[];
  members: any[];
  pendingInvites: any[];
  planTier: string;
  maxDevices: number;
  maxMembers: number;
  isOwner: boolean;
}

export function renderCabinetHtml(props: CabinetViewProps): string {
  const { user, currentOrg, workspaces, devices, dashboards, members, pendingInvites, planTier, maxDevices, maxMembers, isOwner } = props;
  const currentWsId = workspaces[0]?.id || '';
  const totalAccounts = members.length + pendingInvites.length;
  const canAddDevice = devices.length < maxDevices;
  const canInvite = totalAccounts < maxMembers && isOwner;

  return `
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
        .section-title { font-size: 17px; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; }
        .tier-badge { background: #182234; border: 1px solid #2b3d5b; color: #38bdf8; font-size: 12px; padding: 4px 10px; border-radius: 6px; font-weight: 500; }
        
        .card { background: #131720; border: 1px solid #222938; border-radius: 10px; padding: 20px; margin-bottom: 28px; }
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
        
        .btn-primary { background: #0284c7; color: #fff; border: 1px solid transparent; padding: 8px 18px; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; }
        .btn-primary:hover { background: #0369a1; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        
        .btn-danger-sm { background: transparent; border: 1px solid #ef4444; color: #f87171; padding: 3px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; }
        .btn-danger-sm:hover { background: rgba(239, 68, 68, 0.15); }
        
        .form-group { margin-bottom: 16px; text-align: left; }
        .form-label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 6px; }
        .form-input, .form-select { width: 100%; background: #0f1217; border: 1px solid #283141; color: #f8fafc; padding: 10px 14px; border-radius: 6px; font-size: 14px; outline: none; }
        .form-input:focus, .form-select:focus { border-color: #38bdf8; }
        .form-input::placeholder { color: #475569; }
        
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.75); z-index: 1000; align-items: center; justify-content: center; backdrop-filter: blur(2px); }
        .modal-box { background: #181d28; border: 1px solid #334155; border-radius: 12px; padding: 24px; max-width: 440px; width: 92%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .modal-title { color: #f8fafc; font-size: 17px; font-weight: 600; margin-bottom: 16px; text-align: left; }
        .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
        .key-display { background: #0f1217; border: 1px dashed #38bdf8; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 13px; color: #38bdf8; word-break: break-all; user-select: all; margin: 12px 0; text-align: left; }

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
          <span class="tier-badge">Тариф: Семья (бесплатный) · 1 компьютер · до 5 аккаунтов</span>
          <span class="user-email">${user.name || user.email}</span>
          <a href="/auth/logout" class="btn-logout">Выйти</a>
        </div>
      </div>

      <div class="container">
        <!-- Блок Дашборды -->
        <div class="section-title">
          <span>Дашборды</span>
        </div>

        <div class="card">
          ${dashboards.length === 0 ? `
            <div class="empty-state">
              Пока нет доступных дашбордов.<br>
              Чтобы добавить дашборды, создайте устройство в блоке ниже и укажите его ключ в настройках программы.
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
                      Открыть дашборд ↗
                    </a>
                    <button onclick="showQr('/view/${d.org_slug}/${d.ws_slug}/${d.id}', '${d.name}')" class="btn-secondary" title="QR-код для смартфона">
                      📱 QR
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <!-- Блок Устройства -->
        <div class="section-title">
          <span>Устройства (${devices.length} из ${maxDevices})</span>
          ${canAddDevice ? `
            <button class="btn-secondary" onclick="openAddDeviceModal('${currentWsId}')">+ Добавить устройство</button>
          ` : `
            <span style="font-size:12px; color:#94a3b8;">Лимит бесплатной версии (1 устройство) заполнен</span>
          `}
        </div>

        <div class="card" style="padding:0; overflow:hidden;">
          ${devices.length === 0 ? `
            <div class="empty-state">
              Нет добавленных устройств. Нажмите «+ Добавить устройство», чтобы получить ключ для программы.
            </div>
          ` : `
            <table>
              <thead>
                <tr>
                  <th>Устройство</th>
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

        <!-- Блок Семейный доступ -->
        <div class="section-title">
          <span>Семейный доступ (${totalAccounts} из ${maxMembers})</span>
          ${canInvite ? `
            <button class="btn-secondary" onclick="openInviteModal()">+ Пригласить члена семьи</button>
          ` : `
            <span style="font-size:12px; color:#94a3b8;">${totalAccounts >= maxMembers ? 'Лимит 5 аккаунтов заполнен' : ''}</span>
          `}
        </div>

        <div class="card" style="padding:0; overflow:hidden;">
          <table>
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Роль</th>
                <th>Статус</th>
                ${isOwner ? '<th style="text-align:right;">Действие</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${members.map(m => `
                <tr>
                  <td style="font-weight:500;">
                    ${m.email} ${m.is_owner ? '<span style="color:#38bdf8; font-size:12px; margin-left:6px;">(Владелец)</span>' : ''}
                  </td>
                  <td><span style="font-size:12px; color:#94a3b8;">${m.is_owner ? 'Администратор' : 'Член семьи (Оператор)'}</span></td>
                  <td><span class="badge badge-online"><span class="dot"></span> Подключён</span></td>
                  ${isOwner ? `
                    <td style="text-align:right;">
                      ${!m.is_owner ? `<button onclick="removeMember('${m.id}')" class="btn-danger-sm">Отозвать</button>` : '—'}
                    </td>
                  ` : ''}
                </tr>
              `).join('')}
              ${pendingInvites.map(inv => `
                <tr style="opacity: 0.75;">
                  <td>${inv.email}</td>
                  <td><span style="font-size:12px; color:#94a3b8;">Член семьи (Оператор)</span></td>
                  <td><span class="badge badge-offline"><span class="dot"></span> Ожидает входа через Google</span></td>
                  ${isOwner ? `
                    <td style="text-align:right;">
                      <button onclick="removeInvite('${inv.email}')" class="btn-danger-sm">Отменить</button>
                    </td>
                  ` : ''}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Модальное окно приглашения члена семьи -->
      <div id="inviteModal" class="modal-overlay">
        <div class="modal-box">
          <div class="modal-title">Пригласить члена семьи</div>
          <p style="font-size:13px; color:#94a3b8; margin-bottom:16px;">
            Укажите адрес электронной почты Google. Человек сможет войти в этот кабинет со своего телефона через Google и смотреть дашборды.
          </p>
          <form onsubmit="submitInvite(event)">
            <div class="form-group">
              <label class="form-label" for="inviteEmailInput">Email аккаунта Google</label>
              <input id="inviteEmailInput" class="form-input" type="email" placeholder="example@gmail.com" required autocomplete="off" />
            </div>
            <div id="inviteError" style="color:#f87171; font-size:13px; margin-bottom:12px; display:none;"></div>
            <div class="modal-actions">
              <button type="button" onclick="closeInviteModal()" class="btn-secondary">Отмена</button>
              <button id="inviteSubmitBtn" type="submit" class="btn-primary">Пригласить</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Модальное окно создания устройства -->
      <div id="addDeviceModal" class="modal-overlay">
        <div class="modal-box">
          <div class="modal-title">Новое устройство</div>
          <form id="addDeviceForm" onsubmit="submitAddDevice(event)">
            <div class="form-group">
              <label class="form-label" for="deviceNameInput">Название устройства</label>
              <input id="deviceNameInput" class="form-input" type="text" placeholder="Рабочий компьютер" required autocomplete="off" />
            </div>
            <div class="form-group">
              <label class="form-label" for="deviceRoleSelect">Роль устройства</label>
              <select id="deviceRoleSelect" class="form-select">
                <option value="primary">Основное (Primary)</option>
                <option value="standby">Резервное (Standby)</option>
              </select>
            </div>
            <div id="addDeviceError" style="color: #f87171; font-size: 13px; margin-bottom: 12px; display: none;"></div>
            <div class="modal-actions">
              <button type="button" onclick="closeAddDeviceModal()" class="btn-secondary">Отмена</button>
              <button id="addDeviceSubmitBtn" type="submit" class="btn-primary">Добавить устройство</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Модальное окно подтверждения связки устройства (Pairing) -->
      <div id="pairApproveModal" class="modal-overlay">
        <div class="modal-box" style="max-width: 480px;">
          <div class="modal-title" style="color:#38bdf8;">Запрос на привязку устройства</div>
          <p style="font-size: 13px; color: #94a3b8; line-height: 1.5; margin-bottom: 16px;">
            Программа на вашем компьютере запрашивает связку с личным кабинетом.
          </p>
          <div style="background:#0f1217; border:1px solid #283141; border-radius:8px; padding:14px; margin-bottom:16px; text-align:left; font-size:13px;">
            <div><strong>Устройство:</strong> <span id="pairDeviceName">—</span></div>
            <div style="margin-top:4px;"><strong>Платформа:</strong> <span id="pairOsInfo">—</span></div>
            <div style="margin-top:4px;"><strong>Код проверки:</strong> <span id="pairCodeDisplay" style="color:#38bdf8; font-weight:700;">—</span></div>
          </div>
          <div id="pairError" style="color:#f87171; font-size:13px; margin-bottom:12px; display:none;"></div>
          <div class="modal-actions">
            <button type="button" onclick="closePairModal()" class="btn-secondary">Отклонить</button>
            <button id="pairApproveBtn" type="button" onclick="confirmPairing()" class="btn-primary">Подтвердить привязку</button>
          </div>
        </div>
      </div>

      <!-- Модальное окно с созданным ключом -->
      <div id="keySuccessModal" class="modal-overlay">
        <div class="modal-box" style="max-width: 480px;">
          <div class="modal-title" style="color:#4ade80;">✓ Устройство добавлено</div>
          <p style="font-size: 13px; color: #94a3b8; text-align: left; line-height: 1.5;">
            Скопируйте секретный ключ и вставьте его в программе <strong>MQTT Control RS</strong> в окне «Сервер» → «Облачный хаб»:
          </p>
          <div id="keyDisplayBox" class="key-display"></div>
          <div style="font-size: 12px; color: #f59e0b; margin-bottom: 16px; text-align: left;">
            ⚠ Ключ отображается только один раз. Обязательно скопируйте его сейчас.
          </div>
          <div class="modal-actions" style="justify-content: space-between;">
            <button id="copyKeyBtn" type="button" onclick="copyCreatedKey()" class="btn-secondary">📋 Скопировать ключ</button>
            <button type="button" onclick="location.reload()" class="btn-primary">Готово</button>
          </div>
        </div>
      </div>

      <!-- Модальное окно QR-кода -->
      <div id="qrModal" class="modal-overlay">
        <div class="modal-box" style="text-align:center; max-width:360px;">
          <h3 id="qrTitle" style="color:#f8fafc; font-size:16px; margin-bottom:12px;">Дашборд</h3>
          <p style="color:#94a3b8; font-size:13px; margin-bottom:18px;">Наведите камеру смартфона для быстрого входа:</p>
          <div style="background:#fff; padding:12px; border-radius:8px; display:inline-block; margin-bottom:18px;">
            <img id="qrImage" src="" alt="QR" style="display:block; width:200px; height:200px;">
          </div>
          <div>
            <button onclick="closeQr()" class="btn-secondary" style="width:100%;">Закрыть</button>
          </div>
        </div>
      </div>

      <script>
        let currentWorkspaceId = '${currentWsId}';
        let createdDeviceKey = '';
        let activePairCode = '';

        // Проверка URL на наличие запроса связки (?pair=...)
        window.addEventListener('DOMContentLoaded', async () => {
          const params = new URLSearchParams(window.location.search);
          const pairCode = params.get('pair');
          if (pairCode) {
            activePairCode = pairCode;
            try {
              const res = await fetch('/api/v1/pair/info?code=' + encodeURIComponent(pairCode));
              const data = await res.json();
              if (data.status === 'ok') {
                document.getElementById('pairDeviceName').textContent = data.device_name;
                document.getElementById('pairOsInfo').textContent = data.os_info || 'ПК';
                document.getElementById('pairCodeDisplay').textContent = pairCode;
                document.getElementById('pairApproveModal').style.display = 'flex';
              }
            } catch (err) {}
          }
        });

        async function confirmPairing() {
          const btn = document.getElementById('pairApproveBtn');
          const errDiv = document.getElementById('pairError');
          btn.disabled = true;
          btn.textContent = 'Привязка...';
          errDiv.style.display = 'none';

          try {
            const res = await fetch('/api/v1/pair/approve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: activePairCode })
            });
            const data = await res.json();
            if (data.status === 'ok') {
              alert(data.message || 'Устройство успешно привязано!');
              window.location.href = '/cabinet';
            } else {
              errDiv.textContent = data.message || 'Ошибка подтверждения';
              errDiv.style.display = 'block';
              btn.disabled = false;
              btn.textContent = 'Подтвердить привязку';
            }
          } catch (e) {
            errDiv.textContent = 'Сетевая ошибка';
            errDiv.style.display = 'block';
            btn.disabled = false;
            btn.textContent = 'Подтвердить привязку';
          }
        }

        function closePairModal() {
          document.getElementById('pairApproveModal').style.display = 'none';
        }

        function openAddDeviceModal(wsId) {
          currentWorkspaceId = wsId;
          document.getElementById('deviceNameInput').value = '';
          document.getElementById('deviceRoleSelect').value = 'primary';
          document.getElementById('addDeviceError').style.display = 'none';
          document.getElementById('addDeviceModal').style.display = 'flex';
          setTimeout(() => document.getElementById('deviceNameInput').focus(), 50);
        }

        function closeAddDeviceModal() {
          document.getElementById('addDeviceModal').style.display = 'none';
        }

        async function submitAddDevice(e) {
          e.preventDefault();
          const nameInput = document.getElementById('deviceNameInput');
          const roleSelect = document.getElementById('deviceRoleSelect');
          const submitBtn = document.getElementById('addDeviceSubmitBtn');
          const errDiv = document.getElementById('addDeviceError');

          const name = nameInput.value.trim();
          if (!name) return;

          submitBtn.disabled = true;
          submitBtn.textContent = 'Добавление...';
          errDiv.style.display = 'none';

          try {
            const res = await fetch('/api/v1/devices/create', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ workspace_id: currentWorkspaceId, name: name, role: roleSelect.value })
            });
            const data = await res.json();
            if (data.status === 'ok') {
              closeAddDeviceModal();
              createdDeviceKey = data.device_key;
              document.getElementById('keyDisplayBox').textContent = createdDeviceKey;
              document.getElementById('keySuccessModal').style.display = 'flex';
            } else {
              errDiv.textContent = data.message || 'Ошибка добавления устройства';
              errDiv.style.display = 'block';
            }
          } catch (err) {
            errDiv.textContent = 'Сетевая ошибка при добавлении устройства';
            errDiv.style.display = 'block';
          } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Добавить устройство';
          }
        }

        function openInviteModal() {
          document.getElementById('inviteEmailInput').value = '';
          document.getElementById('inviteError').style.display = 'none';
          document.getElementById('inviteModal').style.display = 'flex';
          setTimeout(() => document.getElementById('inviteEmailInput').focus(), 50);
        }

        function closeInviteModal() {
          document.getElementById('inviteModal').style.display = 'none';
        }

        async function submitInvite(e) {
          e.preventDefault();
          const email = document.getElementById('inviteEmailInput').value.trim();
          const btn = document.getElementById('inviteSubmitBtn');
          const errDiv = document.getElementById('inviteError');
          if (!email) return;

          btn.disabled = true;
          btn.textContent = 'Отправка...';
          errDiv.style.display = 'none';

          try {
            const res = await fetch('/api/v1/family/invite', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: email, role: 'operator' })
            });
            const data = await res.json();
            if (data.status === 'ok') {
              alert(data.message);
              location.reload();
            } else {
              errDiv.textContent = data.message || 'Ошибка отправки приглашения';
              errDiv.style.display = 'block';
            }
          } catch (err) {
            errDiv.textContent = 'Сетевая ошибка';
            errDiv.style.display = 'block';
          } finally {
            btn.disabled = false;
            btn.textContent = 'Пригласить';
          }
        }

        async function removeMember(userId) {
          if (!confirm('Отозвать доступ у этого пользователя?')) return;
          try {
            const res = await fetch('/api/v1/family/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: userId })
            });
            const data = await res.json();
            if (data.status === 'ok') location.reload();
            else alert(data.message || 'Ошибка');
          } catch (e) { alert('Ошибка сети'); }
        }

        async function removeInvite(email) {
          if (!confirm('Отменить приглашение для ' + email + '?')) return;
          try {
            const res = await fetch('/api/v1/family/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: email })
            });
            const data = await res.json();
            if (data.status === 'ok') location.reload();
            else alert(data.message || 'Ошибка');
          } catch (e) { alert('Ошибка сети'); }
        }

        async function copyCreatedKey() {
          if (!createdDeviceKey) return;
          try {
            await navigator.clipboard.writeText(createdDeviceKey);
            const btn = document.getElementById('copyKeyBtn');
            btn.textContent = '✓ Скопировано!';
            setTimeout(() => { btn.textContent = '📋 Скопировать ключ'; }, 2500);
          } catch (err) {
            const box = document.getElementById('keyDisplayBox');
            const range = document.createRange();
            range.selectNodeContents(box);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
          }
        }

        function showQr(path, title) {
          const fullUrl = window.location.origin + path;
          document.getElementById('qrTitle').textContent = title;
          document.getElementById('qrImage').src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(fullUrl);
          document.getElementById('qrModal').style.display = 'flex';
        }

        function closeQr() {
          document.getElementById('qrModal').style.display = 'none';
        }
      </script>
    </body>
    </html>
  `;
}
