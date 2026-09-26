/**
 * HTML-разметка блока супер-администратора (управление лицензиями)
 */
export function renderAdminSection(isSuperAdmin: boolean): string {
  if (!isSuperAdmin) return '';

  return `
    <!-- Панель супер-администратора -->
    <div class="section-title" style="margin-top: 40px; border-top: 1px dashed #334155; padding-top: 24px;">
      <span style="color:#f59e0b; display:flex; align-items:center; gap:8px;">
        🛡️ Управление лицензиями (Администратор системы)
      </span>
      <button class="btn-secondary" onclick="loadAdminUsers()">Обновить список</button>
    </div>

    <div class="card" style="margin-bottom: 24px;">
      <div style="font-size: 14px; font-weight: 600; color: #f8fafc; margin-bottom: 12px;">Быстрая выдача Pro-лицензии</div>
      <form id="grantLicenseForm" onsubmit="submitAdminGrant(event)" style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
        <div style="flex:1; min-width:240px;">
          <label class="form-label" for="grantEmail">Email пользователя</label>
          <input id="grantEmail" class="form-input" type="email" placeholder="user@gmail.com" required autocomplete="off" />
        </div>
        <div style="width:160px;">
          <label class="form-label" for="grantDuration">Срок</label>
          <select id="grantDuration" class="form-select">
            <option value="month">+1 месяц</option>
            <option value="year">+1 год</option>
            <option value="lifetime">Бессрочно (50 лет)</option>
          </select>
        </div>
        <div>
          <button id="grantSubmitBtn" type="submit" class="btn-primary" style="background:#d97706; padding:10px 18px;">
            ✓ Выдать Pro
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

      function renderUserRows(users) {
        const tbody = document.getElementById('adminUsersBody');
        if (!tbody) return;
        if (!users || users.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#64748b;">Пользователи не найдены</td></tr>';
          return;
        }
        tbody.innerHTML = users.map(u => {
          const isPro = u.plan_tier === 'pro';
          const endDate = u.current_period_end > 0 
            ? new Date(u.current_period_end * 1000).toLocaleDateString('ru-RU')
            : '—';
          const badge = isPro 
            ? '<span class="badge" style="background:#1e3a5f; color:#38bdf8; border:1px solid #0284c7;">PRO</span>'
            : '<span class="badge badge-offline">FREE</span>';
          return \`
            <tr>
              <td>
                <div style="font-weight:600; color:#f8fafc;">\${u.email}</div>
                <div style="font-size:12px; color:#64748b;">\${u.name || '—'}</div>
              </td>
              <td>\${badge}</td>
              <td style="color:#94a3b8; font-size:13px;">до \${u.max_devices} хостов</td>
              <td style="color:#cbd5e1; font-size:13px;">\${endDate}</td>
              <td style="text-align:right;">
                \${isPro ? \`
                  <button onclick="revokeAdminLicense('\${u.email}')" class="btn-danger-sm" title="Сбросить на Free">Отозвать</button>
                \` : \`
                  <button onclick="quickGrant('\${u.email}', 'month')" class="btn-secondary" style="padding:3px 8px; font-size:12px; border-color:#0284c7; color:#38bdf8;">+1 мес Pro</button>
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

      async function submitAdminGrant(e) {
        e.preventDefault();
        const email = document.getElementById('grantEmail').value.trim();
        const duration = document.getElementById('grantDuration').value;
        const msgDiv = document.getElementById('grantMsg');
        const btn = document.getElementById('grantSubmitBtn');
        btn.disabled = true;

        try {
          const res = await fetch('/api/v1/admin/license/grant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, duration })
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
        if (!confirm('Отозвать лицензию Pro у ' + email + ' и сбросить на Free?')) return;
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

      window.addEventListener('DOMContentLoaded', () => {
        loadAdminUsers();
      });
    </script>
  `;
}
