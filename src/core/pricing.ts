/** Получить системные цены подписки. */
export async function getPlanPrices(db: D1Database, strict = false): Promise<{ month: number; year: number }> {
  try {
    const rows = await db.prepare(
      "SELECT key, value FROM system_settings WHERE key IN ('price_month_usd', 'price_year_usd')"
    ).all<{ key: string; value: string }>();

    let month = 12.0;
    let year = 100.0;

    for (const r of rows.results || []) {
      if (r.key === 'price_month_usd') {
        const val = Number(r.value);
        if (Number.isFinite(val) && val >= 0.01 && val <= 1000000) month = val;
        else if (strict) throw new Error('Invalid monthly subscription price');
      } else if (r.key === 'price_year_usd') {
        const val = Number(r.value);
        if (Number.isFinite(val) && val >= 0.01 && val <= 1000000) year = val;
        else if (strict) throw new Error('Invalid annual subscription price');
      }
    }
    return { month, year };
  } catch (error) {
    if (strict) throw error;
    return { month: 12.0, year: 100.0 };
  }
}
