import Mustache from 'mustache';
import { z } from 'zod';

/**
 * Logic-less templates (Mustache). `{{var}}` is HTML-escaped in HTML bodies, `{{{var}}}`
 * is raw and therefore rejected for HTML templates to avoid accidental markup injection.
 */
export const templateVariableSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  required: z.boolean().default(true),
  /** Used for previews and when an optional variable is omitted. */
  sample: z.string().max(1000).optional(),
  fallback: z.string().max(1000).optional(),
});
export type TemplateVariable = z.infer<typeof templateVariableSchema>;
export type TemplateValues = Record<string, string | number | boolean | null>;

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Collect variable names referenced by a template (top level only; sections are allowed). */
export function referencedVariables(source: string): { names: Set<string>; raw: Set<string> } {
  const names = new Set<string>();
  const raw = new Set<string>();
  const walk = (tokens: unknown[]): void => {
    for (const t of tokens as Array<[string, string, number, number, unknown[]?]>) {
      const [type, value, , , children] = t;
      if (type === 'name' || type === '#' || type === '^') names.add(value);
      if (type === '&' || type === '{') {
        names.add(value);
        raw.add(value);
      }
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(Mustache.parse(source));
  return { names, raw };
}

export function validateTemplateSource(
  parts: { subject: string; html?: string | null; text?: string | null },
  variables: TemplateVariable[],
): void {
  const declared = new Set(variables.map((v) => v.name));
  for (const [field, src] of Object.entries(parts)) {
    if (!src) continue;
    let refs;
    try {
      refs = referencedVariables(src);
    } catch (err) {
      throw new TemplateError(`${field}: invalid template syntax`, {
        field,
        reason: (err as Error).message,
      });
    }
    if (field === 'html' && refs.raw.size > 0) {
      throw new TemplateError('html: unescaped variables ({{{ }}} / {{& }}) are not allowed', {
        variables: [...refs.raw],
      });
    }
    const undeclared = [...refs.names].filter((n) => !declared.has(n));
    if (undeclared.length > 0) {
      throw new TemplateError(`${field}: uses undeclared variables`, {
        field,
        variables: undeclared,
      });
    }
  }
}

export function resolveValues(
  variables: TemplateVariable[],
  provided: TemplateValues,
  mode: 'send' | 'preview',
): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  const declared = new Set(variables.map((v) => v.name));
  const unknown = Object.keys(provided).filter((k) => !declared.has(k));
  if (unknown.length > 0)
    throw new TemplateError('unknown template variables', { variables: unknown });
  for (const v of variables) {
    const value = provided[v.name];
    if (value !== undefined && value !== null) out[v.name] = String(value);
    else if (mode === 'preview') out[v.name] = v.sample ?? v.fallback ?? `[${v.name}]`;
    else if (v.fallback !== undefined) out[v.name] = v.fallback;
    else if (v.required) missing.push(v.name);
    else out[v.name] = '';
  }
  if (missing.length > 0)
    throw new TemplateError('missing required template variables', { variables: missing });
  return out;
}

export interface RenderedContent {
  subject: string;
  html: string | null;
  text: string | null;
}

export function renderTemplate(
  source: { subject: string; html?: string | null; text?: string | null },
  values: Record<string, string>,
): RenderedContent {
  const plain = (s: string) => Mustache.render(s, values, {}, { escape: (v: string) => v });
  const subject = plain(source.subject);
  if (/[\r\n]/.test(subject)) throw new TemplateError('rendered subject contains a line break');
  return {
    subject,
    html: source.html ? Mustache.render(source.html, values) : null,
    text: source.text ? plain(source.text) : null,
  };
}
