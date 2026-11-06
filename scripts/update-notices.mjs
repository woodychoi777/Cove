import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,relative} from 'node:path';
const root=process.cwd();
const paths=[...new Set(execFileSync('npm',['ls','--omit=dev','--parseable','--all'],{encoding:'utf8'}).trim().split('\n').slice(1))];
let text='# Third-party notices\n\nCove is MIT licensed. The following production packages keep their own licenses.\nElectron also ships its LICENSE and LICENSES.chromium.html in the app Resources folder, covering Electron, Chromium, Node.js and included components.\nBuild tools are development dependencies; see package-lock.json and their installed license files.\n';
for(const path of paths){
 const meta=JSON.parse(await readFile(join(path,'package.json'),'utf8'));
 const license=(await readdir(path)).find(name=>/^licen[cs]e(?:\.[\w-]+)?$/i.test(name));
 const licenseText=license ? await readFile(join(path,license),'utf8') : meta.name==='@tokenizer/token' ? (await readFile(join(path,'README.md'),'utf8')).split('## Licence')[1] : '';
 if(!licenseText.trim()) throw Error('Missing license: '+meta.name);
 text+='\n## '+meta.name+' '+meta.version+' ('+meta.license+')\n\nSource: '+relative(root,path)+'\n\n```text\n'+licenseText.trim()+'\n```\n';
}
text+='\n## Windows installer — NSIS 3.13\n\nThe Windows installer includes NSIS components with their own licenses. Full notices and the source location are in docs/public/NSIS-LICENSE.txt in this source distribution, and NSIS-LICENSE.txt inside resources/app in the installed Windows app. Cove’s MIT license does not replace those component licenses.\n';
await writeFile('THIRD_PARTY_NOTICES.md',text);
