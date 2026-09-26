/**
 * HTML-разметка диалоговых модальных окон личного кабинета
 */
export function renderCabinetModals(planPrices?: { month: number; year: number }): string {
  const pMonth = (planPrices?.month ?? 12.0).toFixed(2);
  const pYear = (planPrices?.year ?? 100.0).toFixed(2);
  return `
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

    <!-- Модальное окно создания хоста -->
    <div id="addDeviceModal" class="modal-overlay">
      <div class="modal-box">
        <div class="modal-title">Новая хост-программа</div>
        <form id="addDeviceForm" onsubmit="submitAddDevice(event)">
          <div class="form-group">
            <label class="form-label" for="deviceNameInput">Название хоста</label>
            <input id="deviceNameInput" class="form-input" type="text" placeholder="Домашний сервер" required autocomplete="off" />
          </div>

          <div id="addDeviceError" style="color: #f87171; font-size: 13px; margin-bottom: 12px; display: none;"></div>
          <div class="modal-actions">
            <button type="button" onclick="closeAddDeviceModal()" class="btn-secondary">Отмена</button>
            <button id="addDeviceSubmitBtn" type="submit" class="btn-primary">Добавить хост</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Модальное окно подтверждения связки хоста (Pairing) -->
    <div id="pairApproveModal" class="modal-overlay">
      <div class="modal-box" style="max-width: 480px;">
        <div class="modal-title" style="color:#38bdf8;">Запрос на привязку хоста</div>
        <p style="font-size: 13px; color: #94a3b8; line-height: 1.5; margin-bottom: 16px;">
          Хост-программа на вашем компьютере запрашивает привязку к этому аккаунту.
        </p>
        <div style="background:#0f1217; border:1px solid #283141; border-radius:8px; padding:14px; margin-bottom:16px; text-align:left; font-size:13px;">
          <div><strong>Новый хост:</strong> <span id="pairDeviceName">—</span></div>
          <div style="margin-top:4px;"><strong>Платформа:</strong> <span id="pairOsInfo">—</span></div>
          <div style="margin-top:4px;"><strong>Код проверки:</strong> <span id="pairCodeDisplay" style="color:#38bdf8; font-weight:700;">—</span></div>
        </div>

        <div id="pairConflictBlock" style="display:none; background:#18181b; border:1px solid #713f12; border-radius:8px; padding:14px; margin-bottom:16px; text-align:left; font-size:13px;">
          <div style="color:#fbbf24; font-weight:600; margin-bottom:6px;">⚠ На бесплатном тарифе доступен 1 хост</div>
          <div style="color:#e4e4e7;">Сейчас подключен: <strong id="pairExistingName">—</strong> (<span id="pairExistingStatus">—</span>)</div>
          <div style="color:#a1a1aa; font-size:12px; margin-top:6px;">
            Переносов за последние 30 дней: <strong id="pairTransfersUsed">0</strong> из <strong>4</strong>.
          </div>
        </div>

        <div id="pairError" style="color:#f87171; font-size:13px; margin-bottom:12px; display:none;"></div>

        <div id="pairStandardActions" class="modal-actions">
          <button type="button" onclick="closePairModal()" class="btn-secondary">Отклонить</button>
          <button id="pairApproveBtn" type="button" onclick="confirmPairing('standard')" class="btn-primary">Подтвердить привязку</button>
        </div>

        <div id="pairConflictActions" class="modal-actions" style="display:none; flex-direction:column; gap:8px;">
          <button id="pairTransferBtn" type="button" onclick="confirmPairing('transfer')" class="btn-primary" style="background:#0284c7; width:100%; padding:10px;">🔄 Перенести привязку на этот компьютер</button>
          <button id="pairTrialBtn" type="button" onclick="confirmPairing('trial')" class="btn-primary" style="background:#7c3aed; width:100%; padding:10px; display:none;">✨ Оставить оба (Включить 60 дней Pro)</button>
          <button type="button" onclick="closePairModal()" class="btn-secondary" style="width:100%; margin-top:4px;">Отмена</button>
        </div>
      </div>
    </div>

    <!-- Модальное окно с созданным ключом -->
    <div id="keySuccessModal" class="modal-overlay">
      <div class="modal-box" style="max-width: 480px;">
        <div class="modal-title" style="color:#4ade80;">✓ Хост добавлен</div>
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

    <!-- Модальное окно оформления Pro подписки -->
    <div id="proModal" class="modal-overlay">
      <div class="modal-box" style="max-width: 480px;">
        <div class="modal-title" style="display:flex; align-items:center; justify-content:space-between;">
          <span>⭐ Тариф MQTT Control RS Pro</span>
          <button onclick="closeProModal()" style="background:none; border:none; color:#64748b; font-size:18px; cursor:pointer;">✕</button>
        </div>
        <p style="font-size: 13px; color: #94a3b8; margin-bottom: 18px; line-height: 1.5; text-align: left;">
          Тариф Pro расширяет возможности: до 10 хост-программ, до 50 дашбордов и до 15 членов семьи / операторов.
        </p>
        
        <div style="display:flex; flex-direction:column; gap:12px; margin-bottom: 20px;">
          <label style="display:flex; align-items:center; justify-content:space-between; background:#0f1217; border:1px solid #334155; padding:14px; border-radius:8px; cursor:pointer;">
            <div>
              <input type="radio" name="pro_period" value="month" checked style="margin-right:8px;">
              <span style="font-weight:600; color:#f8fafc;">1 месяц</span>
            </div>
            <span style="font-weight:700; color:#38bdf8;">$${pMonth}</span>
          </label>

          <label style="display:flex; align-items:center; justify-content:space-between; background:#0f1217; border:1px solid #0284c7; padding:14px; border-radius:8px; cursor:pointer;">
            <div>
              <input type="radio" name="pro_period" value="year" style="margin-right:8px;">
              <span style="font-weight:600; color:#f8fafc;">1 год</span>
              <span style="background:#0369a1; color:#e0f2fe; font-size:11px; padding:2px 6px; border-radius:4px; margin-left:6px;">Выгодный</span>
            </div>
            <span style="font-weight:700; color:#38bdf8;">$${pYear}</span>
          </label>
        </div>

        <div style="background:#131b29; border:1px solid #1e293b; border-radius:6px; padding:12px; font-size:12px; color:#94a3b8; margin-bottom:20px; text-align: left;">
          Оплата в криптовалюте <strong>USDT / USDC</strong> (сети TRON, Polygon, TON, Ethereum) или банковской картой через шлюз <strong>NOWPayments</strong>.
        </div>

        <div id="proModalError" style="color:#ef4444; font-size:13px; margin-bottom:12px; display:none; text-align:left;"></div>

        <div class="modal-actions" style="justify-content:space-between;">
          <button type="button" onclick="closeProModal()" class="btn-secondary">Отмена</button>
          <button type="button" id="proPayBtn" onclick="submitProPayment()" class="btn-primary" style="background:#0284c7;">Перейти к оплате ↗</button>
        </div>
      </div>
    </div>
  `;
}
