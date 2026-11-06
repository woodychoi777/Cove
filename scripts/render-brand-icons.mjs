// Source geometry is shared with the in-app mark; PNGs are build-time assets only.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/render-brand-icons.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { icon } from '../public/icons.js';

const directory = fileURLToPath(new URL('../public/icons/', import.meta.url));
const mark = icon('cove-brand').match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1];
// Each approved path owns its 5/3 stroke or fill; do not add a global stroke.
const standalone = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-labelledby="title"><title id="title">Cove 헤드폰</title><style>:root{color:#244e79}@media(prefers-color-scheme:dark){:root{color:#9ebff5}}</style>${mark}</svg>`;
const app = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="title"><title id="title">Cove 헤드폰 앱 아이콘</title><rect width="512" height="512" rx="112" fill="#FFFFFF"/><g transform="translate(54 54) scale(4.2)" color="#244E79">${mark}</g></svg>`;
await mkdir(directory, {recursive:true});
await writeFile(`${directory}/soriseojae-mark-v4.svg`, standalone + '\n');
await writeFile(`${directory}/soriseojae-app-v4.svg`, app + '\n');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true,channel:'chrome'});
try {
  for (const [size, name, svg] of [[192,'app-v4-192',app],[512,'app-v4-512',app],[180,'apple-v4',app],[32,'favicon-v4',standalone]]) {
    const page = await browser.newPage({viewport:{width:size,height:size},deviceScaleFactor:1,colorScheme:'light'});
    await page.setContent(`<style>html,body{margin:0;background:${name.startsWith('favicon') ? 'transparent' : '#FFFFFF'}}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    await page.screenshot({path:`${directory}/soriseojae-${name}.png`,omitBackground:true});
    await page.close();
  }
} finally { await browser.close(); }
console.log('승인된 흰 배경·블루 헤드폰 SVG와 32/180/192/512px 아이콘 생성 완료');
