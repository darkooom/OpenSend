export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function relative(value: string | null | undefined): string {
  if (!value) return '—';
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  const abs = Math.abs(diff);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return fmt.format(-Math.round(diff), 'second');
  if (abs < 3600) return fmt.format(-Math.round(diff / 60), 'minute');
  if (abs < 86400) return fmt.format(-Math.round(diff / 3600), 'hour');
  return fmt.format(-Math.round(diff / 86400), 'day');
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
