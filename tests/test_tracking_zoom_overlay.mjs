import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

test("legacy Bézier corner guides meet beyond the rounded outline", () => {
    const source = fs.readFileSync(new URL("../web/xzg_points_editor.js", import.meta.url), "utf8");
    const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
    const guide = vm.runInNewContext(
        extract("        const cubicPoint =", "        // 命中范围") +
        extract("        const curveCornerGuide =", "        const curveControls =") +
        "curveCornerGuide({x:0,y:0,out:{x:.55,y:0}}, {x:1,y:1,in:{x:1,y:.45},out:{x:1,y:1.55}}, {x:0,y:2,in:{x:.55,y:2}})"
    );
    assert.ok(guide.joint.x > 1);
    assert.ok(Math.abs(guide.joint.y - 1) < 1e-9);
});

test("rounded corners leave the outer control vertex off the mask outline", () => {
    const source = fs.readFileSync(new URL("../web/xzg_points_editor.js", import.meta.url), "utf8");
    const code = source.slice(source.indexOf("        const curveOutline ="), source.indexOf("        const curveControls ="));
    const outline = vm.runInNewContext(code + "curveOutline([{x:0,y:0,roundness:0},{x:1,y:0,roundness:.25},{x:1,y:1,roundness:0}])");
    assert.equal(outline[2].x, .75);
    assert.equal(outline[2].y, 0);
    assert.equal(outline[3].x, 1);
    assert.equal(outline[3].y, .25);
    assert.ok(!outline.some(point => point.x === 1 && point.y === 0));
});

test('unselected curves use solid cubic paths at screen size and pixel density',()=>{
    const source=fs.readFileSync(new URL('../web/xzg_points_editor.js',import.meta.url),'utf8');
    const code=source.slice(source.indexOf('        const syncBrushOverlaySize ='),source.indexOf('        // 开关关闭时的提示遮罩'));
    let zoom=1, previewZoom=1;const paths=[], dashes=[], squares=[];
    const painter=new Proxy({}, {get:(obj,key)=>obj[key] || ((...args)=>{
        if(key==='bezierCurveTo')paths.push(args);
        if(key==='setLineDash')dashes.push(args[0].length);
        if(key==='fillRect')squares.push(args[2]);
    })});
    const overlay={width:0,height:0,clientWidth:200,getBoundingClientRect:()=>({left:0,top:0,width:200*zoom,height:100*zoom}),getContext:()=>painter};
    const curve=[{x:.1,y:.1,in:{x:.1,y:.1},out:{x:.3,y:.1}},{x:.8,y:.8,in:{x:.6,y:.8},out:{x:.8,y:.8}}];
    const region={curve,poly:[[.1,.1],[.8,.8]]};
    const state={image:{},mode:'manual',manualKeyframes:{1:{0:[region]}},frameIdx:5,trackId:1,shapeSelected:false};
    const ctx=vm.createContext({state,brushOverlay:overlay,canvas:{clientWidth:200,getBoundingClientRect:()=>({left:0,top:0,width:200*zoom*previewZoom,height:100*zoom*previewZoom})},window:{devicePixelRatio:2},TRACK_COLORS:['red'],_solo:false,visibleTrackRegions:()=>[region]});
    vm.runInContext(code+'globalThis.draw=drawActiveOverlay;',ctx);
    ctx.draw();assert.equal(overlay.width,400);assert.equal(paths.length,2);assert.equal(paths[0][0],60);
    zoom=2;paths.length=0;ctx.draw();assert.equal(overlay.width,800);assert.equal(overlay.height,400);assert.equal(paths.length,2);assert.equal(paths[0][0],120);
    ctx.window.devicePixelRatio=1;ctx.draw();assert.equal(overlay.width,400);
    assert.ok(dashes.every(length => length === 0));
    zoom=1; state.shapeSelected=true;
    ctx.draw(); assert.equal(squares.at(-1),5);
    previewZoom=3;
    ctx.draw(); assert.equal(squares.at(-1),15);
    assert.equal(overlay.width,200);
});
