// Usage display helpers.
//
// This fork intentionally does NOT poll provider usage endpoints or read any
// provider credentials. The cache reader stays a no-op so daemon template vars
// remain empty; the reset-time formatters stay live for the template variables
// that consume them.

export function readUsageCache() {
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
