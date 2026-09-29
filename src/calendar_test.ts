import { addCalendarMonths, addCalendarYears, calculateNextPeriodEnd } from './calendar';

function runTests() {
  // Тест 1: 10-е число остается 10-м числом
  // 10 января 2026 12:00 UTC
  const jan10 = Math.floor(new Date('2026-01-10T12:00:00Z').getTime() / 1000);
  const feb10 = addCalendarMonths(jan10, 1);
  const feb10Date = new Date(feb10 * 1000);
  console.assert(feb10Date.getUTCDate() === 10, `Ожидалось 10 февраля, получено: ${feb10Date.toISOString()}`);
  console.assert(feb10Date.getUTCMonth() === 1, `Ожидался февраль (1), получено: ${feb10Date.getUTCMonth()}`);

  // Тест 2: Из февраля в март - 10 марта
  const mar10 = addCalendarMonths(feb10, 1);
  const mar10Date = new Date(mar10 * 1000);
  console.assert(mar10Date.getUTCDate() === 10, `Ожидалось 10 марта, получено: ${mar10Date.toISOString()}`);

  // Тест 3: 31 января -> последний день февраля (28 февраля)
  const jan31 = Math.floor(new Date('2026-01-31T12:00:00Z').getTime() / 1000);
  const febLast = addCalendarMonths(jan31, 1);
  const febLastDate = new Date(febLast * 1000);
  console.assert(febLastDate.getUTCDate() === 28, `Ожидалось 28 февраля, получено: ${febLastDate.toISOString()}`);

  // Тест 4: Год вперед
  const yearLater = addCalendarYears(jan10, 1);
  const yearLaterDate = new Date(yearLater * 1000);
  console.assert(yearLaterDate.getUTCFullYear() === 2027 && yearLaterDate.getUTCDate() === 10, 'Год вперед');

  // Тест 5: Продление за 10 дней до окончания (остаток не сгорает, число сохраняется)
  // Действует до 10 ноября, сегодня 1 ноября
  const nov10 = Math.floor(new Date('2026-11-10T12:00:00Z').getTime() / 1000);
  const nov01 = Math.floor(new Date('2026-11-01T12:00:00Z').getTime() / 1000);
  const nextEnd = calculateNextPeriodEnd(nov10, 'pro', false, nov01);
  const nextEndDate = new Date(nextEnd * 1000);
  console.assert(nextEndDate.getUTCDate() === 10 && nextEndDate.getUTCMonth() === 11, `Ожидалось 10 декабря, получено: ${nextEndDate.toISOString()}`);

  console.log('Все календарные тесты успешно пройдены!');
}

runTests();
