// Bounded image loading with deduplication and foreground request priority.
export class FrameLoader {
 constructor(load,{capacity=12,concurrency=2,maxBytes=96*1024*1024}={}){this.load=load;this.capacity=capacity;this.concurrency=concurrency;this.maxBytes=maxBytes;this.windowSize=capacity;this.cacheBytes=0;this.weights=new Map();this.generation=0;this.cache=new Map();this.pending=new Map();this.queue=[];this.active=0;}
 get(index,priority=true){
  if(this.cache.has(index)){const image=this.cache.get(index);this.cache.delete(index);this.cache.set(index,image);return Promise.resolve(image);}
  if(this.pending.has(index)){if(priority){const pos=this.queue.findIndex(task=>task.index===index);if(pos>=0){this.queue[pos].priority=true;this.queue.unshift(this.queue.splice(pos,1)[0]);}}return this.pending.get(index);}
  let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});this.pending.set(index,promise);const task={index,resolve,reject,promise,priority,generation:this.generation};if(priority)this.queue.unshift(task);else this.queue.push(task);this.pump();return promise;
 }
 pump(){while(this.active<this.concurrency&&this.queue.length){const task=this.queue.shift();this.active++;Promise.resolve().then(()=>this.load(task.index)).then(image=>{if(task.generation===this.generation){const weight=Math.max(1,(image.naturalWidth||image.width||1)*(image.naturalHeight||image.height||1)*4);this.windowSize=Math.max(1,Math.min(this.capacity,Math.floor(this.maxBytes/weight)));this.cacheBytes-=this.weights.get(task.index)||0;this.cache.set(task.index,image);this.weights.set(task.index,weight);this.cacheBytes+=weight;while(this.cache.size>this.windowSize||(this.cacheBytes>this.maxBytes&&this.cache.size>1)){const first=this.cache.keys().next().value;this.cacheBytes-=this.weights.get(first);this.weights.delete(first);this.cache.delete(first);}}task.resolve(image);},error=>task.reject(error)).finally(()=>{if(this.pending.get(task.index)===task.promise)this.pending.delete(task.index);this.active--;this.pump();});}}
 prefetch(indices){indices.forEach(index=>this.get(index,false).catch(()=>{}));}
 prefetchWindow(indices){const wanted=new Set(indices);this.queue=this.queue.filter(task=>{if(task.priority||wanted.has(task.index))return true;if(this.pending.get(task.index)===task.promise)this.pending.delete(task.index);task.resolve(null);return false;});this.prefetch(indices);}
 clear(){this.generation++;for(const task of this.queue)task.resolve(null);this.queue=[];this.pending.clear();this.cache.clear();this.weights.clear();this.cacheBytes=0;this.windowSize=this.capacity;}
}

// A slow old request may fill the cache, but cannot overwrite a newer seek.
export class FramePresenter {
 constructor(loader,present,onError=()=>{}){this.loader=loader;this.present=present;this.onError=onError;this.generation=0;}
 cancel(){this.generation++;}
 async show(index){const generation=++this.generation;try{const image=await this.loader.get(index);if(generation!==this.generation)return false;this.present(index,image);return true;}catch(error){if(generation===this.generation)this.onError(error,index);return false;}}
}
