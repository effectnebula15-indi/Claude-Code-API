/**
 * Builds the `claude` CLI argv for one conversation.
 *
 * The defaults here are deliberately locked down: a gateway that is reachable
 * from the internet must not hand an anonymous caller a shell. Tools are off
 * unless the agent profile names them, settings/plugins/hooks on the host are
 * ignored, and MCP is limited to what the profile passes explicitly.
 */

/**
 * @param {Object} o
 * @param {import('../types.js').Agent} o.agent
 * @param {string} o.sessionId       UUID we assign to the conversation.
 * @param {boolean} o.resume         Reattach to an existing conversation.
 * @param {boolean} [o.safeMode]     Ignore host CLAUDE.md/skills/plugins/hooks.
 * @returns {string[]}
 */
export function buildArgs({ agent, sessionId, resume, safeMode = true }) {
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    // stream-json output is rejected without --verbose.
    '--verbose',
    '--include-partial-messages',
    // Nothing on the server can answer an interactive prompt, so anything that
    // would ask is denied instead of hanging forever.
    '--permission-prompts', 'none',
    '--disable-slash-commands',
  ];

  if (resume) args.push('--resume', sessionId);
  else args.push('--session-id', sessionId);

  if (agent.model) args.push('--model', agent.model);
  if (agent.effort) args.push('--effort', agent.effort);

  // "" is how the CLI spells "no tools at all".
  args.push('--tools', agent.tools.length ? agent.tools.join(',') : '');

  if (agent.permissionMode && agent.permissionMode !== 'default') {
    args.push('--permission-mode', agent.permissionMode);
  }
  if (agent.systemPrompt) args.push('--system-prompt', agent.systemPrompt);
  if (agent.appendSystemPrompt) args.push('--append-system-prompt', agent.appendSystemPrompt);

  for (const dir of agent.addDirs) args.push('--add-dir', dir);

  if (agent.mcpConfig) args.push('--mcp-config', agent.mcpConfig, '--strict-mcp-config');
  else args.push('--strict-mcp-config');

  if (safeMode && !agent.mcpConfig) args.push('--safe-mode');

  args.push(...agent.extraArgs);
  return args;
}
