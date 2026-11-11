(() => {
  const visualPacks = [
    { id: 'lin', name: '林澄', caption: '冷蓝纪实', cover: '/coach-media/lin-cover.jpg' },
    { id: 'yue', name: '岳川', caption: '深夜馆', cover: '/coach-media/yue-cover.jpg' },
    { id: 'su', name: '苏禾', caption: '自然光', cover: '/coach-media/su-cover.jpg' }
  ];
  const shell = document.querySelector('.shell');
  const visualKey = () => 'trainmind-coach-pack:' + userId;
  const currentPack = () => visualPacks.find(pack => pack.id === localStorage.getItem(visualKey())) ?? visualPacks[0];

  // 2026-11-11 审查：此前任何动作都退回教练封面照，于是"鸟狗式"整屏铺着一张
  // 哑铃硬拉的照片——图与动作对不上，越大的图越像演示壳。
  // 现在的口径：**只在与动作真的对得上时出图**，对不上就不放照片（返回 null），
  // 由调用方改用"大字号动作名 + 动作要点"的版式。
  function visualImage(exercise, pack = currentPack()) {
    const id = exercise?.exerciseId ?? exercise?.id;
    // 唯一可靠的"图与动作一致"来源：free-exercise-db 里该动作的真实照片。
    // 没有对应照片就不出图（返回 null），由调用方走"文字优先"版式——
    // 拿教练封面照兜底会得到"做鸟狗式却整屏硬拉"，比留白更像演示壳。
    if (id && typeof freedbFrames === 'function') {
      const frames = freedbFrames(id);
      if (frames) return frames[0];
    }
    return null;
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
      const coverImage = visualImage(workout.exercises[0]);
      if (coverImage) {
        const image = document.createElement('img');
        image.src = coverImage;
        image.alt = '';
        cover.append(image);
      } else {
        // 没有对得上的动作图：改用纯色渐变，别拿无关照片凑
        cover.classList.add('visual-plan-cover-plain');
      }
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
      // RepDB 免费档两帧(起始/顶点)已经画在这个 thumb 里时不要覆盖
      // (2026-11-09:视觉层原来无条件 replaceChildren,会把动作帧冲掉)
      if (!thumb || thumb.querySelector('.visual-plan-thumb') || thumb.querySelector('.tm-anim')) return;
      const src = visualImage(workout.exercises[index]);
      if (!src) return; // 没有对得上的动作图 → 保留矢量图标（比放一张无关照片诚实）
      const image = document.createElement('img');
      image.className = 'visual-plan-thumb';
      image.src = src;
      image.alt = '';
      thumb.replaceChildren(image);
    });
  }

  function decorateSession(root) {
    const exercise = workout.exercises[workout.runtime.currentExerciseIndex];
    const image = visualImage(exercise);
    if (image) {
      // free-exercise-db 的照片是 850×567 的**横图**，铺成全屏背景会被裁切/留黑边。
      // 改成"动作参考卡"：横图缩在卡片里完整显示（起始帧 + 结束帧），文字版式照旧。
      root.classList.add('visual-photo-card');
      mountCues(root, exercise);
      mountPhotoCard(root, exercise, image);
    } else {
      // 没有与动作匹配的图：不铺无关照片，改成"大字号动作名 + 动作要点"的版式。
      // 训练屏上铺一张做别的动作的照片，比留白更容易让人一眼看出是演示壳。
      root.classList.add('visual-text-first');
      mountCues(root, exercise);
    }
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

  // 没有动作图时，屏中间会空出一大片。那里本来该是"看着能照着做的提示"，
  // 而动作要点一直藏在折叠的 <details> 里。这里把要点搬到明面上（复制一份，原折叠保留）。
  function mountCues(root, exercise) {
    if (!exercise || root.querySelector('.visual-cues')) return;
    const lines = (exercise.instructions ?? []).filter(Boolean).slice(0, 3);
    const box = document.createElement('div');
    box.className = 'visual-cues';
    if (lines.length) {
      const title = document.createElement('span');
      title.className = 'visual-cues-title';
      title.textContent = '这一组注意';
      const list = document.createElement('ol');
      for (const line of lines) {
        const li = document.createElement('li');
        li.textContent = line;
        list.append(li);
      }
      box.append(title, list);
    }
    // 剂量依据：把 recommendation 里的机器语言翻成人话（原样贴给用户会看到
    // "experience_default_calibration" 这种内部标识，2026-11-11 审查）
    const basis = doseBasis(exercise);
    if (basis) {
      const note = document.createElement('p');
      note.className = 'visual-cues-basis';
      note.textContent = basis;
      box.append(note);
    }
    if (!box.children.length) return;
    // 放在"预设条"之后、教练卡之前，正好填住照片移走后留下的区域
    const preset = root.querySelector('.set-prescription');
    if (preset) preset.after(box);
    else root.querySelector('.workout-head')?.after(box);
  }

  // 剂量依据 → 一句人话。只翻译"这一组为什么是这个数"，不给新数字。
  const BASIS_TEXT = {
    no_training_history: "第一次练这个动作，先用一组找合适的强度",
    experience_default_calibration: "第一次练这个动作，先用一组找合适的强度",
    familiar_movement_pattern: "同类型动作练过，先保守起步",
    conservative_transfer_only: "同类型动作练过，先保守起步",
    capability_stale_over_90_days: "这个动作很久没练了，先重新确认强度",
    recent_pain_safety_override: "最近这个动作有过疼痛记录，今天避开",
    recent_survey_fatigue: "最近一次训练反馈偏累，今天少做一点",
    reported_fatigue: "今天状态偏累，今天少做一点",
    hard_but_completed: "上次完成但偏吃力，这次先保持",
    repeated_hard_sessions: "连续两次偏吃力，这次减一组",
    recent_failed_reps: "上次没做到目标，这次降一档",
    top_rep_range_reached: "上次做满目标次数，这次略微加重",
    no_load_increment_available: "没有更重的档位，这次多做一组",
    hysteresis_hold: "再稳一次，不急着加量",
    insufficient_evidence_for_progression: "再稳一次，不急着加量"
  };
  function doseBasis(exercise) {
    const codes = exercise?.recommendation?.reasonCodes ?? [];
    for (const code of codes) if (BASIS_TEXT[code]) return BASIS_TEXT[code];
    return null;
  }

  // 动作参考卡：free-exercise-db 每个动作有起始/结束两帧，横图并排比铺满屏幕更清楚。
  function mountPhotoCard(root, exercise, image) {
    if (root.querySelector('.visual-photo-reference')) return;
    const id = exercise?.exerciseId ?? exercise?.id;
    const frames = (typeof freedbFrames === 'function' ? freedbFrames(id) : null) ?? [image];
    const card = document.createElement('figure');
    card.className = 'visual-photo-reference';
    const shots = document.createElement('div');
    shots.className = 'visual-photo-shots';
    frames.slice(0, 2).forEach((src, index) => {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      shots.append(img);
      if (index === 0) { const caption = document.createElement('span'); caption.className = 'visual-photo-caption'; caption.textContent = frames.length > 1 ? '起始 → 结束' : '动作参考'; shots.append(caption); }
    });
    const note = document.createElement('figcaption');
    note.textContent = '照这个样子做，动作稳比次数重要。';
    card.append(shots, note);
    const preset = root.querySelector('.set-prescription');
    if (preset) preset.after(card);
    else root.querySelector('.workout-head')?.after(card);
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
