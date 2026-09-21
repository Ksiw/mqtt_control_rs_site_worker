// Криптографические утилиты для работы с Web Crypto API внутри Cloudflare Workers

/**
 * Вычисляет SHA-256 хеш от переданной строки и возвращает hex-представление
 */
export async function sha256Hex(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Проверяет подпись HMAC-SHA256 для запроса от настольного приложения
 */
export async function verifyHmacSha256(
  deviceKey: string,
  dataToSign: string,
  expectedSignatureHex: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(deviceKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // Преобразуем hex-строку подписи в байты
  const sigBytes = new Uint8Array(
    expectedSignatureHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );

  return await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    encoder.encode(dataToSign)
  );
}

/**
 * Создаёт подпись HMAC-SHA256
 */
export async function signHmacSha256(secret: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  return signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Генерирует криптографически стойкий случайный ключ устройства
 */
export function generateDeviceKey(): { prefix: string; fullKey: string } {
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const prefix = `mcrs_live_${hex.substring(0, 4)}`;
  const fullKey = `mcrs_live_${hex}`;
  return { prefix, fullKey };
}
