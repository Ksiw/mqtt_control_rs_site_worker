import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(__dirname, '..');
const appRoot = resolve(workerRoot, '../mqtt_control_rs');
const uiDir = resolve(appRoot, 'src/ui');
const localesDir = resolve(appRoot, 'locales');

const isCheck = process.argv.includes('--check');

const CSS_FILES = [
  'operator_web_page_style_common.css',
  'operator_web_auth.css',
  'operator_web_widget_toggle.css',
  'operator_web_widget_machine.css',
  'operator_web_widget_fan.css',
  'operator_web_widget_lamp.css',
  'operator_web_widget_slider.css',
  'operator_web_widget_meter.css',
  'operator_web_widget_gauge.css',
  'operator_web_widget_level.css',
  'operator_web_widget_gate.css',
  'operator_web_widget_segment.css',
  'operator_web_widget_textdisplay.css',
  'operator_web_widget_textinput.css',
  'operator_web_widget_generic.css',
];

const JS_FILES = [
  'operator_web_chart_geometry.js',
  'operator_web_chart.js',
  'operator_web_widget_helpers.js',
  'operator_web_widget_render.js',
  'operator_web_widget_interactions.js',
  'operator_web_auth.js',
  'operator_web_script.js',
];

const KEY_MAPPING = {
  operator_window_title: 'title',
  operator_window_no_controls: 'no_controls_text',
  operator_web_dashboard_label: 'dashboard_label',
  operator_web_no_dashboards_text: 'no_dashboards_text',
  operator_web_device_offline_text: 'device_offline_text',
  operator_web_token_label: 'token_label',
  operator_web_value_placeholder: 'value_placeholder',
  operator_web_save_button: 'save_button_text',
  operator_web_refresh_button: 'refresh_button_text',
  operator_web_loading_text: 'loading_text',
  operator_web_pending_text: 'pending_text',
  operator_web_log_text: 'log_text',
  operator_web_last_text: 'last_text',
  operator_web_on_text: 'on_text',
  operator_web_off_text: 'off_text',
  operator_web_open_text: 'open_text',
  operator_web_closed_text: 'closed_text',
  operator_web_transit_text: 'transit_text',
  operator_web_login_label: 'login_label',
  operator_web_password_label: 'password_label',
  operator_web_sign_in_button: 'sign_in_text',
  operator_web_sign_out_button: 'sign_out_text',
  operator_web_session_active_text: 'session_active_text',
  operator_web_login_required_text: 'login_required_text',
  operator_web_login_failed_text: 'login_failed_text',
};

// 1. Prepare CSS
const cssContent = CSS_FILES.map((f) => readFileSync(resolve(uiDir, f), 'utf-8')).join('\n');
const cssHash = createHash('sha256').update(cssContent).digest('hex').slice(0, 16);
const stylesTs = `// Автоматически сформировано скриптом scripts/sync-operator-assets.mjs\nexport const OPERATOR_CSS = ${JSON.stringify(cssContent)};\n`;

// 2. Prepare JS
const jsContent = JS_FILES.map((f) => readFileSync(resolve(uiDir, f), 'utf-8')).join('\n');
const jsHash = createHash('sha256').update(jsContent).digest('hex').slice(0, 16);
const scriptsTs = `// Автоматически сформировано скриптом scripts/sync-operator-assets.mjs\nexport const OPERATOR_JS = ${JSON.stringify(jsContent)};\n`;

// 3. Prepare Locales
const locales = {};
for (const lang of ['ru', 'en']) {
  const json = JSON.parse(readFileSync(resolve(localesDir, `${lang}.json`), 'utf-8'));
  const strings = {};
  for (const [sourceKey, targetKey] of Object.entries(KEY_MAPPING)) {
    strings[targetKey] = json[sourceKey] || '';
  }
  locales[lang] = strings;
}

const localesTs = `// Автоматически сформировано скриптом scripts/sync-operator-assets.mjs
export interface OperatorStrings {
  title: string;
  no_controls_text: string;
  dashboard_label: string;
  no_dashboards_text: string;
  device_offline_text: string;
  token_label: string;
  value_placeholder: string;
  save_button_text: string;
  refresh_button_text: string;
  loading_text: string;
  pending_text: string;
  log_text: string;
  last_text: string;
  on_text: string;
  off_text: string;
  open_text: string;
  closed_text: string;
  transit_text: string;
  login_label: string;
  password_label: string;
  sign_in_text: string;
  sign_out_text: string;
  session_active_text: string;
  login_required_text: string;
  login_failed_text: string;
}

export const OPERATOR_LOCALES: Record<string, OperatorStrings> = ${JSON.stringify(locales, null, 2)};
`;

// 4. Prepare Assets
const assetsTs = `// Автоматически сформировано скриптом scripts/sync-operator-assets.mjs
export const OPERATOR_JS_HASH = '${jsHash}';
export const OPERATOR_CSS_HASH = '${cssHash}';
export const OPERATOR_JS_PATH = '/operator-static/operator.${jsHash}.js';
export const OPERATOR_CSS_PATH = '/operator-static/operator.${cssHash}.css';
`;

const targets = [
  { path: resolve(workerRoot, 'src/operator/styles.ts'), content: stylesTs, name: 'styles.ts' },
  { path: resolve(workerRoot, 'src/operator/scripts.ts'), content: scriptsTs, name: 'scripts.ts' },
  { path: resolve(workerRoot, 'src/operator/locales.ts'), content: localesTs, name: 'locales.ts' },
  { path: resolve(workerRoot, 'src/operator/assets.ts'), content: assetsTs, name: 'assets.ts' },
];

if (isCheck) {
  let hasDiff = false;
  for (const t of targets) {
    if (!existsSync(t.path)) {
      console.error(`Missing generated file: ${t.name}`);
      hasDiff = true;
      continue;
    }
    const current = readFileSync(t.path, 'utf-8');
    if (current !== t.content) {
      console.error(`Outdated generated file: ${t.name}`);
      hasDiff = true;
    }
  }
  if (hasDiff) {
    console.error('Operator assets are out of date! Run: npm run sync-assets');
    process.exit(1);
  }
  console.log('All operator assets are up to date.');
} else {
  for (const t of targets) {
    writeFileSync(t.path, t.content);
    console.log(`Synchronized ${t.name}`);
  }
}
