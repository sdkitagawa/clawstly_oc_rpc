// Usage display helpers.
//
// This fork intentionally does NOT poll Anthropic usage endpoints or read any
// provider credentials. The service is disabled by default and no network/token
// access exists here. The exported no-ops keep template/dashboard callers safe.

export const USAGE_STALE_MS = 30 * 60 * 1000;

export function readUsageCache() {
  return null;
}

export async function pollUsage() {
  return { ok: false, reason: 'disabled' };
}

export function fetchUsage() {
  return Promise.resolve({ ok: false, reason: 'disabled' });
}

export function writeUsageCache() {}

export function normalizeUsage() {
  return null;
}

export function fmtResetTime(iso) {
  const d = new Date(iso || NaN);
  if (isNaN(d)) return '';
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
}

export function fmtResetDay(iso, now = new Date()) {
  const d = new Date(iso || NaN);
  if (isNaN(d)) return '';
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((that - today) / 86_400_000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}
