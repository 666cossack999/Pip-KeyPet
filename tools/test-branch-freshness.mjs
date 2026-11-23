// Execute the actual workflow's github-script with a mocked GitHub API.
// Protects against stale-branch misclassification and accidental auto-merge.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const text = readFileSync('.github/workflows/branch-freshness.yml', 'utf8');
const marker = '          script: |\n';
const idx = text.indexOf(marker);
assert.ok(idx >= 0, 'github-script body');
const script = text.slice(idx + marker.length).split('\n')
  .filter(line => line.startsWith('            '))
  .map(line => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const execute = new AsyncFunction('context','github','core',script);
assert.ok(!/github\.rest\.repos\.(merge|updateBranch)|github\.rest\.git\.updateRef|force-push/.test(script),
  'freshness check must not merge/update refs');

async function run({behind, draft=false, dirty=false, oldLabel=false, eventName='pull_request'}) {
  const events = [];
  const sha='a'.repeat(40);
  const pr={number:3,draft,head:{ref:'feature/ble-ota',sha,
    repo:{full_name:'666cossack999/Pip-KeyPet'}},labels:oldLabel?[{name:'needs-main-sync'}]:[]};
  const core={
    info:x=>events.push('info:'+x),
    warning:x=>events.push('warn:'+x),
    setFailed:x=>events.push('fail:'+x),
    summary:{addHeading(){return this;},addTable(){return this;},async write(){}}
  };
  const github={
    paginate:async()=>[pr],
    request:async()=>({data:{behind_by:behind,ahead_by:2}}),
    rest:{
      pulls:{
        list(){},
        get:async()=>({data:{...pr,mergeable:dirty?false:true,
            mergeable_state:dirty?'dirty':'clean'}})
      },
      issues:{
        getLabel:async()=>({}),
        createLabel:async()=>{events.push('create-label');},
        addLabels:async v=>{events.push('add:'+v.labels[0]);},
        removeLabel:async v=>{events.push('remove:'+v.name);}
      }
    }
  };
  const context={
    repo:{owner:'666cossack999',repo:'Pip-KeyPet'},
    eventName,
    payload:{pull_request:{number:3,draft}}
  };
  await execute(context,github,core);
  return events;
}
const staleDraft=await run({behind:7,draft:true,dirty:true,eventName:'push'});
assert.ok(staleDraft.includes('add:needs-main-sync'));
assert.ok(staleDraft.includes('add:main-sync-conflict'));
assert.ok(!staleDraft.some(e=>e.startsWith('fail:')));
const staleReady=await run({behind:7,draft:false});
assert.ok(staleReady.some(e=>e.startsWith('fail:')));
const fresh=await run({behind:0,oldLabel:true,eventName:'push'});
assert.ok(fresh.includes('remove:needs-main-sync'));
assert.ok(!fresh.some(e=>e.startsWith('fail:')));
const push=await run({behind:7,eventName:'push'});
assert.ok(push.includes('add:needs-main-sync'));
assert.ok(!push.some(e=>e.startsWith('fail:')));
const readOnlyPR=await run({behind:7,draft:true,eventName:'pull_request'});
assert.ok(!readOnlyPR.some(e=>e.startsWith('add:') || e.startsWith('remove:') || e.startsWith('create-label')));
assert.ok(!readOnlyPR.some(e=>e.startsWith('fail:')));
console.log('ok: branch freshness workflow, draft/ready, conflict, restored freshness, no mutations of refs');
