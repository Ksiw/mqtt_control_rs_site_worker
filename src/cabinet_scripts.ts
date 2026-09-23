export function renderCabinetScripts(currentWsId: string): string {
  return `
    <script>
      let currentWorkspaceId = '${currentWsId}';
      let createdDeviceKey = '';
      let activePairCode = '';

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

              if (data.has_limit_reached && data.existing_device) {
                document.getElementById('pairConflictBlock').style.display = 'block';
                document.getElementById('pairExistingName').textContent = data.existing_device.name;
                document.getElementById('pairExistingStatus').textContent = data.existing_device.is_online ? 'в сети' : 'не в сети';
                document.getElementById('pairTransfersUsed').textContent = data.transfers_used;

                document.getElementById('pairStandardActions').style.display = 'none';
                document.getElementById('pairConflictActions').style.display = 'flex';

                const transferBtn = document.getElementById('pairTransferBtn');
                if (data.can_transfer) {
                  transferBtn.disabled = false;
                  transferBtn.textContent = '🔄 Перенести привязку на этот компьютер';
                } else {
                  transferBtn.disabled = true;
                  transferBtn.textContent = 'Лимит переносов исчерпан (4 из 4 за 30 дн.)';
                  transferBtn.style.opacity = '0.5';
                  transferBtn.style.cursor = 'not-allowed';
                }

                if (data.can_trial) {
                  document.getElementById('pairTrialBtn').style.display = 'block';
                } else {
                  document.getElementById('pairTrialBtn').style.display = 'none';
                }
              } else {
                document.getElementById('pairConflictBlock').style.display = 'none';
                document.getElementById('pairStandardActions').style.display = 'flex';
                document.getElementById('pairConflictActions').style.display = 'none';
              }

              document.getElementById('pairApproveModal').style.display = 'flex';
            }
          } catch (err) {}
        }
      });

      async function confirmPairing(action = 'standard') {
        const errDiv = document.getElementById('pairError');
        errDiv.style.display = 'none';

        let btn = document.getElementById('pairApproveBtn');
        if (action === 'transfer') {
          btn = document.getElementById('pairTransferBtn');
        } else if (action === 'trial') {
          btn = document.getElementById('pairTrialBtn');
        }

        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Обработка...';

        try {
          const res = await fetch('/api/v1/pair/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: activePairCode, action: action })
          });
          const data = await res.json();
          if (data.status === 'ok') {
            alert(data.message || 'Хост-программа успешно привязана!');
            window.location.href = '/cabinet';
          } else {
            errDiv.textContent = data.message || 'Ошибка подтверждения';
            errDiv.style.display = 'block';
            btn.disabled = false;
            btn.textContent = originalText;
          }
        } catch (e) {
          errDiv.textContent = 'Сетевая ошибка';
          errDiv.style.display = 'block';
          btn.disabled = false;
          btn.textContent = originalText;
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
            errDiv.textContent = data.message || 'Ошибка добавления хоста';
            errDiv.style.display = 'block';
          }
        } catch (err) {
          errDiv.textContent = 'Сетевая ошибка при добавлении хоста';
          errDiv.style.display = 'block';
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Добавить хост';
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
  `;
}
