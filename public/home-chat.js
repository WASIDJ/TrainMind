/* D33: conversation is the home; training continues through existing rule-driven flows. */
let homeConversationId=null;
function homeConversationKey(){return 'trainmind-conversations:'+userId}
function readHomeConversations(){
  try{const rows=JSON.parse(localStorage.getItem(homeConversationKey())||'[]');return Array.isArray(rows)?rows.filter(x=>typeof x.id==='string'&&Array.isArray(x.messages)).slice(0,12):[]}catch{return []}
}
function saveHomeConversation(){
  if(!document.querySelector('.conversation-home')||!homeConversationId)return;
  if(!coachHistory.length)return;
  const rows=readHomeConversations().filter(x=>x.id!==homeConversationId);
  rows.unshift({id:homeConversationId,title:coachHistory.find(x=>x.role==='user')?.content.slice(0,32)||'和教练聊聊',updatedAt:Date.now(),messages:coachHistory.slice(-100),proposal:coachProposal});
  try{localStorage.setItem(homeConversationKey(),JSON.stringify(rows.slice(0,12)))}catch{const note=document.querySelector('#home-connection');if(note)note.textContent='此设备暂时无法保存对话；当前仍可继续聊天。'}
}
function syncHomeConversation(){
  const root=document.querySelector('.conversation-home');if(!root)return;
  root.classList.toggle('has-messages',coachHistory.length>0);
  const body=root.querySelector('.conversation-body');body.scrollTop=body.scrollHeight;
  const mic=root.querySelector('#mic');if(mic)mic.setAttribute('aria-label',voiceState==='listening'?'结束说话':'用语音和教练聊');
}
function home(intent=false){
  if(intent===true)return intentHome(true);
  leaveTrainingView();setNav('home');const shell=document.querySelector('.shell');shell.dataset.screen='home';
  voiceInputTarget='coach';voiceState='idle';voiceCaption='';coachError=null;
  const rows=readHomeConversations();
  const current=rows.find(x=>x.id===homeConversationId)||(!homeConversationId?rows[0]:null);
  homeConversationId=current?.id||homeConversationId||crypto.randomUUID();
  coachHistory=current?.messages.filter(x=>['user','assistant'].includes(x.role)&&typeof x.content==='string')||[];coachProposal=current?.proposal||null;
  if(coachHistory.at(-1)?.role==='user')coachError={input:coachHistory.at(-1).content,message:'上次回复未完成，可以重试这条消息。'};
  let pack='lin';try{pack=localStorage.getItem('trainmind-coach-pack:'+userId)||'lin'}catch{}
  const coach=({lin:['林澄','lin'],yue:['岳川','yue'],su:['苏禾','su']})[pack]||['林澄','lin'];
  app.innerHTML=`<section class="coach-screen conversation-home">
    <header class="conversation-header"><button class="chat-icon" id="chat-history-open" aria-label="查看此设备的历史对话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6h16M4 12h11M4 18h16"/></svg></button><div class="conversation-identity"><strong>${coach[0]} <span>AI 教练</span></strong><small><i></i> 随时在这里</small></div><button class="chat-icon" id="new-home-chat" aria-label="新建对话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9M15 3l6 6M10 14l2-6 6-6 4 4-6 6z"/></svg></button></header>
    <div class="conversation-body"><div class="conversation-welcome"><div class="chat-portrait"><img src="/coach-media/${coach[1]}-cover.jpg" alt="${coach[0]}教练形象"><span>AI</span></div><p class="chat-eyebrow">YOUR EVERYDAY COACH</p><h1>今天，想聊点什么？</h1><p>想练什么，或只是聊聊今天。<br>从你想说的开始，我在听。</p></div><div id="coach-history" class="coach-history" role="log" aria-label="与 AI 教练的对话" aria-live="polite"></div></div>
    <div class="conversation-bottom"><div id="home-resume"></div><button type="button" class="home-primary" id="home-primary"><span>看看下一场练什么</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button><div class="suggestion-heading"><span id="suggestion-label">我可以帮你</span><button id="refresh-suggestions" type="button">换一换 <span aria-hidden="true">↻</span></button></div><div class="service-bubbles" id="service-bubbles"></div><div class="home-chat-composer"><form id="coach-form"><textarea id="coach-input" rows="1" maxlength="500" aria-label="与教练对话" placeholder="和教练说说你的想法…"></textarea><div class="composer-actions"><button type="button" id="mic" class="chat-mic-icon" data-keep-icon="1" aria-label="用语音和教练聊" title="用语音和教练聊"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg></button><button type="submit" id="home-chat-send" aria-label="发送消息"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg></button></div></form></div><div class="chat-status" aria-live="polite"><span id="voice-status"></span><span id="voice-caption"></span><span id="home-connection"></span></div></div>
    <dialog id="home-history-dialog"><div class="history-header"><div><h2>最近的对话</h2><p>仅保存在此设备 · 最多 12 条对话</p></div><button class="chat-icon" id="close-home-history" aria-label="关闭历史对话">×</button></div><div id="home-history-list"></div></dialog>
  </section>`;
  const root=app.firstElementChild,box=root.querySelector('#coach-input');
  updateCoachHistory();voiceUI();
  root.querySelector('#coach-form').onsubmit=e=>{e.preventDefault();if(coachBusy)return;const text=box.value.trim();if(text){box.value='';box.style.height='auto';handleCoachInput(text,false,'touch')}};
  box.oninput=()=>{box.style.height='auto';box.style.height=Math.min(100,box.scrollHeight)+'px'};
  // 发送键只在有内容时点亮：常亮的高饱和黄会把输入框变成一屏里最响的东西
  {const sendBtn=root.querySelector('#home-chat-send');if(sendBtn){const syncSend=()=>sendBtn.classList.toggle('ready',!!box.value.trim());box.addEventListener('input',syncSend);syncSend()}}
  box.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();root.querySelector('#coach-form').requestSubmit()}};
  root.querySelector('#mic').onclick=()=>{if(coachBusy)return;toggleListening();syncHomeConversation()};
  root.querySelector('#new-home-chat').onclick=()=>{homeConversationId=crypto.randomUUID();home()};
  root.querySelector('#chat-history-open').onclick=()=>showHomeHistory(root);
  // 2026-11-09：右上角'新建对话'之前只画了图标没接事件（点了没反应）
  {const nb=root.querySelector('#new-home-chat');if(nb)nb.onclick=()=>{saveHomeConversation();homeConversationId=crypto.randomUUID();coachHistory=[];coachProposal=null;coachError=null;home()}};
  root.querySelector('#close-home-history').onclick=()=>root.querySelector('dialog').close();
  let alternate=false;
  // 2026-11-11：原来 4 个气泡排成两行两列，占掉小半屏，而且"安排今天的训练"
  // 与主行动"看看下一场练什么"其实是同一件事。现在主行动独立成按钮，
  // 气泡只留"说一句"这类对话入口，并排成一行横向滑动，不再换行。
  const suggestions=[
    {text:'今天有点累，想聊聊',icon:'☁',run:()=>send('今天有点累，想和你聊聊。')},
    {text:'回顾最近的训练',icon:'↺',run:()=>reviewHomeTraining(root)},
    {text:'看看计划适不适合我',icon:'⌁',run:()=>{appendHomeExchange('帮我看看这个训练计划','把计划文字或链接贴进来，我会对照现有训练信息分析。');importPage()}}
  ];
  const extra=[{text:'不知道从哪里开始',icon:'✧',run:()=>send('我想开始训练，但不知道从哪里开始。')},{text:'聊聊我的训练目标',icon:'◎',run:()=>send('我想和你聊聊我的训练目标。')},{text:'今天练了多久合适',icon:'◷',run:()=>send('今天适合练多久？')}];
  const send=text=>{if(!coachBusy)handleCoachInput(text,false,'touch')};
  const renderSuggestions=()=>{const host=root.querySelector('#service-bubbles');host.replaceChildren();for(const item of alternate?extra:suggestions){const b=document.createElement('button');b.type='button';const icon=document.createElement('span');icon.setAttribute('aria-hidden','true');icon.textContent=item.icon;b.append(icon,document.createTextNode(item.text));b.onclick=()=>{if(!coachBusy)item.run()};host.append(b)}};
  renderSuggestions();root.querySelector('#refresh-suggestions').onclick=()=>{alternate=!alternate;renderSuggestions()};
  root.querySelector('#home-primary').onclick=()=>{if(coachBusy)return;trainingHub(true)};
  api('/api/coach/settings').then(d=>{if(root.isConnected&&!d.configured){const status=root.querySelector('#home-connection');status.innerHTML='自由聊天需要连接模型。<button type="button">连接教练</button>';status.querySelector('button').onclick=()=>coachSettings(false)}}).catch(()=>{if(root.isConnected)root.querySelector('#home-connection').textContent='连接检查失败，发送时可重试。'});
  // 2026-11-11：这里原来还会追加一个「看看下一场练什么」的气泡，与主行动按钮重复，已移除。
  api('/api/workouts/active?userId='+encodeURIComponent(userId)).then(d=>{const saved=d.workout||workout;if(!root.isConnected||!saved||['completed','aborted'].includes(saved.status))return;const host=root.querySelector('#home-resume');host.replaceChildren();const b=document.createElement('button');b.className='chat-resume';b.textContent='↗ 继续未完成的训练';b.onclick=()=>{setWorkout(saved);continueWorkout()};host.append(b)}).catch(()=>{});
}
function appendHomeExchange(message,reply){coachError=null;coachHistory.push({role:'user',content:message},{role:'assistant',content:reply});updateCoachHistory()}
async function reviewHomeTraining(root){
  if(coachBusy)return;
  const button=[...root.querySelectorAll('#service-bubbles button')].find(x=>x.textContent.includes('回顾'));if(button)button.disabled=true;
  try{const data=await api('/api/progress?userId='+encodeURIComponent(userId));if(!root.isConnected)return;const volume=data.volume,rel=data.relationship;const text=rel?.totalSessions?volume?.text||rel.text:'还没有可回顾的训练记录。我们可以先聊聊目标，也可以安排第一场训练。';appendHomeExchange('帮我回顾最近的训练。',text);const detail=document.createElement('button');detail.className='chat-record-link';detail.textContent='查看训练记录 ↗';detail.onclick=recordsPage;root.querySelector('#coach-history').append(detail)}catch(e){if(root.isConnected){voiceCaption=e.message;voiceUI()}}finally{if(button?.isConnected)button.disabled=false}
}
function showHomeHistory(root){
  const list=root.querySelector('#home-history-list');list.replaceChildren();const rows=readHomeConversations();
  if(!rows.length){const empty=document.createElement('p');empty.textContent='还没有对话。从今天想说的开始吧。';list.append(empty)}
  for(const row of rows){const line=document.createElement('div');line.className='home-history-row';const open=document.createElement('button');open.className='history-open';const title=document.createElement('strong');title.textContent=row.title;const date=document.createElement('small');date.textContent=new Date(row.updatedAt).toLocaleString('zh-CN');open.append(title,date);open.onclick=()=>{homeConversationId=row.id;home()};const remove=document.createElement('button');remove.className='chat-icon';remove.textContent='×';remove.setAttribute('aria-label','删除对话：'+row.title);remove.onclick=()=>{try{localStorage.setItem(homeConversationKey(),JSON.stringify(readHomeConversations().filter(x=>x.id!==row.id)))}catch{remove.textContent='删除失败';return}if(row.id===homeConversationId){homeConversationId=crypto.randomUUID();home();return}line.remove()};line.append(open,remove);list.append(line)}
  root.querySelector('dialog').showModal();
}
