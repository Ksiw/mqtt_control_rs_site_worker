export type OperatorLanguage = 'ru' | 'en';

export function preferredOperatorLanguage(header: string | undefined): OperatorLanguage {
  let best: { language: OperatorLanguage; quality: number; order: number } | null = null;
  for (const [order, entry] of (header || '').split(',').entries()) {
    const [tag, ...parameters] = entry.trim().toLowerCase().split(';');
    const primary = tag.split('-')[0];
    if (primary !== 'ru' && primary !== 'en') continue;
    let quality = 1;
    const qualityParam = parameters.find((parameter) => parameter.trim().startsWith('q='));
    if (qualityParam) quality = Number(qualityParam.trim().slice(2));
    if (!Number.isFinite(quality) || quality <= 0 || quality > 1) continue;
    if (!best || quality > best.quality || (quality === best.quality && order < best.order)) {
      best = { language: primary, quality, order };
    }
  }
  return best?.language || 'ru';
}
