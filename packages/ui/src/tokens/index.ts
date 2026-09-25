// Typed access to the design tokens (F-001 design §7.1). Components style themselves with the
// Tailwind classes from dist/css/theme.css; tokenVar() is for the rare inline or computed case.
import { TOKEN_CSS_VARS, TOKEN_THEMES, type TokenName } from './generated.js';

export { TOKEN_CSS_VARS, TOKEN_THEMES, type TokenName };
export type TokenTheme = (typeof TOKEN_THEMES)[number];

/** `tokenVar('color.bg.canvas')` → `var(--ralysa-color-bg-canvas)`. */
export function tokenVar(name: TokenName): string {
  return `var(${TOKEN_CSS_VARS[name]})`;
}
