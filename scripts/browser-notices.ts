import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

const fileName = 'THIRD_PARTY_NOTICES.txt';
const source = new URL(`../src/web/public/${fileName}`, import.meta.url);
const header = 'Third-party license notices for the Spectral Risk Chimera browser distribution.\n';
const shimHeading =
  '## es-module-shims (MIT; code adapted in the modulepreload polyfill)\n' +
  'https://github.com/guybedford/es-module-shims/blob/1.0.0/LICENSE\n\n';
const shimHash = '13dc18f97f767475f7ad48fdd12a2e45be30fb309c604730f406f625cf7d8f7f';
const licenseFiles = new Map([
  ['decimal.js', 'LICENCE.md'],
  ['react', 'LICENSE'],
  ['react-dom', 'LICENSE'],
  ['rolldown', 'LICENSE'],
  ['scheduler', 'LICENSE'],
  ['vite', 'LICENSE.md'],
  ['zod', 'LICENSE'],
]);

function packageNotice(root: string): { name: string; text: string } {
  const { name, version, license } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license?: string;
  };
  const file = licenseFiles.get(name);
  if (file === undefined || license !== 'MIT') {
    throw new Error(
      `Review browser redistribution terms for ${name}@${version} (${license ?? 'unknown license'}).`,
    );
  }
  let text = readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n');
  if (name === 'vite') {
    // Only Vite's own polyfill code ships, not the dependencies in the Vite npm distribution.
    const end = text.indexOf('\n# Licenses of bundled dependencies\n');
    if (end === -1) throw new Error('Review the Vite core license section.');
    text = text.slice(0, end);
  }
  if (name === 'rolldown') {
    text += '\nUpstream third-party notices for derived code (THIRD-PARTY-LICENSE)\n\n';
    text += readFileSync(join(root, 'THIRD-PARTY-LICENSE'), 'utf8').replaceAll('\r\n', '\n');
  }
  return { name, text: `## ${name}@${version} (${license})\n\n${text}` };
}

/** Fail builds when the rendered graph, upstream texts, or delivered file no longer match. */
export function browserNotices(): Plugin {
  return {
    name: 'browser-license-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const vite = createRequire(import.meta.url).resolve('vite/package.json');
      const rolldown = createRequire(vite).resolve('rolldown/package.json');
      const roots = new Set<string>();
      let includesShim = false;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const [id, { renderedLength }] of Object.entries(chunk.modules)) {
          const packageRoot = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(id)?.[1];
          if (packageRoot !== undefined) roots.add(packageRoot);
          if (!id.startsWith('\0') || renderedLength === 0) continue;
          if (id === '\0rolldown/runtime.js') roots.add(dirname(rolldown));
          else if (id === '\0vite/modulepreload-polyfill.js') {
            roots.add(dirname(vite));
            roots.add(dirname(rolldown));
            includesShim = true;
          } else this.error(`Review browser redistribution terms for generated module ${id.slice(1)}.`);
        }
      }

      const packages = [...roots]
        .map((root) => packageNotice(root))
        .sort((a, b) => a.name.localeCompare(b.name));
      const installedNotices = header + '\n' + packages.map(({ text }) => text).join('\n\n') + '\n\n';
      const notices = readFileSync(source, 'utf8');
      const prefix = installedNotices + (includesShim ? shimHeading : '');
      const shimText = notices.slice(prefix.length);
      const matchesShim = includesShim
        ? createHash('sha256').update(shimText).digest('hex') === shimHash
        : shimText === '';
      if (!notices.startsWith(prefix) || !matchesShim) {
        this.error(`${fileName} must match the full notices for the rendered browser dependencies.`);
      }
    },
    writeBundle({ dir }) {
      if (dir === undefined || !readFileSync(join(dir, fileName)).equals(readFileSync(source))) {
        this.error(`${fileName} was not copied intact to the browser distribution.`);
      }
    },
  };
}
