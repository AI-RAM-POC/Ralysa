// Shared helper: lint a CSS snippet with the real @ralysa/stylelint-config.
import stylelint from 'stylelint';
import config from '../index.js';

export interface Warning {
  rule: string;
  text: string;
}

export async function lintCss(
  code: string,
  codeFilename = 'src/styles/fixture.css',
): Promise<Warning[]> {
  const { results } = await stylelint.lint({ code, config, codeFilename });
  return results.flatMap((result) =>
    result.warnings.map((warning) => ({ rule: warning.rule, text: warning.text })),
  );
}

export async function rulesFor(code: string, codeFilename?: string): Promise<string[]> {
  return (await lintCss(code, codeFilename)).map((warning) => warning.rule);
}
