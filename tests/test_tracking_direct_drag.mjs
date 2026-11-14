import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source=fs.readFileSync(new URL("../web/xzg_points_editor.js",import.meta.url),"utf8");
function harness(manual,frame=5) {
    const state={manualKeyframes:manual,frames:Array(11),fillEdges:true,frameIdx:frame,trackId:1,image:{},mode:'manual',shapeSelected:true,tool:'rect'};
    const handlers={}; let writes=0;
    const wrapper={addEventListener:(key,fn)=>handlers[key]=fn,setPointerCapture(){}};
    const ctx=vm.createContext({state,canvasWrapper:wrapper,canvas:{getBoundingClientRect:()=>({width:1000,height:1000})},
        _solo:false,CONTROL_HIT_RADIUS:15,CURVE_CONTROL_HIT_RADIUS:10,controlScreenScale:()=>1,
        calcLayout:()=>({imgW:100,imgH:100}),toImg:e=>({x:e.x*100,y:e.y*100}),
        stopPlay(){},refreshTrackBtns(){},refreshToolBtn(){},updateCurveCursor(){},redraw(){},drawActiveOverlay(){},clearBrushOverlay(){},
        writeData(){writes++},curvePoly:curve=>curve.map(q=>[q.x,q.y]),
        insideCurve:()=>true,hitCurveSegment:()=>null,smoothCurve(){},hitEditableRegion:(r,p)=>r.curve ? p.x < .8 : (p.x>=r.x1&&p.x<=r.x2&&p.y>=r.y1&&p.y<=r.y2),
        saveCurve:curve=>{state.manualKeyframes[state.trackId][state.frameIdx]=[{curve,poly:curve.map(q=>[q.x,q.y])}];writes++}
    });
    const helpers=source.slice(source.indexOf('        const polySignedArea ='),source.indexOf('        const drawRegionBox ='));
    const target=source.slice(source.indexOf('        const rectDragTarget ='),source.indexOf('        const updateCurveCursor ='));
    const start=source.indexOf("        canvasWrapper.addEventListener('pointerdown'",source.indexOf('// ---- 框选交互 ----'));
    const events=source.slice(start,source.indexOf("        canvasWrapper.addEventListener('contextmenu'",start));
    const controls=source.slice(source.indexOf('        const curveCornerGuide ='),source.indexOf('        const drawActiveOverlay ='));
    const cubic=source.slice(source.indexOf('        const cubicPoint ='),source.indexOf('        // 命中范围'));
    vm.runInContext(helpers+cubic+controls+target+events+"\nglobalThis.visible = visibleTrackRegions;",ctx);
    const event=(x,y)=>({x,y,button:0,pointerId:1,altKey:false});
    return {state,handlers,event,visible:ctx.visible,writes:()=>writes};
}

test('blank clicks do not start a draft over a tracked or interpolated curve', () => {
    const curve = [[.2,.2],[.5,.2],[.35,.5]].map(([x,y]) => ({x,y,in:{x,y},out:{x,y}}));
    const region = {curve,poly:curve.map(({x,y}) => [x,y])};
    const h = harness({1:{0:[region],10:[region]}});
    h.state.tool = 'brush';
    h.handlers.pointerdown(h.event(.9,.9));
    assert.ok(!h.state.curveDraft);
    assert.equal(h.state.manualKeyframes[1][5], undefined);
    h.state.srcKey = 'video';
    h.state.autoTracking = {video_id:'video', tracks:{1:{5:region}}};
    h.handlers.pointerdown(h.event(.9,.9));
    assert.ok(!h.state.curveDraft);
    assert.equal(h.writes(), 0);
});

test('edge fill follows the first and last authored masks and can be switched off', () => {
    const first = {x1:.1,y1:.1,x2:.4,y2:.4};
    const last = {x1:.3,y1:.3,x2:.6,y2:.6};
    const h = harness({1:{3:[first]}});
    assert.equal(h.visible(1, 0)[0], first);
    assert.equal(h.visible(1, 10)[0], first);
    h.state.manualKeyframes[1][7] = [last];
    assert.equal(h.visible(1, 0)[0], first);
    assert.equal(h.visible(1, 10)[0], last);
    assert.deepEqual(Object.keys(h.state.manualKeyframes[1]), ["3", "7"]);
    h.state.fillEdges = false;
    assert.equal(h.visible(1, 0).length, 0);
    assert.equal(h.visible(1, 10).length, 0);
    assert.equal(h.visible(1, 5).length, 1);
});

test('curve anchor hit area wins near the point and the outline margin blocks whole dragging', () => {
    const curve = [[.2,.2],[.6,.2],[.6,.6],[.2,.6]].map(([x,y]) => ({
        x, y, in:{x,y}, out:{x,y}, roundness:0, auto:false,
    }));
    const h = harness({1:{5:[{curve,poly:curve.map(q => [q.x,q.y])}]}});
    h.handlers.pointerdown(h.event(.208,.2));
    assert.equal(h.state.curveDrag.kind, 'anchor');
    h.handlers.pointerup(h.event(.208,.2));
    h.handlers.pointerdown(h.event(.4,.204));
    assert.equal(h.state.curveDrag, null);
    h.handlers.pointerdown(h.event(.4,.4));
    assert.equal(h.state.curveDrag.kind, 'whole');
});

test('curve tool can draw and close a new outline over a rectangle', () => {
    const rect = {x1:.1,y1:.1,x2:.8,y2:.8};
    const h = harness({1:{5:[rect]}});
    h.state.tool = 'brush';
    for (const [x,y] of [[.2,.2],[.5,.25],[.35,.6]]) {
        h.handlers.pointerdown(h.event(x,y));
        h.handlers.pointerup(h.event(x,y));
    }
    assert.equal(h.state.curveDraft.length, 3);
    assert.equal(h.state.manualKeyframes[1][5][0], rect);
    h.handlers.pointerdown(h.event(.2,.2));
    h.handlers.pointerup(h.event(.2,.2));
    assert.equal(h.state.curveDraft, null);
    assert.equal(h.state.manualKeyframes[1][5][0].curve.length, 3);
});

test('curve bounds edges resize one axis and corners resize both axes', () => {
    const makeCurve = () => [[.2,.2],[.6,.2],[.6,.6],[.2,.6]].map(([x,y]) => ({
        x, y, in:{x,y}, out:{x,y}, auto:false,
    }));
    for (const corner of [false,true]) {
        const curve = makeCurve();
        const h = harness({1:{5:[{curve, poly:curve.map(({x,y}) => [x,y])}]}});
        const y = corner ? .188 : .4;
        h.handlers.pointerdown(h.event(.188,y));
        h.handlers.pointermove(h.event(.138,y-.07));
        h.handlers.pointerup(h.event(.138,y-.07));
        if (corner) {
            assert.ok(curve[0].x < .2 && curve[0].y < .2);
            assert.ok(Math.abs(curve[2].x - .6) < .002);
            assert.ok(Math.abs(curve[2].y - .6) < .003);
        } else {
            assert.ok(curve[0].x < .2);
            assert.ok(Math.abs(curve[2].x - .6) < .002);
            assert.equal(curve[0].y, .2);
            assert.equal(curve[2].y, .6);
        }
    }
});

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

test('clicking a tracked rectangle without dragging saves a manual keyframe', () => {
    const rect = {x1:.2,y1:.2,x2:.4,y2:.4};
    const h = harness({1:{0:[{x1:.1,y1:.1,x2:.3,y2:.3}]}});
    h.state.srcKey = 'video';
    h.state.autoTracking = {video_id:'video', tracks:{1:{5:rect}}};
    h.handlers.pointerdown(h.event(.3,.3));
    h.handlers.pointerup(h.event(.3,.3));
    assert.deepEqual({...h.state.manualKeyframes[1][5][0]}, rect);
    assert.equal(h.writes(), 1);
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

test('clicking a tiny rectangle with slight pointer jitter preserves its geometry', () => {
    const rect = {x1:.1,y1:.1,x2:.104,y2:.104};
    const original = {...rect};
    const h = harness({1:{5:[rect]}});
    h.handlers.pointerdown(h.event(.1,.1));
    h.handlers.pointermove(h.event(.102,.102));
    h.handlers.pointerup(h.event(.102,.102));
    assert.deepEqual(rect, original);
});

test('dragging the center of a tiny rectangle moves it without changing size', () => {
    const rect = {x1:.1,y1:.1,x2:.104,y2:.104};
    const h = harness({1:{5:[rect]}});
    h.handlers.pointerdown(h.event(.102,.102));
    h.handlers.pointermove(h.event(.112,.122));
    h.handlers.pointerup(h.event(.112,.122));
    assert.ok(Math.abs(rect.x1-.11) < 1e-9);
    assert.ok(Math.abs(rect.y1-.12) < 1e-9);
    assert.ok(Math.abs(rect.x2-rect.x1-.004) < 1e-9);
    assert.ok(Math.abs(rect.y2-rect.y1-.004) < 1e-9);
});

test('dragging a rectangle blends both sides without removing automatic results or manual anchors', () => {
    const box = x => ({x1:x, y1:.2, x2:x+.2, y2:.5});
    const h = harness({1:{2:[box(0)], 5:[box(.1)], 9:[box(.6)]}});
    const frames = {1:box(0), 3:box(0), 4:{...box(0), tracking_reliable:false},
        5:box(.1), 6:{...box(.1), tracking_reliable:false}, 7:box(.1), 8:box(.5), 10:box(.6)};
    h.state.srcKey = 'video';
    h.state.autoTracking = {video_id:'video', tracks:{1:frames}};
    h.handlers.pointerdown(h.event(.2,.35));
    h.handlers.pointermove(h.event(.3,.35));
    h.handlers.pointerup(h.event(.3,.35));
    assert.ok(Math.abs(h.visible(1, 4)[0].x1 - .2 * 2 / 3) < 1e-9);
    assert.ok(Math.abs(h.visible(1, 7)[0].x1 - .15) < 1e-9);
    assert.ok(Math.abs(h.visible(1, 8)[0].x1 - .525) < 1e-9);
    assert.equal(h.visible(1, 2)[0].x1, 0);
    assert.equal(h.visible(1, 9)[0].x1, .6);
    assert.equal(frames[10].manual_transition, undefined);
    assert.equal(frames[4].manual_transition, true);
});
