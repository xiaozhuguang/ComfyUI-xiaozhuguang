// Framework-independent, portable sequence transforms. Coordinates remain in source pixels.
export const GROUPS=['pose_keypoints_2d','face_keypoints_2d','hand_left_keypoints_2d','hand_right_keypoints_2d','foot_keypoints_2d'];
export const SCALE_KEYS=['head_x','head_y','neck','shoulders','upper_arm','lower_arm','torso','hips','upper_leg','lower_leg','hands','feet'];
export const BODY_EDGES=[[1,2],[2,3],[3,4],[1,5],[5,6],[6,7],[1,8],[8,9],[9,10],[1,11],[11,12],[12,13],[1,0],[0,14],[14,16],[0,15],[15,17]];
export const BODY_NAMES=['鼻尖','脖子','右肩','右肘','右腕','左肩','左肘','左腕','右髋','右膝','右踝','左髋','左膝','左踝','右眼','左眼','右耳','左耳'];
export const clone=v=>JSON.parse(JSON.stringify(v));
const point=(flat,i)=>flat.slice(i*3,i*3+2);
const set=(flat,i,p)=>flat.splice(i*3,2,...p);
function move(flat,dx,dy,sx=1,sy=1,anchor=[0,0]){for(let i=0;i<flat.length;i+=3){if(flat[i+2]<=0)continue;flat[i]=anchor[0]+(flat[i]-anchor[0])*sx+dx;flat[i+1]=anchor[1]+(flat[i+1]-anchor[1])*sy+dy;}}
export function transformPerson(person,values){
 const s=Object.fromEntries(SCALE_KEYS.map(k=>[k,values[k]??1])),body=person.pose_keypoints_2d,old=Array.from({length:18},(_,i)=>point(body,i)),next=clone(old);
 const mid=(a,b)=>a.map((v,i)=>(v+b[i])/2),shoulder=mid(old[2],old[5]),hip=mid(old[8],old[11]);
 const headAnchor=old[0],neckVector=old[0].map((v,i)=>v-old[1][i]),movedHeadAnchor=old[1].map((v,i)=>v+neckVector[i]*s.neck),headDelta=movedHeadAnchor.map((v,i)=>v-headAnchor[i]);
 next[0]=movedHeadAnchor;
 for(const j of [14,15,16,17])next[j]=movedHeadAnchor.map((v,i)=>v+(old[j][i]-headAnchor[i])*s[i===0?'head_x':'head_y']);
 for(const j of [2,5])next[j]=shoulder.map((v,i)=>v+(old[j][i]-v)*s.shoulders);
 const targetHip=shoulder.map((v,i)=>v+(hip[i]-v)*s.torso);
 for(const j of [8,11])next[j]=targetHip.map((v,i)=>v+(old[j][i]-hip[i])*s.hips);
 for(const [parent,child,key] of [[2,3,'upper_arm'],[3,4,'lower_arm'],[5,6,'upper_arm'],[6,7,'lower_arm'],[8,9,'upper_leg'],[9,10,'lower_leg'],[11,12,'upper_leg'],[12,13,'lower_leg']])next[child]=next[parent].map((v,i)=>v+(old[child][i]-old[parent][i])*s[key]);
 move(person.face_keypoints_2d??[],headDelta[0],headDelta[1],s.head_x,s.head_y,headAnchor);
 for(const [key,j] of [['hand_right_keypoints_2d',4],['hand_left_keypoints_2d',7]])move(person[key]??[],next[j][0]-old[j][0],next[j][1]-old[j][1],s.hands,s.hands,old[j]);
 const feet=person.foot_keypoints_2d??[];
 for(const [offset,j] of [[0,13],[9,10]]){const part=feet.slice(offset,offset+9);move(part,next[j][0]-old[j][0],next[j][1]-old[j][1],s.feet,s.feet,old[j]);feet.splice(offset,part.length,...part);}
 for(let j=0;j<18;j++)if(body[j*3+2]>0)set(body,j,next[j]);
}
export function swapHands(person){const left=person.hand_left_keypoints_2d,right=person.hand_right_keypoints_2d;delete person.hand_left_keypoints_2d;delete person.hand_right_keypoints_2d;if(right!==undefined)person.hand_left_keypoints_2d=right;if(left!==undefined)person.hand_right_keypoints_2d=left;}
export function repairHands(person,width,height){const b=person.pose_keypoints_2d,l=person.hand_left_keypoints_2d??[],r=person.hand_right_keypoints_2d??[];if(l.length<3||r.length<3||Math.min(l[2],r[2],b[14],b[23])<=.05)return false;const lw=point(b,7),rw=point(b,4),distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]),diag=Math.hypot(width,height);const wl=Math.max(.15,l[2]),wr=Math.max(.15,r[2]),same=(distance(l,lw)*wl+distance(r,rw)*wr)/(wl+wr),swapped=(distance(l,rw)*wl+distance(r,lw)*wr)/(wl+wr);if(same-swapped>Math.max(3,.005*diag)&&swapped<.9*same){swapHands(person);return true;}return false;}
function expandedOperations(index,operations,count){
 const tracks=new Map(),discrete=[],legacy=[];
 for(const op of operations){
  if(Number.isInteger(op.frame)){
   if(['scale','translate','joint','set_joint'].includes(op.type)){const key=`${op.type}|${op.person??-1}|${['joint','set_joint'].includes(op.type)?op.joint:''}`;if(!tracks.has(key))tracks.set(key,[]);tracks.get(key).push(op);}
   else discrete.push(op);
  }else if(index>=(op.start??0)&&index<=(op.end??Infinity))legacy.push(op);
 }
 const output=legacy;
 for(const keys of tracks.values()){
  keys.sort((a,b)=>a.frame-b.frame);let left=keys[0],right=keys[keys.length-1];
  if(index<=left.frame)right=left;else if(index>=right.frame)left=right;else{for(let i=1;i<keys.length;i++)if(keys[i].frame>=index){left=keys[i-1];right=keys[i];break;}}
  const t=left===right?0:(index-left.frame)/(right.frame-left.frame),mix=(a,b)=>(a??0)+((b??0)-(a??0))*t;
  const op={...left,frame:index};
  if(left.type==='scale')op.values=Object.fromEntries(SCALE_KEYS.map(k=>[k,(left.values?.[k]??1)+((right.values?.[k]??1)-(left.values?.[k]??1))*t]));
  else if(left.type==='set_joint'){op.x=mix(left.x,right.x);op.y=mix(left.y,right.y);op.deleted=(t===1?right:left).deleted===true;}
  else{op.dx=mix(left.dx,right.dx);op.dy=mix(left.dy,right.dy);}
  output.push(op);
 }
 const grouped=new Map();for(const op of discrete){const key=`${op.type}|${op.person??-1}`;if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(op);}
 for(const events of grouped.values()){
  const keys=events.filter(op=>Number.isInteger(op.frame)).sort((a,b)=>a.frame-b.frame);
  if(keys.length){if(['swap_hands','swap_arms'].includes(keys[0].type)){const toggles=keys.filter((op,i)=>i>0&&op.frame<=index).length;if(toggles%2)continue;output.push({...keys[0],frame:index});}else{const chosen=[...keys].filter(op=>op.frame<=index).at(-1)??keys[0];output.push({...chosen,frame:index});}}
  else output.push(...events);
 }
 return output;
}
export function applyFrame(frame,index,operations,count=Infinity){
 const result=clone(frame);
 for(const op of expandedOperations(index,operations,count)){if(index<(op.start??0)||index>(op.end??Infinity))continue;const people=op.person===-1||op.person===undefined?result.people:result.people.slice(op.person,op.person+1);
 for(const person of people){if(op.type==='scale')transformPerson(person,op.values??{});else if(op.type==='swap_hands'||op.type==='swap_arms'){if(op.type==='swap_arms'){const b=person.pose_keypoints_2d;for(const [a,c]of [[2,5],[3,6],[4,7]]){const pa=b.slice(a*3,a*3+3),pc=b.slice(c*3,c*3+3);b.splice(a*3,3,...pc);b.splice(c*3,3,...pa);}}swapHands(person);}else if(op.type==='repair_hands')repairHands(person,frame.canvas_width,frame.canvas_height);else if(op.type==='set_joint'){const body=person.pose_keypoints_2d;body[op.joint*3]=op.x*frame.canvas_width;body[op.joint*3+1]=op.y*frame.canvas_height;body[op.joint*3+2]=op.deleted?0:.8;}else{const dx=op.dx*frame.canvas_width,dy=op.dy*frame.canvas_height;if(op.type==='translate')GROUPS.forEach(key=>move(person[key]??[],dx,dy));else if(op.type==='joint'){const body=person.pose_keypoints_2d,p=point(body,op.joint);set(body,op.joint,[p[0]+dx,p[1]+dy]);const key={4:'hand_right_keypoints_2d',7:'hand_left_keypoints_2d'}[op.joint];if(key)move(person[key]??[],dx,dy);if(op.joint===0||op.joint===1){for(const j of [0,14,15,16,17]){if(j===op.joint||body[j*3+2]<=0)continue;const head=point(body,j);set(body,j,[head[0]+dx,head[1]+dy]);}move(person.face_keypoints_2d??[],dx,dy);}if([10,13].includes(op.joint)){const feet=person.foot_keypoints_2d??[],start=op.joint===10?9:0,part=feet.slice(start,start+9);move(part,dx,dy);feet.splice(start,part.length,...part);}}}}
 }return result;
}
export function applySequence(frames,operations){const active=operations.filter(op=>op.type!=='complete_pose');return frames.map((frame,i)=>applyFrame(frame,i,active));}
