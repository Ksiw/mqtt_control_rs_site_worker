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
