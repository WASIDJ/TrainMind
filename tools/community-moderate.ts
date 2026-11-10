// Local operator tool. Read-only by default; explicit commands hide posts/suspend accounts.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const path = process.env.TRAINMIND_DB ?? fileURLToPath(new URL('../trainmind.db', import.meta.url));
const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
const [command = 'reports', id, reason] = process.argv.slice(2);
try {
  if (command === 'reports') console.log(JSON.stringify(db.prepare("SELECT id,target_type,target_id,reason,status,created_at FROM community_reports WHERE status='open' ORDER BY created_at LIMIT 100").all(), null, 2));
  else if (command === 'hide-post' && /^\d+$/.test(id ?? '') && reason?.trim()) {
    const result = db.prepare("UPDATE community_posts SET status='hidden' WHERE id=? AND status='published'").run(Number(id));
    db.prepare("UPDATE community_reports SET status='handled' WHERE target_type='post' AND target_id=?").run(id);
    db.prepare('INSERT INTO community_moderation_log (action,target_id,reason,created_at) VALUES (?,?,?,?)').run('hide-post', id, reason, new Date().toISOString());
    console.log(JSON.stringify({ hidden: result.changes, reason }));
  } else if (command === 'suspend-account' && /^[a-f0-9-]{36}$/.test(id ?? '') && reason?.trim()) {
    db.exec('BEGIN IMMEDIATE'); try { const result = db.prepare("UPDATE community_accounts SET status='suspended' WHERE id=?").run(id); db.prepare('DELETE FROM community_sessions WHERE account_id=?').run(id); db.prepare("UPDATE community_reports SET status='handled' WHERE target_type='profile' AND target_id=?").run(id); db.prepare('INSERT INTO community_moderation_log (action,target_id,reason,created_at) VALUES (?,?,?,?)').run('suspend-account', id, reason, new Date().toISOString()); db.exec('COMMIT'); console.log(JSON.stringify({ suspended: result.changes, reason })); } catch (e) { db.exec('ROLLBACK'); throw e; }
  } else throw Error('用法: node tools/community-moderate.ts reports | hide-post <id> <原因> | suspend-account <id> <原因>');
} finally { db.close(); }
