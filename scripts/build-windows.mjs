import {cp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';import{promisify}from'node:util';import{fileURLToPath}from'node:url';import{join,relative}from'node:path';
import{packager}from'@electron/packager';import{Resvg}from'@resvg/resvg-js';
const run=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const build=join(root,'.windows-build'),source=join(build,'source'),metadata=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
await rm(build,{recursive:true,force:true});await mkdir(join(source,'desktop'),{recursive:true});
await Promise.all(['src','public'].map(name=>cp(join(root,name),join(source,name),{recursive:true})));
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])await cp(join(root,name),join(source,name));
for(const name of ['main.cjs','preload.cjs','library-location.cjs','alarm.cjs','wake.cjs','media-controls.cjs'])await cp(join(root,'desktop',name),join(source,'desktop',name));
await cp(join(root,'desktop/package.json'),join(source,'package.json'));
await cp(join(root,'docs/public/NSIS-LICENSE.txt'),join(source,'NSIS-LICENSE.txt'));
const{stdout}=await run('npm',['ls','--omit=dev','--parseable','--all'],{cwd:root,shell:process.platform==='win32'});
for(const dependency of new Set(stdout.trim().split(/\r?\n/).slice(1))){const path=relative(root,dependency);if(!path.startsWith('node_modules'))throw Error('Unexpected external dependency');await cp(dependency,join(source,path),{recursive:true});}
const svg=await readFile(join(root,'public/icons/soriseojae-app-v4.svg'),'utf8'),png=new Resvg(svg,{font:{loadSystemFonts:false},fitTo:{mode:'width',value:256}}).render().asPng();
const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);const icon=join(build,'Cove.ico');await writeFile(icon,Buffer.concat([header,png]));
const paths=await packager({dir:source,name:'Cove',platform:'win32',arch:'x64',out:join(root,'dist'),overwrite:true,asar:false,prune:false,electronVersion:metadata.devDependencies.electron,appVersion:metadata.version,buildVersion:metadata.version,icon,win32metadata:{CompanyName:'woodychoi777',ProductName:'Cove',FileDescription:'Cove music library'},appCopyright:'Copyright 2026 woodychoi'});
const app=paths[0],prefix=process.platform==='win32'?'/':'-',makensis=process.env.COVE_MAKENSIS||(process.platform==='win32'?'makensis.exe':'makensis');
const installer=join(root,'dist',`Cove-Setup-${metadata.version}-x64.exe`);
const uninstall=join(build,'uninstall-files.nsh'),files=[],directories=[];
async function inventory(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory()){await inventory(path);directories.push(relative(app,path));}else files.push(relative(app,path));}}
await inventory(app);
const escape=value=>value.replaceAll('\\','/').replaceAll('$','$$').replaceAll('"','$\\"').replaceAll('/','\\');
await writeFile(uninstall,[...files.map(file=>'Delete "$INSTDIR\\'+escape(file)+'"'),...directories.map(dir=>'RMDir "$INSTDIR\\'+escape(dir)+'"')].join('\n')+'\n');
await run(makensis,[prefix+'V2',prefix+'DVERSION='+metadata.version,prefix+'DAPP_DIR='+app,prefix+'DOUTPUT_FILE='+installer,prefix+'DROOT='+root,prefix+'DAPP_ICON='+icon,prefix+'DUNINSTALL_INCLUDE='+uninstall,join(root,'desktop/windows/installer.nsi')],{maxBuffer:8*1024*1024});
console.log('Windows app: '+app);console.log('Windows installer: '+installer);
