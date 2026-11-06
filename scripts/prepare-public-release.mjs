// Deliberately copy an allowlist; never publish the working tree wholesale.
import {cp,mkdir,readdir,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {join,relative,extname} from 'node:path';
const root=process.cwd(),destination=join(root,'dist/cove-public-source');
const roots=['README.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore','package.json','package-lock.json','src','public','desktop','scripts','tests','config','docs/public','.github','SECURITY.md'];
const files=[];
async function walk(path){
 const info=await lstat(path);
 if(info.isSymbolicLink()) throw Error('Symlink cannot be published: '+relative(root,path));
 if(info.isDirectory()){ for(const name of (await readdir(path)).sort()) await walk(join(path,name)); return; }
 const name=relative(root,path);
 if(name==='desktop/library-default.json') return;
 if(/(?:^|\/)(?:data|update-backups|node_modules|\.planning|\.agents|\.codex)(?:\/|$)|\.(?:sqlite|db|dmg|exe|mobileprovision)(?:$|-)/i.test(name)) throw Error('Private/runtime file: '+name);
 if(!/\.(?:mjs|cjs|js|json|html|css|svg|png|md|sh|plist|m|m4a|webmanifest|yml|yaml|txt|nsi)$/.test(name)&&!['LICENSE','.gitignore'].includes(name)) throw Error('Unexpected candidate: '+name);
 if(extname(name)==='.m4a'&&!['tests/fixtures/aac-tone.m4a','tests/fixtures/aac-controls-tone.m4a'].includes(name)) throw Error('Unexpected audio: '+name);
 const bytes=await readFile(path);
 if(!['.png','.m4a'].includes(extname(name))){
  const content=bytes.toString('utf8');
  if(/\/Users\/[^\s/]+\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{24,}|\bAKIA[A-Z0-9]{16}\b/.test(content)) throw Error('Private path or credential in '+name);
 }
 files.push(name);
}
for(const entry of roots) await walk(join(root,entry));
await rm(destination,{recursive:true,force:true});await mkdir(destination,{recursive:true});
for(const file of files){await mkdir(join(destination,file,'..'),{recursive:true});await cp(join(root,file),join(destination,file));}
await writeFile(join(root,'dist/PUBLIC_FILES.txt'),files.sort().join('\n')+'\n');
await writeFile(join(root,'dist/PUBLIC_SCAN.json'),JSON.stringify({files:files.length,privatePathOrCredentialFindings:0,audioFixturesOnly:true,excluded:['data','dist','.desktop-build','.planning','.agents','.codex','docs/ux','docs/quality','personal screenshots','desktop/library-default.json'],published:false},null,2)+'\n');
console.log('Public candidate: '+files.length+' files. No upload performed.');
