// These views use the existing prototype's actions and session data.
const sceneAssets = {
  squat: new URL('./action-squat.jpg', import.meta.url).href,
  hinge: new URL('./action-hinge.jpg', import.meta.url).href,
  pushup: new URL('./action-pushup.jpg', import.meta.url).href
};

function movementImage(move, coach) {
  if (coach.id !== 'lin') return coach.photo;
  if (/硬拉|划船/.test(move.name)) return sceneAssets.hinge;
  if (/俯卧撑/.test(move.name)) return sceneAssets.pushup;
  return sceneAssets.squat;
}

function stage(move, coach, className = '') {
  const image = movementImage(move, coach);
  return `<div class="scene-backdrop" style="background-image:url('${image}')" aria-hidden="true"></div><img class="scene-photo ${className}" src="${image}" alt="">`;
}

function miniAvatar(ui) {
  return `<div class="floating-coach">${ui.avatar()}<span>${ui.voiceLine()}</span></div>`;
}

function progress(ui) {
  const percent = Math.round(ui.completed.length / ui.total() * 100);
  return `<div class="session-progress"><div><b class="hud-time">0:00</b><span> · ${percent}%</span></div><button data-action="pause" aria-label="暂停训练">${ui.icon('pause')}</button></div>
    <div class="hud-steps" aria-label="已完成 ${ui.completed.length} 组，共 ${ui.total()} 组">${Array.from({ length: ui.total() }, (_, i) => `<i class="${i < ui.completed.length ? 'complete' : ''}"></i>`).join('')}</div>`;
}

function sessionSheet(ui, controls, title) {
  return `<footer class="session-sheet"><span class="sheet-handle" aria-hidden="true"></span><div class="sheet-heading"><b>${title}</b><span>第 ${ui.setIndex + 1} / ${ui.move.sets} 组</span></div>${controls}</footer>`;
}

function active(ui) {
  const cue = ui.openingCue ? '准备好，说「开始」。' : ui.move.cue;
  return `<section class="immersive-session active-session">
    ${stage(ui.move, ui.coach)}
    <div class="scene-shade"></div>
    <div class="session-top">${progress(ui)}<div class="move-caption"><p>第 ${ui.setIndex + 1} / ${ui.move.sets} 组</p><h2><em>${ui.currentReps()} 次</em> ${ui.move.name}</h2><small>本组目标 · ${ui.move.equipment}</small></div></div>
    ${ui.adjustment ? `<p class="scene-reason">${ui.adjustment}</p>` : ''}
    <div class="onstage-cue"><p>${cue}</p>${miniAvatar(ui)}</div>
    ${sessionSheet(ui, `<div class="sheet-controls"><button class="primary slide" data-action="complete"><span>滑动完成本组</span><span aria-hidden="true">→</span></button><button class="round-action" data-action="pause" aria-label="暂停训练">${ui.icon('pause')}</button><details class="scene-menu"><summary aria-label="更多训练操作">•••</summary><div><button data-action="replace-active">换个动作</button><button data-action="skip">跳过这组</button><button data-action="repeat">再说一遍</button><button data-action="finish-early">结束训练</button></div></details></div>`, ui.move.name)}
  </section>`;
}

function rest(ui) {
  return `<section class="immersive-session rest-session">
    ${stage(ui.move, ui.coach)}
    <div class="scene-shade"></div>
    <div class="session-top">${progress(ui)}<div class="next-banner"><img src="${movementImage(ui.move,ui.coach)}" alt=""><div><small>下一组 · 第 ${ui.setIndex + 1} 组</small><b>${ui.currentReps()} 次 ${ui.move.name}</b></div></div>${ui.agencyPending ? ui.choiceCard() : ''}</div>
    <div class="rest-focus"><p>REST / 休息</p>${ui.clock('剩余休息')}<button class="prep-time" data-action="extend">＋ 15 秒</button></div>
    <div class="onstage-cue"><p>${ui.adjustment || '放松肩膀，慢慢呼吸。'}</p>${miniAvatar(ui)}</div>
    ${sessionSheet(ui, `<div class="sheet-controls">${ui.button('开始下一组','next')}<button class="round-action" data-action="finish-early" aria-label="结束训练">×</button></div>`, '接下来 · '+ui.move.name)}
  </section>`;
}

function paused(ui) {
  return `<section class="immersive-session pause-session">
    ${stage(ui.move,ui.coach)}
    <div class="scene-shade"></div>
    <div class="session-top">${progress(ui)}<button class="exit-session" data-action="finish-early">结束训练</button></div>
    <div class="pause-focus"><h2>已暂停</h2><button data-action="resume" class="play-button" aria-label="继续训练">▶</button><p>说「继续」，接着练。</p></div>
    ${sessionSheet(ui, '<p class="sheet-note">进度已保留</p>', ui.move.name)}
  </section>`;
}

function timed(ui) {
  const warm = ui.timedKind === 'warm';
  return `<section class="immersive-session timed-session">
    ${stage(ui.move,ui.coach)}
    <div class="scene-shade"></div>
    <div class="session-top">${progress(ui)}<div class="move-caption"><p>${warm?'WARM UP':'COOL DOWN'}</p><h2>${warm?'慢慢活动开':'放松呼吸'}</h2><small>${warm?'按舒服的幅度活动。':'按自己的节奏放松。'}</small></div></div>
    <div class="timed-focus">${ui.clock(warm?'剩余热身':'剩余放松')}</div>
    ${miniAvatar(ui)}
    ${sessionSheet(ui, ui.button(warm?'开始第一组':'完成训练','timer-next'), warm?'热身':'放松')}
  </section>`;
}

function plan(ui) {
  return `${ui.top('今日训练','course')}
    <section class="immersive-plan-cover">${stage(ui.exercises[0],ui.coach)}<div class="scene-shade"></div>
      <div class="plan-cover-text"><p>TRAIN WITH ${ui.coach.name}</p><h2>${ui.plan.title.replace('力量','<br>力量训练')}</h2><span>${[...new Set(ui.exercises.map(move=>move.equipment))].join(' · ')}</span></div>
    </section>
    <section class="content plan-body">
      <div class="plan-metrics"><span><b>${ui.plan.minutes}</b> 分钟<small>预计用时</small></span><span><b>${ui.total()}</b> 组<small>${ui.exercises.length} 个动作 · ${ui.plan.intensity}</small></span></div>
      <p class="plan-reason">${ui.plan.reason}</p>
      <h3 class="list-heading">正式训练 <span>${ui.exercises.length} 个动作</span></h3>
      <ol class="thumbnail-movements">${ui.exercises.map((move,i)=>`<li><details><summary><img src="${movementImage(move,ui.coach)}" alt=""><span><b><em>${move.sets}×</em> ${move.name}</b><small>${move.reps} 次 · 休息 ${ui.plan.restSeconds} 秒</small></span><span class="more-dots">•••</span></summary><p>${move.cue}</p><div class="edit-actions">${[['上移','up'],['下移','down'],['替换','replace'],['删除','remove']].map(([label,action])=>`<button data-action="edit:${action}:${i}" ${(action==='up'&&i===0)||(action==='down'&&i===ui.exercises.length-1)||(action==='remove'&&ui.exercises.length===1)?'disabled':''}>${label}</button>`).join('')}</div></details></li>`).join('')}</ol>
    </section>
    <footer class="dock">${ui.button('开始训练','start')}</footer>`;
}

function home(ui) {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate()-(today.getDay()+6)%7);
  const days = Array.from({length:7},(_,i)=>{
    const date = new Date(monday);
    date.setDate(monday.getDate()+i);
    return `<span ${i===(today.getDay()+6)%7?'aria-current="date"':''}><small>${'一二三四五六日'[i]}</small><b>${date.getDate()}</b></span>`;
  }).join('');
  const latest=ui.trainingHistory()[0];
  return `<header class="compact-home-top"><button class="identity-button" data-page="coaches" aria-label="选择教练形象">${ui.avatar()}</button><div class="slim-week">${days}</div><button class="icon-button" data-page="profile" aria-label="打开我的">${ui.icon('coaches')}</button></header>
    <div class="team-heading"><h2>跟着 ${ui.coach.name} 练</h2><button data-page="coaches">更换形象 ↗</button></div>
    <section class="immersive-workout-card">${stage(ui.exercises[0],ui.coach)}<div class="scene-shade"></div><span class="day-label">今天 · 第 1 周</span><span class="card-corner" aria-hidden="true">↗</span>
      <button class="workout-card-link" data-action="plan" aria-label="打开今日全身力量训练"></button>
      <div class="workout-card-copy"><span class="workout-tag">STRENGTH / 02</span><h2>全身力量<br><span>从这一场开始</span></h2><p>30 分钟 · 哑铃 / 自重</p><div>${ui.avatar()}<span>第 1 章 · 起步</span><button data-action="plan" aria-label="查看训练计划">→</button></div></div>
    </section>
    <div class="home-after-card">${ui.viewState==='resume'?ui.linkRow('继续上次训练','进度已保留','resume-preview'):''}<p class="quiet-relationship">一起练了 ${ui.trainingHistory().length} 次 · 当前在第 1 章</p>
      <div class="section-line"><h3>最近一次</h3><button data-page="records">全部记录 ↗</button></div>${ui.linkRow(latest.name,latest.date+' · '+latest.duration+' 分钟','record:0')}
      ${ui.linkRow('今天换个安排','选择时间、器械和状态','intent')}
    </div>`;
}

function probe(ui) {
  return `<section class="immersive-session probe-session">
    ${stage(ui.move,ui.coach)}<div class="scene-shade"></div>
    <div class="session-top">${progress(ui)}</div>
    <div class="scene-dialog"><p class="workout-tag">听到你说撑不住</p><h2>是累，还是哪儿不对劲？</h2><p>可以直接说「累」或「疼」。</p><div>${ui.button('就是累','fatigue')}${ui.button('不对劲','pain','arrow',true)}</div></div>
  </section>`;
}

function summary(ui) {
  const result=ui.result;
  return `<section class="immersive-session summary-session">
    <img class="scene-photo" src="${ui.coach.photo}" alt=""><div class="scene-shade"></div>
    <button class="scene-back-button" data-page="home" aria-label="返回首页">${ui.icon('back')}</button>
    <div class="summary-overlay"><p class="workout-tag">SESSION COMPLETE</p><h2>${result.ended?'今天练到这里。':'今天，练完了。'}</h2><div class="overlay-metrics"><div><b>${result.duration}</b><span>分钟</span></div><div><b>${result.moves ?? 2}</b><span>完成动作</span></div><div><b>${result.sets}</b><span>完成组数</span></div></div><p>这场训练，已经记下来了。</p></div>
    <footer class="session-sheet"><span class="sheet-handle" aria-hidden="true"></span><div class="summary-actions">${ui.button('查看记录详情','record:0')}${result.survey?'':ui.button('留下训练感受','survey-start','arrow',true)}</div></footer>
  </section>`;
}

function survey(ui) {
  const question=ui.surveyQuestion;
  return `<section class="immersive-session survey-session">
    <img class="scene-photo" src="${ui.coach.photo}" alt=""><div class="scene-shade"></div>
    <div class="survey-overlay"><p class="workout-tag">训练后反馈 · ${ui.surveyStep+1} / 3</p><h2>${question.question}</h2><div class="survey-options">${question.answers.map((label,i)=>`<button data-action="survey:${i}">${label}</button>`).join('')}</div><p>${question.note ?? '也可以直接说出你的选择。'}</p></div>
    <footer class="session-sheet"><span class="sheet-handle" aria-hidden="true"></span>${ui.button('跳过问卷','survey-skip','arrow',true)}</footer>
  </section>`;
}

export function renderImmersive(page, ui) {
  const views = { home, plan, active, rest, agency:rest, paused, timed, probe, summary, survey };
  return views[page] ? views[page](ui) : null;
}
