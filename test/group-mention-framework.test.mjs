import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp } from 'alemonjs/testing';
import { useEvent, useMessage, useMedia } from 'alemonjs';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { respondToGroupBatch } from '../lib/social/respond.js';

test('group replies mention explicit callers but ordinary follow-ups stay natural', async () => {
  const root = await mkdtemp(join(tmpdir(), 'group-mention-policy-'));
  const previousFetch = globalThis.fetch;
  const config = {
    apiKey: 'test', model: 'test', runtimeMode: 'chat-only', stateBackend: 'local',
    workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'),
    modules: { disabled: ['opinions'], settings: { mood: { modelJudge: false } } }
  };
  const app = createTestApp({ config: { 'alemonjs-agent-link': config } });
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '在呢，接着说呀。' } }] });
  try {
    for (const kind of ['mention', 'command', 'name', 'follow_up', 'ambient']) {
      const handler = async () => {
        const [context] = useEvent({ selects: 'message.create' });
        const event = context.current;
        const anchor = {
          id: event.MessageId, channelId: event.ChannelId, platform: event.Platform,
          userId: event.UserId, userKey: event.UserId, name: '网友', owner: false,
          text: event.MessageText, direct: kind !== 'ambient',
          explicitMention: kind === 'mention', explicitCommand: kind === 'command'
        };
        const outcome = await respondToGroupBatch(event, { message: useMessage()[0], media: useMedia()[0] }, {
          id: `mention-policy-${kind}`, mode: kind === 'ambient' ? 'interject' : 'direct',
          anchor, messages: [anchor]
        });
        assert.equal(outcome.delivered, true);
        assert.equal(outcome.completed, true);
      };
      const event = app.events.groupMessage({}, {
        Platform: 'qq', BotId: 'bot', ChannelId: `mention-${kind}`, UserId: 'human',
        MessageId: `input-${kind}`, MessageText: '继续聊呀', IsPrivate: false
      });
      const result = await app.runHandler(handler, event, 'alemonjs-agent-link');
      assert.equal(result.errors.length, 0);
      assert.ok(result.messages.length > 0);
      const nodes = JSON.stringify(result.messages.map(message => message.nodes));
      assert.match(nodes, /在呢/);
      if (kind === 'mention' || kind === 'command') assert.match(nodes, /Mention|mention/);
      else assert.doesNotMatch(nodes, /Mention|mention/);
    }
  } finally {
    await (await getModuleRuntime(config)).close();
    await app.dispose();
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});
