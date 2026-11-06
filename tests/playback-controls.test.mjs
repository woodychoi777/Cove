import test from 'node:test';
import assert from 'node:assert/strict';
import { setupPlaybackControls } from '../public/playback-controls.js';

test('방향키: 5% 경계, 음소거 해제, 곡 이동 반복 방지와 입력·팝업·알람 보호', () => {
  const handlers = new Map(); let modal = false, alarm = false;
  const doc = { addEventListener: (type, fn) => handlers.set(type, fn), removeEventListener: type => handlers.delete(type), querySelector: () => modal, activeElement: null };
  const player = Object.assign(new EventTarget(), { volume: .98, muted: true, hasNext: true, hasPrevious: true, nextCalls: 0, previousCalls: 0, paused: true, toggles: 0, play() { this.paused = false; this.toggles++; }, pause() { this.paused = true; this.toggles++; }, next() { this.nextCalls++; }, previous() { this.previousCalls++; } });
  const opened = []; player.trackId = 5;
  const cleanup = setupPlaybackControls({ player, document: doc, navigator: {}, alarmActive: () => alarm, openTrack: id => opened.push(id) });
  const key = (value, extra = {}) => { const event = { key: value, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra }; handlers.get('keydown')(event); return event; };
  assert(key(' ').defaultPrevented); key(' ', { repeat: true }); assert.equal(player.toggles, 1); key(' '); assert.equal(player.paused, true); assert.equal(player.toggles, 2);
  assert(key('Enter').defaultPrevented); key('Enter', { repeat: true }); assert.deepEqual(opened, [5]);
  assert(key('ArrowUp').defaultPrevented); assert.equal(player.volume, 1); assert.equal(player.muted, false);
  key('ArrowDown'); assert.equal(player.volume, .95); player.volume = .02; key('ArrowDown'); assert.equal(player.volume, 0);
  key('ArrowRight'); key('ArrowRight', { repeat: true }); key('ArrowLeft'); assert.equal(player.nextCalls, 1); assert.equal(player.previousCalls, 1);
  for (const extra of [{ ctrlKey: true }, { shiftKey: true }, { isComposing: true }, { target: { closest: () => true } }]) assert(!key('ArrowRight', extra).defaultPrevented);
  modal = true; assert(!key('ArrowRight').defaultPrevented); modal = false; alarm = true; assert(!key('ArrowRight').defaultPrevented);
  assert(!key(' ').defaultPrevented); assert.equal(player.toggles, 2);
  assert.equal(player.nextCalls, 1); cleanup(); assert(!handlers.has('keydown'));
});

test('미디어 명령: 동일 재생기로 이전·다음·재생·정지, 메타데이터 갱신과 알람 간섭 방지', () => {
  const actions = new Map(); let alarm = false;
  const media = { setActionHandler: (name, handler) => actions.set(name, handler), setPositionState(value) { this.position = value; } };
  const doc = { baseURI: 'http://localhost/', addEventListener() {}, removeEventListener() {} };
  const player = Object.assign(new EventTarget(), { trackId: 1, track: { id: 1, title: '첫 곡', artist: '가수' }, duration: 100, currentTime: 20, paused: false, hasNext: true, hasPrevious: true, calls: [], play() { this.calls.push('play'); }, pause() { this.calls.push('pause'); }, next() { this.calls.push('next'); }, previous() { this.calls.push('previous'); } });
  const cleanup = setupPlaybackControls({ player, document: doc, navigator: { mediaSession: media }, Metadata: class { constructor(data) { Object.assign(this, data); } }, alarmActive: () => alarm });
  for (const name of ['nexttrack','previoustrack','play','pause']) actions.get(name)();
  assert.deepEqual(player.calls, ['next','previous','play','pause']); assert.equal(media.playbackState, 'playing'); assert.equal(media.metadata.title, '첫 곡');
  alarm = true; actions.get('nexttrack')(); assert.equal(player.calls.length, 4);
  player.track = { id: 2, title: '다음 곡' }; player.paused = true; player.dispatchEvent(new Event('change')); assert.equal(media.metadata.title, '다음 곡'); assert.equal(media.playbackState, 'paused');
  cleanup(); assert.equal(actions.get('nexttrack'), null); assert.equal(media.playbackState, 'none');
});

test('Ctrl 1–5 / Escape and Space on a focused playlist tab', () => {
  const handlers = new Map(), chosen = []; let escaped = 0;
  const doc = { body: { dataset: { route: 'detail' } }, querySelector: () => null, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener() {} };
  const tab = { closest: selector => selector.includes('[role="tab"]') ? true : null };
  doc.activeElement = tab;
  const player = Object.assign(new EventTarget(), { trackId: 1, paused: false, pause() { this.paused = true; } });
  setupPlaybackControls({ player, document: doc, navigator: {}, selectList: index => chosen.push(index), leaveLyrics: () => escaped++ });
  const fire = (type, key, extra = {}) => { const e = { key, target: tab, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra }; handlers.get(type)(e); return e; };
  for (let i=1;i<=5;i++) assert(fire('keydown', String(i), {ctrlKey:true}).defaultPrevented);
  assert.deepEqual(chosen,[0,1,2,3,4]);
  assert(fire('keydown','Escape').defaultPrevented); assert.equal(escaped,1);
  assert(fire('keydown',' ').defaultPrevented); assert.equal(player.paused,true);
  assert(fire('keyup',' ').defaultPrevented);
});

test('XM4 seeks: default/explicit offset, bounds, invalid input, stop and alarm protection', () => {
  const actions=new Map();let alarm=false;
  const doc={addEventListener(){},removeEventListener(){},baseURI:'http://localhost/'};
  const media={setActionHandler:(key,fn)=>actions.set(key,fn)};
  const p=Object.assign(new EventTarget(),{trackId:1,track:{id:1,title:'song'},duration:100,currentTime:50,paused:false,seekCalls:[],seek(value){this.currentTime=value;this.seekCalls.push(value);},pause(){this.paused=true;}});
  setupPlaybackControls({player:p,document:doc,navigator:{mediaSession:media},alarmActive:()=>alarm});
  assert.equal(actions.size,8);
  actions.get('seekforward')({}); assert.equal(p.currentTime,60);
  actions.get('seekbackward')({seekOffset:15}); assert.equal(p.currentTime,45);
  actions.get('seekto')({seekTime:300}); assert.equal(p.currentTime,100);
  actions.get('seekbackward')({seekOffset:300}); assert.equal(p.currentTime,0);
  const before=p.seekCalls.length;
  for(const value of [NaN,Infinity,-1,0,'10']) actions.get('seekforward')({seekOffset:value});
  actions.get('seekto')({seekTime:NaN});assert.equal(p.seekCalls.length,before);
  alarm=true;actions.get('seekto')({seekTime:20});actions.get('stop')();assert.equal(p.paused,false);assert.equal(p.seekCalls.length,before);
  alarm=false;p.currentTime=20;actions.get('stop')();assert.equal(p.currentTime,0);assert.equal(p.paused,true);
});

test('native media bridge owns commands once, publishes state, ends held seeking and protects alarms', async () => {
  let listener, alarm=false;const published=[];
  const bridge={ready:async()=>true,onAction:fn=>{listener=fn;return()=>{listener=null;};},update:state=>published.push(state)};
  const p=Object.assign(new EventTarget(),{trackId:1,track:{id:1,title:'Native song'},duration:100,currentTime:20,paused:false,calls:[],seek(value){this.currentTime=value;this.calls.push(value);},pause(){this.paused=true;},play(){this.paused=false;}});
  const doc={addEventListener(){},removeEventListener(){},baseURI:'http://localhost/'};
  const cleanup=setupPlaybackControls({player:p,document:doc,navigator:{mediaSession:{setActionHandler(){throw Error('Duplicate web handler');}}},nativeBridge:bridge,alarmActive:()=>alarm});
  await Promise.resolve(); assert.equal(published[0].title,'Native song');
  listener({action:'toggle'});assert.equal(p.paused,true);listener({action:'toggle'});assert.equal(p.paused,false);
  listener({action:'seekforward',phase:'begin'});assert.equal(p.currentTime,25);
  await new Promise(resolve=>setTimeout(resolve,550));assert(p.currentTime>=30);
  listener({action:'seekforward',phase:'end'});const position=p.currentTime;
  await new Promise(resolve=>setTimeout(resolve,550));assert.equal(p.currentTime,position);
  alarm=true;listener({action:'toggle'});listener({action:'seekto',seekTime:99});assert.equal(p.currentTime,position);assert.equal(p.paused,false);
  cleanup();assert.equal(listener,null);
});
