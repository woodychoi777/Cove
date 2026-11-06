import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Preserve the approved SVG's geometry, blue and rounded white tile.
// Native macOS icons need transparent corners and canvas margin, unlike PWA PNGs.
export async function renderMacIcon(root, build) {
  const original = await readFile(join(root, 'public/icons/soriseojae-app-v4.svg'), 'utf8');
  const artwork = original.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g transform="translate(48 48) scale(0.8125)">${artwork}</g></svg>`;
  const iconset = join(build, 'Cove.iconset');
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    const png = new Resvg(svg, { font: { loadSystemFonts: false }, fitTo: { mode: 'width', value: size * scale } }).render().asPng();
    await writeFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), png);
    if (size === 512 && scale === 2) await writeFile(join(build, 'CoveDock.png'), png);
  }
  return iconset;
}
