/** Экранирование значения для текста и атрибутов HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** Строковый аргумент обработчика onclick внутри HTML-атрибута. */
export function htmlJsArg(value: unknown): string {
  return escapeHtml(JSON.stringify(String(value ?? '')));
}
