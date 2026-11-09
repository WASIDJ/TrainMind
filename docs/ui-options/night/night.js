import { packs } from './packs.js';
import { renderImmersive } from '../ladder/immersive-views.js';

const editorialDesign = document.body.dataset.design === 'ladder';

const symbols = {
  mark: '<path d="m2 18 6-12 4 8 4-8 6 12"/>',
  home: '<path d="m3 10 9-7 9 7v10H3zM9 20v-6h6v6"/>',
  plan: '<path d="M6 5h12v15H6zM9 9h6m-6 4h6m-6 4h4"/>',
  records: '<path d="M4 20h16M7 16v-4m5 4V5m5 11V9"/>',
  coaches: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H5m6-6-6 6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pause: '<path d="M9 5v14m6-14v14"/>'
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${symbols[name]}</svg>`;
}

const catalog = [
  { name:'杯式深蹲', category:'下肢', reps:10, equipment:'哑铃', cue:'稳住脚掌，控制下蹲。' },
  { name:'罗马尼亚硬拉', category:'下肢', reps:10, equipment:'哑铃', cue:'髋向后坐，哑铃贴近身体。' },
  { name:'俯卧撑', category:'上肢', reps:8, equipment:'自重', cue:'收紧躯干，保持动作平稳。' },
  { name:'徒手深蹲', category:'下肢', reps:8, equipment:'自重', cue:'按自己的节奏下蹲。' },
  { name:'臀桥', category:'下肢', reps:8, equipment:'自重', cue:'动作放慢，稳定落地。' },
  { name:'靠墙俯卧撑', category:'上肢', reps:8, equipment:'自重', cue:'收紧躯干，缓慢推起。' },
  { name:'弹力带划船', category:'上肢', reps:10, equipment:'弹力带', cue:'肩膀放松，手肘向后。' }
];
let exercises = catalog.slice(0,3).map(item => ({...item, sets:3}));
const plan = { title:'全身力量', minutes:30, restSeconds:60, intensity:'中等', reason:'上次动作稳定，今天按熟悉节奏练。' };
const navItems = {
  home:'首页', intent:'计划生成', plan:'计划确认 / 编辑', map:'课程章节地图',
  active:'组内训练', rest:'组间休息', probe:'喊停追问', agency:'退路三选一',
  safety:'疼痛安全态', paused:'暂停', timed:'热身 / 放松', replace:'动作替换 / 跳过',
  summary:'结算', survey:'训练后问卷', records:'记录列表', detail:'记录详情',
  progress:'进步', profile:'我的 / 档案', settings:'教练设置', errors:'权限与错误态',
  coaches:'教练形象资源包'
};
const tabs = { home:'首页', course:'计划', records:'记录', profile:'我的' };
const storageKey = 'trainmind-night-coach';
const screen = document.querySelector('#screen');
const tabBar = document.querySelector('#tabs');
const jumpBar = document.querySelector('#jumps');
const statePicker = document.querySelector('#view-state');
let page = 'home';
let viewState = 'normal';
let coach = packs.find(pack => pack.id === localStorage.getItem(storageKey)) ?? packs[0];
let completed = [];
let moveIndex = 0;
let setIndex = 0;
let deadline = 0;
let clockLength = 60;
let timer;
let startedAt;
let pauseFrom = 'active';
let pauseRemaining = 0;
let safetyStopped = false;
let askedThisSet = false;
let openingCue = false;
let adjustment = '';
let overrideReps = null;
let replaceFrom = 'active';
let replaceIndex = 0;
let agencyScope = 'set';
let agencyPending = false;
let timedKind = 'warm';
let surveyStep = 0;
let surveyAnswers = [];
let recordIndex = 0;
let sessionResult = null;
let voiceState = 'listening';
let errorKind = 'mic';
const durations = [20,30,40,45];
const equipment = ['自重','哑铃','弹力带'];
const goals = ['全身','下肢','上肢','恢复'];
const places = ['在家','健身房','办公室'];
const readiness = ['状态良好','有点累','有不适'];
const intentState = { minutes:30, place:localStorage.getItem('trainmind-night-place') || '在家', gear:['自重'], goal:'全身', state:'状态良好' };
const sampleSets = [
  { movement:'徒手深蹲', number:1, reps:8, weight:'自重', feedback:'稳定', adopted:'保持原目标' },
  { movement:'徒手深蹲', number:2, reps:null, weight:'自重', feedback:'未补充', adopted:'—' },
  { movement:'靠墙俯卧撑', number:1, reps:8, weight:'自重', feedback:'偏难', adopted:'下次少一组' }
];
const sampleHistory = [
  { name:'全身力量', date:'11 月 2 日', duration:30, sets:6, planned:6, weekday:0, details:sampleSets },
  { name:'上肢力量', date:'10 月 29 日', duration:28, sets:4, planned:6, weekday:3, ended:true, details:[] }
];
const total = () => exercises.reduce((sum,item) => sum + item.sets,0);
const trainingHistory = () => sessionResult ? [sessionResult,...sampleHistory] : sampleHistory;
const date = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'short'}).format(new Date());

function avatar(pack = coach) {
  const { zoom, x, y } = pack.avatar;
  return `<span class="avatar" aria-hidden="true"><img src="${pack.photo}" alt="" style="width:${zoom * 100}%;left:${x}%;top:${y}%"></span>`;
}

function photo(pack, role) {
  return `<img class="portrait" src="${pack.photo}" alt="" style="object-position:${pack[role]}">`;
}

function button(label, action, symbol = 'arrow', secondary = false) {
  return `<button class="${secondary ? 'secondary' : 'primary'}" data-action="${action}"><span>${label}</span>${icon(symbol)}</button>`;
}

function top(title, back = 'home') {
  return `<header class="top"><button class="icon-button" data-page="${back}" aria-label="返回">${icon('back')}</button><b>${title}</b><span class="top-end"></span></header>`;
}

const voiceLabels = { listening:'听着呢', speaking:'教练在说', processing:'正在理解…', unclear:'没听清，再说一次', denied:'麦克风没开', unavailable:'语音不可用，点按钮也行' };
function voiceLine() {
  return `<span class="voice ${voiceState}" id="voice-status" aria-live="polite"><i aria-hidden="true"></i>${voiceLabels[voiceState]}</span>`;
}
function coachNote(cue) {
  return `<aside class="coach-note">${avatar()}<div><small>${coach.name} · 教练提示</small><p>${cue}</p></div>${voiceLine()}</aside>`;
}
function linkRow(title, copy, action) {
  return `<button class="link-row" data-action="${action}"><span><b>${title}</b><small>${copy}</small></span>${icon('arrow')}</button>`;
}
function heading(label,title,copy='') {
  return `<p class="eyebrow phase">${label}</p><h2>${title}</h2>${copy ? `<p class="phase-sub">${copy}</p>` : ''}`;
}
function dock(...items) {
  return `<footer class="dock">${items.join('')}</footer>`;
}
function home() {
  if (editorialDesign) return editorialHome();
  const latest = trainingHistory()[0];
  return `<header class="top home-top"><b>${icon('mark')}TrainMind</b><button class="icon-button" data-page="coaches" aria-label="选择教练形象">${avatar()}</button></header>
    <section class="home-cover">${photo(coach,'cover')}<div class="cover-date mono">${date}</div>
      <div class="cover-copy"><p class="eyebrow">第 1 周 · 起步 · 第 2 场</p><h2>全身力量</h2><p class="cover-meta">今天练什么 · 约 30 分钟</p>${button('查看今日训练','plan')}</div>
    </section>
    <div class="home-lower">${viewState === 'resume' ? linkRow('继续未完成的训练','保留上次进度','resume-preview') : ''}
      <div class="relationship">${avatar()}<div>${sessionResult ? '' : '<b>隔了 4 天，今天接着练。</b>'}<small>一起练了 ${trainingHistory().length} 次 · 当前在第 1 章</small></div></div>
      ${linkRow('最近一次 · '+latest.name,latest.date+' · '+latest.duration+' 分钟','record:0')}
      ${linkRow('安排一场新训练','设置时长、器械和今天的状态','intent')}
    </div>`;
}
function editorialHome() {
  const latest = trainingHistory()[0];
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay()+6)%7);
  const weekdays = Array.from({length:7}, (_,i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate()+i);
    const current = i===(now.getDay()+6)%7;
    return `<div ${current?'aria-current="date"':''}><span>${'一二三四五六日'[i]}</span><b>${String(day.getDate()).padStart(2,'0')}</b></div>`;
  }).join('');
  return `<header class="top home-top"><b>${icon('mark')}TRAINMIND</b><button class="icon-button" data-page="profile" aria-label="打开我的档案">${avatar()}</button></header>
    <div class="editorial-intro"><p class="eyebrow">YOUR NEXT SESSION</p><h2>今天，练起来。</h2></div>
    <div class="week-band" aria-label="本周日历">${weekdays}</div>
    <section class="home-cover">
      ${photo(coach,'cover')}
      <div class="cover-badges"><span>第 1 周 · 起步</span><span class="priority">今日训练</span></div>
      <div class="cover-copy"><p class="eyebrow">STRENGTH / 02</p><h2>全身<br>力量训练</h2><p class="cover-meta">30 分钟 · 哑铃 / 自重</p><div class="cover-coach">${avatar()}<span>跟着 ${coach.name} 练</span></div>${button('查看今日训练','plan')}</div>
    </section>
    <div class="home-lower">${viewState === 'resume' ? linkRow('继续未完成的训练','保留上次进度','resume-preview') : ''}
      <p class="relationship-line">一起练了 ${trainingHistory().length} 次 · 当前在第 1 章</p>
      <div class="recent-heading"><h3>接着上次的节奏</h3><button class="text-button" data-page="records">全部记录 ↗</button></div>
      ${linkRow(latest.name,latest.date+' · '+latest.duration+' 分钟','record:0')}
      ${linkRow('按今天的状态调整','设置时长、器械和目标','intent')}
    </div>`;
}
function editorialCoaches() {
  return `${top('教练形象','profile')}<section class="content editorial-coaches">
    ${heading('FIND YOUR COACH','找到你的训练搭子。','选一个喜欢的形象，一起开始训练。')}
    <div class="coach-posters">${packs.map(pack => `<button data-pack="${pack.id}" aria-pressed="${pack.id===coach.id}">
      ${photo(pack,'cover')}<span class="pack-status">${pack.id===coach.id?'✓ 使用中':'选择形象'}</span>
      <span class="poster-copy"><small>TRAINMIND COACH</small><b>${pack.name}</b><span>${pack.caption}</span></span>
    </button>`).join('')}</div>
  </section>`;
}
function chips(values,key,multiple=false) {
  return `<div class="chips">${values.map((label,index) => `<button aria-pressed="${multiple ? intentState[key].includes(label) : intentState[key] === label}" data-action="intent:${key}:${index}">${label}</button>`).join('')}</div>`;
}
function intent() {
  const i = durations.indexOf(intentState.minutes);
  return `${top('计划生成')}<section class="content form-page">${heading('训练准备','今天怎么练','一次选好训练条件。')}
    <fieldset><legend>时长</legend><div class="stepper"><button data-action="duration:-1" aria-label="缩短时间" ${i===0?'disabled':''}>−</button><b>${intentState.minutes} 分钟</b><button data-action="duration:1" aria-label="增加时间" ${i===durations.length-1?'disabled':''}>+</button></div></fieldset>
    <fieldset><legend>地点</legend>${chips(places,'place')}</fieldset>
    <fieldset><legend>器械 <small>可多选</small></legend>${chips(equipment,'gear',true)}</fieldset>
    <fieldset><legend>目标</legend>${chips(goals,'goal')}</fieldset>
    <fieldset><legend>身体状态</legend>${chips(readiness,'state')}</fieldset>
  </section>${dock(button('生成训练计划','generate'),button('语音输入','intent-voice','arrow',true))}`;
}
function course() {
  return `${top('计划')}<section class="content">${heading('训练计划','从这一场开始。')}
    <button class="chapter-link" data-action="map"><span class="eyebrow">第 1 章 · 起步</span><b>建立动作模式</b><progress value="1" max="6" aria-label="已完成 1 场，共 6 场"></progress><small>已完成 1 / 6 场 · 查看章节地图 ↗</small></button>
    ${linkRow('今天这一场','第 1 周 · 第 2 场 · 全身力量','plan')}
    ${linkRow('安排单场训练','按今天的时间和状态来','intent')}
  </section>`;
}
function map() {
  const labels = ['已完成','今天这一场','未到'];
  return `${top('课程章节地图','course')}<section class="content">${heading('课程地图','第 1 章 · 起步','这一章要拿下：建立动作模式。')}
    <div class="chapter-map">${[1,2].map(week=>`<div><h3>第 ${week} 周</h3><div class="nodes">${[1,2,3].map(n=>{
      const state = week === 1 ? n - 1 : 2;
      return `<div class="node state-${state}">${state === 1 ? `<button aria-label="打开今天这一场" data-action="plan">${n}</button>` : `<span>${state===0?'✓':n}</span>`}<small>${labels[state]}</small></div>`;
    }).join('')}</div></div>`).join('')}</div>
    <article class="note-card"><p class="eyebrow">章末关卡</p><h3>综合训练</h3><p>本章场次全部完成，且无疼痛中断，即通过关卡。下一章可照常查看。</p></article>
  </section>`;
}
function planPage() {
  const stats = [[plan.minutes+' 分','预计用时'],[exercises.length+' 个','训练动作'],[total()+' 组','总组数'],[plan.intensity,'强度']];
  return `${top('训练计划','course')}<section class="plan-hero">${photo(coach,'portrait')}<div><p class="eyebrow">今日训练</p><h2>${plan.title}</h2><p>${[...new Set(exercises.map(item=>item.equipment))].join(' · ')}</p></div></section>
    <section class="content plan-body"><div class="stats four">${stats.map(([value,label])=>`<div><b>${value}</b><span>${label}</span></div>`).join('')}</div>
    <p class="reason">${plan.reason}</p><h3 class="section-title">动作顺序</h3>
    <ol class="movement-list">${exercises.map((item,i)=>`<li><details><summary><span class="sequence mono">0${i+1}</span><span><b>${item.name}</b><small>${item.equipment} · 休息 ${plan.restSeconds} 秒</small></span><strong>${item.sets} × ${item.reps}</strong></summary><p>${item.cue}</p><div class="edit-actions">${[['上移','up'],['下移','down'],['替换','replace'],['删除','remove']].map(([label,action])=>`<button data-action="edit:${action}:${i}" ${(action==='up'&&i===0)||(action==='down'&&i===exercises.length-1)||(action==='remove'&&exercises.length===1)?'disabled':''}>${label}</button>`).join('')}</div></details></li>`).join('')}</ol>
    <p class="phase-sub">可以说「开始」。</p></section>${dock(button('开始训练','start'))}`;
}
function currentMove() { return exercises[Math.min(moveIndex,exercises.length-1)]; }
const currentReps = () => overrideReps ?? currentMove().reps;
function active() {
  const move=currentMove();
  return `${top('组内训练','paused')}<section class="active-body content">
    <div class="progress-steps" aria-label="已完成 ${completed.length} 组，共 ${total()} 组">${Array.from({length:total()},(_,i)=>`<i class="${i<completed.length?'done':i===completed.length?'current':''}"></i>`).join('')}</div>
    ${heading('动作 '+(moveIndex+1)+' / '+exercises.length,move.name,'第 '+(setIndex+1)+' / '+move.sets+' 组 · '+move.equipment)}
    ${editorialDesign ? `<div class="movement-stage">${photo(coach,'cover')}<div><span class="eyebrow">TRAIN WITH ${coach.name}</span><span>训练画面 · 示意</span></div></div>` : ''}
    <div class="target-display"><span class="mono target-label">本组目标</span><strong>${currentReps()}</strong><span>次</span></div>
    ${adjustment ? `<p class="reason">${adjustment}</p>` : ''}
    ${coachNote(openingCue?'先准备，听到提示再开始。':move.cue)}<p class="voice-hint">${openingCue?'说「开始」或等教练提示。':'说「做完了」·「暂停」·「换个动作」'}</p>
    <details class="more-actions"><summary>训练操作</summary><div class="edit-actions"><button data-action="replace-active">换个动作</button><button data-action="skip">跳过这组</button><button data-action="repeat">再说一遍</button><button data-action="finish-early">结束训练</button></div></details>
  </section>${dock('<button class="primary slide" data-action="complete"><span>滑动完成本组</span><span aria-hidden="true">→</span></button>',button('暂停','pause','pause',true))}`;
}
function clock(label) {
  return `<div class="clock" id="clock"><div><strong id="remaining">--:--</strong><span>${label}</span></div></div>`;
}
function choiceCard() {
  const moveScope = agencyScope === 'move';
  const choices = moveScope ? ['下一个轻一点','按原计划','少练一个'] : ['降一点','就这样','少做一组'];
  return `<aside class="agency-card"><b>${moveScope?'下一个动作怎么走？':'下一组怎么走？'}</b><div class="chips">${choices.map((label,i)=>`<button data-action="agency:${i}">${label}</button>`).join('')}</div><small>默认降一档 · 可以说「听你的」</small></aside>`;
}
function rest() {
  const next=currentMove();
  return `${top('组间休息','paused')}<section class="rest-body content">
    ${heading(completed.length+' / '+total()+' 组已完成','缓口气。')}${agencyPending?choiceCard():''}${clock('剩余休息')}
    <div class="next-up"><small>下一组</small><div><b>${next.name}</b><span>第 ${setIndex+1} 组 · ${currentReps()} 次</span></div></div>
    ${adjustment?`<p class="reason">${adjustment}</p>`:''}
    ${coachNote('放松肩膀，慢慢呼吸。')}<p class="voice-hint">说「下一组」·「多休息 15 秒」·「结束训练」</p>
    <button class="text-button" data-action="finish-early">结束训练</button>
  </section>${dock(button('开始下一组','next'),button('+15 秒','extend','clock',true))}`;
}
function probe() {
  return `${top('组内训练','active')}<section class="content moment">${heading('听到你说撑不住','是累，还是哪儿不对劲？','可以直接说「累」或「疼」。')}${coachNote('先稳住，放慢节奏。')}</section>
    ${dock(button('就是累','fatigue'),button('不对劲','pain','arrow',true))}`;
}
function safety() {
  return `${top('训练已停止','home')}<section class="content moment safety"><div class="finish-mark">${icon('pause')}</div>
    ${heading('安全暂停','先停下来，安全放下负重。','今天可以到此为止。')}<p class="voice-hint">说「结束训练」或「换个动作」。</p>
  </section>${dock(button('结束训练','finish-early'),button('换个不疼的动作','replace-active','arrow',true))}`;
}
function pausedPage() {
  return `${top('训练暂停','home')}<section class="content moment"><div class="finish-mark">${icon('pause')}</div>
    ${heading('进度已保留','准备好再继续。',currentMove().name+' · 已完成 '+completed.length+' 组')}${coachNote('准备好时说「继续」。')}
  </section>${dock(button('继续训练','resume'),button('结束训练','finish-early','arrow',true))}`;
}
function timed() {
  const warm=timedKind==='warm';
  return `${top(warm?'热身':'放松','paused')}<section class="content moment">
    ${heading(warm?'进入训练':'训练收尾',warm?'慢慢活动开。':'把呼吸放慢。')}${clock(warm?'剩余热身':'剩余放松')}
    ${coachNote(warm?'按舒服的幅度活动。':'慢慢呼吸，放松肩背。')}
    <p class="voice-hint">${warm?'说「开始」进入第一组。':'说「结束训练」查看结算。'}</p>
  </section>${dock(button(warm?'开始第一组':'查看结算','timer-next'))}`;
}
function replace() {
  const move=exercises[replaceIndex];
  const allowed=replaceFrom==='plan' ? [...new Set([...intentState.gear, ...exercises.map(item=>item.equipment)])] : [...new Set(exercises.map(item=>item.equipment))];
  const alternatives=catalog.filter(item=>item.name!==move.name && item.category===move.category && allowed.includes(item.equipment));
  return `${top('动作替换',safetyStopped?'safety':replaceFrom)}<section class="content">
    ${heading('调整计划','换个动作',move.name+' · '+move.equipment)}
    ${alternatives.length?alternatives.map(item=>linkRow(item.name,item.equipment+' · 保持同类训练目标','use:'+catalog.indexOf(item))).join(''):'<p class="note-card">当前器械下没有合适的替代动作。</p>'}
    <p class="voice-hint">${safetyStopped?'说「换成」加动作名，或说「结束训练」。':'说「换成」加动作名，或说「跳过这组」。'}</p>
  </section>${dock(safetyStopped?button('结束训练','finish-early'):replaceFrom==='active'?button('跳过这组','skip'):button('返回计划','plan','back'))}`;
}
function summary() {
  const result=sessionResult ?? sampleHistory[0];
  return `${top('训练结算')}<section class="summary-body content"><div class="finish-mark">${icon('check')}</div>
    ${heading(plan.title,result.ended?'今天练到这里。':'今天练完了。')}
    <div class="stats summary-stats"><div><b>${result.duration}</b><span>训练分钟</span></div><div><b>${result.moves ?? 2}</b><span>完成动作</span></div><div><b>${result.sets}</b><span>完成组数</span></div></div>
    <div class="summary-photo">${photo(coach,'portrait')}<p>今天这场，<br>记下来了。</p></div>
    ${sessionResult?.survey ? '' : linkRow('留下训练感受','整场只问一次，可跳过','survey-start')}
  </section>${dock(button('查看记录详情','record:0'),button('回首页','home','back',true))}`;
}
const survey = [
  { question:'今天整体强度如何？', answers:['1','2','3','4','5'], note:'1 很轻松 · 5 很吃力' },
  { question:'目标肌群有感觉吗？', answers:['没感觉','有感觉','感觉很强'] },
  { question:'有没有不适？', answers:['没有','轻微','明显'] }
];
function surveyPage() {
  const step=survey[surveyStep];
  return `${top('训练后反馈','summary')}<section class="content moment">${heading('第 '+(surveyStep+1)+' / 3 步',step.question,step.note)}
    <div class="survey-options">${step.answers.map((value,i)=>`<button data-action="survey:${i}">${value}</button>`).join('')}</div>
    <p class="voice-hint">也可以直接说出你的选择。</p>
  </section>${dock(button('跳过问卷','survey-skip','arrow',true))}`;
}
function records() {
  return `${top('训练记录')}<section class="content records-body">${heading('训练周记','每一场都有数。')}
    ${linkRow('查看规律性','本周与上周的训练对比','progress')}
    <h3 class="section-title">最近训练</h3>
    ${trainingHistory().map((item,i)=>linkRow(item.name,item.date+' · '+item.duration+' 分钟 · '+item.sets+'/'+item.planned+' 组'+(item.ended?' · 提前结束':''),'record:'+i)).join('')}
  </section>`;
}
function detail() {
  const item=trainingHistory()[recordIndex] ?? trainingHistory()[0];
  return `${top('记录详情','records')}<section class="content">${heading(item.date,item.name,item.duration+' 分钟 · '+item.sets+' 组'+(item.ended?' · 提前结束':''))}
    <h3 class="section-title">每组记录</h3>
    ${item.details.length ? item.details.map(set=>`<article class="set-record"><div><b>${set.movement}</b><span>第 ${set.number} 组</span></div><p>${set.reps===null?'次数未确认':set.reps+' 次'} · ${set.weight}</p><small>反馈：${set.feedback}　采纳情况：${set.adopted}</small></article>`).join('') : '<p class="note-card">这场没有可展示的逐组记录。</p>'}
  </section>`;
}
function progress() {
  const sessions=1+(sessionResult?.sets>0?1:0), sets=6+(sessionResult?.sets??0);
  return `${top('训练进步','records')}<section class="content">${heading('训练规律性','每一次都算数。')}
    <section class="chart-card"><p>本周 · 已完成</p><strong>${sessions} 次 / ${sets} 组</strong><p>比上周多 ${sets-4} 组</p></section>
    <div class="comparison"><div><span>本周 · 组数</span><progress max="${sets}" value="${sets}"></progress><b>${sets}</b></div><div><span>上周 · 组数</span><progress max="${sets}" value="4"></progress><b>4</b></div></div>
    ${linkRow('第 1 章 · 起步','当前章节已完成 1 / 6 场','map')}
  </section>`;
}
function profile() {
  return `${top('我的')}<section class="content">${heading('训练档案','你的训练习惯。')}
    <div class="note-card"><p class="eyebrow">训练模型摘要</p><h3>全身力量 · 每周 2 场</h3><p>常用器械：自重、哑铃。训练方式：语音优先。</p></div>
    ${linkRow('教练形象',coach.name+' · 更换资源包','coaches')}
    ${linkRow('教练设置','模型、语音播放与麦克风','settings')}
  </section>`;
}
function settings() {
  return `${top('教练设置','profile')}<section class="content">${heading('训练偏好','教练与语音')}
    <dl class="settings-list"><div><dt>教练模型</dt><dd>TrainMind 默认</dd></div><div><dt>语音播放</dt><dd>示例配置</dd></div><div><dt>麦克风</dt><dd>在评审区模拟语音状态</dd></div></dl>
    ${linkRow('麦克风与错误指引','查看权限、离线和会话过期','errors')}
    ${linkRow('教练形象',coach.name+' · 更换资源包','coaches')}
  </section>`;
}
const errorInfo = {
  mic:['麦克风没开','在浏览器地址栏的网站权限里允许麦克风。也可到系统设置 → 隐私与安全 → 麦克风开启浏览器权限。','继续用按钮','resume-preview'],
  voice:['语音暂不可用','可以继续使用屏幕按钮，动作与进度会保留在训练页。','继续用按钮','resume-preview'],
  offline:['网络暂时断开','先按屏幕上的计划继续。连接恢复后再确认同步状态。','回到训练','resume-preview'],
  expired:['这场训练的会话已过期','回到首页重新打开训练。','回到首页','home']
};
function errors() {
  const [title,copy,label,action]=errorInfo[errorKind];
  return `${top('权限与错误','profile')}<section class="content moment">${heading('训练连接',title,copy)}
    <div class="chips">${Object.entries({mic:'权限被拒',voice:'语音不可用',offline:'离线',expired:'会话过期'}).map(([id,label])=>`<button data-action="error:${id}" aria-pressed="${errorKind===id}">${label}</button>`).join('')}</div>
  </section>${dock(button(label,action))}`;
}
function coaches() {
  if (editorialDesign) return editorialCoaches();
  return `${top('教练形象')}<section class="content coaches-body"><p class="eyebrow phase">教练资源包</p><h2>选你的教练。</h2><p class="phase-sub">形象会用在首页、训练提示和结算。</p>
    <div class="coach-feature">${photo(coach, 'portrait')}<div><p class="eyebrow">当前使用</p><h3>${coach.name}</h3><p>${coach.caption}</p></div></div>
    <div class="pack-grid" aria-label="可选教练资源包">${packs.map(pack => `<button data-pack="${pack.id}" aria-pressed="${pack.id === coach.id}">${avatar(pack)}<b>${pack.name}</b><small>${pack.id === coach.id ? '使用中' : '使用形象'}</small></button>`).join('')}</div>
  </section>`;
}

const renderers = { home, intent, plan:planPage, course, map, active, rest, probe, agency:rest, safety, paused:pausedPage, timed, replace, summary, survey:surveyPage, records, detail, progress, profile, settings, errors, coaches };
const livePages = new Set(['active','rest','probe','agency','safety','paused','timed','replace']);
const emptyCopy = {
  home:['今天还没安排训练。','安排一场','intent'],
  intent:['还没有训练条件。','选择训练条件','normal'],
  plan:['这里还没有训练计划。','安排一场','intent'],
  course:['还没有课程。','先安排一场','intent'],
  map:['还没有可看的课程章节。','回到计划','course'],
  records:['完成第一场后，就能在这里看到记录。','去安排训练','intent'],
  detail:['这场没有可展示的逐组记录。','回到记录','records'],
  progress:['等你有训练记录，我们再一起看进步。','回到记录','records'],
  coaches:['暂时没有可用的教练形象。','回到我的','profile']
};
function alternateView() {
  if (viewState==='loading') {
    return `${top(navItems[page] ?? '计划')}<section class="content skeleton" aria-busy="true" aria-label="正在加载"><i></i><i></i><i></i><i></i></section>`;
  }
  if (viewState==='empty') {
    const [copy,label,action]=emptyCopy[page] ?? (livePages.has(page)
      ? ['当前没有进行中的训练。','回到计划','course']
      : ['这里还没有可展示的内容。','回到首页','home']);
    return `${top(navItems[page] ?? '计划')}<section class="content moment">${heading('暂时没有内容',copy)}</section>${dock(button(label,action))}`;
  }
  if (viewState==='error') {
    return `${top(navItems[page] ?? '计划')}<section class="content moment">${heading('网络暂时断开','连接恢复后可以重试。',livePages.has(page)?'先按原计划继续，稍后确认同步状态。':'这次没有加载成功。')}</section>${dock(button(livePages.has(page)?'继续用屏幕操作':'重试','normal'))}`;
  }
  if (editorialDesign) {
    const view = renderImmersive(page, {
      icon, avatar, voiceLine, clock, button, top, linkRow, choiceCard, trainingHistory,
      coach, move:currentMove(), exercises, plan, completed, setIndex, total, currentReps,
      agencyPending, openingCue, adjustment, timedKind, viewState,
      result:sessionResult ?? sampleHistory[0], surveyStep, surveyQuestion:survey[surveyStep]
    });
    if (view !== null) return view;
  }
  return renderers[page]();
}
function updateHud() {
  const node=screen.querySelector('.hud-time');
  if (!node) return;
  const elapsed=Math.max(0,Math.floor((Date.now()-(startedAt??Date.now()))/1000));
  node.textContent=Math.floor(elapsed/60)+':'+String(elapsed%60).padStart(2,'0');
}
function updateClock() {
  updateHud();
  const seconds=Math.max(0,Math.ceil((deadline-Date.now())/1000));
  screen.querySelector('#remaining').textContent=[Math.floor(seconds/60),seconds%60].map(value=>String(value).padStart(2,'0')).join(':');
  screen.querySelector('#clock').style.setProperty('--sweep',Math.min(360,seconds/clockLength*360)+'deg');
  if (!seconds && page==='timed') handleAction('timer-next');
  else if (!seconds && agencyPending) chooseAgency(0);
}
function go(next, keepState=false) {
  if (!renderers[next]) return;
  if (safetyStopped && ['active','rest','agency','probe','paused','timed'].includes(next)) next='safety';
  if (!keepState) viewState='normal';
  statePicker.value=viewState;
  clearInterval(timer);
  page=next;
  screen.dataset.page=page;
  document.querySelector('#voice-state').value=voiceState;
  screen.innerHTML=alternateView();
  tabBar.hidden=!(page in tabs);
  tabBar.innerHTML=Object.entries(tabs).map(([id,label])=>`<button data-page="${id}" ${page===id?'aria-current="page"':''}>${icon(id==='profile'?'coaches':id==='course'?'plan':id)}${label}</button>`).join('');
  jumpBar.value=page==='course'?'map':page;
  screen.scrollTop=0;
  if (screen.querySelector('#clock')) {
    timer=setInterval(updateClock,250);
    updateClock();
  } else if (screen.querySelector('.hud-time')) {
    updateHud();
    if (page!=='paused') timer=setInterval(updateHud,1000);
  }
}
function resetSession() {
  clearTimeout(openingTimer);
  completed=[]; moveIndex=0; setIndex=0; askedThisSet=false; openingCue=false; agencyPending=false;
  safetyStopped=false; overrideReps=null; adjustment=''; startedAt=Date.now();
  voiceState='listening'; sessionResult=null; pauseFrom='active'; pauseRemaining=0;
}
function setTimer(seconds) {
  clockLength=seconds;
  deadline=Date.now()+seconds*1000;
}
function startTimer(kind) {
  timedKind=kind;
  setTimer(kind==='warm'?45:30);
  go('timed');
}
function beginSet() {
  openingCue=true;
  voiceState='speaking';
  go('active');
  clearTimeout(openingTimer);
  openingTimer=setTimeout(endOpening,1800);
}
let openingTimer;
function endOpening() {
  if(page!=='active'||!openingCue) return;
  openingCue=false;
  voiceState='listening';
  go('active');
}
function finish(ended) {
  sessionResult={
    name:plan.title, date:'本次演示', duration:Math.max(1,Math.round((Date.now()-(startedAt??Date.now()))/60000)),
    sets:completed.length, planned:total(), moves:new Set(completed.map(set=>set.movement)).size, details:[...completed], ended
  };
  safetyStopped=false;
  go('summary');
}
function advance(toRest, fatigue=false) {
  clearTimeout(openingTimer);
  openingCue=false;
  voiceState='listening';
  const former=moveIndex;
  if (++setIndex>=currentMove().sets) { setIndex=0; moveIndex++; }
  askedThisSet=false;
  overrideReps=null;
  adjustment='';
  agencyPending=false;
  if (moveIndex>=exercises.length) {
    startTimer('cool');
    return;
  }
  if (toRest) {
    setTimer(plan.restSeconds);
    agencyScope=moveIndex===former?'set':'move';
    agencyPending=fatigue;
    go(fatigue?'agency':'rest');
  } else go('active');
}
function chooseAgency(index) {
  agencyPending=false;
  if (index===2) {
    if (agencyScope==='move') { setIndex=0; moveIndex++; }
    else if (++setIndex>=currentMove().sets) { setIndex=0; moveIndex++; }
    if (moveIndex>=exercises.length) { startTimer('cool'); return; }
    adjustment='刚才有点吃力，少安排一组。';
  } else if (index===0) {
    overrideReps=Math.max(1,currentMove().reps-2);
    adjustment='刚才有点吃力，下组少做 2 次。';
  } else adjustment='按你的选择，保持原目标。';
  go('rest');
}
function selectScene(next) {
  resetSession();
  surveyStep=0;
  surveyAnswers=[];
  recordIndex=0;
  if (next==='timed') { startTimer('warm'); return; }
  if (next==='rest'||next==='agency') {
    if (currentMove().sets>1) setIndex=1;
    completed=[{movement:currentMove().name,number:1,reps:null,weight:'未记录',feedback:'未补充',adopted:'—'}];
    setTimer(plan.restSeconds);
    agencyPending=next==='agency';
    agencyScope='set';
  }
  if (next==='safety') safetyStopped=true;
  if (next==='probe') askedThisSet=true;
  if (next==='replace') { replaceFrom='active'; replaceIndex=0; }
  go(next);
}
function generatePlan() {
  if (!intentState.gear.length) {
    document.querySelector('.form-page').insertAdjacentHTML('beforeend','<p class="reason" role="status">先选至少一种可用器械。</p>');
    return;
  }
  const matching=catalog.filter(item=>intentState.gear.includes(item.equipment) && (!['上肢','下肢'].includes(intentState.goal)||item.category===intentState.goal));
  exercises=(matching.length?matching:catalog.filter(item=>intentState.gear.includes(item.equipment))).slice(0,3).map(item=>({...item,sets:intentState.state==='状态良好'?3:2}));
  plan.minutes=intentState.minutes;
  plan.title=intentState.goal==='恢复'?'轻度恢复':intentState.goal+'力量';
  plan.intensity=intentState.state==='状态良好'?'中等':'轻量';
  plan.reason=intentState.state==='状态良好'?'按今天可用的器械安排动作。':'今天的状态偏弱，每个动作少 1 组。';
  go('plan');
}
function editPlan(action,index) {
  if (action==='replace') { replaceFrom='plan'; replaceIndex=index; go('replace'); return; }
  if (action==='remove') { if(exercises.length>1) exercises.splice(index,1); }
  else {
    const other=index+(action==='up'?-1:1);
    if (exercises[other]) [exercises[index],exercises[other]]=[exercises[other],exercises[index]];
  }
  go('plan');
}
function applyReplacement(index) {
  const item=catalog[index], previous=exercises[replaceIndex];
  if (!item || item.name===previous.name || item.category!==previous.category) return;
  
  exercises[replaceIndex]={...item,sets:previous.sets};
  adjustment='换成同类动作，按新目标开始。';
  if (replaceFrom==='plan') { plan.reason=adjustment; go('plan'); return; }
  safetyStopped=false;
  askedThisSet=false;
  overrideReps=null;
  go('active');
}
function handleAction(value) {
  const [action,arg,index]=value.split(':');
  if (safetyStopped && ['start','complete','next','skip','pause','resume','fatigue'].includes(action)) return;
  switch(action) {
    case 'normal': go(page); break;
    case 'intent': {
      if (!arg) { go('intent'); break; }
      const options={place:places,gear:equipment,goal:goals,state:readiness};
      const item=options[arg][Number(index)];
      if (arg==='gear') intentState.gear=intentState.gear.includes(item)?intentState.gear.filter(value=>value!==item):[...intentState.gear,item];
      else intentState[arg]=item;
      if (arg==='place') localStorage.setItem('trainmind-night-place',item);
      go('intent'); break;
    }
    case 'duration': {
      const next=durations[durations.indexOf(intentState.minutes)+Number(arg)];
      if (next) intentState.minutes=next;
      go('intent'); break;
    }
    case 'generate': generatePlan(); break;
    case 'intent-voice': document.querySelector('#utterance').focus(); break;
    case 'edit': editPlan(arg,Number(index)); break;
    case 'start': resetSession(); startTimer('warm'); break;
    case 'timer-next': timedKind==='warm'?beginSet():finish(false); break;
    case 'complete':
      completed.push({movement:currentMove().name,number:setIndex+1,reps:null,weight:currentMove().equipment==='自重'?'自重':'重量未记录',feedback:'未补充',adopted:'—'});
      advance(true); break;
    case 'skip': advance(false); break;
    case 'pause':
      clearTimeout(openingTimer);
      openingCue=false;
      voiceState='listening';
      pauseFrom=page;
      pauseRemaining=Math.max(0,Math.ceil((deadline-Date.now())/1000));
      go('paused'); break;
    case 'resume-preview': go(startedAt?'paused':'plan'); break;
    case 'resume':
      if (['rest','agency','timed'].includes(pauseFrom)) setTimer(pauseRemaining);
      go(pauseFrom); break;
    case 'next':
      if (agencyPending) chooseAgency(0);
      if (page!=='timed') beginSet();
      break;
    case 'extend': deadline=Math.max(deadline,Date.now())+15000; updateClock(); break;
    case 'fatigue':
      if (page==='probe') { askedThisSet=true; go('active'); showVoice('speaking','按自己的节奏继续。'); }
      else if (askedThisSet) advance(true,true);
      else { askedThisSet=true; go('probe'); }
      break;
    case 'pain': safetyStopped=true; go('safety'); break;
    case 'agency': chooseAgency(Number(arg)); break;
    case 'agency-scope': agencyScope=arg; go('agency'); break;
    case 'replace-active': replaceFrom='active'; replaceIndex=moveIndex; go('replace'); break;
    case 'use': applyReplacement(Number(arg)); break;
    case 'repeat': showVoice('speaking',currentMove().cue); break;
    case 'finish-early': finish(true); break;
    case 'survey-start': surveyStep=0; surveyAnswers=[]; go('survey'); break;
    case 'survey':
      surveyAnswers.push(survey[surveyStep].answers[Number(arg)]);
      if (surveyStep<2) { surveyStep++; go('survey'); }
      else { if(sessionResult) sessionResult.survey=surveyAnswers; go('summary'); }
      break;
    case 'survey-skip': if(sessionResult) sessionResult.survey='skipped'; go('summary'); break;
    case 'record': recordIndex=Number(arg); go('detail'); break;
    case 'error': errorKind=arg; go('errors'); break;
    default: go(action);
  }
}
function showVoice(state, message=voiceLabels[state]) {
  voiceState=state;
  const status=screen.querySelector('#voice-status');
  document.querySelector('#voice-state').value=state;
  if (status) {
    status.className='voice '+state;
    status.lastChild.textContent=voiceLabels[state];
  }
  document.querySelector('#voice-result').textContent=message;
}
function simulateVoice(raw) {
  const words=raw.replace(/[，。！？\s]/g,'');
  let action;
  if (page==='plan' && /^(开始|开练|开始训练)$/.test(words)) action='start';
  if (page==='timed') {
    if (words==='开始' && timedKind==='warm') action='timer-next';
    if (words==='结束训练') action=timedKind==='cool'?'timer-next':'finish-early';
    if (words==='完成' && timedKind==='cool') action='timer-next';
  }
  if (page==='active') {
    if (words==='开始' && openingCue) { endOpening(); return; }
    if (/做完了|完成本组/.test(words)) action='complete';
    if (/暂停/.test(words)) action='pause';
    if (/跳过这组/.test(words)) action='skip';
    if (/累了|不行了|撑不住/.test(words)) action='fatigue';
    if (/再说一遍/.test(words)) action='repeat';
  }
  if (page==='probe' && /累/.test(words)) action='fatigue';
  if (['rest','agency'].includes(page)) {
    if (/下一组/.test(words)) action='next';
    if (/多休息|延长/.test(words)) action='extend';
    if (/暂停/.test(words)) action='pause';
    if (/太重|吃力/.test(words)) { agencyPending=true; go('agency'); return; }
    if (agencyPending) {
      if (/听你的|降一点/.test(words)) action='agency:0';
      if (/我能行|按原计划|就这样/.test(words)) action='agency:1';
      if (/少做|少练/.test(words)) action='agency:2';
    }
  }
  if (page==='paused' && /继续/.test(words)) action='resume';
  if (['active','probe','rest','agency','safety'].includes(page) && /换个动作|换个不疼/.test(words)) action='replace-active';
  if (page==='replace') {
    const item=catalog.findIndex(move=>words==='换成'+move.name);
    const candidate=item>=0 && screen.querySelector(`[data-action="use:${item}"]`);
    if (candidate) action='use:'+item;
    if (!safetyStopped && /跳过/.test(words)) action='skip';
  }
  if (livePages.has(page) && /结束训练/.test(words) && page!=='timed') action='finish-early';
  if (['active','probe','rest','agency'].includes(page) && /疼|痛|不对劲/.test(words)) action='pain';
  if (page==='survey') {
    const choice=survey[surveyStep].answers.indexOf(words);
    if (choice>=0) action='survey:'+choice;
    if (/跳过/.test(words)) action='survey-skip';
  }
  if (page==='intent') {
    const minutes=Number(words.match(/\d+(?=分钟)/)?.[0]);
    if (durations.includes(minutes)) intentState.minutes=minutes;
    for (const [key,values] of Object.entries({place:places,goal:goals,state:readiness})) {
      const match=values.find(value=>words.includes(value));
      if (match) intentState[key]=match;
    }
    const gear=equipment.filter(item=>words.includes(item));
    if (gear.length) intentState.gear=gear;
    if (words.includes('生成')) action='generate';
    else if(words) action='intent';
  }
  if (!action) { showVoice('unclear'); return; }
  voiceState='listening';
  handleAction(action);
  document.querySelector('#voice-result').textContent='已模拟识别：'+raw;
}

jumpBar.innerHTML=Object.entries(navItems).map(([id,label],index)=>`<option value="${id}">${String(index+1).padStart(2,'0')} · ${label}</option>`).join('');
jumpBar.addEventListener('change',()=>selectScene(jumpBar.value));
statePicker.addEventListener('change',()=>{
  viewState=statePicker.value;
  if (viewState==='resume') {
    resetSession();
    go('home',true);
  } else go(page,true);
});
const lab=document.querySelector('#voice-demo');
lab.insertAdjacentHTML('beforeend',`<label for="voice-state">语音状态</label><select id="voice-state">${Object.entries(voiceLabels).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select><div class="case-tools"><button type="button" data-case="timed">看放松</button><button type="button" data-case="agency">看跨动作退路</button></div>`);
document.querySelector('#voice-state').addEventListener('change',event=>showVoice(event.target.value));
lab.addEventListener('click',event=>{
  const scenario=event.target.closest('[data-case]')?.dataset.case;
  if (scenario==='timed') { resetSession(); startTimer('cool'); }
  if (scenario==='agency') { selectScene('agency'); agencyScope='move'; moveIndex=Math.min(1,exercises.length-1); setIndex=0; go('agency'); }
});
lab.addEventListener('submit',event=>{
  event.preventDefault();
  const input=document.querySelector('#utterance');
  simulateVoice(input.value.trim());
  input.value='';
});

let pointerStart;
screen.addEventListener('pointerdown',event=>{
  const slide=event.target.closest('.slide');
  if (!slide || event.button!==0) return;
  pointerStart=event.clientX;
  slide.setPointerCapture(event.pointerId);
});
screen.addEventListener('pointermove',event=>{
  if (pointerStart===undefined) return;
  event.target.closest('.slide')?.style.setProperty('--drag',Math.max(0,event.clientX-pointerStart)+'px');
});
screen.addEventListener('pointerup',event=>{
  const slide=event.target.closest('.slide');
  if (slide && pointerStart!==undefined && event.clientX-pointerStart>slide.clientWidth*.36) handleAction('complete');
  pointerStart=undefined;
  slide?.style.removeProperty('--drag');
});
screen.addEventListener('pointercancel',event=>{
  pointerStart=undefined;
  event.target.closest('.slide')?.style.removeProperty('--drag');
});

document.querySelector('.device').addEventListener('click',event=>{
  const choice=event.target.closest('[data-pack]');
  const link=event.target.closest('button[data-page]');
  const action=event.target.closest('[data-action]');
  if (choice) {
    coach=packs.find(pack=>pack.id===choice.dataset.pack);
    localStorage.setItem(storageKey,coach.id);
    const scroll=screen.scrollTop;
    go('coaches');
    screen.scrollTop=scroll;
    screen.querySelector(`[data-pack="${coach.id}"]`).focus({preventScroll:true});
  } else if (link) {
    if (link.dataset.page==='paused') handleAction('pause');
    else go(link.dataset.page);
  } else if (action && (!action.classList.contains('slide')||event.detail===0)) {
    const keepPosition=/^(intent:|duration:)/.test(action.dataset.action);
    const scroll=screen.scrollTop;
    handleAction(action.dataset.action);
    if (keepPosition) {
      screen.scrollTop=scroll;
      const control=screen.querySelector(`[data-action="${action.dataset.action}"]`);
      if (!control?.disabled) control?.focus({preventScroll:true});
    }
  }
});

go('home');
