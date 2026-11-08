import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

test('unselected and dashed curves rerender as cubic paths at screen size and pixel density',()=>{
    const source=fs.readFileSync(new URL('../web/xzg_points_editor.js',import.meta.url),'utf8');
    const code=source.slice(source.indexOf('        const syncBrushOverlaySize ='),source.indexOf('        // 开关关闭时的提示遮罩'));
    let zoom=1;const paths=[];
    const painter=new Proxy({}, {get:(obj,key)=>obj[key] || ((...args)=>{if(key==='bezierCurveTo')paths.push(args)})});
    const overlay={width:0,height:0,clientWidth:200,getBoundingClientRect:()=>({left:0,top:0,width:200*zoom,height:100*zoom}),getContext:()=>painter};
    const curve=[{x:.1,y:.1,in:{x:.1,y:.1},out:{x:.3,y:.1}},{x:.8,y:.8,in:{x:.6,y:.8},out:{x:.8,y:.8}}];
    const region={curve,poly:[[.1,.1],[.8,.8]]};
    const state={image:{},mode:'manual',manualKeyframes:{1:{0:[region]}},frameIdx:5,trackId:1,shapeSelected:false};
    const ctx=vm.createContext({state,brushOverlay:overlay,canvas:{getBoundingClientRect:()=>({left:0,top:0,width:200*zoom,height:100*zoom})},window:{devicePixelRatio:2},TRACK_COLORS:['red'],_solo:false,visibleTrackRegions:()=>[region]});
    vm.runInContext(code+'globalThis.draw=drawActiveOverlay;',ctx);
    ctx.draw();assert.equal(overlay.width,400);assert.equal(paths.length,2);assert.equal(paths[0][0],60);
    zoom=2;paths.length=0;ctx.draw();assert.equal(overlay.width,800);assert.equal(overlay.height,400);assert.equal(paths.length,2);assert.equal(paths[0][0],120);
    ctx.window.devicePixelRatio=1;ctx.draw();assert.equal(overlay.width,400);
});
