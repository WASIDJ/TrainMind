(() => {
  const visualPacks = [
    { id: 'lin', name: '林澄', caption: '冷蓝纪实', cover: '/coach-media/lin-cover.jpg' },
    { id: 'yue', name: '岳川', caption: '深夜馆', cover: '/coach-media/yue-cover.jpg' },
    { id: 'su', name: '苏禾', caption: '自然光', cover: '/coach-media/su-cover.jpg' }
  ];
  const shell = document.querySelector('.shell');
  const visualKey = () => 'trainmind-coach-pack:' + userId;
  const currentPack = () => visualPacks.find(pack => pack.id === localStorage.getItem(visualKey())) ?? visualPacks[0];

  function visualImage(exercise, pack = currentPack()) {
    if (pack.id !== 'lin') return pack.cover;
    const name = exercise?.name ?? '';
    if (/硬拉/.test(name)) return '/coach-media/lin-hinge.jpg';
    if (/俯卧撑/.test(name)) return '/coach-media/lin-pushup.jpg';
    if (/深蹲/.test(name)) return '/coach-media/lin-squat.jpg';
    return pack.cover;
  }

  function backdrop(root, image, portrait = false) {
    if (root.querySelector(':scope > .visual-scene')) return;
    const background = document.createElement('div');
    background.className = 'visual-scene-backdrop';
    background.style.backgroundImage = `url("${image}")`;
    background.setAttribute('aria-hidden', 'true');
    const photo = document.createElement('img');
    photo.className = 'visual-scene';
    photo.src = image;
    photo.alt = '';
    const shade = document.createElement('div');
    shade.className = 'visual-shade';
    root.prepend(background, photo, shade);
    root.classList.toggle('visual-portrait', portrait);
  }

  function sessionProgress(root) {
    if (root.querySelector('.visual-session-progress')) return;
    const prescribed = workout.exercises.reduce((sum, item) => sum + item.sets, 0);
    const finished = workout.exercises.reduce((sum, item) => sum + item.completedSets, 0);
    const progress = document.createElement('div');
    progress.className = 'visual-session-progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', String(prescribed));
    progress.setAttribute('aria-valuenow', String(finished));
    progress.setAttribute('aria-label', '整场已完成组数');
    const caption = document.createElement('span');
    caption.textContent = '已完成 ' + finished + ' / ' + prescribed + ' 组';
    const track = document.createElement('i');
    track.style.setProperty('--finished', Math.min(100, finished / Math.max(1, prescribed) * 100) + '%');
    progress.append(caption, track);
    root.prepend(progress);
  }

  function updateCoachImages(root) {
    const pack = currentPack();
    root.querySelectorAll('.tm-coach > img, .coach-card > img').forEach(photo => {
      photo.src = pack.cover;
      photo.alt = pack.name + '教练形象';
      photo.classList.add('visual-coach-avatar');
    });
    root.querySelectorAll('.tm-coach-copy > small, .coach-label').forEach(label => {
      label.textContent = pack.name + ' · TrainMind 教练';
    });
  }

  function coachPacksPage() {
    leaveTrainingView();
    setNav('profile');
    shell.dataset.screen = 'coach-packs';
    app.innerHTML = '<section class="tm-screen visual-packs"><button class="back-link secondary" id="pack-back">← 返回我的</button><p class="eyebrow">教练形象</p><h1>选你的训练搭子。</h1><p>选择喜欢的形象，陪你继续训练。</p><div class="visual-pack-list"></div></section>';
    document.querySelector('#pack-back').onclick = profilePage;
    const list = document.querySelector('.visual-pack-list');
    visualPacks.forEach(pack => {
      const button = document.createElement('button');
      button.className = 'visual-pack-card';
      button.setAttribute('aria-pressed', String(pack.id === currentPack().id));
      const photo = document.createElement('img');
      photo.src = pack.cover;
      photo.alt = '';
      const copy = document.createElement('span');
      copy.className = 'visual-pack-copy';
      const name = document.createElement('strong');
      name.textContent = pack.name;
      const caption = document.createElement('small');
      caption.textContent = pack.caption;
      copy.append(name, caption);
      const status = document.createElement('span');
      status.className = 'visual-pack-status';
      status.textContent = pack.id === currentPack().id ? '✓ 使用中' : '选择形象';
      button.append(photo, copy, status);
      button.onclick = () => {
        localStorage.setItem(visualKey(), pack.id);
        list.querySelectorAll('button').forEach((item, index) => {
          const active = visualPacks[index].id === pack.id;
          item.setAttribute('aria-pressed', String(active));
          item.querySelector('.visual-pack-status').textContent = active ? '✓ 使用中' : '选择形象';
        });
        applyVisualDesign();
      };
      list.append(button);
    });
  }

  function decorateHome(root) {
    const hero = root.querySelector('.session-hero');
    if (hero && !hero.querySelector('.visual-scene')) {
      backdrop(hero, visualImage({ name: '深蹲' }));
      const title = hero.querySelector('h2');
      title.replaceChildren(document.createTextNode('今天，'), document.createElement('br'), document.createTextNode('练起来。'));
      const note = hero.querySelector('.session-kicker');
      note.textContent = currentPack().name + ' · 今日训练';
      const select = document.createElement('button');
      select.className = 'visual-change-coach';
      select.textContent = '更换形象 ↗';
      select.onclick = coachPacksPage;
      hero.append(select);
      const week = document.createElement('div');
      week.className = 'visual-week';
      week.setAttribute('aria-label', '本周日历');
      const now = new Date();
      const monday = new Date(now);
      monday.setDate(now.getDate() - (now.getDay() + 6) % 7);
      for (let i = 0; i < 7; i++) {
        const day = new Date(monday);
        day.setDate(monday.getDate() + i);
        const item = document.createElement('span');
        const label = document.createElement('small');
        label.textContent = '一二三四五六日'[i];
        const number = document.createElement('b');
        number.textContent = String(day.getDate());
        if (i === (now.getDay() + 6) % 7) item.setAttribute('aria-current', 'date');
        item.append(label, number);
        week.append(item);
      }
      hero.before(week);
    }
  }

  function decoratePlan(root) {
    if (!root.querySelector('.visual-plan-cover')) {
      const cover = document.createElement('div');
      cover.className = 'visual-plan-cover';
      const image = document.createElement('img');
      image.src = visualImage(workout.exercises[0]);
      image.alt = '';
      cover.append(image);
      const header = root.querySelector('.tm-header');
      cover.append(header);
      root.querySelector('.back-link').after(cover);
      const overview = root.querySelector('.plan-overview');
      const groups = document.createElement('div');
      groups.className = 'tm-metric';
      const value = document.createElement('strong');
      value.textContent = workout.exercises.reduce((sum, item) => sum + item.sets, 0) + ' 组';
      const label = document.createElement('small');
      label.textContent = '计划总组数';
      groups.append(value, label);
      overview.insertBefore(groups, overview.lastElementChild);
    }
    root.querySelectorAll('.plan-row').forEach((row, index) => {
      const thumb = row.querySelector('.plan-thumb');
      if (!thumb || thumb.querySelector('.visual-plan-thumb')) return;
      const image = document.createElement('img');
      image.className = 'visual-plan-thumb';
      image.src = visualImage(workout.exercises[index]);
      image.alt = '';
      thumb.replaceChildren(image);
    });
  }

  function decorateSession(root) {
    const exercise = workout.exercises[workout.runtime.currentExerciseIndex];
    const image = visualImage(exercise);
    backdrop(root, image, image.endsWith('-cover.jpg'));
    sessionProgress(root);
    root.classList.add('visual-session');
    shell.classList.add('visual-training');
    const head = root.querySelector('.workout-head');
    if (root.matches('.workout-screen') && head && !head.querySelector('.tm-ring')) {
      const target = root.querySelector('.workout-console .tm-ring');
      if (target) head.append(target);
    }
    if (root.matches('.resting-screen')) {
      const next = root.querySelector('.rest-card');
      if (next && !next.querySelector('img')) {
        const photo = document.createElement('img');
        photo.src = image;
        photo.alt = '';
        next.prepend(photo);
      }
    }
  }

  function decoratePhase() {
    let root = app.querySelector('.visual-timed-screen');
    if (!root) {
      root = document.createElement('section');
      root.className = 'visual-timed-screen';
      root.append(...app.children);
      app.append(root);
    }
    decorateSession(root);
  }

  function applyVisualDesign() {
    observer.disconnect();
    try {
      shell.classList.remove('visual-training');
      const root = app.firstElementChild;
      if (!root) return;
      const pack = currentPack();
      shell.dataset.coachPack = pack.id;
      shell.dataset.voiceState = voiceState;
      shell.style.setProperty('--coach-cover', `url("${pack.cover}")`);
      updateCoachImages(app);
      if (root.matches('.home-screen')) decorateHome(root);
      if (root.matches('.plan-screen') && workout) decoratePlan(root);
      if (root.matches('.workout-screen, .resting-screen, .paused-screen') && workout) decorateSession(root);
      if (app.querySelector('#phase-next') && workout) decoratePhase();
      if (root.matches('.feedback-screen') && workout?.status === 'completed') {
        root.classList.add('visual-summary');
        backdrop(root, pack.cover, true);
      }
      const profile = app.querySelector('.profile-screen .tm-stack');
      if (profile && !profile.querySelector('.visual-packs-link')) {
        const button = document.createElement('button');
        button.className = 'tm-row visual-packs-link';
        button.textContent = '教练形象 · ' + pack.name + '　↗';
        button.onclick = coachPacksPage;
        profile.prepend(button);
      }
    } finally {
      observer.observe(app, { childList: true, subtree: true });
    }
  }

  const observer = new MutationObserver(records => {
    const needsLayout = records.some(record => record.target === app ||
      record.target.matches?.('.profile-screen, .records-screen') ||
      record.target.id === 'voice-status');
    if (needsLayout) applyVisualDesign();
  });
  applyVisualDesign();
})();
