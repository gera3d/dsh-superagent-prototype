import {expect,it} from 'vitest'
import {suggestHelper,extractUserObjectiveFromDigest} from '../src/app/routes/helper.ts'
import {SettingsSchema} from '../src/policy.ts'
const digest={summary:'Explain caching options.',latestTurn:"## Original goal (first human message)\nExplain caching options.\n\n## Latest human message\nPlease draft a new issue for the native-tool gap; do not file or send it.\n\n## What the agent did this turn (0 tool calls; turn ended: completed)\n- (zero outer tool calls; nested-provider coverage unknown, not tests absent)\n\n## Agent's final message to the human\nI can draft the requested issue for review."}
it('real plugin digest uses latest human request, not older original summary',()=>{expect(extractUserObjectiveFromDigest(digest)).toBe('Please draft a new issue for the native-tool gap; do not file or send it.')})
it('real plugin digest keeps useful requested generated draft option after earlier unrelated discussion',async()=>{
 const options=[{id:'draft',label:'Draft requested native-tool gap issue',prompt:'Draft the new issue for the native-tool gap requested above. Do not file or send it.',recommended:true},{id:'clarify',label:'Clarify issue scope',prompt:'Ask which reproduction details belong in the requested issue draft.',recommended:false}]
 const ctx:any={llm:{resolveCallConfig:async(r:any)=>r,async *stream(){yield{type:'text-delta',text:JSON.stringify({options})};yield{type:'finish',reason:{kind:'stop'}}}},logger:{warn(){}},get(){}}
 const response=await suggestHelper(ctx,digest,SettingsSchema.parse({models:{helper:{provider:'test',model:'test'}}}))
 expect(response.options.map(x=>x.id)).toEqual(['draft','clarify'])
})
