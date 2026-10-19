const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
// Run only against an isolated ComfyUI instance with a disposable user directory.
const url=process.env.COMFY_TEST_URL;
if(!url) throw Error('Set COMFY_TEST_URL to an isolated test instance');
const original=process.env.XZG_ORIGINAL_STORAGE;
const mode=process.env.XZG_REFRESH_MODE||'current';
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
 const page=await browser.newPage();
 await page.request.post(url+'/settings',{data:{'Comfy.TutorialCompleted':true,'Comfy.Workflow.Persist':true}});
 let storageLoads=0;
 await page.route('**/extensions/**/*.js',route=>{
  const path=new URL(route.request().url()).pathname;
  const disable=mode==='no-manager'&&path.endsWith('/xzg_workflows.js')
   ||mode==='no-pose'&&/\/(xzg_image_loader|xzg_pose_editor|xzg_image_pose_editor_ctrl_character_controls)\.js$/.test(path)
   ||mode==='no-adapter'&&path.endsWith('/xzg_disable_workflow_drafts.js');
  return disable?route.fulfill({contentType:'text/javascript',body:''}):route.continue();
 });
 if(original) await page.route('**/lib/xzg_workflow_draft_storage.mjs*',route=>{
  storageLoads++;
  const old=mode!=='migrate'||storageLoads===1;
  return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(old?original:'web/lib/xzg_workflow_draft_storage.mjs','utf8')});
 });
 const ready=async()=>{
  await page.waitForFunction(()=>window.app?.canvas&&window.app?.extensionManager?.workflow,{timeout:60000});
  await page.waitForTimeout(2500);
 };
 await page.goto(url);await ready();
 const graph=JSON.parse(fs.readFileSync('../../default_workflow.json','utf8'));
 const expected=await page.evaluate(async({graph,large})=>{
  await app.extensionManager.command.execute('Comfy.NewBlankWorkflow');
  await app.handleFile(new File([JSON.stringify(graph)],'refresh-import-test.json',{type:'application/json'}));
  if(large){
   const node=LiteGraph.createNode('VNCCS_PoseStudio');
   if(!node)throw Error('VNCCS Pose Studio node is not registered');
   app.graph.add(node);
   node.properties.xzgDraftRestoreProbe='pose-node-kept';
   graph=app.graph.serialize();
   graph.extra={...graph.extra,xzgRefreshTest:'x'.repeat(8*1024*1024)};
   await app.handleFile(new File([JSON.stringify(graph)],'refresh-large-test.json',{type:'application/json'}));
  }
  return app.extensionManager.workflow.openWorkflows.map(w=>w.path);
 },{graph,large:mode==='current'});
 await page.waitForTimeout(1200);

 await page.reload();await ready();
 const result=await page.evaluate(()=>({paths:app.extensionManager.workflow.openWorkflows.map(w=>w.path),large:app.graph.serialize().extra?.xzgRefreshTest?.length,pose:app.graph._nodes.find(node=>node.type==='VNCCS_PoseStudio')?.properties.xzgDraftRestoreProbe}));
 if(['no-manager','no-pose','original'].includes(mode)){
  assert.equal(result.paths.includes('workflows/refresh-import-test.json'),false);
  console.log('REPRODUCED '+mode+': imported temporary workflow disappears');
 }else{
  assert.deepEqual(result.paths,expected);
  if(mode==='current'){assert.equal(result.large,8*1024*1024);assert.equal(result.pose,'pose-node-kept');}
  console.log('PASS '+mode+': all '+expected.length+' temporary tabs restored'+(result.large?' including 8 MiB payload':''));
 }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
