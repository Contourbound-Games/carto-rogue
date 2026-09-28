import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('offline play', () => {
  it('loads no resources from the network', () => {
    // The desktop build blocks every network request, and the web build should not depend on one either.
    const html = read('../index.html');
    const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).not.toMatch(/^(?:https?:)?\/\//i);
    expect(html).not.toMatch(/@import|url\(\s*['"]?(?:https?:)?\/\//i);
  });

  it('bundles the Galmuri9 web font from the galmuri package', () => {
    const css = read('../src/galmuri9.css');
    expect(css).toMatch(/font-family:\s*Galmuri9;/);
    const url = /url\('([^']+)'\)/.exec(css)?.[1];
    expect(url).toBe('../node_modules/galmuri/dist/Galmuri9.woff2');
    expect(fs.existsSync(fileURLToPath(new URL(`../src/${url}`, import.meta.url)))).toBe(true);
    expect(read('../index.html')).toContain('href="/src/galmuri9.css"');
  });
});
