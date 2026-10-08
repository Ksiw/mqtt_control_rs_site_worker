/**
 * HTML-разметка блока супер-администратора (управление лицензиями)
 */
export function renderAdminSection(isSuperAdmin: boolean, planPrices?: { twoMonth: number; year: number }): string {
  if (!isSuperAdmin) return '';

  const curTwoMonth = (planPrices?.twoMonth ?? 20.0).toFixed(2);
  const curYear = (planPrices?.year ?? 100.0).toFixed(2);

  return `
    <!-- Панель супер-администратора -->
    <div class="section-title" style="margin-top: 40px; border-top: 1px dashed #334155; padding-top: 24px;">
      <span style="color:#f59e0b; display:flex; align-items:center; gap:8px;">
        🛡️ Управление лицензиями и ценами (Администратор системы)
      </span>
      <button class="btn-secondary" onclick="loadAdminUsers()">Обновить список</button>
    </div>

    <!-- Настройка стоимости подписки -->
    <div class="card" style="margin-bottom: 24px;">
      <div style="font-size: 14px; font-weight: 600; color: #f8fafc; margin-bottom: 12px;">Установка стоимости подписки Pro</div>
      <form id="pricingForm" onsubmit="submitAdminPricing(event)" style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end;">
        <div style="width:160px;">
          <label class="form-label" for="priceTwoMonthInput">2 месяца ($ USD)</label>
          <input id="priceTwoMonthInput" class="form-input" type="number" step="0.5" min="1" value="${curTwoMonth}" required />
        </div>
        <div style="width:160px;">
          <label class="form-label" for="priceYearInput">1 год ($ USD)</label>
          <input id="priceYearInput" class="form-input" type="number" step="1" min="1" value="${curYear}" required />
        </div>
        <div>
          <button id="priceSubmitBtn" type="submit" class="btn-primary" style="background:#0284c7; padding:10px 18px;">
            💾 Сохранить цены
          </button>
        </div>
      </form>
      <div id="pricingMsg" style="font-size:13px; margin-top:10px; display:none;"></div>
    </div>

    <div class="card" style="margin-bottom: 24px;">
      <div style="font-size: 14px; font-weight: 600; color: #f8fafc; margin-bottom: 12px;">Выдача или продление лицензии</div>
      <form id="grantLicenseForm" onsubmit="submitAdminGrant(event)" style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
        <div style="flex:1; min-width:220px;">
          <label class="form-label" for="grantEmail">Email пользователя</label>
          <input id="grantEmail" class="form-input" type="email" placeholder="user@gmail.com" required autocomplete="off" />
        </div>
        <div style="width:160px;">
          <label class="form-label" for="grantTier">Тариф</label>
          <select id="grantTier" class="form-select" onchange="toggleGrantDevices()">
            <option value="pro">Pro (3 хоста)</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </div>
        <div id="grantDevicesGroup" style="width:130px; display:none;">
          <label class="form-label" for="grantDevicesInput">Лимит хостов</label>
          <input id="grantDevicesInput" class="form-input" type="number" min="1" max="9999" placeholder="Кол-во" />
        </div>
        <div style="width:150px;">
          <label class="form-label" for="grantDuration">Срок</label>
          <select id="grantDuration" class="form-select">
            <option value="month">+1 месяц</option>
            <option value="year">+1 год</option>
            <option value="lifetime">Бессрочно (50 лет)</option>
          </select>
        </div>
        <div>
          <button id="grantSubmitBtn" type="submit" class="btn-primary" style="background:#d97706; padding:10px 18px;">
            ✓ Выдать лицензию
          </button>
        </div>
      </form>
      <div id="grantMsg" style="font-size:13px; margin-top:10px; display:none;"></div>
    </div>

    <div class="card" style="padding:0; overflow:hidden; margin-bottom: 32px;">
      <div style="padding:14px 18px; border-bottom:1px solid #1e2430; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
        <span style="font-weight:600; font-size:14px; color:#cbd5e1;">Зарегистрированные аккаунты и лицензии</span>
        <div style="position:relative; width:260px;">
          <input id="adminSearchInput" oninput="filterAdminUsers()" type="text" placeholder="🔍 Поиск по email или имени..." class="form-input" style="padding:6px 12px; font-size:13px; border-radius:6px;" autocomplete="off" />
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table id="adminUsersTable">
          <thead>
            <tr>
              <th>Email / Имя</th>
              <th>Тариф</th>
              <th>Лимиты</th>
              <th>Окончание</th>
              <th style="text-align:right;">Действие</th>
            </tr>
          </thead>
          <tbody id="adminUsersBody">
            <tr>
              <td colspan="5" style="text-align:center; padding:24px; color:#64748b;">Загрузка списка пользователей...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Модальное окно оформления Enterprise для пользователя -->
    <div id="adminEnterpriseModal" class="modal-overlay">
      <div class="modal-box" style="max-width: 440px;">
        <div class="modal-title" style="display:flex; align-items:center; justify-content:space-between;">
          <span style="color:#d8b4fe;">🏢 Назначение Enterprise</span>
          <button onclick="closeEnterpriseModal()" style="background:none; border:none; color:#64748b; font-size:18px; cursor:pointer;">✕</button>
        </div>
        <p style="font-size:13px; color:#94a3b8; margin-bottom:16px;">
          Пользователь: <strong id="entModalEmail" style="color:#f8fafc;"></strong>
        </p>
        <form onsubmit="submitEnterpriseModal(event)">
          <div class="form-group">
            <label class="form-label" for="entModalDevices">Количество хост-программ (серверов компании)</label>
            <input id="entModalDevices" class="form-input" type="number" min="1" max="9999" placeholder="Например: 10, 25 или 100" required autocomplete="off" />
          </div>
          <div class="form-group">
            <label class="form-label" for="entModalDuration">Срок действия контракта</label>
            <select id="entModalDuration" class="form-select">
              <option value="year">+1 год</option>
              <option value="month">+1 месяц</option>
              <option value="lifetime">Бессрочно (50 лет)</option>
            </select>
          </div>
          <div id="entModalError" style="color:#f87171; font-size:13px; margin-bottom:12px; display:none;"></div>
          <div class="modal-actions" style="justify-content:space-between;">
            <button type="button" onclick="closeEnterpriseModal()" class="btn-secondary">Отмена</button>
            <button id="entModalSubmitBtn" type="submit" class="btn-primary" style="background:#9333ea;">✓ Назначить Enterprise</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

/**
 * Клиентский JavaScript для управления лицензиями
 */
export function renderAdminScripts(isSuperAdmin: boolean): string {
  if (!isSuperAdmin) return '';

  return `
    <script>
      let adminCachedUsers = [];

      function escapeAdminHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
      }

      function adminJsArg(value) {
        return escapeAdminHtml(JSON.stringify(String(value ?? '')));
      }

      function renderUserRows(users) {
        const tbody = document.getElementById('adminUsersBody');
        if (!tbody) return;
        if (!users || users.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#64748b;">Пользователи не найдены</td></tr>';
          return;
        }
        tbody.innerHTML = users.map(u => {
          const isPro = u.plan_tier === 'pro';
          const isEnterprise = u.plan_tier === 'enterprise';
          const isPaid = isPro || isEnterprise;
          const endDate = (u.plan_tier === 'free' || !u.current_period_end || u.current_period_end <= 0)
            ? 'Бессрочно'
            : new Date(u.current_period_end * 1000).toLocaleDateString('ru-RU');
          let badge = '<span class="badge badge-offline">Домашний (бесплатный)</span>';
          if (isEnterprise) {
            badge = '<span class="badge" style="background:#3b1e54; color:#d8b4fe; border:1px solid #9333ea;">ENTERPRISE</span>';
          } else if (isPro) {
            badge = '<span class="badge" style="background:#1e3a5f; color:#38bdf8; border:1px solid #0284c7;">PRO</span>';
          }
          return \`
            <tr>
              <td>
                <div style="font-weight:600; color:#f8fafc;">\${escapeAdminHtml(u.email)}</div>
                <div style="font-size:12px; color:#64748b;">\${escapeAdminHtml(u.name || '—')}</div>
              </td>
              <td>\${badge}</td>
              <td style="color:#94a3b8; font-size:13px;">до \${escapeAdminHtml(u.max_devices)} хостов</td>
              <td style="color:#cbd5e1; font-size:13px;">\${endDate}</td>
              <td style="text-align:right; white-space:nowrap;">
                \${isEnterprise ? \`
                  <button onclick="openEnterpriseModal(\${adminJsArg(u.email)}, \${Number(u.max_devices) || 0})" class="btn-secondary" style="padding:3px 8px; font-size:12px; border-color:#9333ea; color:#d8b4fe; margin-right:4px;" title="Изменить лимит хостов или срок">Изменить Enterprise</button>
                  <button onclick="revokeAdminLicense(\${adminJsArg(u.email)})" class="btn-danger-sm" title="Сбросить на Домашний (бесплатный)">Отозвать</button>
                \` : isPro ? \`
                  <button onclick="quickGrant(\${adminJsArg(u.email)}, 'month')" class="btn-secondary" style="padding:3px 8px; font-size:12px; border-color:#0284c7; color:#38bdf8; margin-right:4px;" title="Продлить Pro на 1 месяц">+1 мес Pro</button>
                  <button onclick="openEnterpriseModal(\${adminJsArg(u.email)})" class="btn-secondary" style="padding:3px 8px; font-size:12px; border-color:#9333ea; color:#d8b4fe; margin-right:4px;" title="Перевести на Enterprise">Enterprise</button>
                  <button onclick="revokeAdminLicense(\${adminJsArg(u.email)})" class="btn-danger-sm" title="Сбросить на Домашний (бесплатный)">Отозвать</button>
                \` : \`
                  <button onclick="quickGrant(\${adminJsArg(u.email)}, 'month')" class="btn-secondary" style="padding:3px 8px; font-size:12px; border-color:#0284c7; color:#38bdf8; margin-right:4px;">+1 мес Pro</button>
                  <button onclick="openEnterpriseModal(\${adminJsArg(u.email)})" class="btn-secondary" style="padding:3px 8px; font-size:12px; border-color:#9333ea; color:#d8b4fe;">Enterprise</button>
                \`}
              </td>
            </tr>
          \`;
        }).join('');
      }

      function filterAdminUsers() {
        const input = document.getElementById('adminSearchInput');
        const q = (input ? input.value : '').toLowerCase().trim();
        if (!q) {
          renderUserRows(adminCachedUsers);
          return;
        }
        const filtered = adminCachedUsers.filter(u => 
          (u.email && u.email.toLowerCase().includes(q)) || 
          (u.name && u.name.toLowerCase().includes(q))
        );
        renderUserRows(filtered);
      }

      async function loadAdminUsers() {
        const tbody = document.getElementById('adminUsersBody');
        if (!tbody) return;
        try {
          const res = await fetch('/api/v1/admin/users');
          const data = await res.json();
          if (data.status === 'ok') {
            adminCachedUsers = data.users || [];
            filterAdminUsers();
          }
        } catch (err) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#ef4444; padding:20px;">Ошибка загрузки списка</td></tr>';
        }
      }

      function toggleGrantDevices() {
        const tier = document.getElementById('grantTier') ? document.getElementById('grantTier').value : 'pro';
        const group = document.getElementById('grantDevicesGroup');
        if (group) {
          group.style.display = tier === 'enterprise' ? 'block' : 'none';
        }
      }

      async function submitAdminGrant(e) {
        e.preventDefault();
        const email = document.getElementById('grantEmail').value.trim();
        const tier = document.getElementById('grantTier') ? document.getElementById('grantTier').value : 'pro';
        const duration = document.getElementById('grantDuration').value;
        const devInput = document.getElementById('grantDevicesInput');
        const max_devices = (tier === 'enterprise' && devInput) ? parseInt(devInput.value, 10) : undefined;

        const msgDiv = document.getElementById('grantMsg');
        const btn = document.getElementById('grantSubmitBtn');
        btn.disabled = true;

        try {
          const res = await fetch('/api/v1/admin/license/grant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, tier, duration, max_devices })
          });
          const data = await res.json();
          msgDiv.style.display = 'block';
          if (data.status === 'ok') {
            msgDiv.style.color = '#34d399';
            msgDiv.textContent = '✓ ' + data.message;
            document.getElementById('grantEmail').value = '';
            loadAdminUsers();
          } else {
            msgDiv.style.color = '#f87171';
            msgDiv.textContent = '✕ ' + (data.message || 'Ошибка');
          }
        } catch (err) {
          msgDiv.style.display = 'block';
          msgDiv.style.color = '#f87171';
          msgDiv.textContent = '✕ Ошибка сети';
        } finally {
          btn.disabled = false;
        }
      }

      async function quickGrant(email, duration) {
        if (!confirm('Выдать Pro для ' + email + '?')) return;
        try {
          const res = await fetch('/api/v1/admin/license/grant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, duration })
          });
          const data = await res.json();
          if (data.status === 'ok') {
            loadAdminUsers();
          } else {
            alert(data.message || 'Ошибка');
          }
        } catch (err) {
          alert('Ошибка сети');
        }
      }

      async function revokeAdminLicense(email) {
        if (!confirm('Отозвать лицензию Pro у ' + email + ' и сбросить на Домашний (бесплатный)?')) return;
        try {
          const res = await fetch('/api/v1/admin/license/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
          });
          const data = await res.json();
          if (data.status === 'ok') {
            loadAdminUsers();
          } else {
            alert(data.message || 'Ошибка');
          }
        } catch (err) {
          alert('Ошибка сети');
        }
      }

      let currentEnterpriseEmail = '';

      function openEnterpriseModal(email, currentDevices) {
        currentEnterpriseEmail = email;
        const emailEl = document.getElementById('entModalEmail');
        if (emailEl) emailEl.textContent = email;
        const devInput = document.getElementById('entModalDevices');
        if (devInput) devInput.value = currentDevices ? currentDevices : '';
        const errDiv = document.getElementById('entModalError');
        if (errDiv) errDiv.style.display = 'none';
        const modal = document.getElementById('adminEnterpriseModal');
        if (modal) modal.style.display = 'flex';
        if (devInput) devInput.focus();
      }

      function closeEnterpriseModal() {
        const modal = document.getElementById('adminEnterpriseModal');
        if (modal) modal.style.display = 'none';
      }

      async function submitEnterpriseModal(e) {
        e.preventDefault();
        const devices = parseInt(document.getElementById('entModalDevices').value, 10);
        const duration = document.getElementById('entModalDuration').value;
        const errDiv = document.getElementById('entModalError');
        const btn = document.getElementById('entModalSubmitBtn');

        if (!devices || devices < 1) {
          if (errDiv) {
            errDiv.textContent = 'Укажите количество хостов больше 0';
            errDiv.style.display = 'block';
          }
          return;
        }

        btn.disabled = true;
        btn.textContent = 'Сохранение...';

        try {
          const res = await fetch('/api/v1/admin/license/grant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: currentEnterpriseEmail,
              tier: 'enterprise',
              max_devices: devices,
              duration: duration
            })
          });
          const data = await res.json();
          if (data.status === 'ok') {
            closeEnterpriseModal();
            loadAdminUsers();
          } else {
            if (errDiv) {
              errDiv.textContent = data.message || 'Ошибка';
              errDiv.style.display = 'block';
            }
          }
        } catch (err) {
          if (errDiv) {
            errDiv.textContent = 'Ошибка сети';
            errDiv.style.display = 'block';
          }
        } finally {
          btn.disabled = false;
          btn.textContent = '✓ Назначить Enterprise';
        }
      }

      async function submitAdminPricing(e) {
        e.preventDefault();
        const twoMonth = parseFloat(document.getElementById('priceTwoMonthInput').value);
        const year = parseFloat(document.getElementById('priceYearInput').value);
        const msgDiv = document.getElementById('pricingMsg');
        const btn = document.getElementById('priceSubmitBtn');
        btn.disabled = true;

        try {
          const res = await fetch('/api/v1/admin/pricing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ twoMonth, year })
          });
          const data = await res.json();
          msgDiv.style.display = 'block';
          if (data.status === 'ok') {
            msgDiv.style.color = '#34d399';
            msgDiv.textContent = '✓ ' + data.message;
            setTimeout(() => { location.reload(); }, 1200);
          } else {
            msgDiv.style.color = '#f87171';
            msgDiv.textContent = '✕ ' + (data.message || 'Ошибка');
          }
        } catch (err) {
          msgDiv.style.display = 'block';
          msgDiv.style.color = '#f87171';
          msgDiv.textContent = '✕ Ошибка сети';
        } finally {
          btn.disabled = false;
        }
      }

      window.addEventListener('DOMContentLoaded', () => {
        loadAdminUsers();
      });
    </script>
  `;
}
