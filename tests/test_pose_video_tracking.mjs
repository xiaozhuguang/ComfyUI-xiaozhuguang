import assert from 'node:assert/strict';
import fs from 'node:fs';

const coreURL='data:text/javascript;base64,'+Buffer.from(fs.readFileSync('web/editor/pose-core.js','utf8')).toString('base64');
const source=fs.readFileSync('web/editor/video-tracking.js','utf8').replace('./pose-core.js?v=16',coreURL);
const {buildTrackingPlan,mergeTrackingResult}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const {applyFrame,compileOperations}=await import(coreURL);
const body=Array(54).fill(0);body.splice(13*3,3,40,50,1);
const frames=Array.from({length:6},()=>({canvas_width:100,canvas_height:100,people:[{pose_keypoints_2d:[...body]}]}));
const key=(frame,x,needs_adjustment=false)=>({type:'set_joint',person:0,joint:13,frame,x,y:.5,needs_adjustment,completion_pending:false,active_ranges:[[0,4]]});
const operations=[key(0,.4),key(2,.6,true),key(4,.8),key(1,.45,true),{...key(5,.9),active_ranges:[[5,5]]}];
const original=JSON.stringify(operations);
const plan=buildTrackingPlan(frames,operations,0,13,2);
assert.deepEqual(plan.anchors.map(p=>p.frame),[0,4]);
const manualMiddle=operations.map(op=>op.frame===2?{...op,needs_adjustment:false}:op);
assert.deepEqual(buildTrackingPlan(frames,manualMiddle,0,13,1).anchors.map(p=>p.frame),[0,2]);
assert.deepEqual(buildTrackingPlan(frames,manualMiddle,0,13,2).anchors.map(p=>p.frame),[2,4]);
assert.deepEqual(buildTrackingPlan(frames,manualMiddle,0,13,4).anchors.map(p=>p.frame),[2,4]);
assert.throws(()=>buildTrackingPlan(frames,[key(0,.4,true),key(4,.8)],0,13,2),/手工/);
assert.throws(()=>buildTrackingPlan(frames,operations,0,13,5),/生效区间/);
assert.throws(()=>buildTrackingPlan(frames,operations,-1,13,2),/具体人物/);
const result={start:0,end:4,points:[{frame:1,x:.5,y:.5,confidence:.9}],failed_frames:[2,3]};
const merged=mergeTrackingResult(frames,operations,[],plan,result);
assert.equal(JSON.stringify(operations),original,'input operations must remain untouched');
for(const frame of [0,4,5])assert.equal(merged.find(op=>op.frame===frame),operations.find(op=>op.frame===frame),'manual and out-of-range keys must survive');
assert.equal(merged.find(op=>op.frame===1).completion_source,'video');
assert.equal(merged.find(op=>op.frame===3).tracking_failed,true);
assert.equal(merged.filter(op=>op.frame===1).length,1);
assert.equal(applyFrame(frames[1],1,compileOperations(merged),frames.length).people[0].pose_keypoints_2d[39],50);
assert.ok(merged.filter(op=>op.completion_source?.startsWith('video')).every(op=>op.needs_adjustment));
// Adjustment tracks store offsets, not absolute coordinates. Later scaling must not
// apply a second time to video positions, and other frames/manual keys stay intact.
const adjustmentFrames=Array.from({length:6},(_,index)=>{
 const body=Array(54).fill(0);
 for(const [joint,x,y] of [[1,50,20],[2,20,20],[3,30,30],[4,40+index,40],[5,80,20],[8,40,65],[11,60,65]])body.splice(joint*3,3,x,y,.9);
 if(index===2)body[14]=0;
 return {canvas_width:100,canvas_height:100,people:[{pose_keypoints_2d:body,hand_left_keypoints_2d:[40+index,40,.9]}]};
});
const adjustmentKeys=[
 {type:'joint',person:0,joint:4,frame:0,dx:0,dy:0,active_ranges:[[0,4]]},
 {type:'joint',person:0,joint:4,frame:4,dx:.1,dy:.05,active_ranges:[[0,4]]},
 {type:'scale',person:0,frame:0,values:{lower_arm:1.4},active_ranges:[[0,5]]},
];
const fixes=[{type:'swap_hands',person:-1}];
const adjustmentPlan=buildTrackingPlan(adjustmentFrames,adjustmentKeys,0,4,2,fixes);
assert.equal(adjustmentPlan.type,'joint');
const originalRender=index=>applyFrame(adjustmentFrames[index],index,compileOperations([...fixes,...adjustmentKeys]),6);
assert.ok(Math.abs(adjustmentPlan.anchors[0].x-originalRender(0).people[0].pose_keypoints_2d[12]/100)<1e-9);
const adjustmentResult={start:0,end:4,points:[1,2,3].map(frame=>({frame,x:.45+frame*.05,y:.5+frame*.02,confidence:.9})),failed_frames:[]};
const adjusted=mergeTrackingResult(adjustmentFrames,adjustmentKeys,fixes,adjustmentPlan,adjustmentResult);
for(const point of adjustmentResult.points){
 const rendered=applyFrame(adjustmentFrames[point.frame],point.frame,compileOperations([...fixes,...adjusted]),6),body=rendered.people[0].pose_keypoints_2d;
 assert.ok(Math.abs(body[12]/100-point.x)<1e-6);assert.ok(Math.abs(body[13]/100-point.y)<1e-6);assert.ok(body[14]>.3);
 assert.equal(adjusted.find(op=>op.frame===point.frame&&op.type==='joint').needs_adjustment,true);
}
for(const frame of [0,4,5])assert.deepEqual(applyFrame(adjustmentFrames[frame],frame,compileOperations([...fixes,...adjusted]),6),originalRender(frame));
assert.equal(adjusted.find(op=>op.type==='joint'&&op.frame===0),adjustmentKeys[0]);
assert.equal(adjusted.find(op=>op.type==='joint'&&op.frame===4),adjustmentKeys[1]);
console.log('Passed: interval selection, manual anchors, scope preservation, failed-frame fallback, frontend output and confirmation state.');
