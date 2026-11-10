import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { CommunityStore, createCommunityHandler, communityDay, communityLevel } from '../src/community.ts';
const catalog = [{ id: 'squat-a', movementPattern: 'squat' }, { id: 'push-a', movementPattern: 'horizontal_push' }, { id: 'squat-b', movementPattern: 'squat' }, { id: 'push-b', movementPattern: 'horizontal_push' }];
function setup() { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); return { db, store: new CommunityStore(db, catalog) }; }
let sequence = 0;
async function member(store: CommunityStore, nickname = '普通练友') { return store.register({ handle: 'user_' + ++sequence, nickname, password: 'test-password-123', accepted: true }); }
const profileInput = (extra = {}) => ({ nickname: '慢慢来', bio: '享受自己的运动生活', activity: '力量训练', goal: 'general_fitness', environment: 'home', experience: 'beginner', frequency: 3, duration: 30, allowMatching: true, plan: null, ...extra });

test('community: independent password credentials and no public credential/plan leak', async () => {
  const { db, store } = setup(); try {
    const a = await member(store); assert.notEqual(a.password_hash, 'test-password-123'); assert.equal(await store.verify(a, 'wrong'), false); assert.equal(await store.verify(a, 'test-password-123'), true);
    store.updateProfile(a.id, profileInput({ plan: { exerciseIds: ['squat-a', 'push-a'], restrictions: ['private-diagnosis'] } }));
    const publicData = JSON.stringify(store.profile(store.account(a.id))); assert.doesNotMatch(publicData, /password|salt|exerciseIds|private-diagnosis/);
    assert.doesNotMatch(store.account(a.id).plan_json, /restrictions|private-diagnosis/);
    await assert.rejects(() => store.register({ handle: a.handle, nickname: '冒名', password: 'another-password', accepted: true }), /已被使用/);
  } finally { db.close(); }
});
test('community: checkin business date and all level boundaries are explicit', () => {
  assert.equal(communityDay(new Date('2026-11-09T16:01:00Z')), '2026-11-10');
  assert.equal(communityDay(new Date('2026-11-09T15:59:00Z')), '2026-11-09');
  for (const [i, day] of [0, 3, 7, 14, 30, 90, 180, 365].entries()) assert.equal(communityLevel(day).index, i);
  assert.equal(communityLevel(2).index, 0); assert.equal(communityLevel(364).index, 6);
});
test('community: publishing is quota-bound, idempotent, and cannot steal uploaded photos', async () => {
  const { db, store } = setup(); try {
    const a = await member(store), b = await member(store);
    const bytes = await readFile(new URL('../public/coach-media/lin-cover.jpg', import.meta.url));
    const media = store.upload(a, { data: 'data:image/jpeg;base64,' + bytes.toString('base64') });
    assert.throws(() => store.createPost(b, { requestId: 'stolen', text: '盗图', topic: '生活照片', mediaIds: [media] }), /图片不可用/);
    const first = store.createPost(a, { requestId: 'own-photo', text: '<script>untrusted</script>', topic: '生活照片', mediaIds: [media], authorId: b.id });
    const replay = store.createPost(a, { requestId: 'own-photo', text: 'retry', topic: '生活照片', mediaIds: [media] }); assert.equal(first.id, replay.id); assert.equal(first.author.id, a.id);
    assert.throws(() => store.createPost(a, { requestId: 'over-quota', text: '第二条', topic: '生活照片' }), /额度/);
    assert.throws(() => store.upload(a, { data: 'data:image/svg+xml;base64,PHN2Zz4=' }), /JPEG/);
  } finally { db.close(); }
});
test('community: following feed, bidirectional block, and report suppression cannot be bypassed', async () => {
  const { db, store } = setup(); try {
    const a = await member(store), b = await member(store), c = await member(store);
    const p = store.createPost(b, { requestId: 'one', text: '分享经历', topic: '训练经历' }); store.createPost(c, { requestId: 'two', text: '今天散步', topic: '生活照片' });
    db.prepare('INSERT INTO community_follows VALUES (?,?,?)').run(a.id, b.id, new Date().toISOString());
    assert.deepEqual(store.feed(a.id, new URLSearchParams({ tab: 'following' })).posts.map(x => x.id), [p.id]);
    db.prepare('INSERT INTO community_blocks VALUES (?,?)').run(b.id, a.id);
    assert.equal(store.feed(a.id, new URLSearchParams()).posts.length, 1); assert.throws(() => store.post(p.id, a.id), /不可见/);
    db.prepare('DELETE FROM community_blocks').run();
    db.prepare("INSERT INTO community_reports (reporter_id,target_type,target_id,reason,created_at) VALUES (?,'post',?,'不适',?)").run(a.id, String(p.id), new Date().toISOString());
    assert.equal(store.feed(a.id, new URLSearchParams()).posts.length, 1); assert.equal(store.feed(c.id, new URLSearchParams()).posts.length, 2);
  } finally { db.close(); }
});
test('community: plan matching uses normalized patterns and chosen tags, never exposes health claims', async () => {
  const { db, store } = setup(); try {
    const a = await member(store), b = await member(store), unknown = await member(store);
    store.updateProfile(a.id, profileInput({ plan: { exerciseIds: ['squat-a', 'push-a'] } }));
    store.updateProfile(b.id, profileInput({ plan: { exerciseIds: ['squat-b', 'push-b'] } }));
    assert.deepEqual(store.recommend(store.account(unknown.id)), { people: [], basis: 'off' });
    const matches = store.recommend(store.account(a.id)); assert.equal(matches.people.length, 1); assert.equal(matches.people[0].basis, 'shared_plan');
    assert.doesNotMatch(JSON.stringify(matches), /password|salt|exerciseIds|身体相同|疾病|百分比/);
    store.updateProfile(b.id, profileInput({ allowMatching: false })); assert.equal(store.recommend(store.account(a.id)).people.length, 0);
  } finally { db.close(); }
});
test('community: cursors preserve distinct pages and exclude hidden/suspended content', async () => {
  const { db, store } = setup(); try {
    const a = await member(store); for (let i = 0; i < 28; i++) db.prepare("INSERT INTO community_posts (author_id,text,topic,request_id,created_at,day) VALUES (?,?,'训练经历',?,?,?)").run(a.id, String(i), 'cursor-' + i, new Date().toISOString(), '2026-01-01');
    const first = store.feed('', new URLSearchParams()), second = store.feed('', new URLSearchParams({ before: String(first.next) }));
    assert.equal(first.posts.length, 12); assert.equal(second.posts.length, 12); assert.equal(new Set([...first.posts, ...second.posts].map(p => p.id)).size, 24);
    db.prepare("UPDATE community_accounts SET status='suspended' WHERE id=?").run(a.id); assert.equal(store.feed('', new URLSearchParams()).posts.length, 0);
  } finally { db.close(); }
});
test('community HTTP: session auth, CSRF, forged ownership, media, moderation, export and deletion', { timeout: 30000 }, async () => {
  const { db, store } = setup(), handler = createCommunityHandler(store), server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const call = async (path: string, payload?: any, cookie = '', method?: string, custom?: Record<string, string>) => { const r = await fetch(origin + '/api/community' + path, { method: method ?? (payload === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json', 'x-community-client': '1', ...(cookie ? { cookie } : {}), ...custom }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) }); const data: any = r.headers.get('content-type')?.includes('application/json') ? await r.json() : await r.arrayBuffer(); return { status: r.status, data, cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '', headers: r.headers }; };
  try {
    const one = await call('/register', { handle: 'http_one', nickname: '甲', password: 'password-123', accepted: true }); const two = await call('/register', { handle: 'http_two', nickname: '乙', password: 'password-123', accepted: true });
    assert.equal(one.status, 200); assert.match(one.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/); const a = one.cookie, b = two.cookie;
    assert.equal((await call('/me', undefined, a)).data.account.id, one.data.account.id);
    assert.equal((await call('/posts', { text: 'unowned' })).status, 401);
    assert.equal((await call('/checkin', { kind: 'recovery' }, a, undefined, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await call('/checkin', { kind: 'recovery' }, a, undefined, { 'x-community-client': '' })).status, 403);
    assert.equal((await call('/checkin', { kind: 'training', userId: two.data.account.id }, a)).status, 400);
    await call('/checkin', { kind: 'recovery', day: '2000-01-01' }, a); await call('/checkin', { kind: 'recovery' }, a);
    assert.equal((await call('/me', undefined, a)).data.account.level.days, 1);
    const jpeg = await readFile(new URL('../public/coach-media/lin-cover.jpg', import.meta.url)); const media = await call('/media', { data: 'data:image/jpeg;base64,' + jpeg.toString('base64') }, a);
    assert.equal(media.status, 201); assert.equal((await call('/media/' + media.data.id)).status, 404);
    assert.equal((await call('/posts', { requestId: 'steal', text: '偷照片', topic: '生活照片', mediaIds: [media.data.id] }, b)).status, 400);
    const published = await call('/posts', { requestId: 'post-a', text: '我的生活照片', topic: '生活照片', mediaIds: [media.data.id], authorId: two.data.account.id }, a);
    assert.equal(published.status, 201); assert.equal(published.data.post.author.id, one.data.account.id); const id = published.data.post.id;
    assert.equal((await call('/media/' + media.data.id)).status, 200);
    await call('/profiles/' + one.data.account.id + '/follow', { following: true }, b);
    assert.equal((await call('/feed?tab=following', undefined, b)).data.posts.length, 1);
    await call('/posts/' + id + '/like', { liked: true }, b); await call('/posts/' + id + '/like', { liked: true }, b);
    assert.equal((await call('/feed', undefined, b)).data.posts[0].likes, 1);
    const comment = await call('/posts/' + id + '/comments', { text: '看着就开心', requestId: 'comment-once' }, b); await call('/posts/' + id + '/comments', { text: '看着就开心', requestId: 'comment-once' }, b);
    assert.equal((await call('/posts/' + id + '/comments', undefined, b)).data.comments.length, 1);
    assert.equal((await call('/comments/' + comment.data.comments[0].id, undefined, a, 'DELETE')).status, 404);
    assert.equal((await call('/posts/' + id, undefined, b, 'DELETE')).status, 404);
    await call('/profiles/' + two.data.account.id + '/block', { blocked: true }, a);
    assert.equal((await call('/media/' + media.data.id, undefined, b)).status, 404);
    assert.equal((await call('/feed', undefined, b)).data.posts.length, 0);
    assert.equal((await call('/profiles/' + one.data.account.id + '/follow', { following: true }, b)).status, 404);
    await call('/profiles/' + two.data.account.id + '/block', { blocked: false }, a);
    await call('/reports', { type: 'post', targetId: id, reason: '测试反馈' }, b);
    assert.equal((await call('/feed', undefined, b)).data.posts.length, 0);
    assert.equal((await call('/feed', undefined, a)).data.posts.length, 1);
    const exported = await call('/export', undefined, a); assert.equal(exported.data.posts.length, 1); assert.equal(exported.data.media.length, 1); assert.doesNotMatch(JSON.stringify(exported.data), /password_hash|token_hash|"salt"/);
    db.prepare("UPDATE community_posts SET status='hidden' WHERE id=?").run(id); assert.equal((await call('/media/' + media.data.id)).status, 404);
    assert.equal((await call('/account', { password: 'wrong-password' }, a, 'DELETE')).status, 401);
    assert.equal((await call('/account', { password: 'password-123' }, a, 'DELETE')).status, 200);
    assert.equal((await call('/me', undefined, a)).data.account, null);
    for (const table of ['community_posts','community_media','community_checkins','community_likes','community_comments']) assert.equal((db.prepare('SELECT COUNT(*) n FROM ' + table).get() as any).n, 0, table);
    assert.equal((await call('/login', { handle: 'http_two', password: 'password-123' })).status, 200);
    await call('/logout', {}, b); assert.equal((await call('/me', undefined, b)).data.account, null);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});

test('community: SQLite state and authenticated session survive store reopening', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'community-persist-')), path = join(dir, 'test.db'); let db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
  try {
    let store = new CommunityStore(db, catalog); const a = await member(store); const cookie = store.session(a.id);
    store.createPost(a, { requestId: 'persist-post', text: '刷新后仍然在', topic: '生活照片' }); db.close();
    db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON'); store = new CommunityStore(db, catalog);
    assert.equal(store.feed(a.id, new URLSearchParams()).posts[0].text, '刷新后仍然在');
    assert.equal(store.viewer({ headers: { cookie: 'tm_community=' + cookie } } as any).id, a.id);
    assert.equal(await store.verify(store.account(a.id), 'test-password-123'), true);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
