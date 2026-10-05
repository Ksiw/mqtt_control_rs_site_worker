import { escapeHtml } from '../html';
import { OPERATOR_LOCALES, OperatorStrings } from './locales';
import { OPERATOR_CSS_PATH, OPERATOR_JS_PATH } from './assets';

export interface OperatorPageConfig {
  title?: string;
  lang?: string;
  enterpriseMode?: boolean;
  dashboardId?: string;
}

export function escapeJsonForHtml(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export function renderOperatorDashboardPage(options: OperatorPageConfig = {}): string {
  const lang = options.lang && OPERATOR_LOCALES[options.lang] ? options.lang : 'ru';
  const strings: OperatorStrings = OPERATOR_LOCALES[lang] || OPERATOR_LOCALES.ru;
  const title = options.title || strings.title;
  const enterpriseMode = !!options.enterpriseMode;

  const pageConfig = {
    ...strings,
    title,
    lang,
    enterprise_mode: enterpriseMode,
    dashboard_id: options.dashboardId || null,
  };

  const toolbar = enterpriseMode
    ? `<div class="toolbar">
        <div id="enterpriseLogin" class="auth-fields">
          <input id="login" type="text" autocomplete="username" placeholder="${escapeHtml(strings.login_label)}">
          <input id="password" type="password" autocomplete="current-password" placeholder="${escapeHtml(strings.password_label)}">
          <button id="signIn" class="primary">${escapeHtml(strings.sign_in_text)}</button>
        </div>
        <div id="enterpriseSession" class="auth-session" hidden>
          <span id="sessionIdentity" class="session-identity">${escapeHtml(strings.session_active_text)}</span>
          <button id="signOut" class="ghost">${escapeHtml(strings.sign_out_text)}</button>
        </div>
      </div>`
    : '';

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${OPERATOR_CSS_PATH}">
</head>
<body>
<div class="shell">
  ${toolbar}
  <div id="status" class="status"></div>

  <section class="panel" id="dashboardPanel">
    <div class="panel-head">
      <div class="panel-title">${escapeHtml(strings.dashboard_label)}</div>
      <div class="subtle" id="dashboardCount"></div>
    </div>
    <div class="dashboard-picker" id="dashboardPicker">
      <button id="dashboardTrigger" class="dashboard-trigger ghost small" type="button"></button>
      <div id="dashboardMenu" class="dashboard-menu"></div>
    </div>
  </section>

  <main id="controls" class="controls"></main>
</div>
<script type="application/json" id="operatorConfig">${escapeJsonForHtml(pageConfig)}</script>
<script src="${OPERATOR_JS_PATH}"></script>
</body>
</html>`;
}

export function renderOperatorUnavailablePage(lang: 'ru' | 'en'): string {
  const strings = OPERATOR_LOCALES[lang];
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(strings.title)}</title>
<link rel="stylesheet" href="${OPERATOR_CSS_PATH}">
</head>
<body><div class="shell"><div class="status error">${escapeHtml(strings.device_offline_text)}</div></div></body>
</html>`;
}
