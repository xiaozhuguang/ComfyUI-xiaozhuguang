import {applyFrame,compileOperations,isOperationActive} from './pose-core.js?v=16';

const anchorPositions=new WeakMap();
export function buildTrackingPlan(frames,operations,person,joint,current,handFixes=[],compiled=null){
 if(!Number.isInteger(person)||person<0||!Number.isInteger(joint))throw Error('请激活一个具体人物的关节轨道');
 const keys=operations.filter(op=>['joint','set_joint'].includes(op.type)&&op.person===person&&op.joint===joint&&Number.isInteger(op.frame)&&!op.single_frame_only&&!op.deleted);
 const scope=keys.find(op=>!op.completion_pending&&op.active_ranges?.some(([a,b])=>a<b&&a<=current&&current<=b))?.active_ranges;
 const span=scope?.find(([a,b])=>a<b&&a<=current&&current<=b);
 if(!span)throw Error('请将播放头移到当前关节轨道的生效区间');
 const [rangeStart,rangeEnd]=span;
 const manual=[...new Map(keys.filter(op=>!op.needs_adjustment&&op.frame>=rangeStart&&op.frame<=rangeEnd&&isOperationActive(op,op.frame)).sort((a,b)=>a.frame-b.frame).map(op=>[op.frame,op])).values()];
 let right=manual.findIndex(op=>op.frame>current);
 if(right<0&&manual.at(-1)?.frame===current)right=manual.length-1;
 if(right<1)throw Error('请将播放头放到两个绿色关键帧之间，并先手工调整这两个关键帧');
 const anchorKeys=manual.slice(right-1,right+1),start=anchorKeys[0].frame,end=anchorKeys[1].frame;
 if(end-start+1>600)throw Error('单次最多追踪 600 帧，请拆分补全区间');
 compiled=compiled||compileOperations([...handFixes,...operations]);
 let cached=anchorPositions.get(compiled);if(!cached||cached.frames!==frames){cached={frames,positions:new Map()};anchorPositions.set(compiled,cached);}
 const anchors=anchorKeys.map(op=>{const key=`${person}|${joint}|${op.frame}`;if(cached.positions.has(key))return cached.positions.get(key);const preview=applyFrame(frames[op.frame],op.frame,compiled,frames.length),body=preview.people[person]?.pose_keypoints_2d;if(!(body?.[joint*3+2]>.3))throw Error('请先调整两个有效的关节关键帧');const point={frame:op.frame,x:body[joint*3]/preview.canvas_width,y:body[joint*3+1]/preview.canvas_height};cached.positions.set(key,point);return point;});
 if(anchors.some(op=>!Number.isFinite(op.x)||!Number.isFinite(op.y)||op.x<0||op.x>1||op.y<0||op.y>1))throw Error('追踪锚点必须位于视频画面内');
 const type=keys.some(op=>op.type==='set_joint')?'set_joint':'joint';
 return {person,joint,type,start,end,scope:scope.map(span=>[...span]),anchors};
}

export function mergeTrackingResult(frames,operations,handFixes,plan,result){
 if(result.start!==plan.start||result.end!==plan.end||!Array.isArray(result.points)||!Array.isArray(result.failed_frames))throw Error('视频追踪结果格式无效');
 const protectedFrames=new Set(operations.filter(op=>['joint','set_joint'].includes(op.type)&&op.person===plan.person&&op.joint===plan.joint&&(!op.needs_adjustment||op.single_frame_only||op.deleted)).map(op=>op.frame));
 const points=new Map(result.points.map(p=>[p.frame,p])),failed=new Set(result.failed_frames),compiled=compileOperations([...handFixes,...operations]);
 const generated=[],type=plan.type||'set_joint',trial={...compiled,tracks:new Map(compiled.tracks)};
 const key=`${type}|${plan.person}|${plan.joint}`;
 function operationAt(frame,x,y,ensureJoint){
  const base={type,...(type==='joint'?{ensure_joint:ensureJoint}:{}),person:plan.person,joint:plan.joint,frame,active_ranges:plan.scope.map(span=>[...span]),completion_pending:false};
  const evaluate=(u,v)=>{const op={...base,...(type==='joint'?{dx:u,dy:v}:{x:u,y:v})};trial.tracks.set(key,{keys:[op],singles:new Map()});const preview=applyFrame(frames[frame],frame,trial,frames.length),body=preview.people[plan.person].pose_keypoints_2d;return [body[plan.joint*3]/preview.canvas_width,body[plan.joint*3+1]/preview.canvas_height];};
  // Invert the actual render transform, including scale operations applied after this track.
  const origin=evaluate(0,0),epsilon=.001,u=evaluate(epsilon,0),v=evaluate(0,epsilon),a=(u[0]-origin[0])/epsilon,b=(v[0]-origin[0])/epsilon,c=(u[1]-origin[1])/epsilon,d=(v[1]-origin[1])/epsilon,det=a*d-b*c;
  if(Math.abs(det)<1e-8)throw Error('当前关节被其他位置轨道覆盖，请先删除冲突轨道');
  const dx=x-origin[0],dy=y-origin[1],first=(dx*d-b*dy)/det,second=(a*dy-dx*c)/det;
  if(!Number.isFinite(first)||!Number.isFinite(second)||Math.abs(first)>10||Math.abs(second)>10)throw Error('追踪位移超出范围，请检查姿势比例');
  return {...base,...(type==='joint'?{dx:first,dy:second}:{x:first,y:second})};
 }
 for(let frame=plan.start+1;frame<plan.end;frame++){
  if(protectedFrames.has(frame))continue;
  const point=points.get(frame),lost=failed.has(frame)||!point;
  let x=point?.x,y=point?.y;
  if(lost){const preview=applyFrame(frames[frame],frame,compiled,frames.length),body=preview.people[plan.person]?.pose_keypoints_2d;if(!body)continue;x=body[plan.joint*3]/preview.canvas_width;y=body[plan.joint*3+1]/preview.canvas_height;}
  if(!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>10||Math.abs(y)>10)throw Error('视频追踪坐标无效');
  generated.push({...operationAt(frame,x,y,!lost),needs_adjustment:true,completion_source:lost?'video_fallback':'video',tracking_failed:lost,tracking_confidence:lost?0:point.confidence});
 }
 const replace=new Set(generated.map(op=>op.frame));
 const kept=operations.filter(op=>!(op.type===type&&op.person===plan.person&&op.joint===plan.joint&&replace.has(op.frame)&&!protectedFrames.has(op.frame)));
 if(kept.length+generated.length>10000)throw Error('关键帧超过 10000 个，请缩短追踪区间');
 return [...kept,...generated];
}
