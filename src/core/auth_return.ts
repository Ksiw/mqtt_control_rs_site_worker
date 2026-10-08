export function safeAuthReturn(path: string): string | null {
  if (/^\/(?:ru|en)\/wiki(?:#article=[a-zA-Z0-9_-]{1,100})?$/.test(path)) return path;
  if (/^\/view\/device\/mcrs_live_[a-f0-9]{6}\/\d+$/.test(path)) return path;
  if (/^\/view\/[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_-]{1,150}$/.test(path)) {
    return path;
  }
  return null;
}
