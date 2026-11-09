const directions = [
  { id: 'a', name: '夜场', description: '深蓝摄影 · 全幅封面', hero: '硬拉训练中的运动员' },
  { id: 'b', name: '晨练', description: '暖白留白 · 训练日程', hero: '在晨光中做弓步的运动员' },
  { id: 'c', name: '动起来', description: '朱红插画 · 运动海报', hero: '做高脚杯深蹲的丝网印刷风运动插画' }
];

const shapes = {
  home: '<path d="m3 10 9-7 9 7v10H3zM9 20v-6h6v6"/>',
  plan: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2m6 2V2M8 10h8m-8 4h5"/>',
  record: '<path d="M4 20h16M7 16v-4m5 4V5m5 11V9"/>',
  coach: '<path d="M20 11a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 14-5Z"/><path d="M9 11h.01m3 0h.01m3 0h.01"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  mark: '<path d="m2 18 6-12 4 8 4-8 6 12"/>'
};

function icon(name) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+shapes[name]+'</svg>';
}

function planButton() {
  return '<button class="start" data-open="plan">查看训练计划'+icon('arrow')+'</button>';
}

function homeContent({id, hero}) {
  const image = '<img class="hero-image" src="hero-'+id+'.jpg" alt="'+hero+'" width="800" height="1000">';
  const meta = '<p class="meta"><span>30 分钟</span><span>哑铃 · 自重</span></p>';
  if (id === 'a') {
    return '<section class="cover">'+image+'<div class="cover-copy"><p class="overline"><i></i> 今日训练</p><h3>全身力量</h3>'+meta+planButton()+'</div></section>';
  }
  if (id === 'b') {
    return '<section class="schedule"><header><p class="overline">11 月 5 日 · 周四</p><h3>今天的训练</h3></header><div class="schedule-main">'+image+'<div class="schedule-copy"><p class="overline">今日安排</p><h4>全身<br>力量</h4>'+meta+'</div></div>'+planButton()+'</section>';
  }
  return '<section class="poster"><div class="poster-heading"><p class="overline">今日训练</p><h3>全身力量</h3></div><div class="poster-art">'+image+'<span aria-hidden="true">30<small>MIN</small></span></div><p class="poster-meta">30 分钟 <span>哑铃 · 自重</span></p>'+planButton()+'</section>';
}

const week = '<section class="week"><div><h3>本周训练</h3><button data-open="record" class="text">看记录 ↗</button></div><div class="week-stats"><span><b>2</b> 场</span><span><b>58</b> 分钟</span></div></section>';
const coach = '<button class="coach" data-open="coach"><span class="coach-icon">'+icon('coach')+'</span><span><b>问问教练</b><small>今天的状态，随时聊</small></span>'+icon('arrow')+'</button>';
const tabs = '<nav class="tabs" aria-label="预览内导航"><button aria-current="page">'+icon('home')+'首页</button><button data-open="plan">'+icon('plan')+'计划</button><button data-open="record">'+icon('record')+'记录</button><button data-open="coach">'+icon('coach')+'教练</button></nav>';

const options = document.querySelector('#options');
options.innerHTML = directions.map(direction => {
  const {id, name, description} = direction;
  return '<article class="option" id="option-'+id+'"><header class="label"><b>'+id.toUpperCase()+'</b><h2>'+name+'</h2><p>'+description+'</p></header><div class="phone theme-'+id+'" data-theme="'+id+'"><header class="bar"><span>'+icon('mark')+'TrainMind</span><button aria-label="打开教练" data-open="coach">'+icon('coach')+'</button></header>'+homeContent(direction)+'<div class="extras">'+week+coach+'</div>'+tabs+'</div></article>';
}).join('');

const pages = {
  plan: {label:'今日训练', title:'全身力量', content:'<p>30 分钟 · 哑铃与自重</p><ol><li><span>哑铃杯式深蹲</span><small>3 组 × 10 次</small></li><li><span>哑铃罗马尼亚硬拉</span><small>3 组 × 10 次</small></li><li><span>俯卧撑</span><small>3 组 × 8 次</small></li></ol>'},
  record: {label:'训练记录', title:'本周训练', content:'<p>完成 2 场，累计 58 分钟。</p><ol><li><span>上肢力量</span><small>30 分钟</small></li><li><span>下肢力量</span><small>28 分钟</small></li></ol>'},
  coach: {label:'TrainMind 教练', title:'今天感觉怎么样？', content:'<p>如果今天时间紧，可以先安排一场短一点的全身训练。</p><p>这是首页方向评审里的教练入口示意。</p>'}
};

const switcher = document.querySelector('.switcher');
switcher.addEventListener('click', event => {
  const selected = event.target.closest('[data-show]');
  if (!selected) return;
  const id = selected.dataset.show;
  switcher.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button === selected)));
  options.classList.toggle('single', id !== 'all');
  options.querySelectorAll('.option').forEach(option => { option.hidden = id !== 'all' && option.id !== 'option-'+id; });
});

const dialog = document.querySelector('dialog');
options.addEventListener('click', event => {
  const button = event.target.closest('[data-open]');
  if (!button) return;
  const page = pages[button.dataset.open];
  dialog.className = 'theme-'+button.closest('[data-theme]').dataset.theme;
  dialog.querySelector('.sheet').innerHTML = '<form method="dialog"><button class="close" aria-label="关闭">×</button></form><p class="overline">'+page.label+'</p><h2 id="sheet-title">'+page.title+'</h2>'+page.content+'<form method="dialog"><button class="start">返回首页预览'+icon('arrow')+'</button></form>';
  dialog.showModal();
});
