const PATTERNS: Array<[RegExp, string]> = [
  [
    /(authorization|password|pass|secret|token|apikey|api_key|access[_-]?key)(["'\s:=]+)([^\s"',;]+)/gi,
    '$1$2[redacted]',
  ],
  [/os_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{20,}/g, 'os_[redacted]'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA[redacted]'],
  [/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2'],
];

/** Removes credentials and masks email addresses in free-form error text before persisting/logging it. */
export function redact(input: string | undefined | null, maxLength = 500): string | null {
  if (input === undefined || input === null) return null;
  let out = String(input);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${address[0]}***@${address.slice(at + 1)}`;
}
