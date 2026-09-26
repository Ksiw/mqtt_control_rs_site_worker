import { Device, Organization, User, Workspace } from './types';
import { renderCabinetScripts } from './cabinet_scripts';
import { renderCabinetModals } from './cabinet_modals';
import { renderAdminSection, renderAdminScripts } from './admin_view';
export { renderLoginHtml } from './login_view';

function renderDashCard(d: any): string {
  const dashUrl = `/view/${d.org_slug}/${d.ws_slug}/${d.id}${d.slug && d.slug.includes('?') ? '?' + d.slug.split('?')[1] : ''}`;
  const isOnline = d.is_online === 1;
  return `
    <div class="dash-card"${isOnline ? '' : ' style="opacity: 0.65;"'}>
      <div>
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          ${isOnline 
            ? '<span class="badge badge-online"><span class="dot"></span> Доступен</span>' 
            : '<span class="badge badge-offline"><span class="dot"></span> Хост не в сети</span>'}
          <span class="dash-meta">${d.ws_slug}</span>
        </div>
        <div class="dash-name">${d.name}</div>
      </div>
      <div style="display:flex; gap:8px;">
        ${isOnline ? `
          <a href="${dashUrl}" target="_blank" class="btn-open" style="flex:1;">Открыть дашборд ↗</a>
          <button onclick="showQr('${dashUrl}', '${d.name.replace(/'/g, "\\'")}')" class="btn-secondary" title="QR-код для смартфона">📱 QR</button>
        ` : `
          <span class="btn-secondary" style="opacity:0.6; cursor:not-allowed; flex:1; text-align:center; padding:8px 0;">Хост не в сети</span>
        `}
      </div>
    </div>
  `;
}

function renderHostSection(dev: Device, devDashboards: any[]): string {
  const onlineBadge = dev.is_online === 1
    ? '<span class="badge badge-online"><span class="dot"></span> Онлайн</span>'
    : '<span class="badge badge-offline"><span class="dot"></span> Оффлайн</span>';

  return `
    <div class="card" style="margin-bottom: 20px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #1e2430; flex-wrap:wrap; gap:8px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="font-size:18px;">🖥️</span>
          <span style="font-size:16px; font-weight:600; color:#f8fafc;">${dev.name}</span>
          ${dev.app_version ? `<span style="font-size:12px; color:#64748b;">v${dev.app_version}</span>` : ''}
        </div>
        <div>${onlineBadge}</div>
      </div>
      ${devDashboards.length > 0 ? `
        <div class="grid">
          ${devDashboards.map(renderDashCard).join('')}
        </div>
      ` : `
        <div class="empty-state" style="padding:16px;">
          На этом хосте пока нет опубликованных дашбордов. В окне программы «Сервер» включите синхронизацию дашбордов.
        </div>
      `}
    </div>
  `;
}

function renderUnassignedDashboards(dashboards: any[], devices: Device[]): string {
  if (devices.length <= 1) return '';
  const unassigned = dashboards.filter(d => !devices.some(dev => dev.id === d.device_id));
  if (unassigned.length === 0) return '';
  return `
    <div class="card" style="margin-bottom: 20px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #1e2430;">
        <span style="font-size:15px; font-weight:600; color:#94a3b8;">📦 Прочие дашборды</span>
      </div>
      <div class="grid">
        ${unassigned.map(renderDashCard).join('')}
      </div>
    </div>
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
  isSuperAdmin?: boolean;
  isTrial?: boolean;
  daysLeft?: number;
  paymentNotification?: string;
  planPrices?: { month: number; year: number };
}

export function renderCabinetHtml(props: CabinetViewProps): string {
  const { user, currentOrg, workspaces, devices, dashboards, members, pendingInvites, planTier, maxDevices, maxMembers, isOwner, isSuperAdmin, isTrial, daysLeft, paymentNotification, planPrices } = props;
  const currentWsId = workspaces[0]?.id || '';
  const totalAccounts = members.length + pendingInvites.length;
  const canAddDevice = devices.length < maxDevices && isOwner;
  const canInvite = totalAccounts < maxMembers && isOwner;

  let tierBadge = `<span class="tier-badge">Тариф: Семья (бесплатный) · 1 хост · до 5 аккаунтов</span>`;
  if (!isOwner) {
    tierBadge = `<span class="tier-badge">Пользователь</span>`;
  } else if (isTrial) {
    tierBadge = `<span class="tier-badge" style="background:#2d1b06; border-color:#d97706; color:#fbbf24;">🔥 Тариф Pro (Пробный период: осталось ${daysLeft ?? 60} дн.) · до 5 хостов</span>`;
  } else if (planTier === 'pro') {
    tierBadge = `<span class="tier-badge" style="background:#1e3a5f; border-color:#0284c7; color:#38bdf8;">★ Тариф Pro (активен) · до 10 хостов</span>`;
  }

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
          ${tierBadge}
          ${isOwner ? `<button type="button" onclick="openProModal()" style="background:linear-gradient(135deg, #0284c7, #2563eb); color:#fff; border:none; padding:6px 14px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">${planTier === 'pro' && !isTrial ? '★ Продлить Pro' : '🔥 Оформить Pro'}</button>` : ''}
          <span class="user-email">${user.name || user.email}</span>
          <a href="/auth/logout" class="btn-logout">Выйти</a>
        </div>
      </div>

      <div class="container">
        ${paymentNotification ? `
          <div style="background:#064e3b; border:1px solid #059669; color:#34d399; padding:14px 20px; border-radius:8px; margin-bottom:24px; font-size:14px; display:flex; align-items:center; justify-content:space-between;">
            <span>${paymentNotification}</span>
            <button onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:#34d399; font-size:16px; cursor:pointer;">✕</button>
          </div>
        ` : ''}

        <!-- Блок Дашборды по хостам -->
        <div class="section-title">
          <span>Дашборды</span>
        </div>

        ${devices.length === 0 ? `
          <div class="card">
            <div class="empty-state">
              Пока нет подключённых хост-программ и дашбордов.<br>
              ${isOwner 
                ? 'Чтобы добавить дашборды, подключите хост-программу в блоке ниже или нажмите «+ Добавить хост».' 
                : 'Владелец пространства пока не включил синхронизацию хоста.'}
            </div>
          </div>
        ` : `
          ${devices.map(dev => {
            const devDashboards = dashboards.filter(d => d.device_id === dev.id || (!d.device_id && devices.length === 1));
            return renderHostSection(dev, devDashboards);
          }).join('')}
          ${renderUnassignedDashboards(dashboards, devices)}
        `}

        ${isOwner ? `
          <!-- Блок Хост-программы (доступен только владельцу) -->
          <div class="section-title">
            <span>Хост-программы (серверы автоматики: ${devices.length} из ${maxDevices})</span>
            ${canAddDevice ? `
              <button class="btn-secondary" onclick="openAddDeviceModal('${currentWsId}')">+ Добавить хост</button>
            ` : `
              <span style="font-size:12px; color:#94a3b8;">Лимит слотов (${maxDevices}) заполнен</span>
            `}
          </div>

          <div class="card" style="padding:0; overflow:hidden;">
            ${devices.length === 0 ? `
              <div class="empty-state">
                Нет подключённых хост-программ. В окне программы «Сервер» нажмите «Привязать через браузер» или используйте «+ Добавить хост».
              </div>
            ` : `
              <table>
                <thead>
                  <tr>
                    <th>Хост-программа</th>
                    <th>Статус</th>
                    <th>Версия</th>
                    ${isOwner ? '<th style="text-align:right;">Действие</th>' : ''}
                  </tr>
                </thead>
                <tbody>
                  ${devices.map(dev => `
                    <tr>
                      <td style="font-weight:500;">${dev.name}</td>
                      <td>
                        ${dev.is_online === 1 
                          ? '<span class="badge badge-online"><span class="dot"></span> Онлайн</span>' 
                          : '<span class="badge badge-offline"><span class="dot"></span> Оффлайн</span>'}
                      </td>
                      <td style="color:#64748b;">${dev.app_version || '—'}</td>
                      ${isOwner ? `
                        <td style="text-align:right;">
                          <button onclick="removeDevice('${dev.id}', '${dev.name.replace(/'/g, "\\'")}')" class="btn-danger-sm">Удалить</button>
                        </td>
                      ` : ''}
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `}
          </div>
        ` : ''}

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
                    ${m.email}
                  </td>
                  <td><span style="font-size:12px; color:#94a3b8;">${m.is_owner ? 'Администратор' : 'Пользователь'}</span></td>
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
                  <td><span style="font-size:12px; color:#94a3b8;">Пользователь</span></td>
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

        <!-- Панель супер-администратора (если есть права) -->
        ${renderAdminSection(Boolean(isSuperAdmin), planPrices)}

        <div style="text-align:center; padding:20px 0 8px; font-size:12px; color:#475569;">
          MQTT Control RS Cloud Hub · v1.2.0
        </div>
      </div>

      ${renderCabinetModals(planPrices)}

      ${renderCabinetScripts(currentWsId)}
      ${renderAdminScripts(Boolean(isSuperAdmin))}
    </body>
    </html>
  `;
}
