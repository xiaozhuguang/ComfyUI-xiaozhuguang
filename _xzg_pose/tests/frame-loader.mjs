import assert from 'node:assert/strict';
import {FrameLoader,FramePresenter} from '../web/editor/frame-loader.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {resolve,reject,promise};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
// Slow decoding must retain the existing frame and only present complete frames.
const tasks=new Map(),shown=[];
const loader=new FrameLoader(index=>{const task=deferred();tasks.set(index,task);return task.promise;},{capacity:2,concurrency:2});
const presenter=new FramePresenter(loader,(i,img)=>shown.push([i,img]));
const one=presenter.show(0);await settle();assert.deepEqual(shown,[]);
tasks.get(0).resolve('frame0');assert.equal(await one,true);
const two=presenter.show(1);await settle();assert.deepEqual(shown,[[0,'frame0']]);
tasks.get(1).resolve('frame1');assert.equal(await two,true);
// Multiple requests for one frame are decoded once.
const a=loader.get(2),b=loader.get(2);assert.equal(a,b);await settle();tasks.get(2).resolve('frame2');await a;await settle();assert.equal(loader.cache.size,2);
// A late older seek cannot overwrite the latest request.
const old=presenter.show(3);await settle();const recent=presenter.show(4);await settle();tasks.get(4).resolve('frame4');assert.equal(await recent,true);tasks.get(3).resolve('frame3');assert.equal(await old,false);assert.deepEqual(shown.at(-1),[4,'frame4']);
// Cancellation leaves the displayed frame intact; failed requests can be retried.
const pending=presenter.show(5);await settle();presenter.cancel();tasks.get(5).resolve('frame5');assert.equal(await pending,false);assert.deepEqual(shown.at(-1),[4,'frame4']);
const failed=loader.get(6);await settle();tasks.get(6).reject(Error('offline'));await assert.rejects(failed,/offline/);await settle();const retry=loader.get(6);await settle();tasks.get(6).resolve('frame6');assert.equal(await retry,'frame6');
console.log('PASS: slow decode, retained display, cache bounds, deduplication, stale seeks, cancellation, retry');
