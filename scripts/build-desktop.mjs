import { cp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative } from 'node:path';
import { packager } from '@electron/packager';
import { renderMacIcon } from './render-mac-icon.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const preview = process.env.COVE_PREVIEW_BUILD === '1';
const appName = preview ? 'Cove Preview' : 'Cove';
const build = join(root, '.desktop-build'), source = join(build, 'source');
if (process.platform !== 'darwin') throw Error('Mac에서 실행해 주세요.');
await rm(build, { recursive: true, force: true });
await mkdir(join(source, 'desktop'), { recursive: true });
await Promise.all([
  cp(join(root, 'src'), join(source, 'src'), { recursive: true }),
  cp(join(root, 'public'), join(source, 'public'), { recursive: true }),
  ...['LICENSE', 'THIRD_PARTY_NOTICES.md'].map(file => cp(join(root, file), join(source, file))),
  ...['main.cjs', 'preload.cjs', 'library-location.cjs', 'alarm.cjs', 'wake.cjs', 'media-controls.cjs'].map(file => cp(join(root, 'desktop', file), join(source, 'desktop', file))),
  cp(join(root, 'desktop/package.json'), join(source, 'package.json'))
]);
if (preview) {
  const path = join(source, 'package.json');
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  metadata.name = 'cove-preview'; metadata.productName = appName;
  await writeFile(path, JSON.stringify(metadata, null, 2));
  const html = join(source, 'public/index.html');
  await writeFile(html, (await readFile(html, 'utf8')).replace('Cove · 음악과 기록을 내 서재에', `Cove Preview ${metadata.version} · 확인용`));
}
// Public builds choose a library on first launch; no developer path is bundled.
// Only production packages; never copy Electron tools, source music or the DB.
const { stdout } = await run('npm', ['ls', '--omit=dev', '--parseable', '--all'], { cwd: root });
for (const dependency of new Set(stdout.trim().split('\n').slice(1))) {
  const destination = relative(root, dependency);
  if (!destination.startsWith('node_modules/')) throw Error('프로젝트 밖의 의존성은 묶을 수 없습니다.');
  await cp(dependency, join(source, destination), { recursive: true });
}

await run('/usr/bin/clang', ['-fobjc-arc', '-Wno-deprecated-declarations', '-framework', 'Foundation', '-framework', 'Security', join(root, 'desktop/wake-authorize.m'), '-o', join(source, 'desktop/wake-authorize')]);
const nodeInclude = process.env.COVE_NODE_INCLUDE || '/opt/homebrew/include/node';
await run('/usr/bin/clang', ['-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup', '-I', nodeInclude, '-framework', 'Foundation', '-framework', 'MediaPlayer', join(root, 'desktop/media-controls.m'), '-o', join(source, 'desktop/media-controls.node')]);
const iconset = await renderMacIcon(root, build);
const icns = join(build, 'Cove.icns');
await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icns]);
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const paths = await packager({
  dir: source, name: appName, platform: 'darwin', arch: process.arch,
  out: join(root, 'dist'), overwrite: true, asar: false, prune: false,
  electronVersion: metadata.devDependencies.electron,
  extraResource: [...['LICENSE', 'LICENSES.chromium.html'].map(file => join(root, 'node_modules/electron/dist', file)), join(build, 'CoveDock.png')],
  appBundleId: preview ? 'com.cove.music.preview' : 'com.cove.music', appCategoryType: 'public.app-category.music',
  appVersion: metadata.version, icon: icns,
  extendInfo: { CFBundleIconFile: 'Cove.icns', NSDocumentsFolderUsageDescription: '소장한 음악 파일과 기록을 불러오고 보관합니다.', NSDownloadsFolderUsageDescription: '선택한 음원을 불러오고 내보낸 파일을 저장합니다.' },
  osxSign: { identity: '-', identityValidation: false, preAutoEntitlements: false, continueOnError: false, optionsForFile: () => ({ hardenedRuntime: false }) }
});
const finalPath = join(root, `dist/${appName}.app`);
await rm(finalPath, { recursive: true, force: true });
await rename(join(paths[0], `${appName}.app`), finalPath);
await rm(paths[0], { recursive: true, force: true });
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', finalPath]);
console.log(`Cove 앱 생성 완료: ${finalPath}`);
