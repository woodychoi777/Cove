import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {isWithin}from'../src/path-safety.mjs';import{safeSegment}from'../src/library.mjs';
test('Windows and POSIX containment rejects traversal, sibling prefixes and other drives',()=>{
 for(const p of [path.posix,path.win32]){
  const root=p===path.win32?'C:\\Music\\Cove':'/Music/Cove';
  assert(isWithin(root,root,p));assert(isWithin(p.join(root,'가수','곡.flac'),root,p));
  assert(!isWithin(p.resolve(root,'..','private'),root,p));assert(!isWithin(root+'-other',root,p));
 }
 assert(!isWithin('D:\\Music\\Cove','C:\\Music\\Cove',path.win32));
 assert(isWithin('c:\\music\\cove\\곡.flac','C:\\Music\\Cove',path.win32));
 assert(!isWithin('\\\\server\\other\\file','\\\\server\\music',path.win32));
});
test('managed filenames avoid Windows device names and trailing dots without changing titles',()=>{
 for(const name of ['CON','nul','COM1','LPT9','CON.txt'])assert(safeSegment(name).startsWith('_'));
 assert.equal(safeSegment('곡명...  '),'곡명');assert.equal(safeSegment('...'),'제목 없음');
 assert.equal(safeSegment('한글 🎵 / 음악'),'한글 🎵 음악');
});
