// Bounded image loading with deduplication and foreground request priority.
export class FrameLoader {
 constructor(load,{capacity=12,concurrency=2}={}){this.load=load;this.capacity=capacity;this.concurrency=concurrency;this.cache=new Map();this.pending=new Map();this.queue=[];this.active=0;}
 get(index,priority=true){
  if(this.cache.has(index)){const image=this.cache.get(index);this.cache.delete(index);this.cache.set(index,image);return Promise.resolve(image);}
  if(this.pending.has(index)){if(priority){const pos=this.queue.findIndex(task=>task.index===index);if(pos>=0)this.queue.unshift(this.queue.splice(pos,1)[0]);}return this.pending.get(index);}
  let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});this.pending.set(index,promise);const task={index,resolve,reject};if(priority)this.queue.unshift(task);else this.queue.push(task);this.pump();return promise;
 }
 pump(){while(this.active<this.concurrency&&this.queue.length){const task=this.queue.shift();this.active++;Promise.resolve().then(()=>this.load(task.index)).then(image=>{this.cache.set(task.index,image);while(this.cache.size>this.capacity)this.cache.delete(this.cache.keys().next().value);task.resolve(image);},error=>task.reject(error)).finally(()=>{this.pending.delete(task.index);this.active--;this.pump();});}}
 prefetch(indices){indices.forEach(index=>this.get(index,false).catch(()=>{}));}
}

// A slow old request may fill the cache, but cannot overwrite a newer seek.
export class FramePresenter {
 constructor(loader,present,onError=()=>{}){this.loader=loader;this.present=present;this.onError=onError;this.generation=0;}
 cancel(){this.generation++;}
 async show(index){const generation=++this.generation;try{const image=await this.loader.get(index);if(generation!==this.generation)return false;this.present(index,image);return true;}catch(error){if(generation===this.generation)this.onError(error,index);return false;}}
}
