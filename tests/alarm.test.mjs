import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AlarmSession } from '../public/alarm-session.js';
const require=createRequire(import.meta.url);
const {defaults,validate,wakeTime,AlarmScheduler}=require('../desktop/alarm.cjs');
const {repeatLines,ownsRepeat,WakeSchedule}=require('../desktop/wake.cjs');
const config=()=>({...defaults(),enabled:true,tracks:[1,2,3],classicId:4});
const tick=()=>new Promise(ok=>setImmediate(ok));

test('alarm settings validate all four songs, bounded finite gain and local time',()=>{
 assert.deepEqual(validate(defaults()),defaults()); assert.deepEqual(validate(config()),config());
 for(const patch of [{time:'24:00'},{tracks:[1,2]},{volumes:[.2,NaN,.7]},{volumes:[0,.4,.7]},{classicId:null},{tracks:[1,2,'3']},{enabled:'yes'}])assert.throws(()=>validate({...config(),...patch}));
 assert.equal(wakeTime('00:00'),'23:59:00');assert.equal(wakeTime('07:00'),'06:59:00');
});
test('scheduler: once per local day, restart, grace and next-day edits',()=>{
 let now=new Date(2026,9,27,6,59),fires=[],canceled=[];const state={config:config()};
 const make=()=>new AlarmScheduler({state,persist:()=>{},fire:e=>fires.push(e),cancel:t=>canceled.push(t),now:()=>now});
 let scheduler=make();scheduler.tick();assert.equal(fires.length,0);
 now=new Date(2026,9,27,7,0);scheduler.tick();scheduler.tick();assert.equal(fires.length,1);
 scheduler.save({...config(),time:'07:01'});scheduler.finish(fires[0].token);now=new Date(2026,9,27,7,1);scheduler.tick();assert.equal(fires.length,1);
 scheduler=make();scheduler.tick();assert.equal(fires.length,1);
 now=new Date(2026,9,28,7,5,59);scheduler.tick();assert.equal(fires.length,2);
 scheduler.save({...config(),enabled:false});assert.equal(canceled.length,1);
 scheduler.save(config());now=new Date(2026,9,29,7,5,1);scheduler.tick();assert.equal(fires.length,2);assert.equal(state.lastOutcome,'missed');
 now=new Date(2026,9,29,7,1);scheduler.tick();assert.equal(fires.length,2,'clock moving backward does not retry missed day');
 now=new Date(2026,9,30,7,5);scheduler.tick();assert.equal(fires.length,3);
});
test('pmset ownership is exact and does not confuse one-time or other repeat events',()=>{
 const own='Repeating power events:\n  wake at 6:59AM every day\nScheduled power events:\n [0] wake at 12:00 by someone';
 assert(ownsRepeat(own,'06:59:00'));assert(!ownsRepeat(own,'18:59:00'));
 assert(!ownsRepeat(own.replace('every day','weekdays'),'06:59:00'));
 assert(!ownsRepeat(own.replace('Scheduled power','sleep at 11:00PM every day\nScheduled power'),'06:59:00'));
 assert.deepEqual(repeatLines('Scheduled power events:\n wake at 6:59AM every day'),[]);
 assert(ownsRepeat('Repeating power events:\n wake at 12:00AM every day','00:00:00'));
});
test('wake manager refuses conflicts, validates effect, handles denied authentication and removes only owned repeat',async()=>{
 let text='Repeating power events:\n sleep at 11:00PM every day\n',auth=0;const state={};
 const command=async(path,args)=>{if(path==='/usr/bin/pmset')return{stdout:text};auth++;text=args[0]==='cancel'?'':`Repeating power events:\n wake at 6:59AM every day\n`;return{};};
 const wake=new WakeSchedule({helper:'/fixed/helper',state,persist:()=>{},command});
 await assert.rejects(wake.configure(config()),/다른 반복/);assert.equal(auth,0);
 text='';await wake.configure(config());assert.equal(state.ownedTime,'06:59:00');assert.equal(auth,1);
 await wake.configure(config());assert.equal(auth,1);await wake.configure({...config(),enabled:false});assert.equal(auth,2);assert.equal(text,'');
 const denied=new WakeSchedule({helper:'/fixed/helper',state:{},persist:()=>{},command:async p=>{if(p==='/usr/bin/pmset')return{stdout:''};throw Error('Authorization: -60006');}});
 await assert.rejects(denied.configure(config()),/취소/);
 assert.equal(denied.state.ownedTime,undefined);
});
class FakePlayer extends EventTarget {
 constructor(){super();this.tracks=[1,2,3,4,5].map(id=>({id}));this.persisted=[];this.persist=x=>this.persisted.push(x);this.queue=[{trackId:5}];this.index=0;this.offset=8;this._volume=.8;this._muted=true;this.shuffle=true;this.repeat='all';this.fadeSeconds=4;this.source='원래';this.status='일시정지';this.fail=new Set();this.played=[];this.ramps=[];this.context={currentTime:10};this.master={gain:{cancelScheduledValues:()=>{},setValueAtTime:()=>{},linearRampToValueAtTime:(v,t)=>this.ramps.push([v,t])}};}
 get volume(){return this._volume}set volume(v){this._volume=v}get muted(){return this._muted}set muted(v){this._muted=v}
 get trackId(){return this.queue[this.index]?.trackId}get currentTime(){return this.offset}
 snapshot(){return{ids:this.queue.map(x=>x.trackId),index:this.index,shuffle:this.shuffle,repeat:this.repeat,fadeSeconds:this.fadeSeconds,source:this.source}}
 stop(){this.paused=true}pause(){this.stop()}emit(type){this.dispatchEvent(new Event(type))}
 setQueue(ids,index=0,source){this.queue=ids.filter(id=>this.tracks.some(t=>t.id===id)).map(trackId=>({trackId}));this.index=index;this.source=source;this.offset=0;this.status='재생 준비';this.persist(this.snapshot());this.emit('change')}
 restore(s){this.setQueue(s.ids,s.index,s.source);Object.assign(this,{shuffle:s.shuffle,repeat:s.repeat,fadeSeconds:s.fadeSeconds})}
 async play(){this.paused=false;this.played.push(this.trackId);this.status=this.fail.has(this.trackId)?'재생 실패':'재생 중';this.emit('change')}
 end(){this.paused=true;this.status='대기열 재생 완료';this.emit('change')}
}
test('three stages ramp, advance to classical once without repeat, restore queue and gain',async()=>{
 const p=new FakePlayer(),old=p.snapshot(),acks=[];const session=new AlarmSession({player:p,acknowledge:async t=>acks.push(t)});
 await session.start({token:'a',config:config()});assert.equal(p.trackId,1);assert.deepEqual(p.ramps,[[.2,20]]);assert.equal(p.muted,false);
 p.end();await tick();assert.equal(p.trackId,2);assert.equal(p.volume,.45);
 p.end();await tick();assert.equal(p.trackId,3);assert.equal(p.volume,.7);
 p.end();await tick();assert.deepEqual(p.played,[1,2,3,4]);
 await Promise.all([session.dismiss('a'),session.dismiss('a')]);assert.equal(p.trackId,4);assert.equal(p.volume,.25);assert.deepEqual(acks,['a']);
 p.end();await tick();assert.equal(session.mode,'idle');assert.deepEqual(p.snapshot(),old);assert.equal(p.offset,8);assert.equal(p.volume,.8);assert.equal(p.muted,true);assert(p.paused);assert.deepEqual(p.persisted,[]);
});
test('failed alarm tracks skip forward to classic; failed classic restores without replay',async()=>{
 const p=new FakePlayer();p.fail.add(3);const s=new AlarmSession({player:p});
 await s.start({token:'a',config:config()});p.end();await tick();p.end();await tick();
 assert.equal(s.mode,'classic');assert.deepEqual(p.played,[1,2,3,4]);
 p.end();await tick();assert.equal(s.mode,'idle');assert.equal(p.trackId,5);
 p.fail=new Set([1,2,3,4]);await s.start({token:'b',config:config()});await tick();
 assert.equal(s.mode,'idle');assert.equal(p.trackId,5);assert(p.paused);
 assert.deepEqual(p.played,[1,2,3,4,1,2,3,4]);assert.deepEqual(p.persisted,[]);
});
test('disable and preview do not advance to classic or persist temporary queue',async()=>{
 const p=new FakePlayer(),s=new AlarmSession({player:p});await s.preview({trackId:2,volume:.4,fade:false});assert.equal(s.mode,'preview');s.cancel();assert.equal(p.trackId,5);
 await s.start({token:'a',config:config()});s.cancel('a');assert.equal(s.mode,'idle');assert(!p.played.includes(4));assert.deepEqual(p.persisted,[]);
 await s.start({token:'b',config:config()});await s.dismiss('b');p.setQueue([2]);assert.equal(s.mode,'idle');assert.equal(p.trackId,2);assert.equal(p.volume,.8);assert.equal(p.persisted.length,1);
});
test('late decode cannot resume alarm after dismissal',async()=>{
 const p=new FakePlayer();let release;p.play=()=>new Promise(ok=>{release=()=>{p.status='재생 중';ok();}});
 const s=new AlarmSession({player:p});const starting=s.start({token:'a',config:config()});const oldRelease=release;s.cancel('a');oldRelease();await starting;
 assert.equal(s.mode,'idle');assert.equal(p.trackId,5);assert.deepEqual(p.ramps,[]);
});
