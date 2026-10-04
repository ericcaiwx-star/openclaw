import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const checkout = process.argv[2];
const pr = Number(process.argv[3]);
assert(checkout && [164274,158568].includes(pr));
const proofRoot = await mkdtemp('/tmp/qq-review-');
const results = [];
let failed = false;
for (const scenario of ['recovers', 'persistent', 'failed-tool']) {
  const root = join(proofRoot, scenario), workspace = join(root, 'workspace'), state = join(root,'state');
  await mkdir(workspace,{recursive:true}); await mkdir(state,{recursive:true});
  const ledger = join(workspace,'executions.txt');
  const requests=[];
  const marker = `QQ_REVIEW_${scenario.toUpperCase().replaceAll('-','_')}`;
  const server=createServer(async(req,res)=>{
    try {
      let raw='';for await(const part of req) raw+=part;
      const input=JSON.parse(raw), messages=input.messages;
      const continuation=messages.some(m => m.role==='user' && /Continue (?:the )?current task|Continue from the current state: re-issue|latest tool-call batch was rejected/i.test(JSON.stringify(m.content)));
      requests.push({number:requests.length+1,continuation,toolResultCount:messages.filter(m=>m.role==='tool').length,originalUserCount:messages.filter(m=>m.role==='user'&&JSON.stringify(m.content).includes('Perform the preparation tool once')).length});
      assert(requests.length<=10,'unbounded provider requests');
      res.writeHead(200,{'content-type':'text/event-stream'});
      const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:`review-${requests.length}`,object:'chat.completion.chunk',created:1,model:'deepseek-v4-flash',choices:[{index:0,delta,finish_reason}]})}\n\n`);
      emit({role:'assistant'});
      if(requests.length===1){
        assert(input.tools.some(t=>t.function.name==='exec'),'exec unavailable');
        emit({tool_calls:[{index:0,id:'prepared-once',type:'function',function:{name:'exec',arguments:JSON.stringify({command:`printf 'executed\\n' >> '${ledger}'${scenario==='failed-tool'?' ; exit 7':''}`})}}]});emit({},'tool_calls');
      }else if(requests.length===2||scenario==='persistent'){
        emit({tool_calls:[{index:0,id:`rejected-${requests.length}`,type:'function',function:{name:'exec',arguments:'{"command":'}}]});emit({},'tool_calls');
      }else{
        assert(continuation,'missing transcript continuation');
        assert.equal(requests.at(-1).toolResultCount,1,'completed result missing or duplicated');
        emit({content:scenario==='failed-tool'?`${marker}: prior tool failed with exit 7; no success claimed.`:marker});emit({},'stop');
      }
      res.end('data: [DONE]\n\n');
    }catch(error){res.destroy(error);}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const configPath=join(root,'openclaw.json');
  await writeFile(configPath,JSON.stringify({agents:{defaults:{workspace,skipBootstrap:true,model:{primary:'proof/deepseek-v4-flash'}}},models:{providers:{proof:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'synthetic-loopback-only',models:[{id:'deepseek-v4-flash',name:'Synthetic loopback proof',contextWindow:100000,maxTokens:2048}]}}},plugins:{enabled:false},tools:{allow:['exec'],codeMode:false,exec:{host:'gateway',mode:'full'}}}));
  const env={PATH:process.env.PATH,HOME:join(root,'home'),USER:'runner',LANG:'C.UTF-8',OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:configPath};
  await mkdir(env.HOME,{recursive:true});
  let stdout='',stderr='',code=null;
  const child=spawn(process.execPath,[join(checkout,'openclaw.mjs'),'agent','--local','--agent','main','--session-id',`qq-review-${scenario}`,'--message','Perform the preparation tool once, then finish the response.','--thinking','off','--json','--timeout','60'],{cwd:checkout,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',p=>stdout+=p);child.stderr.on('data',p=>stderr+=p);
  const timer=setTimeout(()=>child.kill('SIGTERM'),75000);
  try{code=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});}finally{clearTimeout(timer);await new Promise(r=>server.close(r));}
  await writeFile(join(root,'stdout.log'),stdout);await writeFile(join(root,'stderr.log'),stderr);await writeFile(join(root,'requests.json'),JSON.stringify(requests,null,2));
  const lines=await readFile(ledger,'utf8').then(t=>t.trim().split('\n')).catch(()=>[]);
  const recovered=stdout.includes(marker);
  const row={scenario,code,requestCount:requests.length,preparationExecutions:lines.length,recovered,requests};
  try{
    assert.deepEqual(lines,['executed'],'completed operation was repeated or missing');
    assert(requests.every(r=>r.originalUserCount===1),'original user turn duplicated');
    if(scenario==='recovers') {assert(recovered,'no successful continuation');assert.equal(code,0);assert.equal(requests.length,3);}
    if(scenario==='persistent'){assert(!recovered);assert(requests.length>=3&&requests.length<=9);assert.notEqual(code,0);assert(/incomplete_turn|Agent run failed|couldn.t|malformed/.test(stdout+stderr));}
    if(scenario==='failed-tool'){
      if(pr===164274){assert(!recovered,'failed tool incorrectly continued');assert.notEqual(code,0);}
      else{assert(recovered,'failed-tool continuation missing');assert.equal(code,0);}
    }
    row.verdict='pass';
  }catch(error){row.verdict='fail';row.error=error.message;failed=true;}
  console.log('RUNTIME_SCENARIO '+JSON.stringify(row)); results.push(row);
}
await writeFile(join(proofRoot,'summary.json'),JSON.stringify({pr,results},null,2));
console.log('RUNTIME_PROOF_ROOT '+proofRoot);
process.exitCode=failed?1:0;
