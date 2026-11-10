#!/usr/bin/env node
// 社区演示内容（2026-11-09）：给投资人看"这里有人"，但不是刷屏水军。
//
// 为什么需要它：社区页现在是空的。空列表讲不出"社区"这件事，也没法演示
// "不同处境的人都在用同一个教练"。但灌数据有一条底线 —— 语气必须和产品一致：
// 不吹效果、不制造焦虑、不承诺天数，否则前面所有克制的设计自己打自己脸。
//
// 6 个账号 + 6 条纯文字帖 + 互相关注 + 若干点赞与 2 条回复。
// 纯文字不配图：community_media 只收 base64 JPEG，往库里塞图会让仓库和备份都变重。
//
// 账号是"演示身份"：密码为 32 字节随机数，任何人都登不进去（不是藏密码，是没有密码）。
// 账号 id 与 handle 固定，重跑覆盖同一批，不会越跑越多。
//
// 用法（建议先停服务）：
//   node tools/demo-community-seed.ts               # dry-run，只报告
//   TRAINMIND_APPLY=1 node tools/demo-community-seed.ts   # 写入（先 VACUUM INTO 备份，再单一事务）
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const dbPath = process.env.TRAINMIND_DB ?? fileURLToPath(new URL("../trainmind.db", import.meta.url));
const apply = process.env.TRAINMIND_APPLY === "1";
const DAY = 86_400_000;
const dayOf = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const today = Date.now();

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");

// 话题只能取自 src/community.ts 的 topics，写别的会被 createPost 拒绝。
const TOPIC_TRAINING = "训练经历";
const TOPIC_PEER = "找同路人";

type Account = {
  id: string; handle: string; nickname: string; bio: string;
  activity: string; goal: string; environment: string; experience: string;
  frequency: number; duration: number; checkins: number;
};

// checkins 决定社区等级（0/3/7/14/30/90/180/365 天），给不同"资历"让主页看起来有分层。
const ACCOUNTS: Account[] = [
  { id: "d0c0a000-0000-4000-8000-000000000001", handle: "demo_amu", nickname: "阿木", bio: "练了三个月，还在学怎么记次数", activity: "力量训练", goal: "general_fitness", environment: "home", experience: "intermediate", frequency: 2, duration: 30, checkins: 45 },
  { id: "d0c0a000-0000-4000-8000-000000000002", handle: "demo_laozhou", nickname: "老周", bio: "卡过平台期，现在信换动作多于加重量", activity: "力量训练", goal: "lower_body", environment: "gym", experience: "advanced", frequency: 3, duration: 50, checkins: 120 },
  { id: "d0c0a000-0000-4000-8000-000000000003", handle: "demo_xiaoman", nickname: "小满", bio: "容易练过头，在学怎么收手", activity: "力量训练", goal: "upper_body", environment: "gym", experience: "intermediate", frequency: 3, duration: 40, checkins: 20 },
  { id: "d0c0a000-0000-4000-8000-000000000004", handle: "demo_anmom", nickname: "安安妈妈", bio: "两个孩子，只能捡碎片时间练", activity: "运动生活", goal: "general_fitness", environment: "home", experience: "beginner", frequency: 3, duration: 15, checkins: 60 },
  { id: "d0c0a000-0000-4000-8000-000000000005", handle: "demo_first", nickname: "第一次来", bio: "刚起步，先做到不放弃", activity: "力量训练", goal: "general_fitness", environment: "home", experience: "beginner", frequency: 2, duration: 20, checkins: 5 },
  { id: "d0c0a000-0000-4000-8000-000000000006", handle: "demo_knee", nickname: "想继续练", bio: "膝盖有点状况，在找能练下去的方式", activity: "力量训练", goal: "lower_body", environment: "unknown", experience: "intermediate", frequency: 2, duration: 30, checkins: 30 },
];

type Post = { account: number; text: string; topic: string; daysAgo: number; requestId: string };

// 时间顺序按 daysAgo 从大到小插入，feed 用 id DESC 排序 —— 所以最后插入的那条在最上面。
// 置顶选"练了三个月"，因为它最能说明这个产品到底在夸什么：不是体重，是次数。
const POSTS: Post[] = [
  { account: 5, daysAgo: 5, topic: TOPIC_PEER, requestId: "demo-post-knee",
    text: "膝盖有点不舒服，就是下楼梯时那种钝钝的、说不上疼但不舒服。\n\n应该停几天，还是换个动作继续练？不想一停就断掉。" },
  { account: 4, daysAgo: 4, topic: TOPIC_TRAINING, requestId: "demo-post-first",
    text: "第一次用，本来最担心的就是自己选动作这件事 —— 我根本不知道该练几组。\n\n结果它直接告诉我练什么、几组、大概多少分钟，我照着做就行。今天完成了，虽然只有 18 分钟。" },
  { account: 3, daysAgo: 3, topic: TOPIC_PEER, requestId: "demo-post-mom",
    text: "孩子午睡那 15 分钟，我练了一组深蹲加一组俯卧撑，中间还被打断一次。\n\n以前我觉得这么短不算训练，练了也白练。现在觉得算了 —— 15 分钟也是 15 分钟。" },
  { account: 2, daysAgo: 2, topic: TOPIC_TRAINING, requestId: "demo-post-extra",
    text: "今天计划的练完了，手痒又加了 20 分钟。\n\n系统把它单独记成「加练」，没算进课程进度。我一开始以为它会拦我，结果没有，但它也没让我的课程显示「提前完成」——这个区分我觉得挺对的，不用为了凑进度硬练。" },
  { account: 1, daysAgo: 1, topic: TOPIC_TRAINING, requestId: "demo-post-plateau",
    text: "同一个重量卡了快一个月，每次都想往上加，加不动就很挫败。\n\n后来被建议先别加量，换个动作角度试试。第二周就有变化了 —— 原来不是我练得不够多，是刺激一直打在同一个点上。" },
  { account: 0, daysAgo: 0, topic: TOPIC_TRAINING, requestId: "demo-post-progress",
    text: "练了三个月，今天深蹲第一次做到 12 次。\n\n不是某天突然变强的，是每周多一两个。自己练的时候感觉不到，翻记录才看得出来 —— 那条线比我自己的感觉可信。" },
];

// 回复只给"膝盖提问"那条：社区能真的接住一个人，比十条点赞更有说服力。
const COMMENTS: Array<{ post: string; account: number; text: string; requestId: string }> = [
  { post: "demo-post-knee", account: 1, requestId: "demo-comment-knee-1", text: "我上次也这样，先别硬练下蹲那类。把腿的动作换掉，两周缓过来了。但如果是真疼、或者有肿，还是去看医生，别自己扛。" },
  { post: "demo-post-knee", account: 0, requestId: "demo-comment-knee-2", text: "同意上面。停几天不是退步，是让下一次能练。" },
];

// ── 1. 报告 ──
console.log(`数据库: ${dbPath}`);
console.log(`演示账号: ${ACCOUNTS.length} 个`);
for (const a of ACCOUNTS) console.log(`  ${a.handle.padEnd(14)} ${a.nickname.padEnd(6)} 关注等级按 ${a.checkins} 天恢复记录`);
console.log(`帖子: ${POSTS.length} 条（全部纯文字，公开可见）`);
for (const p of POSTS) console.log(`  ${dayOf(new Date(today - p.daysAgo * DAY))}  ${ACCOUNTS[p.account]!.nickname.padEnd(6)} ${p.text.split("\n")[0]!.slice(0, 28)}…`);
console.log(`互相关注: ${ACCOUNTS.length * (ACCOUNTS.length - 1)} 条`);
console.log(`回复: ${COMMENTS.length} 条（只挂在膝盖提问下）`);

const existing = Number((db.prepare(`SELECT COUNT(*) n FROM community_accounts WHERE id IN (${ACCOUNTS.map(() => "?").join(",")})`).get(...ACCOUNTS.map(a => a.id)) as any).n);
console.log(`\n库中现有本批账号: ${existing} / ${ACCOUNTS.length}`);

if (!apply) {
  console.log("\ndry-run,未写入（加 TRAINMIND_APPLY=1 生效）。");
  db.close();
  process.exit(0);
}

// ── 2. 备份 ──
const backup = `${dbPath}.bak-community-${Date.now()}`;
db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
if (check?.quick_check !== "ok") { console.error(`备份自检未通过(${check?.quick_check}),已中止。`); db.close(); process.exit(1); }
console.log(`备份(一致性快照): ${backup}`);

// ── 3. 清旧 + 写入（单一事务） ──
// 显式删子表而不是靠 ON DELETE CASCADE：PRAGMA foreign_keys 未开时级联不会发生，
// 那会留下一批悬空的帖子，feed 里"作者不存在"直接 500。
try {
  db.exec("BEGIN IMMEDIATE");
  const ids = ACCOUNTS.map(a => a.id);
  const holes = ids.map(() => "?").join(",");
  const myPosts = `SELECT id FROM community_posts WHERE author_id IN (${holes})`;
  db.prepare(`DELETE FROM community_likes WHERE post_id IN (${myPosts})`).run(...ids);
  db.prepare(`DELETE FROM community_comments WHERE post_id IN (${myPosts})`).run(...ids);
  db.prepare(`DELETE FROM community_media WHERE owner_id IN (${holes})`).run(...ids);
  db.prepare(`DELETE FROM community_posts WHERE author_id IN (${holes})`).run(...ids);
  db.prepare(`DELETE FROM community_follows WHERE follower_id IN (${holes}) OR followed_id IN (${holes})`).run(...ids, ...ids);
  db.prepare(`DELETE FROM community_likes WHERE account_id IN (${holes})`).run(...ids);
  db.prepare(`DELETE FROM community_checkins WHERE account_id IN (${holes})`).run(...ids);
  db.prepare(`DELETE FROM community_accounts WHERE id IN (${holes})`).run(...ids);

  const createdAt = (daysAgo: number) => new Date(today - daysAgo * DAY).toISOString();
  ACCOUNTS.forEach((a, index) => {
    db.prepare(`INSERT INTO community_accounts (id,handle,password_hash,salt,nickname,bio,activity,goal,environment,experience,frequency,duration,allow_matching,plan_json,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'active',?)`).run(
      a.id, a.handle, randomBytes(64).toString("hex"), randomBytes(16).toString("hex"), a.nickname, a.bio,
      a.activity, a.goal, a.environment, a.experience, a.frequency, a.duration, 1,
      // 最早那个账号建得最久，让主页的"加入时间"看着合理。
      createdAt(200 + index * 30),
    );
    for (let i = 0; i < a.checkins; i++) {
      db.prepare("INSERT OR IGNORE INTO community_checkins VALUES (?,?,'recovery',?)").run(a.id, dayOf(new Date(today - i * DAY)), createdAt(i));
    }
  });

  const postIds = new Map<string, number>();
  for (const p of POSTS) {
    const at = createdAt(p.daysAgo);
    const result = db.prepare("INSERT INTO community_posts (author_id,text,topic,status,request_id,created_at,day) VALUES (?,?,?,'published',?,?,?)")
      .run(ACCOUNTS[p.account]!.id, p.text, p.topic, p.requestId, at, dayOf(new Date(today - p.daysAgo * DAY)));
    postIds.set(p.requestId, Number(result.lastInsertRowid));
  }

  for (const c of COMMENTS) {
    db.prepare("INSERT OR IGNORE INTO community_comments (author_id,post_id,text,request_id,created_at) VALUES (?,?,?,?,?)")
      .run(ACCOUNTS[c.account]!.id, postIds.get(c.post)!, c.text, c.requestId, createdAt(4));
  }

  // 互相关注：六个人两两互关，见谁都像"熟人社区"，而不是一片零关注的新号。
  for (const a of ACCOUNTS) for (const b of ACCOUNTS) {
    if (a.id !== b.id) db.prepare("INSERT OR IGNORE INTO community_follows VALUES (?,?,?)").run(a.id, b.id, createdAt(150));
  }

  // 点赞：每条帖由另外几个人顶一下，数字不夸张（2–4 个）。
  POSTS.forEach((p, postIndex) => {
    const likers = ACCOUNTS.filter((_, i) => i !== p.account).slice(0, 2 + (postIndex % 3));
    for (const who of likers) db.prepare("INSERT OR IGNORE INTO community_likes VALUES (?,?)").run(who.id, postIds.get(p.requestId)!);
  });

  db.exec("COMMIT");
} catch (error) {
  try { db.exec("ROLLBACK"); } catch { /* 连接已回滚 */ }
  console.error(`\n失败,已整体回滚: ${error instanceof Error ? error.message : String(error)}`);
  db.close();
  process.exit(1);
}

console.log(`\n已写入。浏览器打开 http://localhost:3000/community 即可看到。`);
console.log(`注意:这些是演示身份,密码为随机数 —— 不要当作可登录账号使用。`);
db.close();
