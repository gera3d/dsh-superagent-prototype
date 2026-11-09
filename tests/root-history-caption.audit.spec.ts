import {expect,it} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {DecisionCard} from '../src/client/decision-card.tsx'
it('an unresolved read-only or restored staged card is not historical merely because execution callback is absent',()=>{
 const html=renderToStaticMarkup(createElement(DecisionCard,{title:'Choose a real next step',stageOnly:true,choices:[{id:'a',label:'Review current evidence'},{id:'b',label:'Inspect remaining requirement'}],recommendation:{recommendedValue:'a',confidence:0.7,rationale:'Current unresolved step',distribution:[],provider:'fixture',latencyMs:0}}))
 expect(html).not.toContain('Historical recommendation')
})
