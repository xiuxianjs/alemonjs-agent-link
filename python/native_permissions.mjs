/** Adapt trusted host grants to DSH's native permission service, also on resume. */
export const name = 'agent-link-native-permissions';
export const inject = ['permissionPresets'];
export function apply(ctx, config) {
  const preset = config?.preset;

  if (!['read-only', 'workspace-write'].includes(preset)) throw new Error('Unsupported AgentLink permission preset');
  ctx.on('agent/created', ({ agent }) => {
    ctx.permissionPresets.set(agent.session, preset);
    if (ctx.permissionPresets.current(agent.session) !== preset) throw new Error('Native permission reconciliation failed');
    // Authenticated startup acknowledgement, before the first model request.
    const nonce = process.env.AGENTLINK_PERMISSION_NONCE;

    if (nonce) process.stderr.write(`AGENTLINK_PERMISSION ${JSON.stringify([nonce, String(agent.session.id), preset])}\n`);
  });
}
