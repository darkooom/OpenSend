import { domainToASCII } from 'node:url';

/** Reserved names (RFC 2606 / RFC 6761) that can never receive real mail. */
const LOCAL_ONLY_SUFFIXES = ['.test', '.localhost', '.invalid', '.example', '.local'];
const LOCAL_ONLY_EXACT = ['localhost', 'example.com', 'example.net', 'example.org'];

export function isLocalOnlyDomain(name: string): boolean {
  return (
    LOCAL_ONLY_EXACT.includes(name) ||
    LOCAL_ONLY_EXACT.some((d) => name.endsWith(`.${d}`)) ||
    LOCAL_ONLY_SUFFIXES.some((s) => name.endsWith(s))
  );
}

/** Lower-case punycode form without trailing dot, or null when not a valid hostname. */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().replace(/\.$/, '');
  if (!trimmed || trimmed.length > 253 || /[\s/@:]/.test(trimmed)) return null;
  const ascii = domainToASCII(trimmed).toLowerCase();
  if (!ascii) return null;
  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  for (const l of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
  }
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null; // IP-looking
  return ascii;
}

export function domainOfAddress(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}
