import { promises as dns } from 'node:dns';

/** Injectable DNS resolver (replaced by a fake in tests). */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
}

export const systemDnsResolver: DnsResolver = {
  async resolveTxt(name) {
    try {
      return (await dns.resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch (err) {
      if (['ENODATA', 'ENOTFOUND', 'ESERVFAIL'].includes((err as NodeJS.ErrnoException).code ?? ''))
        return [];
      throw err;
    }
  },
  async resolveCname(name) {
    try {
      return await dns.resolveCname(name);
    } catch (err) {
      if (['ENODATA', 'ENOTFOUND'].includes((err as NodeJS.ErrnoException).code ?? '')) return [];
      throw err;
    }
  },
};
