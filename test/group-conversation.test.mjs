import test from 'node:test';
import assert from 'node:assert/strict';
import { getGroupChatPolicy, decideGroupReply, isQuietHour, groupTopicRelevance } from '../lib/social/group-policy.js';
import { GroupConversationCoordinator, buildGroupBatchPrompt, needsReplySelection } from '../lib/social/group-conversation.js';

const now = Date.parse('2026-10-26T04:00:00Z');
const policy = overrides => getGroupChatPolicy({ interjectChance: 1, quietHours: [0, 0], ...overrides });
const decision = overrides =>
  decideGroupReply({
    policy: policy(),
    direct: false,
    owner: false,
    now,
    recentTimes: [now, now, now],
    replyTimes: [],
    interjectTimes: [],
    engagedUntil: 0,
    relevance: 0.8,
    random: () => 0,
    ...overrides
  });
const message = (id, overrides = {}) => ({
  channelId: 'group',
  id,
  userId: id,
  userKey: id,
  name: id,
  owner: false,
  text: '一起聊游戏',
  direct: true,
  ...overrides
});
const harness = extra => {
  let clock = now;
  let nextTimer = 0;
  const timers = new Map();
  const coordinator = new GroupConversationCoordinator({
    now: () => clock,
    random: () => 0,
    schedule: (run, ms) => {
      const id = ++nextTimer;
      timers.set(id, { run, ms });
      return id;
    },
    unschedule: id => timers.delete(id),
    ...extra
  });
  return {
    coordinator,
    timers,
    advance: ms => {
      clock += ms;
    }
  };
};

test('reply policy covers direct wake, quiet time, relevance, active windows, cooldown, engagement and burst limits', () => {
  assert.equal(decision().mode, 'interject');
  assert.equal(decision({ direct: true, relevance: 0 }).mode, 'direct');
  assert.equal(decision({ now: Date.parse('2026-10-25T18:00:00Z'), policy: policy({ quietHours: [1, 8] }) }).reply, false);
  assert.equal(decision({ policy: policy({ enabled: false }) }).reply, false);
  assert.equal(decision({ relevance: 0.1 }).reply, false);
  assert.equal(decision({ recentTimes: [now] }).reply, false);
  assert.equal(decision({ interjectTimes: [now - 1] }).reply, false);
  assert.equal(decision({ policy: policy({ maxPerHour: 1 }), interjectTimes: [now - 100000] }).reply, false);
  assert.equal(decision({ engagedUntil: now + 1, interjectTimes: [now - 1] }).mode, 'engaged');
  assert.equal(decision({ semantic: true, engagedUntil: now + 1, relevance: 0.8, interjectTimes: [now - 1] }).mode, 'engaged');
  assert.equal(decision({ semantic: true, engagedUntil: now + 1, relevance: 0.1 }).mode, 'interject');
  assert.equal(decision({ policy: policy({ burstMax: 1 }), replyTimes: [now - 1], direct: true }).reply, false);
  assert.equal(decision({ policy: policy({ burstMax: 1 }), replyTimes: [now - 1], direct: true, owner: true }).mode, 'direct');
  assert.equal(isQuietHour(23, [22, 7]), true);
  assert.equal(isQuietHour(6, [22, 7]), true);
  assert.equal(isQuietHour(12, [22, 7]), false);
  assert.equal(groupTopicRelevance(['猫 猫 猫'], ['猫']), 0.3);
  for (const invalid of [
    { interjectChance: NaN },
    { batchWindowMs: 100, maxBatchWaitMs: 99 },
    { quietHours: [0, 24] },
    { timezone: 'invalid' },
    { interests: [''] }
  ]) {
    assert.throws(() => getGroupChatPolicy(invalid));
  }
  assert.equal(getGroupChatPolicy({ overrides: { one: { enabled: false } } }, 'one').enabled, false);
});

test('debounce combines participants and preserves the last actual direct sender as authority', async () => {
  const h = harness();
  const batches = [];
  const respond = async batch => {
    batches.push(batch);
    return { delivered: true };
  };
  try {
    const first = h.coordinator.receive(message('owner', { owner: true }), policy(), respond);
    h.advance(100);
    const second = h.coordinator.receive(message('member', { owner: false }), policy(), respond);
    const third = h.coordinator.receive(message('background', { direct: false, text: '补充一点' }), policy(), respond);
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].ms, 1100);
    await h.coordinator.flush('group');
    await Promise.all([first, second, third]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].anchor.userId, 'member');
    assert.equal(batches[0].anchor.owner, false);
    assert.equal(batches[0].messages.length, 3);
    assert.equal(batches[0].mode, 'direct');
    const prompt = buildGroupBatchPrompt(batches[0]);
    assert.ok(prompt.includes('m3'));
    assert.ok(prompt.includes('background'));
    assert.equal((await h.coordinator.receive(message('member'), policy(), respond)).reason, '重复消息');
  } finally {
    h.coordinator.close();
  }
});

test('continuous input is bounded by the maximum wait and active replies buffer the next segment', async () => {
  const h = harness();
  const batches = [];
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const respond = async batch => {
    batches.push(batch);
    if (batches.length === 1) await gate;
    return { delivered: true };
  };
  try {
    const first = h.coordinator.receive(message('one', { direct: false }), policy({ minRecentMessages: 1 }), respond);
    h.advance(3900);
    const more = h.coordinator.receive(message('two', { direct: false }), policy({ minRecentMessages: 1 }), respond);
    assert.equal([...h.timers.values()][0].ms, 100);
    const flushing = h.coordinator.flush('group');
    const next = h.coordinator.receive(message('three'), policy(), respond);
    assert.equal(h.timers.size, 0);
    await h.coordinator.flush('group');
    assert.equal(batches.length, 1);
    release();
    await flushing;
    await Promise.all([first, more]);
    assert.equal(h.timers.size, 1);
    await h.coordinator.flush('group');
    await next;
    assert.equal(batches.length, 2);
    assert.deepEqual(
      batches[1].messages.map(m => m.id),
      ['three']
    );
  } finally {
    release();
    h.coordinator.close();
  }
});

test('silence and failures never start engagement; failed requests can be retried', async () => {
  const h = harness();
  const p = policy({ minRecentMessages: 1, engagedSeconds: 60 });
  try {
    const silent = h.coordinator.receive(message('silent', { direct: false }), p, async () => ({ delivered: false, completed: true }));
    await h.coordinator.flush('group');
    await silent;
    const after = h.coordinator.receive(message('after', { direct: false }), p, async batch => {
      assert.equal(batch.mode, 'interject');
      return { delivered: false, completed: false };
    });
    await h.coordinator.flush('group');
    await after;
    const retry = h.coordinator.receive(message('after'), p, async () => ({ delivered: true }));
    await h.coordinator.flush('group');
    assert.equal((await retry).reply, true);
    const engaged = h.coordinator.receive(message('engaged', { direct: false }), p, async batch => {
      assert.equal(batch.mode, 'engaged');
      return { delivered: true };
    });
    await h.coordinator.flush('group');
    await engaged;
  } finally {
    h.coordinator.close();
  }
});

test('an engaged group topic still checks whether a different speaker is addressing the bot', async () => {
  let classified = 0;
  const batches = [];
  const h = harness({
    classify: async () => {
      classified++;
      return { reply: false, addressed: 'none', related: 'none', reason: 'none', source: 'human', loopRisk: false };
    }
  });
  const p = policy({ minRecentMessages: 1, engagedSeconds: 60, interests: ['游戏'] });
  const respond = async batch => {
    batches.push(batch);
    return { delivered: true, replyText: '接着聊' };
  };
  const first = h.coordinator.receive(message('first', { explicitMention: true, text: '一起聊游戏' }), p, respond);
  await h.coordinator.flush('group');
  await first;
  assert.equal(classified, 0);
  assert.equal(batches.length, 1);

  const second = h.coordinator.receive(message('second', { direct: false, text: '游戏里那个 boss 怎么打' }), p, respond);
  await h.coordinator.flush('group');
  await second;
  assert.equal(classified, 1, 'topic engagement is not proof of the recipient');
  assert.equal(batches.length, 1, 'do not answer another member when classification rejects');
  h.coordinator.close();
});

test('pending cancellation respects sender ownership and reset discards pending context', async () => {
  const h = harness();
  try {
    const pending = h.coordinator.receive(message('one'), policy(), async () => assert.fail('cancelled batch ran'));
    assert.equal(h.coordinator.cancelPending('group', 'other'), false);
    assert.equal(h.coordinator.cancelPending('group', 'one'), true);
    await pending;
    assert.equal(h.timers.size, 0);
    const again = h.coordinator.receive(message('two'), policy(), async () => assert.fail('reset batch ran'));
    h.coordinator.clear('group');
    await again;
    assert.equal(h.timers.size, 0);
    await h.coordinator.flush('group');
  } finally {
    h.coordinator.close();
  }
});

test('flush rechecks changed policy and burst limits after the preceding response', async () => {
  let current = policy({ minRecentMessages: 1 });
  const h = harness({ getPolicy: () => current });
  try {
    const pending = h.coordinator.receive(message('one', { direct: false }), current, async () => assert.fail('disabled batch ran'));
    current = policy({ enabled: false });
    await h.coordinator.flush('group');
    await pending;
    const explicit = h.coordinator.receive(message('two'), current, async () => ({ delivered: true }));
    await h.coordinator.flush('group');
    await explicit;
    current = policy({ burstMax: 1 });
    assert.equal((await h.coordinator.receive(message('three'), current, async () => assert.fail('burst batch ran'))).reply, false);
  } finally {
    h.coordinator.close();
  }
});

test('reset while a full segment is flushing resolves incoming requests without scheduling retired context', async () => {
  const h = harness();
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const p = policy({ maxBatchMessages: 1 });
  let calls = 0;
  try {
    const first = h.coordinator.receive(message('first'), p, async () => {
      calls++;
      await gate;
      return { delivered: true };
    });
    const overflow = h.coordinator.receive(message('overflow'), p, async () => assert.fail('retired request ran'));
    h.coordinator.clear('group');
    release();
    await first;
    assert.equal((await overflow).reply, false);
    assert.equal(calls, 1);
    assert.equal(h.timers.size, 0);
  } finally {
    release();
    h.coordinator.close();
  }
});

test('semantic gate replaces random relevance and denies even explicit name calls', async () => {
  let classified = 0;
  let replied = 0;
  const h = harness({
    classify: async input => {
      classified++;
      assert.equal(input.messages[0].called, true);
      return { reply: false, addressed: 'none', related: 'none', reason: 'none' };
    }
  });
  const done = h.coordinator.receive(message('gate', { text: '大肥鱼别回复' }), policy(), async () => {
    replied++;
    return { delivered: true };
  });
  await h.coordinator.flush('group');
  await done;
  assert.equal(classified, 1);
  assert.equal(replied, 0);
  h.coordinator.close();
});

test('semantic gate does not admit unrelated help without address or context', async () => {
  let replied = 0;
  const h = harness({
    classify: async () => ({ reply: false, addressed: 'none', related: 'none', reason: 'none', source: 'human', loopRisk: false })
  });
  const done = h.coordinator.receive(
    message('help', { text: '这个报错该怎么处理', direct: false }),
    policy({ interjectChance: 0.01, interests: [], minRecentMessages: 100 }),
    async () => {
      replied++;
      return { delivered: true };
    }
  );
  await h.coordinator.flush('group');
  await done;
  assert.equal(replied, 0);
  h.coordinator.close();
});

test('semantic gate admits a related follow-up without a name call and passes the relation', async () => {
  let batch;
  const h = harness({
    classify: async () => ({ reply: true, addressed: 'none', related: 'my_last_reply', reason: 'context', source: 'human', loopRisk: false })
  });
  const done = h.coordinator.receive(
    message('follow', { text: '那这个参数呢', direct: false }),
    policy({ interjectChance: 0.01, interests: [], minRecentMessages: 100 }),
    async value => {
      batch = value;
      return { delivered: true };
    }
  );
  await h.coordinator.flush('group');
  await done;
  assert.equal(batch.replyReason, 'context');
  assert.equal(batch.replyAddressed, 'none');
  assert.equal(batch.replyRelated, 'my_last_reply');
  assert.match(buildGroupBatchPrompt(batch), /related=my_last_reply/);
  h.coordinator.close();
});

test('commands bypass classification and classifier exceptions never invoke DSH', async () => {
  let calls = 0;
  let replies = 0;
  const h = harness({
    classify: async () => {
      calls++;
      throw new Error('offline');
    }
  });
  const respond = async () => {
    replies++;
    return { delivered: true };
  };
  const a = h.coordinator.receive(message('cmd', { explicitCommand: true }), policy(), respond);
  await h.coordinator.flush('group');
  await a;
  assert.equal(calls, 0);
  assert.equal(replies, 1);
  const b = h.coordinator.receive(message('ordinary'), policy(), respond);
  await h.coordinator.flush('group');
  await b;
  assert.equal(calls, 1);
  assert.equal(replies, 1);
  h.coordinator.close();
});

test('cancel during classification prevents a late positive verdict from replying', async () => {
  let resolve;
  let replies = 0;
  const h = harness({
    classify: () =>
      new Promise(done => {
        resolve = done;
      })
  });
  const done = h.coordinator.receive(message('cancel'), policy(), async () => {
    replies++;
    return { delivered: true };
  });
  const flush = h.coordinator.flush('group');
  assert.equal(h.coordinator.cancelPending('group', 'someone-else'), false);
  assert.equal(h.coordinator.cancelPending('group', 'cancel'), true);
  resolve({ reply: true, addressed: 'direct', related: 'none', reason: 'direct' });
  await flush;
  await done;
  assert.equal(replies, 0);
  h.coordinator.close();
});

test('loop breaker also applies to explicit commands and owners without calling AI again', async () => {
  const h = harness();
  let replies = 0;
  const respond = async () => {
    replies++;
    return { delivered: true, replyText: '已回答你的详细问题' };
  };
  const first = h.coordinator.receive(
    message('loop1', { userId: 'peer', text: '请详细解释这一个问题', explicitCommand: true, owner: true }),
    policy(),
    respond
  );
  await h.coordinator.flush('group');
  await first;
  const second = await h.coordinator.receive(
    message('loop2', { userId: 'peer', text: '请详细解释这一个问题', explicitCommand: true, owner: true }),
    policy(),
    respond
  );
  assert.equal(second.reply, false);
  assert.equal(replies, 1);
  const bot = await h.coordinator.receive(message('bot', { isBot: true }), policy(), respond);
  assert.equal(bot.reply, false);
  h.coordinator.close();
});

test('failed delivery does not train the loop breaker to reject a retry', async () => {
  const h = harness();
  const item = message('retry-loop', { text: '请详细解释这一个失败的问题' });
  const first = h.coordinator.receive(item, policy(), async () => ({ delivered: false }));
  await h.coordinator.flush('group');
  await first;
  let replies = 0;
  const second = h.coordinator.receive(item, policy(), async () => {
    replies++;
    return { delivered: true };
  });
  await h.coordinator.flush('group');
  await second;
  assert.equal(replies, 1);
  h.coordinator.close();
});

test('explicit command has zero debounce and a trailing message cannot delay it', async () => {
  const h = harness();
  const a = h.coordinator.receive(message('command', { explicitCommand: true }), policy(), async () => ({ delivered: true }));
  assert.equal([...h.timers.values()][0].ms, 0);
  const b = h.coordinator.receive(message('background', { direct: false }), policy(), async () => ({ delivered: true }));
  assert.equal([...h.timers.values()][0].ms, 0);
  await h.coordinator.flush('group');
  await Promise.all([a, b]);
  h.coordinator.close();
});

test('explicit mentions debounce at most 200ms and remain responsive after local automatic-chat limits', async () => {
  const h = harness({ classify: () => assert.fail('explicit calls must not classify') });
  let replies = 0;
  for (let i = 0; i < 6; i++) {
    const done = h.coordinator.receive(
      message(`at-${i}`, { userId: 'human', userKey: 'human', explicitMention: true, text: `请回答不同问题${i}` }),
      policy({ burstMax: 1 }),
      async () => {
        replies++;
        return { delivered: true, replyText: `回答${i}` };
      }
    );
    assert.ok([...h.timers.values()][0].ms <= 200);
    await h.coordinator.flush('group');
    await done;
  }
  assert.equal(replies, 6);
  h.coordinator.close();
});

test('one speaker direct replies have a fixed target; multiple speakers still support reply selection', () => {
  const anchor = message('one');
  const batch = { id: 'batch', mode: 'direct', anchor, messages: [anchor, { ...anchor, id: 'part2' }] };
  assert.equal(needsReplySelection(batch), false);
  assert.doesNotMatch(buildGroupBatchPrompt(batch), /<reply:m1>/);
  assert.equal(needsReplySelection({ ...batch, messages: [anchor, message('two')] }), true);
  assert.equal(needsReplySelection({ ...batch, mode: 'interject' }), true);
  assert.match(buildGroupBatchPrompt({ ...batch, styleHint: '最近 10 条群聊中位 8 字；偏短句。' }), /群聊语气参考/);
  assert.match(buildGroupBatchPrompt({ ...batch, styleHint: '最近 10 条群聊中位 8 字；偏短句。' }), /不要照抄原句/);
});

test('latency separates local waiting, classification and response without dropping the gate', async () => {
  let timings;
  const h = harness({
    classify: async () => {
      h.advance(40);
      return { reply: true, addressed: 'direct', related: 'none', reason: 'direct' };
    },
    onTiming: value => {
      timings = value;
    }
  });
  const a = h.coordinator.receive(message('timing'), policy(), async () => {
    h.advance(60);
    return { delivered: true };
  });
  assert.equal([...h.timers.values()][0].ms, 1200);
  h.advance(1200);
  await h.coordinator.flush('group');
  await a;
  assert.deepEqual(timings, { waitMs: 1200, gateMs: 40, responseMs: 60, totalMs: 1300 });
  h.coordinator.close();
});

test('lifecycle invalidation cancels classification without re-enabling a late response', async () => {
  let resolve;
  let replies = 0;
  const h = harness({
    classify: () =>
      new Promise(done => {
        resolve = done;
      })
  });
  const done = h.coordinator.receive(message('withdrawn'), policy(), async () => {
    replies++;
    return { delivered: true };
  });
  const flush = h.coordinator.flush('group');
  h.coordinator.invalidateRecent('group');
  resolve({ reply: true, addressed: 'direct', related: 'none', reason: 'direct' });
  await flush;
  await done;
  assert.equal(replies, 0);
  h.coordinator.close();
});

test('rejected partial speech is reconsidered with the same speaker continuation', async () => {
  const inputs = [],
    replies = [];
  const h = harness({
    classify: async input => {
      inputs.push(input);
      return input.messages.length > 1
        ? { reply: true, addressed: 'name', related: 'none', reason: 'name', source: 'human', loopRisk: false }
        : { reply: false, addressed: 'none', related: 'none', reason: 'none', source: 'human', loopRisk: false };
    }
  });
  const respond = async batch => {
    replies.push(batch);
    return { delivered: true };
  };
  const first = h.coordinator.receive(message('partial1', { userId: 'alice', text: '肥鱼，那个接口' }), policy(), respond);
  await h.coordinator.flush('group');
  await first;
  assert.equal(replies.length, 0);
  h.advance(3000);
  const second = h.coordinator.receive(message('partial2', { userId: 'alice', text: '一直返回403，帮忙看看权限', direct: false }), policy(), respond);
  await h.coordinator.flush('group');
  await second;
  assert.deepEqual(
    inputs[1].messages.map(item => item.text),
    ['肥鱼，那个接口', '一直返回403，帮忙看看权限']
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0].anchor.id, 'partial2');
  assert.equal(replies[0].messages.length, 2);
  h.coordinator.close();
});

test('continuation arriving during classification prevents a stale answer and is classified together', async () => {
  let resolveFirst;
  const inputs = [],
    replies = [];
  const h = harness({
    classify: async input => {
      inputs.push(input);
      if (inputs.length === 1)
        return new Promise(resolve => {
          resolveFirst = resolve;
        });
      return { reply: true, addressed: 'direct', related: 'none', reason: 'direct', source: 'human', loopRisk: false };
    }
  });
  const respond = async batch => {
    replies.push(batch);
    return { delivered: true };
  };
  const first = h.coordinator.receive(message('race1', { userId: 'alice', text: '肥鱼帮我看看' }), policy(), respond);
  const flushing = h.coordinator.flush('group');
  const second = h.coordinator.receive(message('race2', { userId: 'alice', text: '还有这个条件', direct: false }), policy(), respond);
  resolveFirst({ reply: true, addressed: 'direct', related: 'none', reason: 'direct', source: 'human', loopRisk: false });
  await flushing;
  await first;
  assert.equal(replies.length, 0);
  await h.coordinator.flush('group');
  await second;
  assert.deepEqual(
    inputs[1].messages.map(item => item.text),
    ['肥鱼帮我看看', '还有这个条件']
  );
  assert.equal(replies.length, 1);
  h.coordinator.close();
});

test('wait-until-finished buffers one speaker, only that speaker releases it, and cancellation clears it', async () => {
  const batches = [],
    inputs = [];
  const h = harness({
    classify: async input => {
      inputs.push(input);
      return { reply: true, addressed: 'direct', related: 'none', reason: 'direct', source: 'human', loopRisk: false };
    }
  });
  const respond = async batch => {
    batches.push(batch);
    return { delivered: true };
  };
  const alice = (id, text) => message(id, { userId: 'alice', userKey: 'alice', text, direct: false });
  await h.coordinator.receive(alice('hold1', '肥鱼，等我说完'), policy(), respond);
  await h.coordinator.receive(alice('hold2', '第一段背景'), policy(), respond);
  const other = h.coordinator.receive(message('other', { text: '说完了' }), policy(), respond);
  await h.coordinator.flush('group');
  await other;
  assert.equal(inputs.length, 1);
  assert.ok(!batches[0].messages.some(item => item.userId === 'alice'));
  await h.coordinator.receive(alice('hold3', '第二段问题'), policy(), respond);
  const release = h.coordinator.receive(alice('hold4', '可以回了'), policy(), respond);
  await h.coordinator.flush('group');
  await release;
  assert.deepEqual(
    batches[1].messages.map(item => item.text),
    ['第一段背景', '第二段问题', '可以回了']
  );
  assert.equal(batches[1].anchor.userId, 'alice');
  await h.coordinator.receive(alice('hold5', '先别回'), policy(), respond);
  await h.coordinator.receive(alice('hold6', '不要留下这段'), policy(), respond);
  h.coordinator.cancelPending('group', 'alice');
  const fresh = h.coordinator.receive(alice('hold7', '新的问题'), policy(), respond);
  await h.coordinator.flush('group');
  await fresh;
  assert.deepEqual(
    batches[2].messages.map(item => item.text),
    ['新的问题']
  );
  h.coordinator.close();
});

test('same speaker extends the quiet window but maximum wait is bounded', async () => {
  const h = harness();
  const respond = async () => ({ delivered: true });
  const a = h.coordinator.receive(message('debounce1', { userId: 'alice' }), policy(), respond);
  h.advance(1000);
  const b = h.coordinator.receive(message('debounce2', { userId: 'alice', direct: false }), policy(), respond);
  assert.equal([...h.timers.values()][0].ms, 1200);
  h.advance(2800);
  const c = h.coordinator.receive(message('debounce3', { userId: 'alice', direct: false }), policy(), respond);
  assert.equal([...h.timers.values()][0].ms, 200);
  await h.coordinator.flush('group');
  await Promise.all([a, b, c]);
  h.coordinator.close();
});

test('hold arriving during classification suppresses its late result and retains its text until release', async () => {
  let finish;
  const batches = [];
  let calls = 0;
  const h = harness({
    classify: async () => {
      if (++calls === 1)
        return new Promise(resolve => {
          finish = resolve;
        });
      return { reply: true, addressed: 'direct', related: 'none', reason: 'direct', source: 'human', loopRisk: false };
    }
  });
  const respond = async batch => {
    batches.push(batch);
    return { delivered: true };
  };
  const first = h.coordinator.receive(message('before-hold', { userId: 'alice', userKey: 'alice', text: '肥鱼，先看这个问题' }), policy(), respond);
  const flush = h.coordinator.flush('group');
  await h.coordinator.receive(message('start-hold', { userId: 'alice', userKey: 'alice', text: '等我说完', direct: false }), policy(), respond);
  finish({ reply: true, addressed: 'direct', related: 'none', reason: 'direct' });
  await flush;
  await first;
  assert.equal(batches.length, 0);
  const release = h.coordinator.receive(message('end-hold', { userId: 'alice', userKey: 'alice', text: '可以回了', direct: false }), policy(), respond);
  await h.coordinator.flush('group');
  await release;
  assert.deepEqual(
    batches[0].messages.map(item => item.text),
    ['肥鱼，先看这个问题', '可以回了']
  );
  h.coordinator.close();
});

test('automated and loop-risk rejections are not replayed as unfinished human fragments', async () => {
  const inputs = [];
  const h = harness({
    classify: async input => {
      inputs.push(input);
      return { reply: false, addressed: 'none', related: 'none', reason: 'none', source: 'automated', loopRisk: true };
    }
  });
  for (const id of ['auto1', 'auto2']) {
    const done = h.coordinator.receive(message(id, { userId: 'peer', text: `自动信息 ${id}` }), policy(), async () => {
      assert.fail('must not reply');
    });
    await h.coordinator.flush('group');
    await done;
  }
  assert.equal(inputs[1].messages.length, 1);
  h.coordinator.close();
});

test('exhausted recognition preserves wake calls and only routes ambient messages to the notice path', async () => {
  for (const direct of [true, false]) {
    const h = harness({
      classify: async () => ({ reply: false, addressed: 'none', related: 'none', reason: 'none', budgetBlocked: true })
    });
    const batches = [];
    const done = h.coordinator.receive(message(`blocked-${direct}`, { direct, text: '这个报错怎么处理' }), policy(), async batch => {
      batches.push(batch);
      return { delivered: false, completed: true };
    });
    await h.coordinator.flush('group');
    await done;
    assert.equal(batches.length, 1);
    assert.equal(Boolean(batches[0].budgetBlocked), !direct);
    assert.equal(batches[0].mode === 'direct', direct);
    h.coordinator.close();
  }
});

test('explicit mentions skip reply classification while keyword calls still use it', async () => {
  let classified = 0;
  const batches = [];
  const h = harness({
    classify: async () => {
      classified++;
      return { reply: false, addressed: 'none', related: 'none', reason: 'none' };
    }
  });
  const respond = async batch => {
    batches.push(batch);
    return { delivered: true };
  };
  const mention = h.coordinator.receive(message('at-human', { explicitMention: true, text: '你好' }), policy(), respond);
  const keyword = h.coordinator.receive(message('keyword-other', { text: 'DeepSeek 更新了' }), policy(), respond);
  await h.coordinator.flush('group');
  await Promise.all([mention, keyword]);
  assert.equal(classified, 0);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].anchor.id, 'at-human');
  const second = h.coordinator.receive(message('keyword-only', { text: '他们说肥鱼是人机' }), policy(), respond);
  await h.coordinator.flush('group');
  await second;
  assert.equal(classified, 1);
  assert.equal(batches.length, 1);
  h.coordinator.close();
});

test('explicit mentions retain local bot, stop, hold and loop protections', async () => {
  let calls = 0;
  const h = harness({
    classify: async () => {
      assert.fail('explicit mention must not classify');
    }
  });
  const respond = async () => {
    calls++;
    return { delivered: true, replyText: '完整回复内容' };
  };
  const event = (id, overrides = {}) => message(id, { userId: 'alice', userKey: 'alice', explicitMention: true, text: '请解释这个具体问题', ...overrides });
  assert.equal((await h.coordinator.receive(event('bot', { isBot: true }), policy(), respond)).reply, false);
  await h.coordinator.receive(event('hold', { text: '@肥鱼 等我说完', controlText: '等我说完' }), policy(), respond);
  await h.coordinator.receive(event('piece', { text: '这是问题背景', explicitMention: false, direct: false }), policy(), respond);
  assert.equal(calls, 0);
  await h.coordinator.receive(event('stop', { text: '@肥鱼 不用回复', controlText: '不用回复' }), policy(), respond);
  assert.equal(calls, 0);
  const first = h.coordinator.receive(event('first'), policy(), respond);
  await h.coordinator.flush('group');
  await first;
  assert.equal(calls, 1);
  assert.equal((await h.coordinator.receive(event('repeat'), policy(), respond)).reply, false);
  assert.equal(calls, 1);
  h.coordinator.close();
});

test('local sentence-leading address skips the classification model', async () => {
  const h = harness({
    classify: () => assert.fail('high-confidence address must not classify')
  });
  let replied = 0;
  const done = h.coordinator.receive(message('local-address', { text: '肥鱼，帮我看看这个报错', direct: true, addressed: true }), policy(), async () => {
    replied++;
    return { delivered: true };
  });
  await h.coordinator.flush('group');
  await done;
  assert.equal(replied, 1);
  h.coordinator.close();
});

test('local address timing records a gate bypass without calling the classifier', async () => {
  let timings;
  const h = harness({
    classify: () => assert.fail('fast path must not classify'),
    onTiming: value => {
      timings = value;
    }
  });
  const done = h.coordinator.receive(message('fast-timing', { text: '肥鱼，在吗', direct: true, addressed: true }), policy(), async () => ({
    delivered: true
  }));
  await h.coordinator.flush('group');
  await done;
  assert.equal(timings?.fastPath, true);
  assert.equal(timings?.bypassed, true);
  assert.equal(timings?.gateMs, 0);
  h.coordinator.close();
});

test('low-signal group reactions do not call the classifier', async () => {
  const h = harness({
    classify: () => assert.fail('low-signal message must not classify')
  });
  const done = h.coordinator.receive(message('noise', { text: '666', direct: false }), policy(), async () => {
    assert.fail('low-signal message must not reply');
  });
  await h.coordinator.flush('group');
  await done;
  h.coordinator.close();
});

test('cold statements without a question or topic match skip the gate locally', async () => {
  let timings;
  const h = harness({
    classify: () => assert.fail('cold statement must not classify'),
    onTiming: value => {
      timings = value;
    }
  });
  const done = h.coordinator.receive(message('cold-statement', { text: '今天地铁人很多', direct: false }), policy(), async () => {
    assert.fail('cold statement must not reply');
  });
  await h.coordinator.flush('group');
  await done;
  assert.equal(timings?.localSkip, true);
  h.coordinator.close();
});

test('speaking motive distinguishes direct, continuation and ambient participation without hiding the gate reason', () => {
  const anchor = message('motive');
  const batch = { id: 'motive', mode: 'direct', anchor, messages: [anchor], replyAddressed: 'name', replyRelated: 'none', replyReason: 'name' };
  assert.match(buildGroupBatchPrompt(batch), /reason=name/);
  assert.match(buildGroupBatchPrompt(batch), /本轮发言缘由：回应当前对你说话的人/);
  assert.match(buildGroupBatchPrompt({ ...batch, replyAddressed: 'follow_up', replyReason: 'follow_up' }), /本轮发言缘由：承接正在进行的对话/);
  const ambient = buildGroupBatchPrompt({ ...batch, mode: 'interject', replyAddressed: 'none', replyReason: 'context' });
  assert.match(ambient, /本轮发言缘由：感知到群聊中有可参与的内容/);
  assert.match(ambient, /这不代表有人呼唤或请求你/);
  assert.match(ambient, /不产生任何新的操作授权/);
});

test('active public topic reaches the reply model with participation context', async () => {
  let batch;
  const h = harness({
    classify: async () => ({ reply: true, addressed: 'none', related: 'open_topic', reason: 'context', source: 'human', loopRisk: false })
  });
  const done = h.coordinator.receive(
    message('follow', { text: '大家最近玩的合作游戏有什么有趣的事', direct: false }),
    policy({ activity: 'active', interjectChance: 0.01, interests: [], minRecentMessages: 100 }),
    async value => {
      batch = value;
      return { delivered: true };
    }
  );
  await h.coordinator.flush('group');
  await done;
  assert.equal(batch.replyReason, 'context');
  assert.equal(batch.replyAddressed, 'none');
  assert.equal(batch.replyRelated, 'open_topic');
  assert.match(buildGroupBatchPrompt(batch), /related=open_topic/);
  assert.match(buildGroupBatchPrompt(batch), /主动加入公开闲聊/);
  h.coordinator.close();
});

test('same speaker follow-ups retain actual exchange and bypass ambient limits without another wake', async () => {
  const h = harness({
    classify: async () => {
      throw new Error('follow-up must not need classifier');
    }
  });
  const batches = [];
  const respond = async batch => {
    batches.push(batch);
    return { delivered: true, replyText: batches.length === 1 ? '在呢，什么事' : '可以聊游戏，也能查资料。' };
  };
  const p = policy({ enabled: false, burstMax: 1 });
  try {
    const first = h.coordinator.receive(message('first', { userId: 'person', text: '肥鱼', addressed: true }), p, respond);
    await h.coordinator.flush('group');
    await first;
    h.advance(5000);
    const next = h.coordinator.receive(message('second', { userId: 'person', text: '你是干嘛的', direct: false }), p, respond);
    await h.coordinator.flush('group');
    await next;
    assert.equal(batches.length, 2);
    assert.equal(batches[1].replyReason, 'follow_up');
    assert.equal(batches[1].anchor.continuation.replyText, '在呢，什么事');
    assert.match(buildGroupBatchPrompt(batches[1]), /在呢，什么事/);
    const other = await h.coordinator.receive(message('other', { text: '你能做什么', direct: false }), p, respond);
    assert.equal(other.reply, false);
    h.advance(120001);
    const expired = await h.coordinator.receive(message('expired', { userId: 'person', text: '你能做什么', direct: false }), p, respond);
    assert.equal(expired.reply, false);
  } finally {
    h.coordinator.close();
  }
});

test('stop and redirection never inherit a previous conversation invitation', async () => {
  for (const redirected of [true, false]) {
    const h = harness();
    const p = policy({ enabled: false });
    const respond = async () => ({ delivered: true, replyText: '在呢' });
    try {
      const first = h.coordinator.receive(message('wake', { userId: 'person' }), p, respond);
      await h.coordinator.flush('group');
      await first;
      if (!redirected) await h.coordinator.receive(message('stop', { userId: 'person', text: '别回了', direct: false }), p, respond);
      const next = await h.coordinator.receive(
        message('next', {
          userId: 'person',
          text: '你能做什么',
          direct: false,
          ...(redirected ? { messageContext: { mentions: [{ isSelf: false }], message: {} } } : {})
        }),
        p,
        respond
      );
      assert.equal(next.reply, false);
    } finally {
      h.coordinator.close();
    }
  }
});

test("interleaved conversations keep each person's own confirmed exchange", async () => {
  const h = harness({
    classify: async () => {
      throw new Error('known follow-up must not need another classifier');
    }
  });
  const p = policy({ enabled: false });
  const batches = [];
  const respond = async batch => {
    batches.push(batch);
    return { delivered: true, replyText: `${batch.anchor.userId}，你想看哪类游戏？` };
  };
  const receive = async (id, userId, text, direct) => {
    const done = h.coordinator.receive(message(id, { userId, userKey: userId, platform: 'qq', text, direct, addressed: direct }), p, respond);
    await h.coordinator.flush('group');
    return await done;
  };
  try {
    await receive('a1', 'alice', '肥鱼，推荐个游戏', true);
    await receive('b1', 'bob', '肥鱼，我也想问你', true);
    await receive('a2', 'alice', '能和朋友合作的', false);
    await receive('b2', 'bob', '我更喜欢单机', false);
    assert.equal(batches.length, 4);
    assert.equal(batches[2].anchor.continuation.userText, '肥鱼，推荐个游戏');
    assert.equal(batches[2].anchor.continuation.replyText, 'alice，你想看哪类游戏？');
    assert.equal(batches[3].anchor.continuation.userText, '肥鱼，我也想问你');
    assert.equal(batches[3].anchor.continuation.replyText, 'bob，你想看哪类游戏？');
    assert.equal(batches[2].replyReason, 'follow_up');
  } finally {
    h.coordinator.close();
  }
});

test('stopping or invalidating during response generation prevents a late reply from reopening continuation', async () => {
  for (const action of ['stop', 'invalidate', 'cancel']) {
    const h = harness();
    const p = policy({ enabled: false });
    let finish;
    let began;
    const started = new Promise(resolve => {
      began = resolve;
    });
    const result = new Promise(resolve => {
      finish = resolve;
    });
    const first = h.coordinator.receive(message('first', { userId: 'alice', userKey: 'alice' }), p, async () => {
      began();
      return result;
    });
    const running = h.coordinator.flush('group');
    await started;
    try {
      if (action === 'stop')
        await h.coordinator.receive(message('stop', { userId: 'alice', userKey: 'alice', text: '下次再聊', direct: false }), p, async () => ({
          delivered: false
        }));
      else if (action === 'invalidate') h.coordinator.invalidateRecent('group');
      else h.coordinator.cancelPending('group', 'alice');
      finish({ delivered: true, replyText: '你想聊什么？' });
      await running;
      await first;
      const next = await h.coordinator.receive(message('next', { userId: 'alice', userKey: 'alice', text: '合作游戏', direct: false }), p, async () => {
        throw new Error('ended conversation must not inherit a late invitation');
      });
      assert.equal(next.reply, false, action);
    } finally {
      finish({ delivered: false });
      h.coordinator.close();
    }
  }
});

test("addressing another person ends only that speaker's previous invitation", async () => {
  const h = harness();
  const p = policy({ enabled: false });
  const respond = async () => ({ delivered: true, replyText: '你想聊什么？' });
  try {
    for (const userId of ['alice', 'bob']) {
      const done = h.coordinator.receive(message(`${userId}1`, { userId, userKey: userId }), p, respond);
      await h.coordinator.flush('group');
      await done;
    }
    await h.coordinator.receive(
      message('redirect', { userId: 'alice', userKey: 'alice', direct: false, messageContext: { mentions: [{ isSelf: false }], message: {} } }),
      p,
      respond
    );
    const alice = await h.coordinator.receive(message('alice2', { userId: 'alice', userKey: 'alice', direct: false }), p, respond);
    assert.equal(alice.reply, false);
    const bob = h.coordinator.receive(message('bob2', { userId: 'bob', userKey: 'bob', direct: false }), p, respond);
    await h.coordinator.flush('group');
    assert.equal((await bob).reply, true);
  } finally {
    h.coordinator.close();
  }
});

test('a selected reply creates continuation for its actual recipient instead of the batch anchor', async () => {
  const h = harness();
  const p = policy({ enabled: false });
  const batches = [];
  const respond = async batch => {
    batches.push(batch);
    return { delivered: true, replyText: '甲，你想看什么？', replyToMessageId: 'a1' };
  };
  try {
    const a = h.coordinator.receive(message('a1', { userId: 'alice', userKey: 'alice' }), p, respond);
    const b = h.coordinator.receive(message('b1', { userId: 'bob', userKey: 'bob' }), p, respond);
    await h.coordinator.flush('group');
    await Promise.all([a, b]);
    assert.equal(batches[0].anchor.userId, 'bob');
    const bob = await h.coordinator.receive(message('b2', { userId: 'bob', userKey: 'bob', direct: false }), p, respond);
    assert.equal(bob.reply, false);
    const alice = h.coordinator.receive(message('a2', { userId: 'alice', userKey: 'alice', text: '合作游戏', direct: false }), p, respond);
    await h.coordinator.flush('group');
    assert.equal((await alice).reply, true);
    assert.equal(batches[1].anchor.continuation.replyText, '甲，你想看什么？');
    assert.equal(batches[1].anchor.continuation.userText, batches[0].messages[0].text);
  } finally {
    h.coordinator.close();
  }
});

test('reply recognition retains who answered whom in recent and current messages', async () => {
  const inputs = [];
  const h = harness({
    classify: async input => {
      inputs.push(input);
      return { reply: false, addressed: 'none', related: 'none', reason: 'none' };
    }
  });
  const p = policy({ minRecentMessages: 1, interests: ['游戏'] });
  try {
    const answer = h.coordinator.receive(message('answer', {
      userId: 'lemon', direct: false, text: '游戏已经优化了，对。',
      messageContext: { mentionsKnown: true, mentions: [{ id: 'zero', isSelf: false }], message: { replyToId: 'question' } }
    }), p, async () => assert.fail('member conversation must stay silent'));
    await h.coordinator.flush('group');
    await answer;
    h.advance(10);
    const next = h.coordinator.receive(message('next', {
      userId: 'zero', direct: false, text: '游戏这个优化了吗？',
      messageContext: { mentionsKnown: true, mentions: [], message: { replyToId: 'answer' } }
    }), p, async () => assert.fail('rejected message must stay silent'));
    await h.coordinator.flush('group');
    await next;
    const input = inputs.at(-1);
    const previous = input.recent.find(row => row.messageId === 'answer');
    assert.equal(previous.replyToId, 'question');
    assert.deepEqual(previous.mentions, [{ speaker: input.messages[0].speaker, isSelf: false }]);
    assert.equal(input.messages[0].messageId, 'next');
    assert.equal(input.messages[0].replyToId, 'answer');
    assert.notEqual(previous.speaker, input.messages[0].speaker);
  } finally {
    h.coordinator.close();
  }
});
