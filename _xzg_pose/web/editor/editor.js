import {SCALE_KEYS,BODY_EDGES,BODY_NAMES,clone,applyFrame,compileOperations,isOperationActive} from './pose-core.js?v=16';
import {FrameLoader,FramePresenter} from './frame-loader.js';
function startEditor(){
document.addEventListener('contextmenu',e=>e.preventDefault());
const $=id=>document.getElementById(id),canvas=$('canvas'),ctx=canvas.getContext('2d');
let frames=[],operations=[],sourceDigest='',current=0,drag=null,playing=false,playbackGeneration=0,lastTick=0,history=[],sessionData=null,videoURL=null,initialEdits=null,handFixes=[],manualMode=false,pendingJoint=null,manualPreview=null,hoveredScale=null,dragMode='joint',activeCompletionTrack=null,trackActivationLocked=false;
let completionBatch=false,batchReliableSamples=null;
const splitter=$('timelineSplitter');let splitDrag=null;
// Set this URL when the video tutorial is available; the same button then opens it.
const POSE_TUTORIAL_URL='',helpDialog=$('helpDialog');
$('usageHelp').onclick=()=>{if(POSE_TUTORIAL_URL){window.open(POSE_TUTORIAL_URL,'_blank','noopener,noreferrer');return;}helpDialog.showModal();};
$('helpClose').onclick=()=>helpDialog.close();
helpDialog.addEventListener('click',event=>{if(event.target===helpDialog)helpDialog.close();});

const previewStage=$('stage'),previewViewport=document.createElement('div');previewViewport.className='preview-viewport';
previewViewport.append(...previewStage.childNodes);previewStage.append(previewViewport);
const completionHint=document.createElement('canvas');completionHint.className='completion-hint';completionHint.setAttribute('aria-hidden','true');previewViewport.append(completionHint);
const completionHintContext=completionHint.getContext('2d');let completionHintLines=[],completionHintPoints=[],completionHintRequest=0;
function animateCompletionHint(time){
 completionHintRequest=0;const hctx=completionHintContext,dpr=devicePixelRatio||1;
 hctx.setTransform(dpr,0,0,dpr,0,0);hctx.clearRect(0,0,completionHint.width/dpr,completionHint.height/dpr);
 if(!completionHintPoints.length)return;
 hctx.translate(previewPoseLeft,previewPoseTop);
 const pulse=.5+.5*Math.sin(time/900*Math.PI*2);hctx.globalAlpha=.65+.35*pulse;hctx.strokeStyle=pulse>.5?'#ffffff':'#ffdc4d';hctx.fillStyle='#fff7bc';hctx.shadowColor='#ffda32';hctx.shadowBlur=18;hctx.lineWidth=6;
 hctx.beginPath();for(const [a,b] of completionHintLines){hctx.moveTo(...a);hctx.lineTo(...b);}hctx.stroke();
 for(const point of completionHintPoints){hctx.beginPath();hctx.arc(...point,9,0,Math.PI*2);hctx.stroke();hctx.beginPath();hctx.arc(...point,4,0,Math.PI*2);hctx.fill();}
 completionHintRequest=requestAnimationFrame(animateCompletionHint);
}
function updateCompletionHint(frame){
 completionHintLines=[];completionHintPoints=[];
 const keys=manualMode?operations.filter(op=>op.type==='set_joint'&&op.frame===current&&op.needs_adjustment&&isOperationActive(op,current)&&(!trackActivationLocked||!activeCompletionTrack||((activeCompletionTrack.person===-1||op.person===activeCompletionTrack.person)&&((activeCompletionTrack.type||'joint')!=='joint'||op.joint===activeCompletionTrack.joint)))&&!(drag&&drag.op.person===op.person&&drag.op.joint===op.joint)):[];
 completionHint.hidden=!keys.length;
 if(!keys.length){if(completionHintRequest)cancelAnimationFrame(completionHintRequest);completionHintRequest=0;completionHintContext.clearRect(0,0,completionHint.width,completionHint.height);return;}
 const w=previewPoseWidth,h=previewPoseHeight,dpr=devicePixelRatio||1,layerWidth=parseFloat(canvas.style.width),layerHeight=parseFloat(canvas.style.height);
 completionHint.style.width=layerWidth+'px';completionHint.style.height=layerHeight+'px';
 if(completionHint.width!==Math.round(layerWidth*dpr))completionHint.width=Math.round(layerWidth*dpr);if(completionHint.height!==Math.round(layerHeight*dpr))completionHint.height=Math.round(layerHeight*dpr);
 for(const op of keys){const flat=frame.people[op.person]?.pose_keypoints_2d;if(!flat||flat[op.joint*3+2]<=.3)continue;
  const point=[flat[op.joint*3]/frame.canvas_width*w,flat[op.joint*3+1]/frame.canvas_height*h];completionHintPoints.push(point);
  for(const [a,b] of BODY_EDGES){const neighbor=a===op.joint?b:b===op.joint?a:null;if(neighbor===null||flat[neighbor*3+2]<=.3)continue;completionHintLines.push([point,[flat[neighbor*3]/frame.canvas_width*w,flat[neighbor*3+1]/frame.canvas_height*h]]);}
 }
 if(!completionHintRequest)completionHintRequest=requestAnimationFrame(animateCompletionHint);
}

let previewZoom=1,previewOffsetX=0,previewOffsetY=0,previewPoseWidth=1,previewPoseHeight=1,previewPoseLeft=0,previewPoseTop=0;
function applyPreviewView(){previewViewport.style.transform=`translate(${previewOffsetX}px,${previewOffsetY}px) scale(${previewZoom})`;}
function resetPreviewView(){previewZoom=1;previewOffsetX=previewOffsetY=0;applyPreviewView();}
$('resetView').onclick=resetPreviewView;
let previewPan=null;
previewStage.addEventListener('pointerdown',event=>{
 if(!(event.button===1||(event.button===0&&event.ctrlKey)))return;
 event.preventDefault();event.stopImmediatePropagation();if(drag)endDrag();
 previewPan={pointerId:event.pointerId,x:event.clientX,y:event.clientY,offsetX:previewOffsetX,offsetY:previewOffsetY};
 previewStage.setPointerCapture(event.pointerId);previewStage.classList.add('preview-panning');
},{capture:true});
previewStage.addEventListener('pointermove',event=>{
 if(!previewPan||event.pointerId!==previewPan.pointerId)return;
 event.preventDefault();event.stopImmediatePropagation();
 previewOffsetX=previewPan.offsetX+event.clientX-previewPan.x;previewOffsetY=previewPan.offsetY+event.clientY-previewPan.y;applyPreviewView();
},{capture:true});
function endPreviewPan(event){
 if(!previewPan||event.pointerId!==previewPan.pointerId)return;
 event.preventDefault();event.stopImmediatePropagation();previewPan=null;previewStage.classList.remove('preview-panning');
 if(previewStage.hasPointerCapture(event.pointerId))previewStage.releasePointerCapture(event.pointerId);
}
previewStage.addEventListener('pointerup',endPreviewPan,{capture:true});previewStage.addEventListener('pointercancel',endPreviewPan,{capture:true});
previewStage.addEventListener('lostpointercapture',event=>{if(previewPan?.pointerId===event.pointerId){previewPan=null;previewStage.classList.remove('preview-panning');}});
previewStage.addEventListener('auxclick',event=>{if(event.button===1)event.preventDefault();});

document.addEventListener('keydown',event=>{
 if(helpDialog.open||event.defaultPrevented||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||event.key.toLowerCase()!=='z')return;
 if(event.target?.closest?.('textarea,select,[contenteditable]:not([contenteditable="false"])')||event.target?.matches?.('input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])'))return;
 event.preventDefault();$('resetView').click();
});

previewStage.addEventListener('wheel',event=>{
 event.preventDefault();if(drag||previewPan||!frames.length)return;
 const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?previewStage.clientHeight:1);
 const next=Math.max(.25,Math.min(8,previewZoom*Math.exp(-Math.max(-120,Math.min(120,delta))*.002)));
 const rect=previewStage.getBoundingClientRect(),x=event.clientX-rect.left-rect.width/2,y=event.clientY-rect.top-rect.height/2,ratio=next/previewZoom;
 previewOffsetX=x-(x-previewOffsetX)*ratio;previewOffsetY=y-(y-previewOffsetY)*ratio;previewZoom=next;applyPreviewView();
},{passive:false});

function alignTimelineSpans(){const tracks=$('keyframeTrack'),viewer=splitter.closest('.viewer');viewer.style.setProperty('--timeline-scrollbar',Math.max(0,tracks.offsetWidth-tracks.clientWidth)+'px');}
new ResizeObserver(alignTimelineSpans).observe($('keyframeTrack'));

function setTimelineHeight(height){
 const viewer=splitter.closest('.viewer'),panel=viewer.querySelector('.keyframe-panel'),style=getComputedStyle(viewer);
 const outerHeight=element=>{const css=getComputedStyle(element);return element.getBoundingClientRect().height+(parseFloat(css.marginTop)||0)+(parseFloat(css.marginBottom)||0);};
 const fixed=[...viewer.children].filter(element=>element.id!=='stage'&&element!==panel).reduce((total,element)=>total+outerHeight(element),0);
 const panelStyle=getComputedStyle(panel),titleHeight=panel.querySelector('.tracks-title').getBoundingClientRect().height;
 const padding=(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0);
 const panelSpace=titleHeight+(parseFloat(panelStyle.marginTop)||0)+(parseFloat(panelStyle.marginBottom)||0)+(parseFloat(panelStyle.borderTopWidth)||0)+(parseFloat(panelStyle.borderBottomWidth)||0);
 const max=Math.max(40,viewer.clientHeight-padding-fixed-panelSpace-100),value=Math.max(40,Math.min(max,height));
 document.documentElement.style.setProperty('--timeline-height',value+'px');splitter.setAttribute('aria-valuemin','40');splitter.setAttribute('aria-valuemax',String(Math.round(max)));splitter.setAttribute('aria-valuenow',String(Math.round(value)));
}

splitter.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();splitDrag={y:event.clientY,height:$('keyframeTrack').getBoundingClientRect().height};splitter.setPointerCapture(event.pointerId);document.body.classList.add('timeline-resizing');};
splitter.onpointermove=event=>{if(splitDrag)setTimelineHeight(splitDrag.height+splitDrag.y-event.clientY);};
function endSplit(){splitDrag=null;document.body.classList.remove('timeline-resizing');}
splitter.onpointerup=splitter.onpointercancel=splitter.onlostpointercapture=endSplit;
splitter.onkeydown=event=>{if(!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();setTimelineHeight($('keyframeTrack').getBoundingClientRect().height+(event.key==='ArrowUp'?20:-20));};
const completionDisabled=new Map();
const scales=Object.fromEntries(SCALE_KEYS.map(k=>[k,1]));
const labels={head_x:'头部宽度',head_y:'头部高度',neck:'脖子长度',shoulders:'肩宽',upper_arm:'上臂长度',lower_arm:'前臂长度',torso:'躯干长度',hips:'胯宽',upper_leg:'大腿长度',lower_leg:'小腿长度',hands:'手掌大小',feet:'脚部大小'};
const scaleRegions={head_x:[0,14,15,16,17],head_y:[0,14,15,16,17],neck:[1,0],shoulders:[2,1,5],upper_arm:[2,3,5,6],lower_arm:[3,4,6,7],torso:[1,8,11],hips:[8,11],upper_leg:[8,9,11,12],lower_leg:[9,10,12,13],hands:[4,7],feet:[10,13]};
const scaleHelp={head_x:'以鼻尖为中心调整头部和脸部宽度',head_y:'以鼻尖为中心调整头部和脸部高度，不改变脖子长度',neck:'胸肩交接点固定，移动整个头部和脸部',shoulders:'调整两肩间距，手臂随肩膀移动',upper_arm:'调整肩膀到手肘的长度，前臂和手掌跟随',lower_arm:'调整手肘到手腕的长度，手掌跟随',torso:'调整肩部到髋部的距离，双腿跟随',hips:'调整左右髋部间距，双腿跟随',upper_leg:'调整髋部到膝盖的长度，小腿和脚跟随',lower_leg:'调整膝盖到脚踝的长度，脚部跟随',hands:'以手腕为中心缩放手掌',feet:'以脚踝为中心缩放脚部'};
const colors=['#ff5555','#ffaa44','#ffee55','#99ee55','#44ee88','#55dddd','#55aaff','#aa77ff'];
const params=new URLSearchParams(location.search),token=params.get('session'),apiBase=params.get('api')||'/api/xiaozhuguang/pose/session/';
let frameRate=25;const rate=()=>Math.max(1,Math.min(240,Number(frameRate)||25));
const status=(text,isError=false)=>{const el=$('status');el.textContent=isError?text:'';el.hidden=!isError;};
let baseOpsCache=null,playheads=[];
function invalidateOperations(){baseOpsCache=null;}
function baseOperations(){
 if(!baseOpsCache||baseOpsCache.operations!==operations||baseOpsCache.handFixes!==handFixes){
  const list=[...handFixes,...operations],scaleTracks=new Map();
  for(const op of operations)if(op.type==='scale'&&(Number.isInteger(op.frame)||Number.isInteger(op.start))){const key=`${op.person}|${op.side??'both'}`;if(!scaleTracks.has(key))scaleTracks.set(key,[]);scaleTracks.get(key).push(op);}
  for(const [person,keys] of scaleTracks){keys.sort((a,b)=>a.frame-b.frame);scaleTracks.set(person,{keys:keys.filter(op=>!op.single_frame_only),singles:new Map(keys.filter(op=>op.single_frame_only).map(op=>[op.frame,op]))});}
  baseOpsCache={operations,handFixes,list,compiled:compileOperations(list),scaleTracks};
 }
 return baseOpsCache;
}
let selectedScaleSide='both';
const scaleSide=()=>selectedScaleSide;
const scaleSideJoints=side=>side==='left'?[5,6,7,11,12,13,15,17]:side==='right'?[2,3,4,8,9,10,14,16]:Array.from({length:18},(_,j)=>j);
const scaleHighlightRegion=()=>{const region=scaleRegions[hoveredScale]??[];return scaleSide()==='both'?region:region.filter(j=>scaleSideJoints(scaleSide()).includes(j));};
function selectScaleSide(side){if(scalesDirty)commitScale();selectedScaleSide=side;document.querySelectorAll('input[name=scaleSide]').forEach(input=>input.checked=input.value===side);updateScaleSideControls();}
function scaleAt(frame=current,person=Number($('person').value)){
 const track=baseOperations().scaleTracks.get(`${person}|${scaleSide()}`),single=track?.singles.get(frame);
 if(single&&isOperationActive(single,frame))return Object.fromEntries(SCALE_KEYS.map(k=>[k,single.values?.[k]??1]));
 const keys=track?.keys||[];
 if(!keys.length||!isOperationActive(keys[0],frame))return Object.fromEntries(SCALE_KEYS.map(k=>[k,1]));
 let a=keys[0],b=keys.at(-1);
 if(frame<=a.frame)b=a;else if(frame>=b.frame)a=b;else{let lo=1,hi=keys.length-1;while(lo<hi){const mid=(lo+hi)>>>1;if(keys[mid].frame<frame)lo=mid+1;else hi=mid;}a=keys[lo-1];b=keys[lo];}
 const t=a===b?0:(frame-a.frame)/(b.frame-a.frame);
 return Object.fromEntries(SCALE_KEYS.map(k=>[k,(a.values?.[k]??1)+((b.values?.[k]??1)-(a.values?.[k]??1))*t]));
}
function previewOp(){return scalesDirty?{type:'scale',side:scaleSide(),frame:current,person:Number($('person').value),values:{...scales}}:null;}
function editFrame(index=current){return frames[index];}
function allOps(){if(!scalesDirty&&!manualPreview&&!drag)return baseOperations().list;const op=previewOp(),base=operations.filter(item=>!(op&&item.type==='scale'&&item.person===op.person&&(item.side??'both')===op.side&&item.frame===current));return [...handFixes,...base,...(op?[op]:[]),...(manualPreview?[manualPreview]:[]),...(drag?[drag.op]:[])];}
function remember(){invalidateOperations();if(completionBatch)return;history.push({operations:clone(operations),handFixes:clone(handFixes)});if(history.length>100)history.shift();}
let scalesDirty=false,scalePreviewFrame=0;
function updateScalePreview(key,input){const value=Number(input.value);if(scales[key]===value)return;scales[key]=value;scalesDirty=true;input.nextElementSibling.value=value.toFixed(2);if(!scalePreviewFrame)scalePreviewFrame=requestAnimationFrame(()=>{scalePreviewFrame=0;draw();});}
function resetPreview(redraw=true){scalesDirty=false;const values=scaleAt();SCALE_KEYS.forEach(k=>scales[k]=values[k]);document.querySelectorAll('.slider').forEach(row=>{const key=row.dataset.key;row.querySelector('input').value=scales[key];row.querySelector('output').value=scales[key].toFixed(2);});if(redraw)draw();}
function commitScale(){if(!scalesDirty)return;remember();const person=Number($('person').value),at=operations.findIndex(op=>op.type==='scale'&&op.person===person&&(op.side??'both')===scaleSide()&&op.frame===current);const op=inheritScope({type:'scale',side:scaleSide(),frame:current,person,values:{...scales}});if(at>=0)operations[at]=op;else operations.push(op);scalesDirty=false;if(!trackActivationLocked)activeCompletionTrack={person,type:'scale',side:scaleSide()};updateOperations();draw();status(`已在第 ${current+1} 帧记录比例关键帧`);}
function upsert(op,accumulate=true){
 remember();const at=operations.findIndex(old=>old.type===op.type&&old.person===op.person&&old.frame===op.frame&&(Number.isInteger(op.frame)||(old.start===op.start&&old.end===op.end))&&(!['joint','set_joint'].includes(op.type)||old.joint===op.joint)&&(op.type!=='set_arm_front'||old.side===op.side));
 if(manualMode&&op.type==='set_joint'&&Number.isInteger(op.frame)){
  const keys=operations.filter(old=>old.type==='set_joint'&&!old.single_frame_only&&(old.person??-1)===(op.person??-1)&&old.joint===op.joint&&Number.isInteger(old.frame));
  if(at>=0){op.active_ranges=clone(operations[at].active_ranges||[[op.frame,op.frame]]);op.completion_pending=operations[at].completion_pending===true;}
  else{
   const anchor=keys.find(old=>old.completion_pending===true),ranges=keys.flatMap(old=>old.active_ranges||[[old.frame,old.frame]]),withinInterval=keys.some(old=>!old.completion_pending&&old.active_ranges?.some(([start,end])=>start<end&&op.frame>=start&&op.frame<=end));
   if(withinInterval){op.completion_pending=false;}
   else if(anchor){ranges.push([Math.min(anchor.frame,op.frame),Math.max(anchor.frame,op.frame)]);anchor.completion_pending=false;op.completion_pending=false;}
   else{ranges.push([op.frame,op.frame]);op.completion_pending=true;}
   op.active_ranges=mergeRanges(ranges);for(const old of keys)old.active_ranges=clone(op.active_ranges);
  }
 }else inheritScope(op);
 if(at>=0&&operations[at].single_frame_only){op.single_frame_only=true;op.active_ranges=clone(operations[at].active_ranges);op.interval_ranges=clone(operations[at].interval_ranges||[]);}
 if(at>=0){if(accumulate&&['translate','joint'].includes(op.type)){op.dx+=operations[at].dx||0;op.dy+=operations[at].dy||0;}operations[at]=op;}else operations.push(op);
 if(!trackActivationLocked){activeCompletionTrack={person:op.person,joint:op.joint,type:['joint','set_joint'].includes(op.type)?'joint':op.type};if(manualMode&&op.type==='set_joint')pendingJoint=op.joint;}
 if(completionBatch)invalidateOperations();else{updateOperations();draw();}
}
let timelineZoom=1,timelineStart=0,timelineViewRequest=0;
function timelineSpan(){return Math.max(1,frames.length-1)/timelineZoom;}
function timelinePercent(frame){return (frame-timelineStart)/timelineSpan()*100;}
function timelineFrame(fraction){return Math.max(0,Math.min(frames.length-1,timelineStart+fraction*timelineSpan()));}
function positionTimelineBand(band,start,end){band.dataset.start=start;band.dataset.end=end;band.style.left=timelinePercent(start)+'%';band.style.width=((end-start)/timelineSpan()*100)+'%';}
function refreshTimelineView(){
 drawTimelineTicks();updatePlayheads();
 $('keyframeTrack').querySelectorAll('.keyframe-marker').forEach(marker=>marker.style.left=timelinePercent(Number(marker.dataset.frame))+'%');
 $('keyframeTrack').querySelectorAll('.track-range').forEach(band=>positionTimelineBand(band,Number(band.dataset.start),Number(band.dataset.end)));
}
function scheduleTimelineView(){if(timelineViewRequest)return;timelineViewRequest=requestAnimationFrame(()=>{timelineViewRequest=0;refreshTimelineView();});}
function updatePlayheads(){updateTimelineHead(current);const position=timelinePercent(current);playheads.forEach(head=>{head.style.left=position+'%';head.hidden=position<0||position>100;});}
let keyframeMenu=null;
function closeKeyframeMenu(){keyframeMenu?.remove();keyframeMenu=null;}
document.addEventListener('pointerdown',event=>{if(!keyframeMenu?.contains(event.target))closeKeyframeMenu();},true);
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeKeyframeMenu();});
window.addEventListener('resize',closeKeyframeMenu);document.addEventListener('scroll',closeKeyframeMenu,true);
function showKeyframeMenu(event,items){
 event.preventDefault();event.stopPropagation();pause();closeKeyframeMenu();
 const menu=document.createElement('div');menu.className='keyframe-context-menu';menu.setAttribute('role','menu');keyframeMenu=menu;
 for(const [label,action] of items){const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('role','menuitem');button.onclick=()=>{closeKeyframeMenu();action();};menu.append(button);}
 document.body.append(menu);const box=menu.getBoundingClientRect();menu.style.left=Math.max(4,Math.min(event.clientX,innerWidth-box.width-4))+'px';menu.style.top=Math.max(4,Math.min(event.clientY,innerHeight-box.height-4))+'px';menu.querySelector('button')?.focus();
}
function sameTrack(a,b){return (a.person??-1)===(b.person??-1)&&(a.type===b.type||(['joint','set_joint'].includes(a.type)&&['joint','set_joint'].includes(b.type)))&&(!['joint','set_joint'].includes(a.type)||a.joint===b.joint)&&(a.type!=='scale'||(a.side??'both')===(b.side??'both'));}
function inheritScope(op){const source=operations.find(old=>!old.single_frame_only&&sameTrack(old,op)&&Array.isArray(old.active_ranges));op.active_ranges=source?clone(source.active_ranges):[[0,frames.length-1]];return op;}
function setKeyFrameOnly(ops,enabled=true){
 remember();for(const op of ops){
  if(enabled){if(!op.single_frame_only)op.interval_ranges=clone(op.active_ranges||[[0,frames.length-1]]);op.single_frame_only=true;op.completion_pending=false;op.active_ranges=[[op.frame??op.start,op.frame??op.start]];if(!Number.isInteger(op.frame)){op.frame=op.start??0;delete op.start;delete op.end;}}
  else{op.single_frame_only=false;op.active_ranges=clone(op.interval_ranges||[[0,frames.length-1]]);delete op.interval_ranges;}
 }
 updateOperations();resetPreview();
}
function mergeRanges(ranges){const sorted=ranges.map(span=>[...span]).sort((a,b)=>a[0]-b[0]),result=[];for(const span of sorted){const last=result.at(-1);if(last&&span[0]<=last[1]+1)last[1]=Math.max(last[1],span[1]);else result.push(span);}return result;}
function applyTrackRange(track,start,end,mode='replace'){
 remember();const old=track.ops.find(op=>Array.isArray(op.active_ranges))?.active_ranges;
 let ranges=[[start,end]];
 if(mode==='add')ranges=mergeRanges([...(old||[]),...ranges]);
 if(mode==='remove'){ranges=[];for(const [a,b] of old||[[0,frames.length-1]]){if(b<start||a>end)ranges.push([a,b]);else{if(a<start)ranges.push([a,start-1]);if(b>end)ranges.push([end+1,b]);}}}
 for(const op of track.ops){if(op.single_frame_only)continue;op.completion_pending=false;op.active_ranges=clone(ranges);if(!Number.isInteger(op.frame)){op.frame=op.start??0;delete op.start;delete op.end;}}
 updateOperations();resetPreview();
}
function paintActiveRange(lane,start,end){const band=document.createElement('span');band.className='track-range active-range';positionTimelineBand(band,start,end);if(start===end)band.classList.add('single-frame-range');lane.append(band);}
function activeTrackMatches(person,joint,type='joint',side='both'){return activeCompletionTrack?.person===person&&activeCompletionTrack?.joint===joint&&(activeCompletionTrack.type||'joint')===type&&(type!=='scale'||(activeCompletionTrack.side??'both')===side);}
function activeOperationMatches(op){return activeCompletionTrack&&(op.person??-1)===activeCompletionTrack.person&&((activeCompletionTrack.type||'joint')==='joint'?(['joint','set_joint'].includes(op.type)&&op.joint===activeCompletionTrack.joint):op.type===activeCompletionTrack.type&&(op.type!=='scale'||(op.side??'both')===(activeCompletionTrack.side??'both')));}
function syncTrackActivation(){
 $('keyframeTrack').querySelectorAll('[data-track-type]').forEach(row=>{
  const joint=Number(row.dataset.completionJoint),active=activeTrackMatches(Number(row.dataset.completionPerson),joint===-1?undefined:joint,row.dataset.trackType,row.dataset.trackSide||'both');
  row.classList.toggle('completion-track-active',active);row.setAttribute('aria-selected',String(active));
  const lock=row.querySelector('.track-lock'),locked=active&&trackActivationLocked;lock.hidden=false;lock.setAttribute('aria-pressed',String(locked));lock.title=locked?'解锁当前轨道':'激活并锁定此轨道';lock.setAttribute('aria-label',lock.title);
  lock.innerHTML=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="${locked?'M8 10V7a4 4 0 0 1 8 0v3':'M8 10V7a4 4 0 0 1 8 0'}"/></svg>`;
 });
}
function activateCompletionTrack(person,joint,type='joint',side='both'){
 if(trackActivationLocked&&!activeTrackMatches(person,joint,type,side))return;
 activeCompletionTrack={person,joint,type,side};if(type==='scale'){selectScaleSide(side);}pendingJoint=manualMode&&Number.isInteger(joint)?joint:null;manualPreview=null;
 if(person>=0&&Number($('person').value)!==person){$('person').value=person;resetPreview();}
 syncTrackActivation();poseMap.querySelectorAll('.pose-joint').forEach(item=>item.classList.toggle('selected',Number(item.dataset.joint)===joint));draw();
}
function renderKeyframes(){
 closeKeyframeMenu();
 const container=$('keyframeTrack');container.replaceChildren();playheads=[];if(!frames.length)return;
 const selected=Number($('person').value),count=Math.max(...frames.map(frame=>frame.people.length));
 const persons=selected===-1?Array.from({length:count},(_,i)=>i):[selected];
 if(selected===-1&&operations.some(op=>(op.person??-1)===-1&&(Number.isInteger(op.frame)||Number.isInteger(op.start))))persons.unshift(-1);
 for(const person of persons){
  const heading=document.createElement('div');heading.className='track-heading';heading.textContent=person===-1?'所有人物':`人物 ${person+1}`;
  const personOps=operations.filter(op=>(op.person??-1)===person&&(Number.isInteger(op.frame)||Number.isInteger(op.start)));
  const tracks=BODY_NAMES.map((name,joint)=>({joint,label:`${joint+1}. ${name}`,ops:personOps.filter(op=>['joint','set_joint'].includes(op.type)&&op.joint===joint)})).filter(track=>track.ops.length);
  for(const [type,label] of [['translate','整体平移'],['swap_arms','左右手臂']]){const ops=personOps.filter(op=>op.type===type);if(ops.length)tracks.push({type,label,ops});}
  for(const [side,label] of [['both','身体比例'],['left','身体比例 · 左侧'],['right','身体比例 · 右侧']]){const ops=personOps.filter(op=>op.type==='scale'&&(op.side??'both')===side);if(ops.length)tracks.push({type:'scale',side,label,ops});}
  if(!tracks.length)continue;container.append(heading);
  for(const track of tracks){
   const row=document.createElement('div');row.className='keyframe-row';
   const label=document.createElement('span');label.className='track-label';label.textContent=track.label;row.append(label);
   const trackType=track.type||'joint',trackSide=track.side||'both';
   row.dataset.completionPerson=person;row.dataset.completionJoint=Number.isInteger(track.joint)?track.joint:-1;row.dataset.trackType=trackType;row.dataset.trackSide=trackSide;row.tabIndex=0;row.title='点击激活轨道；使用锁图标固定当前轨道';
   const lock=document.createElement('button');lock.type='button';lock.className='track-lock';lock.hidden=true;label.append(lock);
   lock.onclick=event=>{event.stopPropagation();if(activeTrackMatches(person,track.joint,trackType,trackSide)&&trackActivationLocked){trackActivationLocked=false;}else{trackActivationLocked=false;activateCompletionTrack(person,track.joint,trackType,trackSide);trackActivationLocked=true;}syncTrackActivation();draw();};
   row.addEventListener('click',event=>{if(!event.target.closest('.track-lock'))activateCompletionTrack(person,track.joint,trackType,trackSide);},{capture:true});
   row.addEventListener('keydown',event=>{if(event.target===row&&(event.key==='Enter'||event.key===' ')){event.preventDefault();activateCompletionTrack(person,track.joint,trackType,trackSide);}});

   const deleteTrackItems=[['删除轨道',()=>{
    remember();if(drag&&track.ops.some(op=>sameTrack(op,drag.op)))drag=null;
    manualPreview=null;operations=operations.filter(op=>!track.ops.includes(op));
    if(activeTrackMatches(person,track.joint,trackType,trackSide)){activeCompletionTrack=null;trackActivationLocked=false;}
    if(Number($('person').value)===person&&pendingJoint===track.joint){pendingJoint=null;poseMap.querySelectorAll('.pose-joint').forEach(item=>item.classList.remove('selected'));}
    updateOperations();resetPreview();
   }]];
   const trackMenuItems=deleteTrackItems;
   row.oncontextmenu=event=>showKeyframeMenu(event,trackMenuItems);
   const lane=document.createElement('div');lane.className='joint-track';if(track.ops.some(op=>op.type==='set_joint'))lane.classList.add('completion-track');lane.setAttribute('aria-label',heading.textContent+' '+track.label+'关键帧');row.append(lane);
   const head=document.createElement('span');head.className='track-playhead';lane.append(head);playheads.push(head);
   lane.onclick=event=>{if(!frames.length||event.target.closest('button'))return;if(scalesDirty)commitScale();pause();const rect=lane.getBoundingClientRect();setFrame(Math.round(timelineFrame(Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)))));};
   const intervalOps=track.ops.filter(op=>!op.single_frame_only),explicit=intervalOps.find(op=>Array.isArray(op.active_ranges));
   if(explicit)for(const [start,end] of explicit.active_ranges){if(start===end&&intervalOps.some(op=>op.frame===start&&op.completion_pending))continue;paintActiveRange(lane,start,end);}
   else if(intervalOps.some(op=>Number.isInteger(op.frame)))paintActiveRange(lane,0,frames.length-1);
   else for(const [start,end] of mergeRanges(intervalOps.map(op=>[op.start??0,op.end??frames.length-1])))paintActiveRange(lane,start,end);
   for(const op of track.ops.filter(op=>op.single_frame_only))paintActiveRange(lane,op.frame,op.frame);
   lane.oncontextmenu=event=>{
    if(manualMode){if(deleteTrackItems.length)showKeyframeMenu(event,deleteTrackItems);else{event.preventDefault();event.stopPropagation();}return;}
    const positions=[...new Set(track.ops.filter(op=>Number.isInteger(op.frame)).map(op=>op.frame))].sort((a,b)=>a-b),rect=lane.getBoundingClientRect(),clicked=timelineFrame(Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)));
    const right=positions.findIndex(frame=>frame>clicked);if(right<1){showKeyframeMenu(event,trackMenuItems);return;}
    const start=positions[right-1],end=positions[right];
    showKeyframeMenu(event,[['仅此区间生效（第 '+(start+1)+'–'+(end+1)+' 帧）',()=>applyTrackRange(track,start,end)],['添加此区间到生效范围',()=>applyTrackRange(track,start,end,'add')],['取消此区间生效',()=>applyTrackRange(track,start,end,'remove')],...trackMenuItems]);
   };
   const keyed=new Map();for(const op of track.ops){const key=Number.isInteger(op.frame)?`frame:${op.frame}`:`range:${op.start}:${op.end}`;if(!keyed.has(key))keyed.set(key,[]);keyed.get(key).push(op);}

   for(const ops of keyed.values()){const frame=ops[0].frame??ops[0].start;
    const marker=document.createElement('button');marker.type='button';marker.className='keyframe-marker';
    if(ops.some(op=>op.deleted))marker.classList.add('deleted-key');
    if(ops.some(op=>op.needs_adjustment))marker.classList.add('unadjusted-key');
    marker.dataset.frame=frame;marker.style.left=timelinePercent(frame)+'%';
    marker.title=`${heading.textContent} · ${track.label} · ${Number.isInteger(ops[0].frame)?'第 '+(frame+1)+' 帧':'补全第 '+(ops[0].start+1)+' 至 '+(ops[0].end+1)+' 帧'}（点击跳转，右键设置生效范围或删除）`;marker.setAttribute('aria-label',marker.title);
    marker.onclick=event=>{event.stopPropagation();if(scalesDirty)commitScale();pause();setFrame(frame);};
    marker.oncontextmenu=event=>{
     const deleteItem=['删除关键帧',()=>{remember();operations=operations.filter(op=>!ops.includes(op));updateOperations();resetPreview();}];
     showKeyframeMenu(event,[deleteItem,...deleteTrackItems]);
    };
    lane.append(marker);
   }
   container.append(row);
  }
 }
 syncTrackActivation();updatePlayheads();alignTimelineSpans();
}
function updateOperations(){if(activeCompletionTrack&&!operations.some(activeOperationMatches)){activeCompletionTrack=null;trackActivationLocked=false;pendingJoint=null;}invalidateOperations();renderKeyframes();}
function initialize(data){if(!Array.isArray(data)||!data.length)throw Error('骨骼数组为空');data.forEach(f=>{if(!Number.isFinite(f.canvas_width)||f.canvas_width<=0||!Number.isFinite(f.canvas_height)||f.canvas_height<=0||!Array.isArray(f.people))throw Error('骨骼帧格式无效');f.people.forEach(p=>{for(const [key,flat]of Object.entries(p)){if(key.endsWith('_keypoints_2d')&&(!Array.isArray(flat)||flat.length%3||flat.some(v=>!Number.isFinite(v))))throw Error('关节点格式无效');}if(p.pose_keypoints_2d?.length!==54)throw Error('需要 SDPOSE / OpenPose 18 身体关节');});});frames=clone(data);timelineZoom=1;timelineStart=0;current=0;operations=[];handFixes=[{type:'swap_hands',person:-1}];finishManual();history=[];$('seek').max=frames.length-1;drawTimelineTicks();const count=Math.max(...frames.map(f=>f.people.length));$('person').replaceChildren();for(let i=-1;i<count;i++){const option=document.createElement('option');option.value=i;option.textContent=i===-1?'所有人物':`人物 ${i+1}`;$('person').append(option);}$('info').textContent=`${frames.length} 帧 · 最多 ${count} 人 · SDPOSE 全身骨骼`;resetPreview();updateOperations();resize();setFrame(0);}
function resize(){
 const frame=frames[current];if(!frame)return;const box=$('stage'),ratio=frame.canvas_width/frame.canvas_height;
 previewPoseWidth=Math.min(box.clientWidth,box.clientHeight*ratio);previewPoseHeight=previewPoseWidth/ratio;
 previewPoseLeft=(box.clientWidth-previewPoseWidth)/2;previewPoseTop=(box.clientHeight-previewPoseHeight)/2;
 const dpr=devicePixelRatio||1,pixelWidth=Math.round(box.clientWidth*dpr),pixelHeight=Math.round(box.clientHeight*dpr);
 canvas.style.width=box.clientWidth+'px';canvas.style.height=box.clientHeight+'px';
 if(canvas.width!==pixelWidth)canvas.width=pixelWidth;if(canvas.height!==pixelHeight)canvas.height=pixelHeight;
 ctx.setTransform(dpr,0,0,dpr,0,0);draw();
}
function posePointerBounds(){
 const rect=canvas.getBoundingClientRect(),scaleX=rect.width/(parseFloat(canvas.style.width)||1),scaleY=rect.height/(parseFloat(canvas.style.height)||1);
 return {left:rect.left+previewPoseLeft*scaleX,top:rect.top+previewPoseTop*scaleY,width:previewPoseWidth*scaleX,height:previewPoseHeight*scaleY};
}
function drawFrame(frame){updateCompletionHint(frame);const w=previewPoseWidth,h=previewPoseHeight,sx=w/frame.canvas_width,sy=h/frame.canvas_height,selected=Number($('person').value),locked=trackActivationLocked&&Boolean(activeCompletionTrack),lockedJoint=activeCompletionTrack?.joint,lockedType=activeCompletionTrack?.type||'joint',region=locked?(lockedType==='joint'?[lockedJoint,...BODY_EDGES.flatMap(([a,b])=>a===lockedJoint?[b]:b===lockedJoint?[a]:[]),...(lockedJoint===0?[14,15,16,17]:[])]:lockedType==='swap_arms'?[2,3,4,5,6,7]:Array.from({length:18},(_,j)=>j)):scaleHighlightRegion(),focused=locked||(!manualMode&&region.length>0);ctx.save();ctx.filter=`saturate(${Number($('saturation').value)})`;ctx.lineWidth=Number($('lineWidth').value);
 function group(flat,edges,color,radius,active){const points=[];for(let i=0;i<flat.length;i+=3)points.push([flat[i]*sx,flat[i+1]*sy,flat[i+2]]);edges.forEach(([a,b],n)=>{if(!points[a]||!points[b]||points[a][2]<=.3||points[b][2]<=.3)return;const original=edges===orderedBodyEdges?BODY_EDGES.findIndex(edge=>edge[0]===a&&edge[1]===b):n;ctx.strokeStyle=focused&&!active(a,b)?'#707780':color||colors[(original<0?n:original)%colors.length];ctx.beginPath();ctx.moveTo(...points[a].slice(0,2));ctx.lineTo(...points[b].slice(0,2));ctx.stroke();});points.forEach(([x,y,score],i)=>{if(score<=.3)return;ctx.fillStyle=focused&&!active(i)?'#707780':color||'#fff';ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();});}
 frame.people.forEach((p,person)=>{const matches=locked?activeCompletionTrack.person===-1||activeCompletionTrack.person===person:selected===-1||selected===person,bodyActive=(a,b)=>matches&&(locked&&lockedType==='joint'?(b===undefined?a===lockedJoint:a===lockedJoint||b===lockedJoint):region.includes(a)&&(b===undefined||region.includes(b))),headActive=()=>matches&&(locked?(lockedType==='joint'?lockedJoint===0:lockedType!=='swap_arms'):(region.includes(0)||['head_x','head_y','neck'].includes(hoveredScale)));const armOps=allOps().filter(op=>op.type==='set_arm_front'&&(op.person===-1||op.person===person)&&op.frame<=current).sort((a,b)=>a.frame-b.frame),front=armOps.at(-1)?.side??'left',rightEdges=BODY_EDGES.slice(1,4),leftEdges=BODY_EDGES.slice(4,7),restEdges=BODY_EDGES.filter((_,i)=>![1,2,3,4,5,6].includes(i)),orderedBodyEdges=front==='right'?[...leftEdges,...restEdges,...rightEdges]:[...rightEdges,...restEdges,...leftEdges];group(p.pose_keypoints_2d,orderedBodyEdges,null,4,bodyActive);group(p.face_keypoints_2d??[],[],'#fff',1.3,headActive);const handEdges=[];for(const root of [1,5,9,13,17])for(let j=0;j<4;j++)handEdges.push([j===0?0:root+j-1,root+j]);group(p.hand_left_keypoints_2d??[],handEdges,'#66dddd',2,()=>matches&&(locked?(lockedType!=='joint'?lockedType!=='scale'||region.includes(7):lockedJoint===7):hoveredScale==='hands'&&scaleSide()!=='right'));group(p.hand_right_keypoints_2d??[],handEdges,'#ffbb66',2,()=>matches&&(locked?(lockedType!=='joint'?lockedType!=='scale'||region.includes(4):lockedJoint===4):hoveredScale==='hands'&&scaleSide()!=='left'));group(p.foot_keypoints_2d??[],[[0,1],[0,2],[3,4],[3,5]],'#a8ec77',2,()=>matches&&(locked?(lockedType==='joint'?[10,13].includes(lockedJoint):lockedType!=='swap_arms'):hoveredScale==='feet'));});
 ctx.restore();const drawn=allOps().filter(op=>op.type==='set_joint'&&isOperationActive(op,current));ctx.save();ctx.font='600 11px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';frame.people.forEach((p,person)=>{if(selected!==-1&&selected!==person)return;const body=p.pose_keypoints_2d;for(let joint=0;joint<18;joint++){if(body[joint*3+2]<=.3)continue;const lx=body[joint*3]*sx+13,ly=body[joint*3+1]*sy-12;ctx.fillStyle='#101820dd';ctx.beginPath();ctx.arc(lx,ly,9,0,Math.PI*2);ctx.fill();if(drawn.some(op=>op.joint===joint&&(op.person===person||op.person===-1))){ctx.strokeStyle=(locked?((activeCompletionTrack.person!==-1&&person!==activeCompletionTrack.person)||(lockedType==='joint'?joint!==lockedJoint:!region.includes(joint))):focused&&!region.includes(joint))?'#707780':'#ff6666';ctx.lineWidth=2;ctx.stroke();}ctx.fillStyle=(locked?((activeCompletionTrack.person!==-1&&person!==activeCompletionTrack.person)||(lockedType==='joint'?joint!==lockedJoint:!region.includes(joint))):focused&&!region.includes(joint))?'#707780':'#a7ed7c';ctx.fillText(String(joint+1),lx,ly);}});ctx.restore();
}
function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);if(!frames.length)return;const displayed=drag?applyFrame(drag.baseFrame,current,[drag.op],frames.length):applyFrame(editFrame(),current,!scalesDirty&&!manualPreview?baseOperations().compiled:allOps(),frames.length);ctx.save();ctx.translate(previewPoseLeft,previewPoseTop);drawFrame(displayed);ctx.restore();if(manualMode){const person=Number($('person').value),body=displayed.people[person]?.pose_keypoints_2d,drawn=allOps().filter(op=>op.type==='set_joint'&&(op.person===person||op.person===-1)&&isOperationActive(op,current));$('completeMissing').disabled=pendingJoint===null||!frames.some(frame=>frame.people[person]&&!(frame.people[person].pose_keypoints_2d[pendingJoint*3+2]>.3));$('completeMissing').textContent=pendingJoint===null?'一键补全此编号':`一键补全 ${pendingJoint+1}. ${BODY_NAMES[pendingJoint]}`;document.querySelectorAll('#poseMap .pose-joint').forEach(item=>{const joint=Number(item.dataset.joint),missing=!(body?.[joint*3+2]>.3);item.classList.toggle('missing',missing);item.classList.toggle('drawn',!missing&&drawn.some(op=>op.joint===joint));item.querySelector('title').textContent=`${BODY_NAMES[joint]}${missing?'（缺失）':''}`;});}}
const frameLoader=new FrameLoader(index=>new Promise((resolve,reject)=>{
 const img=new Image(),timer=setTimeout(()=>{img.onload=img.onerror=null;reject(Error('视频帧加载超时，请检查 ComfyUI 是否仍在运行'));},15000);
 img.onload=()=>{clearTimeout(timer);resolve(img);};img.onerror=()=>{clearTimeout(timer);reject(Error('视频帧加载失败，请重新执行编辑节点刷新预览缓存'));};
 img.src=apiBase+encodeURIComponent(token)+'/image/'+index;
}));
function commitFrame(index,image=null){
 if(drag&&index!==current)endDrag();
 if(index!==current&&manualMode){manualPreview=null;pendingJoint=activeCompletionTrack?.person===Number($('person').value)?activeCompletionTrack.joint:null;poseMap.querySelectorAll('.pose-joint').forEach(item=>item.classList.toggle('selected',pendingJoint!==null&&Number(item.dataset.joint)===pendingJoint));$('poseSelection').textContent=pendingJoint!==null?'拖动预览区，继续调整已激活的补全关节。':'请选择关节编号，拖动确定下一个补全位置。';}
 current=index;updatePlayheads();$('seek').value=current;$('frameLabel').textContent=`第 ${current+1} / ${frames.length} 帧`;resetPreview(false);
 const showLocal=Boolean(videoURL),showOriginal=!showLocal&&$('showBackground').checked;$('video').style.visibility=showLocal?'visible':'hidden';
 if(image&&showOriginal){const previous=$('background');image.id='background';image.alt='原视频帧';image.hidden=false;if(previous!==image)previous.replaceWith(image);}else $('background').hidden=true;
 if(videoURL)$('video').currentTime=current/rate();resize();
}
const presenter=new FramePresenter(frameLoader,commitFrame,(error,index)=>{pause();$('seek').value=current;status(`第 ${index+1} 帧：${error.message}`,true);});
async function setFrame(f){
 if(drag)endDrag();
 if(!frames.length)return false;const target=Math.max(0,Math.min(frames.length-1,Math.round(f)));
 if(sessionData?.has_images&&!videoURL&&$('showBackground').checked){
  // Keep the last complete frame visible until the matching background image is ready.
  const shown=await presenter.show(target);
  if(shown)frameLoader.prefetch([target+1,target+2].filter(i=>i<frames.length));
  return shown;
 }
 presenter.cancel();commitFrame(target);return true;
}
function background(){if($('showBackground').checked&&videoURL){URL.revokeObjectURL(videoURL);videoURL=null;$('video').pause();$('video').removeAttribute('src');$('video').load();status('已切换回节点原视频');}return setFrame(current);}
function pause(){playing=false;playbackGeneration++;presenter.cancel();$('play').textContent='▶ 播放';$('video').pause();}
async function tick(time){
 if(!playing)return;const generation=playbackGeneration,interval=1000/rate();
 if(time-lastTick>=interval){
  const elapsed=time-lastTick,steps=Math.max(1,Math.floor(elapsed/interval));lastTick+=steps*interval;
  if(current>=frames.length-1){pause();return;}
  const shown=await setFrame(Math.min(frames.length-1,current+steps));
  if(!playing||generation!==playbackGeneration)return;
  if(!shown){pause();return;}
 }
 if(playing)requestAnimationFrame(tick);
}
const svgNS='http://www.w3.org/2000/svg',poseMap=$('poseMap'),posePoints=[[125,42],[125,88],[91,95],[58,132],[43,170],[159,95],[192,132],[207,170],[105,174],[99,240],[94,310],[145,174],[151,240],[156,310],[116,37],[134,37],[103,43],[147,43]];
for(const [a,b] of BODY_EDGES){const line=document.createElementNS(svgNS,'line');line.setAttribute('x1',posePoints[a][0]);line.setAttribute('y1',posePoints[a][1]);line.setAttribute('x2',posePoints[b][0]);line.setAttribute('y2',posePoints[b][1]);line.setAttribute('class','pose-bone');poseMap.append(line);}
const reliableJointCache=new WeakMap();
const jointParent=[1,null,1,2,3,1,5,6,1,8,9,1,11,12,0,0,14,15];
const jointOpposite={2:5,3:6,4:7,5:2,6:3,7:4,8:11,9:12,10:13,11:8,12:9,13:10};
const median=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:null;};
const hasJoint=(body,j)=>Number.isInteger(j)&&body?.[j*3+2]>.3&&Number.isFinite(body[j*3])&&Number.isFinite(body[j*3+1]);
// Use height for both axes so angles and limb lengths are not distorted by aspect ratio.
const jointPosition=(body,j,height)=>[body[j*3]/height,body[j*3+1]/height];
const jointDistance=(body,a,b,height)=>Math.hypot((body[a*3]-body[b*3])/height,(body[a*3+1]-body[b*3+1])/height);
function bodySize(body,width,height){
 const sizes=[];
 for(const [a,b] of [[1,8],[1,11],[2,5],[8,11]])if(hasJoint(body,a)&&hasJoint(body,b)){const length=jointDistance(body,a,b,height);if(length>.01)sizes.push({a,b,length});}
 return sizes[0]||null;
}
function reliableJointSamples(person,joint){
 const batchKey=`${person}|${joint}`;if(batchReliableSamples?.has(batchKey))return batchReliableSamples.get(batchKey);
 const base=baseOperations();let cache=reliableJointCache.get(base.compiled);if(!cache){cache=new Map();reliableJointCache.set(base.compiled,cache);}
 if(cache.has(batchKey))return cache.get(batchKey);
 const trusted=operations.filter(op=>!op.needs_adjustment),compiled=compileOperations([...handFixes,...trusted]);
 const edited=new Set(trusted.filter(op=>['joint','set_joint'].includes(op.type)&&((op.person??-1)===person||(op.person??-1)===-1)&&op.joint===joint&&Number.isInteger(op.frame)&&isOperationActive(op,op.frame)).map(op=>op.frame));
 const candidates=[];
 for(let index=0;index<frames.length;index++){
  const raw=frames[index].people[person]?.pose_keypoints_2d;if(!hasJoint(raw,joint)&&!edited.has(index))continue;
  const sample=applyFrame(frames[index],index,compiled,frames.length),body=sample.people[person]?.pose_keypoints_2d;if(!hasJoint(body,joint))continue;
  const manual=edited.has(index);if(!manual&&raw[joint*3+2]<.5)continue;
  const size=bodySize(body,sample.canvas_width,sample.canvas_height),parent=jointParent[joint];
  const ratio=size&&hasJoint(body,parent)?jointDistance(body,joint,parent,sample.canvas_height)/size.length:null;
  candidates.push({index,body,width:sample.canvas_width,height:sample.canvas_height,manual,confidence:manual?1:Math.min(1,raw[joint*3+2]),ratio});
 }
 const ratios=candidates.filter(sample=>sample.manual).map(sample=>sample.ratio).filter(v=>v!==null);
 const detectedRatios=candidates.map(sample=>sample.ratio).filter(v=>v!==null);
 const typical=median(ratios.length?ratios:detectedRatios),samples=candidates.filter((sample,i)=>{
  if(sample.manual)return true;
  // Reject implausibly long bones; short projected bones may be legitimate foreshortening.
  if(typical>.02&&detectedRatios.length>=5&&sample.ratio>typical*2.8)return false;
  const previous=candidates[i-1],next=candidates[i+1];
  if(!previous||!next||sample.index-previous.index>3||next.index-sample.index>3)return true;
  const anchor=[1,8,11,2,5].find(j=>j!==joint&&[previous,sample,next].every(item=>hasJoint(item.body,j)));
  if(anchor===undefined)return true;
  const offset=item=>{const p=jointPosition(item.body,joint,item.height),a=jointPosition(item.body,anchor,item.height);return [p[0]-a[0],p[1]-a[1]];};
  const a=offset(previous),b=offset(next),p=offset(sample),t=(sample.index-previous.index)/(next.index-previous.index),size=bodySize(sample.body,sample.width,sample.height)?.length??.2;
  const error=Math.hypot(p[0]-a[0]-(b[0]-a[0])*t,p[1]-a[1]-(b[1]-a[1])*t),motion=Math.hypot(b[0]-a[0],b[1]-a[1]);
  return !(error>size*.65&&error>motion*2);
 });
 cache.set(batchKey,samples);batchReliableSamples?.set(batchKey,samples);return samples;
}
function estimateCompletionPosition(frame,person,joint,index){
 const samples=reliableJointSamples(person,joint);if(!samples.length)return null;
 const trusted=operations.filter(op=>!op.needs_adjustment),reference=applyFrame(frames[index],index,compileOperations([...handFixes,...trusted]),frames.length),body=reference.people[person]?.pose_keypoints_2d;
 if(!body)return null;
 const width=frame.canvas_width,height=frame.canvas_height,maxGap=Math.max(12,Math.round(rate()*2));
 let lo=0,hi=samples.length;while(lo<hi){const mid=(lo+hi)>>>1;if(samples[mid].index<index)lo=mid+1;else hi=mid;}
 if(samples[lo]?.index===index){const sample=samples[lo];return {x:sample.body[joint*3]/sample.width,y:sample.body[joint*3+1]/sample.height,source:'current'};}
 // Prefer a nearby manual reference, while limiting how far a reference can propagate.
 const choose=(begin,step)=>{let best=null,bestScore=-Infinity;for(let i=begin;i>=0&&i<samples.length;i+=step){const sample=samples[i],distance=Math.abs(index-sample.index);if(distance>maxGap)break;const score=(sample.manual?2:sample.confidence)/(1+distance/6);if(score>bestScore){best=sample;bestScore=score;}}return best;};
 const left=choose(lo-1,-1),right=choose(lo,1);if(!left&&!right)return null;
 const sources=[left,right].filter(Boolean),neighbors=BODY_EDGES.flatMap(([a,b])=>a===joint?[b]:b===joint?[a]:[]);
 const anchor=[jointParent[joint],...neighbors,1,8,11,2,5].find(a=>a!==joint&&hasJoint(body,a)&&sources.every(sample=>hasJoint(sample.body,a)));
 if(anchor===undefined)return null;
 // Estimate scale from several stable body segments rather than a single changing bone.
 const sampleScale=sample=>{const ratios=[];for(const [a,b] of [[1,8],[1,11],[2,5],[8,11]])if(a!==joint&&b!==joint&&hasJoint(body,a)&&hasJoint(body,b)&&hasJoint(sample.body,a)&&hasJoint(sample.body,b)){const length=jointDistance(sample.body,a,b,sample.height);if(length>.01)ratios.push(jointDistance(body,a,b,height)/length);}return Math.max(.5,Math.min(2,median(ratios)??1));};
 const orientation=[[1,8],[1,11],[2,5],[8,11]].find(([a,b])=>a!==joint&&b!==joint&&hasJoint(body,a)&&hasJoint(body,b)&&sources.every(sample=>hasJoint(sample.body,a)&&hasJoint(sample.body,b)&&jointDistance(sample.body,a,b,sample.height)>.01)&&jointDistance(body,a,b,height)>.01);
 const predict=sample=>{
  const scale=sampleScale(sample),target=jointPosition(body,anchor,height),sourceAnchor=jointPosition(sample.body,anchor,sample.height),point=jointPosition(sample.body,joint,sample.height);let dx=(point[0]-sourceAnchor[0])*scale,dy=(point[1]-sourceAnchor[1])*scale;
  if(orientation){const [a,b]=orientation,angle=Math.atan2(body[b*3+1]-body[a*3+1],body[b*3]-body[a*3])-Math.atan2(sample.body[b*3+1]-sample.body[a*3+1],sample.body[b*3]-sample.body[a*3]),cos=Math.cos(angle),sin=Math.sin(angle);[dx,dy]=[dx*cos-dy*sin,dx*sin+dy*cos];}
  return {x:target[0]+dx,y:target[1]+dy,scale};
 };
 const a=predict(left||right),b=predict(right||left),t=left&&right?(index-left.index)/(right.index-left.index):0;
 let point=[a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t];
 const lengthTo=neighbor=>{const lengths=sources.map(sample=>hasJoint(sample.body,neighbor)?jointDistance(sample.body,joint,neighbor,sample.height)*sampleScale(sample):null);return lengths.length===2&&lengths.every(v=>v!==null)?lengths[0]+(lengths[1]-lengths[0])*t:lengths.find(v=>v!==null);};
 const available=neighbors.filter(j=>hasJoint(body,j)&&sources.every(sample=>hasJoint(sample.body,j)));
 // Elbows and knees: intersect circles from both connected joints, choosing the closer bend.
 if([3,6,9,12].includes(joint)&&available.length===2){
  const [u,v]=available,p=jointPosition(body,u,height),q=jointPosition(body,v,height),r=lengthTo(u),s=lengthTo(v),dx=q[0]-p[0],dy=q[1]-p[1],d=Math.hypot(dx,dy);
  if(r>0&&s>0&&d>1e-5&&d<=r+s&&d>=Math.abs(r-s)){
   const along=(r*r-s*s+d*d)/(2*d),offset=Math.sqrt(Math.max(0,r*r-along*along)),cx=p[0]+along*dx/d,cy=p[1]+along*dy/d;
   const options=[[cx-offset*dy/d,cy+offset*dx/d],[cx+offset*dy/d,cy-offset*dx/d]];point=options.reduce((best,p)=>Math.hypot(p[0]-point[0],p[1]-point[1])<Math.hypot(best[0]-point[0],best[1]-point[1])?p:best);
  }
 }else if(available.includes(anchor)){
  const origin=jointPosition(body,anchor,height),length=lengthTo(anchor),dx=point[0]-origin[0],dy=point[1]-origin[1],distance=Math.hypot(dx,dy);
  // Preserve projected bone length when angular interpolation would shrink the limb.
  if(length>0&&distance>1e-5)point=[origin[0]+dx/distance*length,origin[1]+dy/distance*length];
 }
 return {x:point[0]*height/width,y:point[1],source:'temporal'};
}
function defaultCompletionOperation(frame,person,index,frameIndex=current){
 const estimated=estimateCompletionPosition(frame,person,index,frameIndex);
 if(estimated)return {type:'set_joint',frame:frameIndex,person,joint:index,x:estimated.x,y:estimated.y,completion_source:estimated.source,needs_adjustment:true};
 const body=frame.people[person].pose_keypoints_2d,neighbors=BODY_EDGES.flatMap(([a,b])=>a===index?[b]:b===index?[a]:[]),anchor=neighbors.find(j=>body[j*3+2]>.3)??Array.from({length:18},(_,j)=>j).find(j=>j!==index&&body[j*3+2]>.3);
 let x=frame.canvas_width/2,y=frame.canvas_height/2;
 if(anchor!==undefined){const vx=posePoints[index][0]-posePoints[anchor][0],vy=posePoints[index][1]-posePoints[anchor][1],distance=Math.hypot(vx,vy)||1,length=Math.min(72,frame.canvas_height*.10);x=body[anchor*3]+vx/distance*length;y=body[anchor*3+1]+vy/distance*length;}
 return {type:'set_joint',frame:frameIndex,person,joint:index,x:x/frame.canvas_width,y:y/frame.canvas_height,completion_source:'fallback',needs_adjustment:true};
}
function choosePoseJoint(index){try{return choosePoseJointImpl(index);}catch(error){status(error.message,true);}}
function choosePoseJointImpl(index){pause();if(!trackActivationLocked)activeCompletionTrack=null;manualPreview=null;pendingJoint=index;const person=Number($('person').value);const frame=applyFrame(editFrame(),current,allOps(),frames.length),body=frame.people[person]?.pose_keypoints_2d;if(body){upsert(defaultCompletionOperation(frame,person,index));}draw();poseMap.querySelectorAll('.pose-joint').forEach(item=>item.classList.toggle('selected',Number(item.dataset.joint)===index));$('poseSelection').textContent=`${index+1}. ${BODY_NAMES[index]}：在工作区按住拖动绘制`; status(`已选择${BODY_NAMES[index]}，请在工作区按住拖动绘制。`);}
BODY_NAMES.forEach((name,index)=>{const group=document.createElementNS(svgNS,'g');group.setAttribute('class','pose-joint');group.setAttribute('tabindex','0');group.setAttribute('role','button');group.setAttribute('aria-label',name);group.dataset.joint=index;const title=document.createElementNS(svgNS,'title');title.textContent=name;const circle=document.createElementNS(svgNS,'circle');circle.setAttribute('cx',posePoints[index][0]);circle.setAttribute('cy',posePoints[index][1]);circle.setAttribute('r',index>13?8:11);const label=document.createElementNS(svgNS,'text');label.setAttribute('x',posePoints[index][0]);label.setAttribute('y',posePoints[index][1]+3);label.textContent=String(index+1);group.append(title,circle,label);group.onclick=()=>choosePoseJoint(index);group.oncontextmenu=e=>{e.preventDefault();deletePoseJoint(index);};group.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choosePoseJoint(index);}};poseMap.append(group);});
function setPoseMode(complete){if(complete&&!manualMode){document.querySelectorAll('button,input,select').forEach(control=>{if(control.classList.contains('track-lock'))return;if(['adjustPose','seek','prev','next','play','person','resetView','reset','close','completeMissing','usageHelp','helpClose'].includes(control.id))return;completionDisabled.set(control,control.disabled);control.disabled=true;});}else if(!complete&&manualMode){completionDisabled.forEach((disabled,control)=>control.disabled=disabled);completionDisabled.clear();}manualMode=complete;if(complete&&activeCompletionTrack&&!Number.isInteger(activeCompletionTrack.joint)){activeCompletionTrack=null;trackActivationLocked=false;}document.body.classList.toggle('pose-completion-mode',complete);$('adjustPose').textContent=complete?'确认补全':'姿势调节';$('adjustPose').classList.toggle('confirm-completion',complete);pendingJoint=complete?activeCompletionTrack?.joint??null:null;manualPreview=null;hoveredScale=null;$('posePicker').hidden=!complete;$('adjustPanel').hidden=complete;for(const [id,active] of [['adjustPose',!complete],['manualPose',complete]]){$(id).classList.toggle('active',active);$(id).setAttribute('aria-pressed',String(active));}poseMap.querySelectorAll('.pose-joint').forEach(item=>item.classList.remove('selected'));$('poseSelection').textContent='左键编号绘制，右键编号删除。';renderKeyframes();updateScaleSideControls();draw();}
function finishManual(){setPoseMode(false);}
$('adjustPose').onclick=finishManual;
function deletePoseJoint(joint){try{return deletePoseJointImpl(joint);}catch(error){status(error.message,true);}}
function deletePoseJointImpl(joint){if(!manualMode||!frames[current]?.people.length)return;pause();manualPreview=null;const person=Number($('person').value),frame=applyFrame(editFrame(),current,allOps(),frames.length),body=frame.people[person].pose_keypoints_2d;upsert({type:'set_joint',frame:current,person,joint,x:body[joint*3]/frame.canvas_width,y:body[joint*3+1]/frame.canvas_height,deleted:true});status(`已删除第 ${current+1} 帧的${BODY_NAMES[joint]}，可撤销或重新绘制。`);}
$('completeMissing').onclick=()=>{
 if(!manualMode||!frames.length||pendingJoint===null)return;pause();if(drag)endDrag();manualPreview=null;
 const person=Number($('person').value),joint=pendingJoint,ranges=[];let start=null;
 for(let frame=0;frame<=frames.length;frame++){
  const body=frames[frame]?.people[person]?.pose_keypoints_2d,missing=Boolean(body)&&!(body[joint*3+2]>.3);
  if(missing&&start===null)start=frame;
  if(!missing&&start!==null){ranges.push([start,frame-1]);start=null;}
 }
 if(!ranges.length)return;remember();completionBatch=true;batchReliableSamples=new Map();
 try{
  const existing=operations.filter(op=>op.type==='set_joint'&&op.person===person&&op.joint===joint&&!op.single_frame_only);
  const effective=mergeRanges([...existing.flatMap(op=>op.active_ranges||[[op.frame,op.frame]]),...ranges]);
  for(const op of existing){op.active_ranges=clone(effective);op.completion_pending=false;}
  invalidateOperations();
  for(const [first,last] of ranges)for(const index of new Set([first,last])){
   if(operations.some(op=>op.type==='set_joint'&&op.person===person&&op.joint===joint&&op.frame===index))continue;
   const preview=applyFrame(frames[index],index,baseOperations().compiled,frames.length),op=defaultCompletionOperation(preview,person,joint,index);
   op.active_ranges=clone(effective);op.completion_pending=false;operations.push(op);invalidateOperations();
  }
  if(!trackActivationLocked)activeCompletionTrack={person,joint};pendingJoint=joint;
 }catch(error){status(error.message,true);}
 finally{completionBatch=false;batchReliableSamples=null;updateOperations();draw();}
};
$('manualPose').onclick=()=>{pause();if(scalesDirty)commitScale();if(!frames[current]?.people.length){status('当前帧没有可补画的人物');return;}if(Number($('person').value)<0){$('person').value='0';$('person').dispatchEvent(new Event('change'));}setPoseMode(true);};

function jumpKeyframe(direction){
 if(scalesDirty)commitScale();if(drag)endDrag();pause();
 const person=Number($('person').value),active=activeCompletionTrack;
 const positions=[...new Set(operations.filter(op=>active?activeOperationMatches(op):(person===-1||(op.person??-1)===person)).map(op=>op.frame??op.start).filter(Number.isInteger))].sort((a,b)=>a-b);
 const target=direction<0?positions.filter(frame=>frame<current).at(-1):positions.find(frame=>frame>current);
 if(target===undefined)return;
 setFrame(target).then(shown=>{if(!shown||current!==target)return;if(target<timelineStart||target>timelineStart+timelineSpan()){timelineStart=Math.max(0,Math.min(Math.max(0,frames.length-1-timelineSpan()),target-timelineSpan()/2));scheduleTimelineView();}});
}
document.addEventListener('keydown',event=>{
 if(helpDialog.open||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||!frames.length||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
 event.preventDefault();event.stopPropagation();
 if(event.key==='ArrowUp'||event.key==='ArrowDown')jumpKeyframe(event.key==='ArrowUp'?-1:1);
 else $(event.key==='ArrowLeft'?'prev':'next').click();
},{capture:true});
SCALE_KEYS.forEach(key=>{const row=document.createElement('div');row.className='slider';row.dataset.key=key;row.onpointerenter=()=>{hoveredScale=key;status(`${labels[key]}：${scaleHelp[key]}`);draw();};row.onfocusin=()=>{hoveredScale=key;status(`${labels[key]}：${scaleHelp[key]}`);draw();};row.innerHTML=`<span>${labels[key]}</span><input type="range" min="0.1" max="3" step="0.01" value="1"><output>1.00</output><button type="button" class="slider-reset" title="重置为 1" aria-label="${labels[key]}重置为 1">↺</button>`;const input=row.querySelector('input');input.addEventListener('input',()=>updateScalePreview(key,input));input.addEventListener('pointermove',e=>{if(e.buttons)updateScalePreview(key,input);});input.onchange=commitScale;row.querySelector('.slider-reset').onclick=()=>{if(scales[key]===1)return;scales[key]=1;input.value=1;row.querySelector('output').value='1.00';scalesDirty=true;commitScale();};$('sliders').append(row);});
$('sliders').onpointerleave=()=>{hoveredScale=null;draw();};$('sliders').onfocusout=e=>{if(!$('sliders').contains(e.relatedTarget)&&!$('sliders').matches(':hover')){hoveredScale=null;draw();}};
 document.querySelectorAll('#dragModes button').forEach(button=>{button.onclick=()=>{if(manualMode)finishManual();dragMode=button.dataset.mode;document.querySelectorAll('#dragModes button').forEach(item=>{const active=item.dataset.mode===dragMode;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});};});
function updateScaleSideControls(){
 const single=scaleSide()!=='both';document.querySelectorAll('.slider').forEach(row=>{const key=row.dataset.key;row.querySelector('input').disabled=manualMode||(single&&['head_x','head_y','neck','torso'].includes(key));row.querySelector('button').disabled=manualMode||(single&&['head_x','head_y','neck','torso'].includes(key));});resetPreview();
}
document.querySelectorAll('input[name=scaleSide]').forEach(input=>input.onchange=()=>selectScaleSide(input.value));
$('person').onchange=()=>{if(!trackActivationLocked)activeCompletionTrack=null;pendingJoint=null;resetPreview();renderKeyframes();draw();};$('lineWidth').oninput=draw;$('saturation').oninput=draw;$('showBackground').onchange=background;
$('rightArmFront').onclick=()=>{if(manualMode||!frames.length)return;pause();upsert({type:'set_arm_front',frame:current,person:Number($('person').value),side:'right'});updateOperations();draw();status('已设置右臂置于前方');};$('leftArmFront').onclick=()=>{if(manualMode||!frames.length)return;pause();upsert({type:'set_arm_front',frame:current,person:Number($('person').value),side:'left'});updateOperations();draw();status('已设置左臂置于前方');};
$('seek').oninput=e=>{if(scalesDirty)commitScale();pause();setFrame(Number(e.target.value));};
const seekControl=$('seek');let seekingPointer=null;
const timelineHead=document.createElement('div');timelineHead.className='timeline-head';timelineHead.setAttribute('aria-hidden','true');seekControl.parentElement.append(timelineHead);
function updateTimelineHead(frame=Number(seekControl.value)){
 const fraction=(frame-timelineStart)/timelineSpan();timelineHead.hidden=fraction<0||fraction>1;
 timelineHead.style.left=(7+fraction*Math.max(0,seekControl.clientWidth-14))+'px';
}

const timelineTicks=document.createElement('canvas');timelineTicks.className='timeline-ticks';timelineTicks.setAttribute('aria-hidden','true');seekControl.parentElement.append(timelineTicks);
function drawTimelineTicks(){
 const width=seekControl.clientWidth,height=seekControl.clientHeight,dpr=devicePixelRatio||1;
 timelineTicks.width=Math.round(width*dpr);timelineTicks.height=Math.round(height*dpr);updateTimelineHead();
 const ticks=timelineTicks.getContext('2d');ticks.setTransform(dpr,0,0,dpr,0,0);
 if(!frames.length||width<=14)return;
 const last=Math.min(frames.length-1,Math.floor(timelineStart+timelineSpan())),first=Math.max(0,Math.ceil(timelineStart)),span=width-14;
 ticks.lineWidth=1;
 for(const long of [false,true]){
  ticks.strokeStyle=long?'#afbec9':'#617482';ticks.globalAlpha=long?1:.6;ticks.beginPath();
  for(let frame=first;frame<=last;frame++){
   if(((frame+1)%10===0)!==long)continue;
   const x=Math.round(7+timelinePercent(frame)/100*span)+.5;
   ticks.moveTo(x,0);ticks.lineTo(x,long?Math.round(height*.66):Math.round(height*.15));
  }
  ticks.stroke();
 }
 ticks.globalAlpha=1;ticks.fillStyle='#afbec9';ticks.font='10px "Segoe UI",sans-serif';ticks.textAlign='left';ticks.textBaseline='top';
 let previousRight=-Infinity;
 for(let frame=first;frame<=last;frame++){
  if(frame!==0&&(frame+1)%10!==0)continue;
  const text=String(frame+1),labelWidth=ticks.measureText(text).width,x=10+timelinePercent(frame)/100*span;
  if(x<previousRight+12||x+labelWidth>width)continue;ticks.fillText(text,x,2);previousRight=x+labelWidth;
 }
}
new ResizeObserver(drawTimelineTicks).observe(seekControl);
seekControl.parentElement.title='滚轮缩放时间轴，右键重置缩放';
seekControl.parentElement.addEventListener('wheel',event=>{
 event.preventDefault();if(frames.length<2)return;
 const rect=seekControl.getBoundingClientRect(),fraction=Math.max(0,Math.min(1,(event.clientX-rect.left-7)/Math.max(1,rect.width-14))),anchor=timelineStart+fraction*timelineSpan();
 const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?48:1);
 timelineZoom=Math.max(1,Math.min(Math.max(1,frames.length-1),timelineZoom*Math.exp(-Math.max(-120,Math.min(120,delta))*.003)));
 timelineStart=Math.max(0,Math.min(Math.max(0,frames.length-1-timelineSpan()),anchor-fraction*timelineSpan()));
 closeKeyframeMenu();scheduleTimelineView();
},{passive:false});
seekControl.parentElement.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();timelineZoom=1;timelineStart=0;closeKeyframeMenu();scheduleTimelineView();});


function seekAtPointer(event){const rect=seekControl.getBoundingClientRect(),span=Math.max(1,rect.width-14),fraction=Math.max(0,Math.min(1,(event.clientX-rect.left-7)/span));seekControl.value=Math.round(timelineFrame(fraction));updateTimelineHead();seekControl.dispatchEvent(new Event('input',{bubbles:true}));}
seekControl.addEventListener('pointerdown',event=>{if(event.button!==0||!frames.length)return;event.preventDefault();seekingPointer=event.pointerId;seekControl.focus({preventScroll:true});seekControl.setPointerCapture(event.pointerId);seekAtPointer(event);});
seekControl.addEventListener('pointermove',event=>{if(event.pointerId!==seekingPointer)return;event.preventDefault();seekAtPointer(event);});
seekControl.addEventListener('pointerup',event=>{if(event.pointerId!==seekingPointer)return;seekAtPointer(event);seekingPointer=null;if(seekControl.hasPointerCapture(event.pointerId))seekControl.releasePointerCapture(event.pointerId);});
seekControl.addEventListener('pointercancel',()=>{seekingPointer=null;});seekControl.addEventListener('lostpointercapture',()=>{seekingPointer=null;});
$('prev').onclick=()=>{if(scalesDirty)commitScale();pause();setFrame(current-1);};$('next').onclick=()=>{if(scalesDirty)commitScale();pause();setFrame(current+1);};$('play').onclick=()=>{if(!frames.length)return;if(scalesDirty)commitScale();if(playing)return pause();playing=true;const generation=++playbackGeneration;if(current===frames.length-1){setFrame(0).then(shown=>{if(playing&&shown&&generation===playbackGeneration){lastTick=performance.now();requestAnimationFrame(tick);}});$('play').textContent='Ⅱ 暂停';return;}lastTick=performance.now();$('play').textContent='Ⅱ 暂停';requestAnimationFrame(tick);};
$('undo').onclick=()=>{if(!history.length)return;const state=history.pop();operations=state.operations;handFixes=state.handFixes;scalesDirty=false;resetPreview();updateOperations();draw();status('已撤销');};$('reset').onclick=()=>{pause();remember();drag=null;manualPreview=null;pendingJoint=null;activeCompletionTrack=null;trackActivationLocked=false;closeKeyframeMenu();poseMap.querySelectorAll('.pose-joint').forEach(item=>item.classList.remove('selected'));$('poseSelection').textContent='左键编号绘制，右键编号删除。';operations=[];handFixes=[{type:'swap_hands',person:-1}];scalesDirty=false;resetPreview();updateOperations();draw();status('已清除全部调整');};
canvas.onpointerdown=e=>{if(e.button!==0||e.ctrlKey||!frames.length)return;try{pause();if(scalesDirty)commitScale();const box=posePointerBounds(),x=(e.clientX-box.left)/box.width,y=(e.clientY-box.top)/box.height;if(manualMode){
 const person=Number($('person').value),baseFrame=applyFrame(editFrame(),current,allOps(),frames.length),body=baseFrame.people[person]?.pose_keypoints_2d;
 let picked=null,distance=18;
 const candidates=trackActivationLocked&&activeCompletionTrack&&(activeCompletionTrack.type||'joint')==='joint'&&activeCompletionTrack.person===person?new Set([pendingJoint??activeCompletionTrack.joint]):activeCompletionTrack?.person===person?new Set([activeCompletionTrack.joint]):new Set(operations.filter(op=>op.type==='set_joint'&&op.person===person&&!op.completion_pending&&op.active_ranges?.some(([start,end])=>start<end&&current>=start&&current<=end)).map(op=>op.joint));
 if(pendingJoint!==null)candidates.add(pendingJoint);
 for(const joint of candidates){if(!(body?.[joint*3+2]>.3))continue;const d=Math.hypot((body[joint*3]/baseFrame.canvas_width-x)*box.width,(body[joint*3+1]/baseFrame.canvas_height-y)*box.height);if(d<distance){picked=joint;distance=d;}}
 if(picked!==null){pendingJoint=picked;poseMap.querySelectorAll('.pose-joint').forEach(item=>item.classList.toggle('selected',Number(item.dataset.joint)===picked));}
 if(pendingJoint===null){status('请先在右侧选择要补全的关节编号');return;}
 const originX=picked!==null?body[picked*3]/baseFrame.canvas_width:x,originY=picked!==null?body[picked*3+1]/baseFrame.canvas_height:y;
 manualPreview=null;drag={x,y,originX,originY,op:{type:'set_joint',frame:current,person,joint:pendingJoint,x:originX,y:originY},baseFrame};
 canvas.setPointerCapture(e.pointerId);draw();return;
}const op={type:dragMode==='move'?'translate':'joint',frame:current,person:Number($('person').value),dx:0,dy:0},baseFrame=applyFrame(editFrame(),current,allOps(),frames.length);if(op.type==='translate'&&trackActivationLocked&&activeCompletionTrack&&(activeCompletionTrack.type||'joint')==='joint')return;if(op.type==='joint'){if(trackActivationLocked&&activeCompletionTrack&&(activeCompletionTrack.type||'joint')!=='joint')return;let best=null,dist=18;baseFrame.people.forEach((p,person)=>{if(op.person!==-1&&person!==op.person)return;const flat=p.pose_keypoints_2d;for(let j=0;j<18;j++){if(trackActivationLocked&&activeCompletionTrack&&((activeCompletionTrack.person!==-1&&person!==activeCompletionTrack.person)||j!==activeCompletionTrack.joint))continue;if(flat[j*3+2]<=.3)continue;const d=Math.hypot((flat[j*3]/baseFrame.canvas_width-x)*box.width,(flat[j*3+1]/baseFrame.canvas_height-y)*box.height);if(d<dist){dist=d;best={joint:j,person};}}});if(!best)return;op.joint=best.joint;op.person=best.person;}const same=operations.filter(old=>old.type===op.type&&(old.person??-1)===op.person&&(op.type!=='joint'||old.joint===op.joint));
const sampled=compileOperations(same),origin={canvas_width:baseFrame.canvas_width,canvas_height:baseFrame.canvas_height,people:baseFrame.people.map(p=>({...p,pose_keypoints_2d:p.pose_keypoints_2d.map((v,i)=>i%3===2?1:0),face_keypoints_2d:[],hand_left_keypoints_2d:[],hand_right_keypoints_2d:[],foot_keypoints_2d:[]}))};
const deltaFrame=applyFrame(origin,current,sampled,frames.length),personIndex=op.person===-1?0:op.person,jointIndex=op.type==='joint'?op.joint:0,flat=deltaFrame.people[personIndex]?.pose_keypoints_2d;
const inherited={dx:(flat?.[jointIndex*3]??0)/baseFrame.canvas_width,dy:(flat?.[jointIndex*3+1]??0)/baseFrame.canvas_height};
const positionTrack=op.type==='joint'&&operations.some(old=>old.type==='set_joint'&&(old.person??-1)===op.person&&old.joint===op.joint);
drag={x,y,op,baseFrame,inherited,positionTrack};canvas.setPointerCapture(e.pointerId);}catch(err){status(err.message,true);}};
canvas.onpointermove=e=>{const box=posePointerBounds(),x=(e.clientX-box.left)/box.width,y=(e.clientY-box.top)/box.height;if(drag){if(drag.op.type==='set_joint'){if(Math.hypot((x-drag.x)*box.width,(y-drag.y)*box.height)>2)drag.moved=true;drag.op.x=drag.originX+x-drag.x;drag.op.y=drag.originY+y-drag.y;}else{drag.op.dx=x-drag.x;drag.op.dy=y-drag.y;}draw();}};canvas.onpointerleave=()=>{if(!drag){manualPreview=null;draw();}};
function endDrag(){
 if(!drag)return;const state=drag;let op={...state.op};drag=null;
 if(op.type==='set_joint'){if(!state.moved){op.x=state.x;op.y=state.y;}op.needs_adjustment=false;}
 if(op.type==='set_joint'||Math.abs(op.dx)+Math.abs(op.dy)>1e-8){
  if(state.positionTrack){const flat=state.baseFrame.people[op.person].pose_keypoints_2d;op={type:'set_joint',frame:op.frame,person:op.person,joint:op.joint,x:flat[op.joint*3]/state.baseFrame.canvas_width+op.dx,y:flat[op.joint*3+1]/state.baseFrame.canvas_height+op.dy};}
  else if(state.inherited){op.dx+=state.inherited.dx;op.dy+=state.inherited.dy;}
  upsert(op,false);
 }
 draw();
}
canvas.onpointerup=endDrag;canvas.onpointercancel=()=>{drag=null;manualPreview=null;draw();};
$('save').onclick=()=>{try{if(!token||!sessionData)throw Error('请从 ComfyUI 节点打开编辑器');commitScale();parent.postMessage({type:'comfyui-pose:save',fps:rate(),edits:{version:1,source_digest:sourceDigest,operations,hand_fixes:handFixes}},location.origin);}catch(e){status(e.message,true);}};$('close').onclick=()=>{pause();parent.postMessage({type:'comfyui-pose:close'},location.origin);};
$('loadVideo').onclick=()=>$('videoFile').click();$('videoFile').onchange=e=>{const file=e.target.files[0];if(!file)return;if(videoURL)URL.revokeObjectURL(videoURL);pause();$('showBackground').checked=false;videoURL=URL.createObjectURL(file);$('video').src=videoURL;$('background').hidden=true;setFrame(current);status('已切换到本地参考视频；勾选“原视频”可切回节点视频');};
$('loadJSON').onclick=()=>$('jsonFile').click();$('jsonFile').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(token)throw Error('节点编辑模式不能替换源数据；需要更换源数据时请修改工作流输入并重新执行');pause();sourceDigest='';initialize(JSON.parse(await file.text()));status('骨骼 JSON 已导入');}catch(err){status(err.message,true);}};
$('demo').onclick=()=>{if(token)return status('节点编辑模式请使用输入骨骼');initialize(Array.from({length:80},(_,f)=>{const p=[[.5,.2],[.5,.3],[.4,.3],[.34,.44],[.3,.56],[.6,.3],[.66,.44],[.7,.56],[.45,.55],[.44,.72],[.42,.9],[.55,.55],[.56,.72],[.58,.9],[.48,.18],[.52,.18],[.46,.2],[.54,.2]];return {canvas_width:640,canvas_height:480,people:[{pose_keypoints_2d:p.flatMap(([x,y],i)=>[(x+(i===4?.05*Math.sin(f/8):0))*640,y*480,1]),face_keypoints_2d:[],hand_left_keypoints_2d:[],hand_right_keypoints_2d:[],foot_keypoints_2d:[]}]};}));status('80 帧关键帧演示：在不同帧调整动作，检查中间帧的过渡');};
function restoreEdits(value){if(!frames.length)return;try{const data=typeof value==='string'?JSON.parse(value):value;if(!data||data.version!==1||!Array.isArray(data.operations))throw Error('编辑项目格式无效');if(data.source_digest&&data.source_digest!==sourceDigest){status('源骨骼已改变，旧调整未加载；保存新调整可替换旧项目');return;}operations=clone(data.operations).filter(op=>!['complete_pose','swap_hands','repair_hands'].includes(op.type));handFixes=[{type:'swap_hands',person:-1},...(Array.isArray(data.hand_fixes)?clone(data.hand_fixes).filter(op=>op.type==='swap_arms'):[])];const groups=new Map(),kept=[];for(const op of operations){if(op.type==='swap_arms'&&!Number.isInteger(op.frame)){if(!handFixes.some(old=>old.type===op.type&&(old.person??-1)===(op.person??-1)))handFixes.push(op);}else if(Number.isInteger(op.frame)&&op.type==='swap_arms'){const key=`${op.type}|${op.person??-1}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(op);}else kept.push(op);}for(const events of groups.values()){const first=events[0],shouldKeep=events.length%2===1;if(shouldKeep)kept.push({type:first.type,person:first.person??-1});}operations=kept;updateOperations();draw();}catch(e){status(e.message,true);}}
window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==parent||e.data?.type!=='comfyui-pose:init')return;initialEdits=e.data.edits;if(frames.length)restoreEdits(initialEdits);});
if(token){$('demo').hidden=true;$('loadJSON').hidden=true;fetch(apiBase+encodeURIComponent(token)).then(async r=>{if(!r.ok)throw Error(await r.text());return r.json();}).then(data=>{sessionData=data;sourceDigest=data.source_digest;frameRate=data.fps;initialize(data.frames);if(initialEdits!==null)restoreEdits(initialEdits);status(`已加载 ${frames.length} 帧，可批量修改；保存后重新执行节点`);}).catch(e=>status(e.message,true));}
parent.postMessage({type:'comfyui-pose:ready'},location.origin);
new ResizeObserver(resize).observe($('stage'));
window.addEventListener('pagehide',()=>{if(completionHintRequest)cancelAnimationFrame(completionHintRequest);pause();if(videoURL)URL.revokeObjectURL(videoURL);});
// Empty space around the video is part of the editable preview area.
for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])previewStage.addEventListener(type,event=>{if(event.target!==canvas&&!previewPan)canvas['on'+type]?.(event);});
for(const name of ['onpointerdown','onpointermove','onpointerup']){const handler=canvas[name];canvas[name]=function(event){try{return handler?.call(this,event);}catch(error){status(error.message,true);}};}


}
if(document.body?.dataset.poseEditor === "true") startEditor();
