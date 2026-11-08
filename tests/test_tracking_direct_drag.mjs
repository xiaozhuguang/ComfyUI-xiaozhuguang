import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source=fs.readFileSync(new URL("../web/xzg_points_editor.js",import.meta.url),"utf8");
function harness(manual,frame=5) {
    const state={manualKeyframes:manual,frameIdx:frame,trackId:1,image:{},mode:'manual',shapeSelected:true,tool:'rect'};
    const handlers={}; let writes=0;
    const wrapper={addEventListener:(key,fn)=>handlers[key]=fn,setPointerCapture(){}};
    const ctx=vm.createContext({state,canvasWrapper:wrapper,canvas:{getBoundingClientRect:()=>({width:1000,height:1000})},
        _solo:false,CONTROL_HIT_RADIUS:15,CURVE_CONTROL_HIT_RADIUS:6,controlScreenScale:()=>1,
        calcLayout:()=>({imgW:100,imgH:100}),toImg:e=>({x:e.x*100,y:e.y*100}),
        stopPlay(){},refreshTrackBtns(){},refreshToolBtn(){},updateCurveCursor(){},redraw(){},drawActiveOverlay(){},clearBrushOverlay(){},
        writeData(){writes++},curvePoly:curve=>curve.map(q=>[q.x,q.y]),
        insideCurve:()=>true,hitCurveSegment:()=>null,hitEditableRegion:(r,p)=>!!r.curve || (p.x>=r.x1&&p.x<=r.x2&&p.y>=r.y1&&p.y<=r.y2),
        saveCurve:curve=>{state.manualKeyframes[state.trackId][state.frameIdx]=[{curve,poly:curve.map(q=>[q.x,q.y])}];writes++}
    });
    const helpers=source.slice(source.indexOf('        const polySignedArea ='),source.indexOf('        const drawRegionBox ='));
    const target=source.slice(source.indexOf('        const rectDragTarget ='),source.indexOf('        const updateCurveCursor ='));
    const start=source.indexOf("        canvasWrapper.addEventListener('pointerdown'",source.indexOf('// ---- 框选交互 ----'));
    const events=source.slice(start,source.indexOf("        canvasWrapper.addEventListener('contextmenu'",start));
    vm.runInContext(helpers+target+events,ctx);
    const event=(x,y)=>({x,y,button:0,pointerId:1,altKey:false});
    return {state,handlers,event,writes:()=>writes};
}

test('dragging an interpolated rectangle creates this frame without changing source keys',()=>{
    const a={x1:.1,y1:.1,x2:.4,y2:.4}, b={x1:.3,y1:.3,x2:.6,y2:.6};
    const h=harness({1:{0:[a],10:[b]}});
    h.handlers.pointerdown(h.event(.35,.35));
    h.handlers.pointermove(h.event(.45,.4));
    h.handlers.pointerup(h.event(.45,.4));
    const r=h.state.manualKeyframes[1][5][0];
    assert.ok(Math.abs(r.x1-.3)<1e-9); assert.ok(Math.abs(r.y1-.25)<1e-9);
    assert.equal(a.x1,.1);assert.equal(b.x1,.3);assert.equal(h.writes(),1);
});

test('dragging after the last keyframe copies the held rectangle',()=>{
    const a={x1:.1,y1:.1,x2:.4,y2:.4};
    const h=harness({1:{0:[a]}});
    h.handlers.pointerdown(h.event(.25,.25));
    h.handlers.pointermove(h.event(.35,.35));
    h.handlers.pointerup(h.event(.35,.35));
    assert.ok(Math.abs(h.state.manualKeyframes[1][5][0].x1-.2)<1e-9);
    assert.equal(a.x1,.1);
});

test('dragging a dashed curve preserves editable handles and the original keyframe',()=>{
    const curve=[[.1,.1],[.5,.1],[.3,.5]].map(([x,y])=>({x,y,in:{x:x-.02,y},out:{x:x+.02,y},auto:false}));
    const snapshot=JSON.stringify(curve);
    const h=harness({1:{0:[{curve,poly:curve.map(q=>[q.x,q.y])}]}});
    h.handlers.pointerdown(h.event(.3,.2));
    h.handlers.pointermove(h.event(.4,.3));
    h.handlers.pointerup(h.event(.4,.3));
    const result=h.state.manualKeyframes[1][5][0];
    assert.ok(Math.abs(result.curve[0].x-.2)<1e-9);
    assert.ok(Math.abs(result.curve[0].in.x-.18)<1e-9);
    assert.equal(JSON.stringify(curve),snapshot);assert.equal(h.writes(),1);
});

test('clicking away from a dashed outline does not promote it',()=>{
    const h=harness({1:{0:[{x1:.1,y1:.1,x2:.4,y2:.4}]}});
    h.handlers.pointerdown(h.event(.9,.9));
    assert.equal(h.state.manualKeyframes[1][5],undefined);
});


test('an interpolated curve can become a draggable keyframe without losing its handles',()=>{
    const make=dx=>[[.1,.1],[.5,.1],[.3,.5]].map(([x,y])=>({x:x+dx,y,in:{x:x+dx-.02,y},out:{x:x+dx+.02,y},auto:false}));
    const a=make(0),b=make(.2);
    const h=harness({1:{0:[{curve:a,poly:a.map(q=>[q.x,q.y])}],10:[{curve:b,poly:b.map(q=>[q.x,q.y])}]}});
    h.handlers.pointerdown(h.event(.3,.2));h.handlers.pointermove(h.event(.4,.3));h.handlers.pointerup(h.event(.4,.3));
    const c=h.state.manualKeyframes[1][5][0].curve;
    assert.ok(Math.abs(c[0].x-.3)<1e-9);assert.ok(Math.abs(c[0].in.x-.28)<1e-9);
    assert.equal(a[0].x,.1);assert.ok(Math.abs(b[0].x-.3)<1e-9);
});

test('a dashed rectangle corner can resize directly into a keyframe',()=>{
    const a={x1:.1,y1:.1,x2:.4,y2:.4};const h=harness({1:{0:[a]}});
    h.handlers.pointerdown(h.event(.4,.4));h.handlers.pointermove(h.event(.6,.55));h.handlers.pointerup(h.event(.6,.55));
    const r=h.state.manualKeyframes[1][5][0];
    assert.ok(Math.abs(r.x2-.6)<1e-9);assert.ok(Math.abs(r.y2-.55)<1e-9);assert.equal(r.x1,.1);assert.equal(a.x2,.4);
});
