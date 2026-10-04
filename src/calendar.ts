/**
 * Календарные расчеты расчетных периодов подписки (без смещения числа месяца).
 */

/**
 * Прибавляет к UNIX timestamp (в секундах) заданное количество календарных месяцев.
 *
 * Сохраняет точное календарное число месяца (например, 10-е число остается 10-м числом
 * независимо от того, сколько дней в месяце — 28, 29, 30 или 31).
 * Если в целевом месяце меньше дней (например, 31 января -> февраль),
 * дата фиксируется на последнем дне целевого месяца (28 или 29 февраля).
 */
export function addCalendarMonths(fromUnixSeconds: number, months: number): number {
  const day = new Date(fromUnixSeconds * 1000).getUTCDate();
  return addCalendarMonthsOnDay(fromUnixSeconds, months, day);
}

/** Сохраняет исходный день оплаты при продлении после короткого месяца. */
export function addCalendarMonthsOnDay(fromUnixSeconds: number, months: number, anchorDay: number): number {
  const d = new Date(fromUnixSeconds * 1000);
  const targetMonth = d.getUTCMonth() + months;

  // Устанавливаем 1-е число месяца, чтобы избежать промежуточного переполнения
  d.setUTCDate(1);
  d.setUTCMonth(targetMonth);

  // Вычисляем максимальное число дней в полученном целевом месяце
  // d.getUTCFullYear() и d.getUTCMonth() + 1 с нулевым днем дают последний день целевого месяца
  const daysInTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

  // Возвращаем либо то же исходное число (например, 10), либо последний возможный день месяца
  d.setUTCDate(Math.min(anchorDay, daysInTargetMonth));

  return Math.floor(d.getTime() / 1000);
}

/**
 * Прибавляет к UNIX timestamp (в секундах) заданное количество календарных лет.
 */
export function addCalendarYears(fromUnixSeconds: number, years: number): number {
  return addCalendarMonths(fromUnixSeconds, years * 12);
}

/**
 * Рассчитывает новую дату окончания подписки при оплате.
 *
 * Если у пользователя уже активен тариф Pro и срок еще не истек,
 * остаток сохраняется, а календарный расчет производится от текущей даты окончания.
 * Если подписка новая, бесплатная или истекшая — отсчет начинается от текущего момента.
 */
export function calculateNextPeriodEnd(
  currentPeriodEnd: number | undefined | null,
  planTier: string | undefined | null,
  isYear: boolean,
  nowSeconds: number,
  billingAnchorDay?: number | null
): number {
  const hasActivePro = (planTier === 'pro') && currentPeriodEnd && currentPeriodEnd > nowSeconds;
  const baseTime = hasActivePro ? currentPeriodEnd : nowSeconds;
  const anchorDay = hasActivePro && billingAnchorDay && billingAnchorDay >= 1 && billingAnchorDay <= 31
    ? billingAnchorDay : new Date(baseTime * 1000).getUTCDate();

  return isYear
    ? addCalendarMonthsOnDay(baseTime, 12, anchorDay)
    : addCalendarMonthsOnDay(baseTime, 1, anchorDay);
}
