// Joins class names, dropping falsy parts. Named `cn` so the Tailwind lint rules check every
// class string passed to it (better-tailwindcss's default callees; F-001 design §7.3.3).
export type ClassPart = string | false | null | undefined;

export function cn(...parts: ClassPart[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}
