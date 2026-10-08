import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {applySequence} from '../web/editor/pose-core.js';
const {frames,operations,expected}=JSON.parse(readFileSync(process.argv[2],'utf8'));
const result=applySequence(frames,operations);
function compare(a,b){if(typeof a==='number'){assert(Math.abs(a-b)<1e-8);return;}if(Array.isArray(a)){assert.equal(a.length,b.length);a.forEach((v,i)=>compare(v,b[i]));return;}if(a&&typeof a==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort());Object.keys(a).forEach(k=>compare(a[k],b[k]));return;}assert.equal(a,b);}
compare(result,expected);console.log('PASS: browser preview and Python output agree, including face/hands/feet');
