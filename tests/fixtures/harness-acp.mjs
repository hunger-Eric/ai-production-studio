import { createInterface } from 'node:readline';
const sessionId = 'test-author-session';
const model = { id:'model', currentValue:'["openai","gpt-6.1-sol"]' };
const effort = { id:'reasoning_effort', category:'thought_level', currentValue:'', options:[{value:'high'}] };
const reply = packet => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...packet})+'\n');
for await (const line of createInterface({input:process.stdin})) {
  const {id,method,params} = JSON.parse(line);
  switch (method) {
    case 'initialize': reply({id,result:{protocolVersion:1}}); break;
    case 'session/new': reply({id,result:{sessionId,configOptions:[model,effort]}}); break;
    case 'session/resume':
      if(params.sessionId!==sessionId) throw new Error('unexpected session');
      reply({id,result:{configOptions:[model,effort]}}); break;
    case 'session/set_config_option':
      if(params.value!=='high') throw new Error('unexpected effort');
      reply({id,result:{configOptions:[model,{...effort,currentValue:'high'}]}}); break;
    case 'session/prompt':
      if(params.sessionId!==sessionId) throw new Error('unexpected prompt recipient');
      reply({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',
        content:{type:'text',text:JSON.stringify({title:'只用于离线测试',scenes:[]})}}}});
      reply({id,result:{stopReason:'end_turn'}}); break;
  }
}
