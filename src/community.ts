// Community v1: independent authenticated identities; legacy training IDs never prove ownership.
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
const scrypt = promisify(scryptCallback);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const topics = ['生活照片', '训练经历', '恢复日记', '找同路人'];
const levels = [0, 3, 7, 14, 30, 90, 180, 365];
const names = ['初来', '起步', '常来', '同行', '稳定', '深耕', '长跑', '同行一年'];
const postLimits = [1, 2, 3, 4, 5, 8, 10, 12];
const now = () => new Date().toISOString();
export const communityDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
class CommunityError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function requireValue(ok: unknown, message: string, status = 400): asserts ok { if (!ok) throw new CommunityError(status, message); }
function string(value: unknown, max: number, label: string, allowEmpty = true) {
  requireValue(typeof value === 'string', label + '格式不正确。');
  const clean = value.trim(); requireValue(clean.length <= max && (allowEmpty || clean.length > 0), label + '长度不合适。');
  return clean;
}
function integer(value: unknown, min: number, max: number) { requireValue(Number.isInteger(value) && Number(value) >= min && Number(value) <= max, '请检查频率和时长。'); return Number(value); }
function choice(value: unknown, options: string[]) { requireValue(typeof value === 'string' && options.includes(value), '请选择有效的选项。'); return value; }
function token(req: IncomingMessage) { return (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('tm_community='))?.slice(13) ?? ''; }
function sessionCookie(req: IncomingMessage, value: string, clear = false) {
  return `tm_community=${value}; Path=/api/community; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 2592000}${(req.socket as any).encrypted ? '; Secure' : ''}`;
}
export function communityLevel(days: number) {
  const index = levels.reduce((result, day, i) => days >= day ? i : result, 0);
  return { index, name: names[index], days, nextAt: levels[index + 1] ?? null, postLimit: postLimits[index], imageLimit: index ? 3 : 1 };
}

export class CommunityStore {
  db: DatabaseSync;
  catalog: Map<string, { id: string; movementPattern: string }>;
  constructor(db: DatabaseSync, catalog: Array<{ id: string; movementPattern: string }> = []) {
    this.db = db; this.catalog = new Map(catalog.map(x => [x.id, x]));
    db.exec(`
      CREATE TABLE IF NOT EXISTS community_accounts (
        id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, salt TEXT NOT NULL,
        nickname TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', activity TEXT NOT NULL DEFAULT '力量训练',
        goal TEXT NOT NULL DEFAULT 'general_fitness', environment TEXT NOT NULL DEFAULT 'unknown',
        experience TEXT NOT NULL DEFAULT 'unknown', frequency INTEGER NOT NULL DEFAULT 0, duration INTEGER NOT NULL DEFAULT 0,
        allow_matching INTEGER NOT NULL DEFAULT 0, plan_json TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS community_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS community_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, text TEXT NOT NULL, topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published', request_id TEXT NOT NULL, created_at TEXT NOT NULL, day TEXT NOT NULL, UNIQUE(author_id, request_id));
      CREATE TABLE IF NOT EXISTS community_media (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, post_id INTEGER REFERENCES community_posts(id) ON DELETE CASCADE, bytes BLOB NOT NULL, mime TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS community_follows (follower_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, followed_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(follower_id, followed_id));
      CREATE TABLE IF NOT EXISTS community_likes (account_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE, PRIMARY KEY(account_id, post_id));
      CREATE TABLE IF NOT EXISTS community_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE, text TEXT NOT NULL, request_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(author_id, request_id));
      CREATE TABLE IF NOT EXISTS community_blocks (blocker_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, blocked_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, PRIMARY KEY(blocker_id, blocked_id));
      CREATE TABLE IF NOT EXISTS community_reports (id INTEGER PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, target_type TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, UNIQUE(reporter_id, target_type, target_id));
      CREATE TABLE IF NOT EXISTS community_checkins (account_id TEXT NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE, day TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind='recovery'), created_at TEXT NOT NULL, PRIMARY KEY(account_id, day));
      CREATE TABLE IF NOT EXISTS community_moderation_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS community_post_feed ON community_posts(status, id DESC);
      CREATE INDEX IF NOT EXISTS community_post_author ON community_posts(author_id, id DESC);
      CREATE INDEX IF NOT EXISTS community_comments_post ON community_comments(post_id, id);
      CREATE INDEX IF NOT EXISTS community_media_post ON community_media(post_id);
    `);
  }
  account(id: string) { return this.db.prepare('SELECT * FROM community_accounts WHERE id=?').get(id) as any; }
  viewer(req: IncomingMessage) {
    const value = token(req); if (!/^[a-f0-9]{64}$/.test(value)) return null;
    return this.db.prepare("SELECT a.* FROM community_sessions s JOIN community_accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>? AND a.status='active'").get(hash(value), now()) as any ?? null;
  }
  session(id: string) {
    this.db.prepare('DELETE FROM community_sessions WHERE expires_at<=?').run(now());
    const value = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO community_sessions VALUES (?,?,?)').run(hash(value), id, new Date(Date.now() + 2592000000).toISOString()); return value;
  }
  async register(input: any) {
    const handle = string(input.handle, 24, '账号', false).toLowerCase();
    requireValue(/^[a-z][a-z0-9_]{2,23}$/.test(handle), '账号需为 3–24 位字母、数字或下划线，以字母开头。');
    const password = string(input.password, 128, '密码', false); requireValue(password.length >= 8, '密码至少 8 位。');
    const nickname = string(input.nickname, 24, '昵称', false); requireValue(input.accepted === true, '请确认公开社区说明。');
    requireValue(!this.db.prepare('SELECT 1 FROM community_accounts WHERE handle=?').get(handle), '账号已被使用。', 409);
    const id = randomUUID(), salt = randomBytes(16).toString('hex'), encoded = (await scrypt(password, salt, 64) as Buffer).toString('hex');
    try { this.db.prepare('INSERT INTO community_accounts (id,handle,password_hash,salt,nickname,created_at) VALUES (?,?,?,?,?,?)').run(id, handle, encoded, salt, nickname, now()); }
    catch (error) { if (this.db.prepare('SELECT 1 FROM community_accounts WHERE handle=?').get(handle)) throw new CommunityError(409, '账号已被使用。'); throw error; }
    return this.account(id);
  }
  async verify(account: any, password: unknown) {
    const value = typeof password === 'string' && password.length <= 128 ? password.trim() : '';
    const encoded = await scrypt(value, account?.salt ?? 'invalid-community-login', 64) as Buffer;
    return !!account && timingSafeEqual(encoded, Buffer.from(account.password_hash, 'hex'));
  }
  blocked(a: string, b: string) { return !!this.db.prepare('SELECT 1 FROM community_blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a, b, b, a); }
  profile(account: any, viewer = '') {
    const days = Number((this.db.prepare('SELECT COUNT(*) n FROM community_checkins WHERE account_id=?').get(account.id) as any).n);
    return { id: account.id, nickname: account.nickname, bio: account.bio, activity: account.activity, level: communityLevel(days), joinedAt: account.created_at,
      matching: !!account.allow_matching, planAvailable: !!account.plan_json,
      following: !!this.db.prepare('SELECT 1 FROM community_follows WHERE follower_id=? AND followed_id=?').get(viewer, account.id),
      followers: Number((this.db.prepare('SELECT COUNT(*) n FROM community_follows WHERE followed_id=?').get(account.id) as any).n),
      followingCount: Number((this.db.prepare('SELECT COUNT(*) n FROM community_follows WHERE follower_id=?').get(account.id) as any).n),
      postCount: Number((this.db.prepare("SELECT COUNT(*) n FROM community_posts WHERE author_id=? AND status='published'").get(account.id) as any).n) };
  }
  me(account: any) {
    const profile = this.profile(account, account.id), today = communityDay();
    const used = Number((this.db.prepare('SELECT COUNT(*) n FROM community_posts WHERE author_id=? AND day=?').get(account.id, today) as any).n);
    return { ...profile, handle: account.handle, goal: account.goal, environment: account.environment, experience: account.experience, frequency: account.frequency, duration: account.duration,
      plan: account.plan_json ? JSON.parse(account.plan_json) : null, checkedIn: !!this.db.prepare('SELECT 1 FROM community_checkins WHERE account_id=? AND day=?').get(account.id, today), remainingPosts: Math.max(0, profile.level.postLimit - used),
      blocks: (this.db.prepare('SELECT a.* FROM community_blocks b JOIN community_accounts a ON a.id=b.blocked_id WHERE b.blocker_id=?').all(account.id) as any[]).map(a => ({ id: a.id, nickname: a.nickname })) };
  }
  updateProfile(id: string, input: any) {
    const nickname = string(input.nickname, 24, '昵称', false), bio = string(input.bio ?? '', 180, '介绍');
    const activity = choice(input.activity, ['力量训练', '跑步', '步行', '灵活性活动', '运动生活']);
    const goal = choice(input.goal, ['general_fitness', 'upper_body', 'lower_body', 'back_strength', 'chest_strength', 'mobility']);
    const environment = choice(input.environment, ['unknown', 'home', 'gym', 'office']);
    const experience = choice(input.experience, ['unknown', 'beginner', 'intermediate', 'advanced']);
    const frequency = integer(input.frequency, 0, 7), duration = integer(input.duration, 0, 180);
    requireValue(typeof input.allowMatching === 'boolean', '请确认同路推荐设置。');
    let plan: string | null = null;
    if (input.plan !== null && input.plan !== undefined) {
      requireValue(Array.isArray(input.plan.exerciseIds) && input.plan.exerciseIds.length >= 1 && input.plan.exerciseIds.length <= 30, '计划摘要格式不正确。');
      const ids = [...new Set(input.plan.exerciseIds)] as string[];
      requireValue(ids.every(x => typeof x === 'string' && this.catalog.has(x)), '计划含暂不支持的动作，请重新选择。');
      plan = JSON.stringify({ exerciseIds: ids, patterns: [...new Set(ids.map(x => this.catalog.get(x)!.movementPattern))], source: 'user_shared', updatedAt: now() });
    }
    this.db.prepare('UPDATE community_accounts SET nickname=?,bio=?,activity=?,goal=?,environment=?,experience=?,frequency=?,duration=?,allow_matching=?,plan_json=? WHERE id=?').run(nickname, bio, activity, goal, environment, experience, frequency, duration, input.allowMatching ? 1 : 0, plan, id);
    return this.me(this.account(id));
  }
  canSee(post: any, viewer = '') {
    return !!post && post.status === 'published' && this.account(post.author_id)?.status === 'active' && !this.blocked(viewer, post.author_id) && !this.db.prepare("SELECT 1 FROM community_reports WHERE reporter_id=? AND ((target_type='post' AND target_id=?) OR (target_type='profile' AND target_id=?))").get(viewer, String(post.id), post.author_id);
  }
  post(id: number, viewer = '') {
    const post = this.db.prepare('SELECT * FROM community_posts WHERE id=?').get(id) as any;
    requireValue(this.canSee(post, viewer), '这条内容暂不可见。', 404); return post;
  }
  serializePost(post: any, viewer = '') {
    return { id: post.id, text: post.text, topic: post.topic, createdAt: post.created_at, author: this.profile(this.account(post.author_id), viewer),
      images: this.db.prepare('SELECT id FROM community_media WHERE post_id=? ORDER BY id').all(post.id).map((x: any) => '/api/community/media/' + x.id),
      liked: !!this.db.prepare('SELECT 1 FROM community_likes WHERE account_id=? AND post_id=?').get(viewer, post.id),
      likes: Number((this.db.prepare('SELECT COUNT(*) n FROM community_likes l WHERE post_id=? AND NOT EXISTS (SELECT 1 FROM community_blocks b WHERE (b.blocker_id=? AND b.blocked_id=l.account_id) OR (b.blocked_id=? AND b.blocker_id=l.account_id))').get(post.id, viewer, viewer) as any).n),
      comments: this.comments(post.id, viewer).length };
  }
  feed(viewer: string, query: URLSearchParams) {
    const tab = query.get('tab') ?? 'discover'; requireValue(['discover', 'following'].includes(tab), '内容分类不正确。');
    const before = query.get('before') ? Number(query.get('before')) : Number.MAX_SAFE_INTEGER;
    requireValue(Number.isSafeInteger(before) && before > 0, '分页参数不正确。');
    const author = query.get('author') ?? '', topic = query.get('topic') ?? '';
    requireValue(!topic || topics.includes(topic), '话题不存在。');
    // Filter in SQL before LIMIT so blocked/hidden content never empties a valid page.
    const rows = this.db.prepare(`SELECT p.* FROM community_posts p JOIN community_accounts a ON a.id=p.author_id WHERE p.status='published' AND a.status='active' AND p.id<? AND (?='' OR p.author_id=?) AND (?='' OR p.topic=?)
      AND (?='discover' OR EXISTS (SELECT 1 FROM community_follows f WHERE f.follower_id=? AND f.followed_id=p.author_id))
      AND NOT EXISTS (SELECT 1 FROM community_blocks b WHERE (b.blocker_id=? AND b.blocked_id=p.author_id) OR (b.blocked_id=? AND b.blocker_id=p.author_id))
      AND NOT EXISTS (SELECT 1 FROM community_reports r WHERE r.reporter_id=? AND ((r.target_type='post' AND r.target_id=CAST(p.id AS TEXT)) OR (r.target_type='profile' AND r.target_id=p.author_id)))
      ORDER BY p.id DESC LIMIT 13`).all(before, author, author, topic, topic, tab, viewer, viewer, viewer, viewer) as any[];
    return { posts: rows.slice(0, 12).map(p => this.serializePost(p, viewer)), next: rows.length > 12 ? rows[11].id : null };
  }
  createPost(account: any, input: any) {
    const requestId = string(input.requestId, 80, '发布标识', false);
    const existing = this.db.prepare('SELECT * FROM community_posts WHERE author_id=? AND request_id=?').get(account.id, requestId) as any;
    if (existing) { requireValue(existing.status === 'published', '这条分享已删除或暂不可见，请勿重复发布。', 409); return this.serializePost(existing, account.id); }
    const text = string(input.text ?? '', 2000, '正文'), topic = choice(input.topic, topics);
    const ids = input.mediaIds ?? [];
    requireValue(Array.isArray(ids) && ids.every(x => typeof x === 'string') && new Set(ids).size === ids.length, '图片列表不正确。');
    const profile = this.me(account);
    requireValue(profile.remainingPosts > 0, '今天的发布额度已用完，明天再分享吧。', 429);
    requireValue(ids.length <= profile.level.imageLimit, '当前等级最多可发布 ' + profile.level.imageLimit + ' 张图片。');
    requireValue(text.length > 0 || ids.length > 0, '写点感受，或选一张喜欢的照片。');
    for (const id of ids) requireValue(this.db.prepare('SELECT 1 FROM community_media WHERE id=? AND owner_id=? AND post_id IS NULL').get(id, account.id), '图片不可用，请重新上传。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT INTO community_posts (author_id,text,topic,request_id,created_at,day) VALUES (?,?,?,?,?,?)').run(account.id, text, topic, requestId, now(), communityDay());
      const id = Number(result.lastInsertRowid);
      for (const media of ids) this.db.prepare('UPDATE community_media SET post_id=? WHERE id=? AND owner_id=? AND post_id IS NULL').run(id, media, account.id);
      this.db.exec('COMMIT'); return this.serializePost(this.post(id, account.id), account.id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  upload(account: any, input: any) {
    requireValue(typeof input.data === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(input.data), '请选择 JPEG 照片。');
    const bytes = Buffer.from(input.data.split(',')[1], 'base64');
    requireValue(bytes.length > 10 && bytes.length <= 600000 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, '照片格式或大小不合适，请重新选择。');
    this.db.prepare("DELETE FROM community_media WHERE post_id IS NULL AND created_at<?").run(new Date(Date.now() - 86400000).toISOString());
    const pending = (this.db.prepare('SELECT COUNT(*) n FROM community_media WHERE owner_id=? AND post_id IS NULL').get(account.id) as any).n;
    requireValue(Number(pending) < 9, '待发布照片较多，请先完成发布或稍后重试。', 429);
    const id = randomUUID(); this.db.prepare("INSERT INTO community_media VALUES (?,?,NULL,?,'image/jpeg',?)").run(id, account.id, bytes, now()); return id;
  }
  comments(postId: number, viewer = '') {
    return (this.db.prepare(`SELECT c.* FROM community_comments c JOIN community_accounts a ON a.id=c.author_id WHERE c.post_id=? AND a.status='active' AND NOT EXISTS (SELECT 1 FROM community_blocks b WHERE (b.blocker_id=? AND b.blocked_id=c.author_id) OR (b.blocked_id=? AND b.blocker_id=c.author_id)) ORDER BY c.id DESC LIMIT 100`).all(postId, viewer, viewer) as any[]).reverse().map(c => ({ id: c.id, text: c.text, createdAt: c.created_at, author: this.profile(this.account(c.author_id), viewer) }));
  }
  recommend(account: any) {
    if (!account.allow_matching) return { people: [], basis: 'off' };
    const candidates = this.db.prepare(`SELECT a.* FROM community_accounts a WHERE a.id<>? AND a.status='active' AND a.allow_matching=1
      AND NOT EXISTS (SELECT 1 FROM community_blocks b WHERE (b.blocker_id=? AND b.blocked_id=a.id) OR (b.blocked_id=? AND b.blocker_id=a.id))
      AND NOT EXISTS (SELECT 1 FROM community_reports r WHERE r.reporter_id=? AND r.target_type='profile' AND r.target_id=a.id) ORDER BY a.created_at DESC LIMIT 500`).all(account.id, account.id, account.id, account.id) as any[];
    const ownPatterns: string[] = account.plan_json ? JSON.parse(account.plan_json).patterns : [];
    const matched = candidates.map(other => {
      const reasons: string[] = []; let score = 0;
      if (account.activity === other.activity) { reasons.push('都喜欢' + account.activity); score += 2; }
      if (account.goal === other.goal) { reasons.push('选择了相同的训练方向'); score += 1; }
      const otherPatterns: string[] = other.plan_json ? JSON.parse(other.plan_json).patterns : [];
      const shared = ownPatterns.filter(p => otherPatterns.includes(p));
      // Normalize set overlap; no public precision percentage or implied health equivalence.
      if (shared.length >= 2) { score += 3 * shared.length / new Set([...ownPatterns, ...otherPatterns]).size; reasons.unshift('主动分享的计划动作结构接近'); }
      if (account.environment !== 'unknown' && account.environment === other.environment) { reasons.push(({ home: '都偏好居家运动', gym: '都偏好在场馆运动', office: '都偏好办公室活动' } as any)[account.environment]); score += 1; }
      if (account.experience !== 'unknown' && account.experience === other.experience) { reasons.push('选择了相同的运动阶段'); score += 1; }
      if (account.frequency > 0 && account.frequency === other.frequency) { reasons.push('每周运动安排接近'); score += 1; }
      if (account.duration > 0 && other.duration > 0 && Math.abs(account.duration - other.duration) <= 10) { reasons.push('每次留给运动的时间接近'); score += .5; }
      return { profile: this.profile(other, account.id), reasons: reasons.slice(0, 3), basis: shared.length >= 2 ? 'shared_plan' : 'chosen_tags', score };
    }).filter(x => x.reasons.length >= 2).sort((a, b) => b.score - a.score).slice(0, 12).map(({ score, ...person }) => person);
    return { people: matched, basis: ownPatterns.length ? 'shared_plan' : 'chosen_tags' };
  }
}

export function createCommunityHandler(store: CommunityStore) {
  const attempts = new Map<string, { count: number; until: number }>();
  function rate(key: string, max: number, ms = 60000) {
    if (attempts.size > 5000) for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k);
    let bucket = attempts.get(key); if (!bucket || bucket.until <= Date.now()) { bucket = { count: 0, until: Date.now() + ms }; attempts.set(key, bucket); }
    requireValue(++bucket.count <= max, '操作有些频繁，请稍后再试。', 429);
  }
  async function read(req: IncomingMessage) {
    requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', '请使用正确的提交格式。', 415);
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; requireValue(size <= 2600000, '内容过大，请减少照片。', 413); chunks.push(chunk); }
    try { const result = JSON.parse(Buffer.concat(chunks).toString() || '{}'); requireValue(result && typeof result === 'object' && !Array.isArray(result), '提交格式不正确。'); return result; }
    catch (error) { if (error instanceof CommunityError) throw error; throw new CommunityError(400, '提交内容不是有效 JSON。'); }
  }
  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost'); if (!url.pathname.startsWith('/api/community/')) return false;
    const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      const method = req.method ?? 'GET', path = url.pathname.slice('/api/community'.length), account = store.viewer(req);
      if (!['GET', 'HEAD'].includes(method)) {
        requireValue(req.headers['x-community-client'] === '1', '请从社区页面提交。', 403);
        if (req.headers.origin) { let origin: URL; try { origin = new URL(req.headers.origin); } catch { throw new CommunityError(403, '请求来源不正确。'); }
          requireValue(origin.host === req.headers.host && ['http:', 'https:'].includes(origin.protocol), '不允许跨站操作。', 403); }
      }
      const needAccount = () => { requireValue(account, '请先登录社区。', 401); return account; };
      const idFrom = (value: string) => { requireValue(/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0, '内容编号不正确。'); return Number(value); };
      if (method === 'GET' && path === '/me') { send(200, { account: account ? store.me(account) : null }); return true; }
      if (method === 'POST' && ['/register', '/login'].includes(path)) {
        rate('auth:' + req.socket.remoteAddress, 12, 900000); const input = await read(req);
        let actor: any;
        if (path === '/register') actor = await store.register(input);
        else { const handle = typeof input.handle === 'string' ? input.handle.trim().toLowerCase() : ''; actor = store.db.prepare('SELECT * FROM community_accounts WHERE handle=?').get(handle) as any;
          requireValue(await store.verify(actor, input.password) && actor?.status === 'active', '账号或密码不正确，或账号暂不可用。', 401); }
        res.setHeader('Set-Cookie', sessionCookie(req, store.session(actor.id))); send(200, { account: store.me(actor) }); return true;
      }
      if (method === 'POST' && path === '/logout') { const value = token(req); if (value) store.db.prepare('DELETE FROM community_sessions WHERE token_hash=?').run(hash(value)); res.setHeader('Set-Cookie', sessionCookie(req, '', true)); send(200, { ok: true }); return true; }
      if (method === 'GET' && path === '/feed') { send(200, store.feed(account?.id ?? '', url.searchParams)); return true; }
      if (method === 'GET' && path.startsWith('/media/')) {
        const media = store.db.prepare('SELECT * FROM community_media WHERE id=?').get(path.slice(7)) as any;
        requireValue(media && (media.post_id ? store.canSee(store.db.prepare('SELECT * FROM community_posts WHERE id=?').get(media.post_id), account?.id) : media.owner_id === account?.id), '图片不可见。', 404);
        res.writeHead(200, { 'content-type': media.mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" }); res.end(Buffer.from(media.bytes)); return true;
      }
      if (method === 'GET' && path === '/people') {
        const people = store.db.prepare("SELECT * FROM community_accounts WHERE status='active' ORDER BY created_at DESC LIMIT 100").all() as any[];
        send(200, { people: people.filter(a => a.id !== account?.id && !store.blocked(a.id, account?.id ?? '') && !store.db.prepare("SELECT 1 FROM community_reports WHERE reporter_id=? AND target_type='profile' AND target_id=?").get(account?.id ?? '', a.id)).slice(0, 20).map(a => store.profile(a, account?.id)) }); return true;
      }
      const profileMatch = path.match(/^\/profiles\/([a-f0-9-]{36})$/);
      if (profileMatch && method === 'GET') { const target = store.account(profileMatch[1]); requireValue(target?.status === 'active' && !store.blocked(account?.id ?? '', target.id), '这个主页暂不可见。', 404); send(200, { profile: store.profile(target, account?.id) }); return true; }
      const commentsMatch = path.match(/^\/posts\/(\d+)\/comments$/);
      if (commentsMatch && method === 'GET') { const post = store.post(idFrom(commentsMatch[1]), account?.id); send(200, { comments: store.comments(post.id, account?.id) }); return true; }
      const actor = needAccount();
      if (method !== 'GET') rate('write:' + actor.id, 50);
      if (method === 'POST' && path === '/profile') { send(200, { account: store.updateProfile(actor.id, await read(req)) }); return true; }
      if (method === 'GET' && path === '/recommendations') { send(200, store.recommend(actor)); return true; }
      if (method === 'POST' && path === '/checkin') { const input = await read(req); requireValue(input.kind === 'recovery', '当前社区支持恢复日记录。'); store.db.prepare("INSERT OR IGNORE INTO community_checkins VALUES (?,?,'recovery',?)").run(actor.id, communityDay(), now()); send(200, { account: store.me(actor) }); return true; }
      if (method === 'POST' && path === '/media') { const id = store.upload(actor, await read(req)); send(201, { id, url: '/api/community/media/' + id }); return true; }
      const mediaDelete = path.match(/^\/media\/([a-f0-9-]{36})$/);
      if (method === 'DELETE' && mediaDelete) { store.db.prepare('DELETE FROM community_media WHERE id=? AND owner_id=? AND post_id IS NULL').run(mediaDelete[1], actor.id); send(200, { ok: true }); return true; }
      if (method === 'POST' && path === '/posts') { send(201, { post: store.createPost(actor, await read(req)), account: store.me(actor) }); return true; }
      if (method === 'POST' && commentsMatch) {
        const post = store.post(idFrom(commentsMatch[1]), actor.id), input = await read(req), text = string(input.text, 1000, '评论', false), requestId = string(input.requestId, 80, '评论标识', false);
        store.db.prepare('INSERT OR IGNORE INTO community_comments (author_id,post_id,text,request_id,created_at) VALUES (?,?,?,?,?)').run(actor.id, post.id, text, requestId, now()); send(201, { comments: store.comments(post.id, actor.id) }); return true;
      }
      const commentDelete = path.match(/^\/comments\/(\d+)$/);
      if (method === 'DELETE' && commentDelete) { const result = store.db.prepare('DELETE FROM community_comments WHERE id=? AND author_id=?').run(idFrom(commentDelete[1]), actor.id); requireValue(result.changes > 0, '无法删除这条评论。', 404); send(200, { ok: true }); return true; }
      const postDelete = path.match(/^\/posts\/(\d+)$/);
      if (method === 'DELETE' && postDelete) { const id = idFrom(postDelete[1]); requireValue(store.db.prepare('SELECT 1 FROM community_posts WHERE id=? AND author_id=?').get(id, actor.id), '无法删除这条内容。', 404); store.db.prepare("UPDATE community_posts SET status='deleted',text='' WHERE id=?").run(id); store.db.prepare('DELETE FROM community_media WHERE post_id=?').run(id); store.db.prepare('DELETE FROM community_comments WHERE post_id=?').run(id); store.db.prepare('DELETE FROM community_likes WHERE post_id=?').run(id); send(200, { ok: true }); return true; }
      const like = path.match(/^\/posts\/(\d+)\/like$/);
      if (method === 'POST' && like) { const post = store.post(idFrom(like[1]), actor.id), input = await read(req); requireValue(typeof input.liked === 'boolean', '点赞操作不正确。'); if (input.liked) store.db.prepare('INSERT OR IGNORE INTO community_likes VALUES (?,?)').run(actor.id, post.id); else store.db.prepare('DELETE FROM community_likes WHERE account_id=? AND post_id=?').run(actor.id, post.id); send(200, { post: store.serializePost(post, actor.id) }); return true; }
      const follow = path.match(/^\/profiles\/([a-f0-9-]{36})\/follow$/);
      if (method === 'POST' && follow) { const target = store.account(follow[1]); requireValue(target && target.status === 'active' && target.id !== actor.id && !store.blocked(actor.id, target.id), '当前无法关注这个人。', 404); const input = await read(req); requireValue(typeof input.following === 'boolean', '关注操作不正确。'); if (input.following) store.db.prepare('INSERT OR IGNORE INTO community_follows VALUES (?,?,?)').run(actor.id, target.id, now()); else store.db.prepare('DELETE FROM community_follows WHERE follower_id=? AND followed_id=?').run(actor.id, target.id); send(200, { profile: store.profile(target, actor.id) }); return true; }
      const block = path.match(/^\/profiles\/([a-f0-9-]{36})\/block$/);
      if (method === 'POST' && block) { const target = store.account(block[1]); requireValue(target && target.id !== actor.id, '用户不存在。', 404); const input = await read(req); requireValue(typeof input.blocked === 'boolean', '屏蔽操作不正确。'); store.db.exec('BEGIN IMMEDIATE'); try { if (input.blocked) { store.db.prepare('INSERT OR IGNORE INTO community_blocks VALUES (?,?)').run(actor.id, target.id); store.db.prepare('DELETE FROM community_follows WHERE (follower_id=? AND followed_id=?) OR (follower_id=? AND followed_id=?)').run(actor.id, target.id, target.id, actor.id); } else store.db.prepare('DELETE FROM community_blocks WHERE blocker_id=? AND blocked_id=?').run(actor.id, target.id); store.db.exec('COMMIT'); } catch (e) { store.db.exec('ROLLBACK'); throw e; } send(200, { account: store.me(actor) }); return true; }
      if (method === 'POST' && path === '/reports') { const input = await read(req), type = choice(input.type, ['post', 'profile']), targetId = string(String(input.targetId ?? ''), 80, '举报对象', false), reason = string(input.reason, 500, '举报说明', false);
        if (type === 'post') store.post(idFrom(targetId), actor.id); else requireValue(store.account(targetId)?.status === 'active', '用户不存在。', 404);
        store.db.prepare('INSERT OR IGNORE INTO community_reports (reporter_id,target_type,target_id,reason,created_at) VALUES (?,?,?,?,?)').run(actor.id, type, targetId, reason, now()); send(201, { ok: true }); return true; }
      if (method === 'GET' && path === '/export') {
        send(200, { exportedAt: now(), account: store.me(actor), posts: store.db.prepare('SELECT id,text,topic,status,created_at FROM community_posts WHERE author_id=?').all(actor.id),
          media: (store.db.prepare('SELECT id,post_id,bytes,mime FROM community_media WHERE owner_id=?').all(actor.id) as any[]).map(m => ({ id: m.id, postId: m.post_id, data: 'data:' + m.mime + ';base64,' + Buffer.from(m.bytes).toString('base64') })),
          comments: store.db.prepare('SELECT id,post_id,text,created_at FROM community_comments WHERE author_id=?').all(actor.id), following: store.db.prepare('SELECT followed_id,created_at FROM community_follows WHERE follower_id=?').all(actor.id),
          likes: store.db.prepare('SELECT post_id FROM community_likes WHERE account_id=?').all(actor.id), checkins: store.db.prepare('SELECT day,kind,created_at FROM community_checkins WHERE account_id=?').all(actor.id),
          reports: store.db.prepare('SELECT target_type,target_id,reason,status,created_at FROM community_reports WHERE reporter_id=?').all(actor.id) }); return true;
      }
      if (method === 'DELETE' && path === '/account') { const input = await read(req); requireValue(await store.verify(actor, input.password), '密码不正确。', 401); store.db.prepare('DELETE FROM community_accounts WHERE id=?').run(actor.id); res.setHeader('Set-Cookie', sessionCookie(req, '', true)); send(200, { ok: true }); return true; }
      send(404, { error: '社区接口不存在。' });
    } catch (error) {
      if (error instanceof CommunityError) send(error.status, { error: error.message });
      else { console.error('community_request_failed', error instanceof Error ? error.message : 'unknown'); send(500, { error: '社区暂时没连上，请稍后重试。' }); }
    }
    return true;
  };
}
