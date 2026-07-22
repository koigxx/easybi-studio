#!/usr/bin/env node
/**
 * Fake Claude CLI for process-protocol tests. Mimics the subset of the
 * stream-json output ClaudeCodeBridge parses. Reads the prompt from stdin,
 * verifies the expected args, and emits scripted stream-json lines.
 *
 * Behavior:
 *  - Always emits system/init with a session_id.
 *  - Emits a text delta echoing the prompt (redaction is tested via a password).
 *  - Emits a tool_use start + tool_result.
 *  - On --resume, emits a delta acknowledging the resume, then result success.
 *  - Without --resume, emits result success.
 */
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const isResume = args.includes('--resume');
const sessionId = isResume
  ? args[args.indexOf('--resume') + 1]
  : 'sess-fake-0001';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let prompt = '';
const rl = createInterface({ input: process.stdin });
rl.on('line', (l) => (prompt += l));
rl.on('close', () => {
  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  emit({
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `收到：${prompt}` } },
  });
  // A secret in output must be redacted by the bridge, not the CLI.
  emit({
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'password="hunter2"' } },
  });
  emit({
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Write' } },
  });
  emit({
    type: 'user',
    session_id: sessionId,
    message: { content: [{ type: 'tool_result', is_error: false }] },
  });
  const result = isResume ? '已根据回复继续并完成' : '完成';
  emit({ type: 'result', subtype: 'success', is_error: false, result, session_id: sessionId });
  if (args.includes('--version')) {
    // handled below; not reached because stdin close drives this
  }
});

// Support `--version` without stdin.
if (args.includes('--version')) {
  process.stdout.write('fake-claude 9.9.9\n');
  process.exit(0);
}
