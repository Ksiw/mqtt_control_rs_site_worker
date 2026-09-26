/**
 * HTML-разметка блока супер-администратора (управление лицензиями)
 */
export function renderAdminSection(isSuperAdmin: boolean, planPrices?: { month: number; year: number }): string {
  if (!isSuperAdmin) return '';

  const curMonth = (planPrices?.month ?? 12.0).toFixed(2);
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
          <label class="form-label" for="priceMonthInput">1 месяц ($ USD)</label>
          <input id="priceMonthInput" class="form-input" type="number" step="0.5" min="1" value="${curMonth}" required />
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

      async function submitAdminPricing(e) {
        e.preventDefault();
        const month = parseFloat(document.getElementById('priceMonthInput').value);
        const year = parseFloat(document.getElementById('priceYearInput').value);
        const msgDiv = document.getElementById('pricingMsg');
        const btn = document.getElementById('priceSubmitBtn');
        btn.disabled = true;

        try {
          const res = await fetch('/api/v1/admin/pricing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ month, year })
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
