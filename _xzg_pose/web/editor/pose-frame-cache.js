// Cached frames are read-only render data. Editing always clears the revision.
export class PoseFrameCache{
 constructor(load,{capacity=120,maxBytes=32*1024*1024,schedule,cancel}={}){
  this.load=load;this.capacity=capacity;this.maxBytes=maxBytes;this.cache=new Map();this.bytes=0;this.queue=[];this.generation=0;this.handle=null;
  this.schedule=schedule||(callback=>typeof requestIdleCallback==='function'?requestIdleCallback(callback,{timeout:150}):setTimeout(()=>callback({timeRemaining:()=>6,didTimeout:true}),0));
  this.cancel=cancel||(handle=>typeof cancelIdleCallback==='function'?cancelIdleCallback(handle):clearTimeout(handle));
 }
 get(index){
  if(this.cache.has(index)){const entry=this.cache.get(index);this.cache.delete(index);this.cache.set(index,entry);return entry.frame;}
  const frame=this.load(index);let weight=256;
  for(const person of frame.people)for(const value of Object.values(person))if(Array.isArray(value))weight+=value.length*16+64;
  this.cache.set(index,{frame,weight});this.bytes+=weight;
  while(this.cache.size>this.capacity||(this.bytes>this.maxBytes&&this.cache.size>1)){const first=this.cache.keys().next().value;this.bytes-=this.cache.get(first).weight;this.cache.delete(first);}
  return frame;
 }
 prefetch(indices){this.queue=[...new Set(indices)].filter(index=>!this.cache.has(index)).slice(0,this.capacity-1);this.pump();}
 pump(){
  if(this.handle!==null||!this.queue.length)return;
  const generation=this.generation;
  this.handle=this.schedule(deadline=>{
   this.handle=null;if(generation!==this.generation)return;
   const start=performance.now();
   while(this.queue.length&&performance.now()-start<4&&(deadline.didTimeout||deadline.timeRemaining()>1)){
    const index=this.queue.shift();try{this.get(index);}catch{this.queue=[];break;}
   }
   this.pump();
  });
 }
 clear(){this.generation++;if(this.handle!==null)this.cancel(this.handle);this.handle=null;this.queue=[];this.cache.clear();this.bytes=0;}
}
