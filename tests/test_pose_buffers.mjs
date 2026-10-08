import assert from 'node:assert/strict';
import fs from 'node:fs';
const loadModule=async path=>import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(path,'utf8')).toString('base64'));
const {FrameLoader}=await loadModule('web/editor/frame-loader.js');
const {PoseFrameCache}=await loadModule('web/editor/pose-frame-cache.js');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {resolve,promise};};

// Decoded image memory, not just frame count, limits the buffer.
let loads=0;
const images=new FrameLoader(async index=>{loads++;return {index,naturalWidth:100,naturalHeight:100};},{capacity:48,maxBytes:80000});
await images.get(0);await images.get(1);await images.get(2);
assert.equal(images.windowSize,2);assert.equal(images.cache.size,2);assert.equal(images.cacheBytes,80000);
await images.get(2);assert.equal(loads,3);

// Rapid seeking must discard obsolete queued preloads, retaining foreground priority.
const active=new Map();
const loader=new FrameLoader(index=>{const task=deferred();active.set(index,task);return task.promise;},{concurrency:1});
loader.prefetchWindow([1,2,3]);await settle();
loader.prefetchWindow([8,9]);assert.deepEqual(loader.queue.map(task=>task.index),[8,9]);
const foreground=loader.get(9);assert.deepEqual(loader.queue.map(task=>task.index),[9,8]);
active.get(1).resolve({width:1,height:1});await settle();active.get(9).resolve({width:1,height:1});await foreground;await settle();
loader.clear();active.get(8)?.resolve({width:1,height:1});await settle();assert.equal(loader.cache.size,0);

// An old in-flight image must not enter the cache after the source changes.
const oldTask=deferred(),newTask=deferred();let round=0;
const resetLoader=new FrameLoader(()=>++round===1?oldTask.promise:newTask.promise,{concurrency:2});
const old=resetLoader.get(0);await settle();resetLoader.clear();const fresh=resetLoader.get(0);await settle();
oldTask.resolve({id:'old'});await old;await settle();assert.equal(resetLoader.pending.get(0),fresh);
newTask.resolve({id:'new'});await fresh;assert.equal(resetLoader.cache.get(0).id,'new');

// Cached skeletons are reused, bounded, and discarded after editing.
let revision=1,computed=0;const callbacks=new Map();let id=0;
const poses=new PoseFrameCache(index=>{computed++;return {index,revision,people:[{pose_keypoints_2d:Array(54).fill(index)}]};},{capacity:3,schedule:callback=>{callbacks.set(++id,callback);return id;},cancel:id=>callbacks.delete(id)});
const first=poses.get(0);assert.equal(poses.get(0),first);assert.equal(computed,1);
poses.prefetch([1,2]);const callback=callbacks.get(id);callbacks.delete(id);callback({timeRemaining:()=>10});assert.equal(computed,3);
poses.get(3);assert.equal(poses.cache.size,3);
poses.prefetch([4]);assert.equal(callbacks.size,1);revision++;poses.clear();assert.equal(callbacks.size,0);assert.equal(poses.get(0).revision,2);
const bounded=new PoseFrameCache(index=>({people:[{pose_keypoints_2d:Array(54).fill(index)}]}),{maxBytes:1200});bounded.get(0);bounded.get(1);assert.equal(bounded.cache.size,1);
// Pausing while video frames are warming up must never restart playback later.
const editor=fs.readFileSync('web/editor/editor.js','utf8');
const toggle=editor.slice(editor.indexOf('async function togglePlayback(){'),editor.indexOf('function background(){'));
const warmup=deferred(),playButton={textContent:''};let animationRequests=0;
const playback=new Function('frameLoader','poseFrameCache','$','requestAnimationFrame',`
 let frames=Array(6).fill({}),scalesDirty=false,playing=false,playbackGeneration=0,current=0,lastTick=0,sessionData={has_images:true},videoURL=null;
 const setFrame=async()=>true,bufferAround=()=>{},tick=()=>{},commitScale=()=>{},status=()=>{};
 const pause=()=>{playing=false;playbackGeneration++;$('play').textContent='▶ 播放';};
 ${toggle}
 return {toggle:togglePlayback};
`)({windowSize:4,prefetchWindow(){},get:()=>warmup.promise},{get(){}},id=>id==='play'?playButton:{checked:true},()=>animationRequests++);
const starting=playback.toggle();await settle();assert.equal(playButton.textContent,'… 缓冲');
await playback.toggle();warmup.resolve();await starting;assert.equal(animationRequests,0);assert.equal(playButton.textContent,'▶ 播放');
console.log('Passed: image memory limits, foreground priority, stale preload cancellation, source replacement, skeleton reuse, edit invalidation and idle precomputation.');
