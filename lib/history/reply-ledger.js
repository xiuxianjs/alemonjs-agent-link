import { speechControl } from "../social/message-fragments.js";

// src/history/reply-ledger.ts
/** Delivery accounting is separate from inbox read progress and task execution success. */
var ReplyLedger = class {
	db;
	constructor(db) {
		this.db = db;
		db.exec(`CREATE TABLE IF NOT EXISTS reply_ledger (
      scope TEXT NOT NULL, message_id TEXT NOT NULL, state TEXT NOT NULL,
      received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, busy_at_receive INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(scope,message_id));
      CREATE INDEX IF NOT EXISTS reply_ledger_scope_time ON reply_ledger(scope,received_at);`);
	}
	receive(scope, message) {
		if (message.role !== "user" || this.state(scope, message.id)) return;
		const command = /^(?:@\S+\s*)?\//u.test(message.text.trim());
		const direct = message.context?.mentionedSelf || [
			"private",
			"mention",
			"wake_name",
			"command"
		].includes(message.context?.trigger || "") || /^(?:大肥鱼|肥鱼)[，,\s]/u.test(message.text);
		if (!command && !direct) return;
		if (direct && speechControl(message.text) === "stop") {
			this.db.prepare(`UPDATE reply_ledger SET state='silent',updated_at=? WHERE scope=? AND state NOT IN ('delivered','unclaimed_command')
        AND message_id IN (SELECT message_id FROM messages WHERE scope=? AND role='user' AND speaker_id=?)`).run(Date.now(), scope, scope, message.speakerId);
			this.db.prepare("INSERT OR IGNORE INTO reply_ledger VALUES(?,?,?,?,?,0)").run(scope, message.id, "silent", message.timestamp ?? Date.now(), Date.now());
			return;
		}
		const now = Date.now();
		const busy = this.db.prepare("SELECT 1 FROM reply_ledger WHERE scope=? AND state='processing' AND updated_at>=? LIMIT 1").get(scope, now - 3e5);
		this.db.prepare("INSERT OR IGNORE INTO reply_ledger VALUES(?,?,?,?,?,?)").run(scope, message.id, command ? "unclaimed_command" : "pending", message.timestamp ?? now, now, Number(Boolean(busy)));
	}
	transition(scope, id, state) {
		if (!id) return;
		const source = this.db.prepare("SELECT message_id,timestamp FROM messages WHERE scope=? AND role='user' AND (message_id=? OR reference_id=?) ORDER BY seq DESC LIMIT 1").get(scope, id, id);
		if (!source) return;
		const now = Date.now();
		this.db.prepare("INSERT OR IGNORE INTO reply_ledger VALUES(?,?,?,?,?,0)").run(scope, source.message_id, "pending", source.timestamp, now);
		if (state === "delivered") this.db.prepare("UPDATE reply_ledger SET state='delivered',updated_at=? WHERE scope=? AND message_id=? AND state='partial'").run(now, scope, source.message_id);
		else this.db.prepare("UPDATE reply_ledger SET state=?,updated_at=? WHERE scope=? AND message_id=? AND state NOT IN ('delivered','silent') AND (state<>'partial' OR ? IN ('failed','cancelled','partial'))").run(state, now, scope, source.message_id, state);
	}
	state(scope, id) {
		return this.db.prepare("SELECT state FROM reply_ledger WHERE scope=? AND message_id=?").get(scope, id)?.state;
	}
	pending(scope, now, excludeId = "") {
		return this.db.prepare(`SELECT l.message_id AS messageId,l.state,l.busy_at_receive AS busyAtReceive,l.received_at AS receivedAt,
      m.speaker,m.speaker_id AS speakerId,substr(m.text,1,200) AS text
      FROM reply_ledger l JOIN messages m ON m.scope=l.scope AND m.message_id=l.message_id AND m.role='user'
      WHERE l.scope=? AND l.received_at>=? AND l.received_at<=? AND l.message_id<>? AND l.state NOT IN ('delivered','silent','cancelled')
      ORDER BY l.received_at DESC,m.seq DESC LIMIT 20`).all(scope, now - 72e5, now, excludeId);
	}
	cleanup() {
		this.db.exec("DELETE FROM reply_ledger WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.scope=reply_ledger.scope AND m.message_id=reply_ledger.message_id AND m.role='user')");
	}
	purge(scope) {
		this.db.prepare("DELETE FROM reply_ledger WHERE scope=?").run(scope);
	}
};

export { ReplyLedger };