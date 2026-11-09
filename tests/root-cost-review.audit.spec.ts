import { it,expect } from 'vitest'
import { JobUsageFold,JobUsageReader } from '../src/app/job-usage.ts'
const usage=(inputTokens:number,outputTokens:number)=>({inputTokens,outputTokens})
const header=(seq:number)=>({seq,type:'request/header',data:{header:{config:{provider:'provider',model:'model'}}}})
const sample=(seq:number,u?:Record<string,number>,type='assistant/message')=>({seq,type,data:{turn:0,step:0,message:{},stream:[],...(u?{usage:u}:{})}})
it('same token sample can correct surviving route attribution after a header arrives',()=>{
 const fold=new JobUsageFold();fold.observe([sample(0,usage(10,5)),header(1),sample(2,usage(10,5))]);const s=fold.summary('session',{'provider/model':{input:1,output:1}})
 expect(s.totals.totalTokens).toBe(15);expect(s.coverage).toMatchObject({attempts:1,reported:1,attribution:'complete'});expect(s.routes).toHaveLength(1);expect(s.cost).toMatchObject({kind:'estimated'});expect('partial' in s.cost?s.cost.partial:false).not.toBe(true)
})
it('a sample-less same-step final message does not erase previously reported attempt usage',()=>{
 const fold=new JobUsageFold();fold.observe([header(0),sample(1,usage(10,5),'assistant/attempt'),sample(2)]);const s=fold.summary('session');expect(s.totals.totalTokens).toBe(15);expect(s.coverage).toMatchObject({attempts:1,reported:1})
})
it('changed opaque persistence revision invalidates an equal-length rewrite without optional eventCount',async()=>{
 let revision='first';let events=[header(0),sample(1,usage(10,5))]
 const service={async stat(){return {header:{id:'session'},revision}},async flush(){},async open(){return {async read(offset:number,length:number){return {events:events.slice(offset,offset+length),eventState:'detached'}},async [Symbol.asyncDispose](){}}}}
 const reader=new JobUsageReader({sessionPersistence:service} as never);expect((await reader.of('session'))?.totals.totalTokens).toBe(15)
 events=[header(0),sample(1,usage(2,1))];revision='second';expect((await reader.of('session'))?.totals.totalTokens).toBe(3)
})
it('retains caches through known-missing-known replacement and counts a genuine same-step retry',()=>{
 const f=new JobUsageFold();f.observe([header(0),sample(1,{inputTokens:10,outputTokens:5,cacheReadTokens:100}),sample(2),sample(3,{inputTokens:12,outputTokens:6,cacheReadTokens:120}),{seq:4,type:'llm/retry-started',data:{turn:0,step:0}},sample(5,usage(7,3))]);const s=f.summary('session');expect(s.coverage).toMatchObject({attempts:2,reported:2,cacheRead:'partial'});expect(s.totals).toMatchObject({uncachedInputTokens:19,outputTokens:9,cacheReadTokens:120,totalTokens:148})
})
