/**
 * The gateway from the official OpenAI Node SDK.
 *
 *   npm i openai
 *   CCA_URL=http://127.0.0.1:8787 CCA_KEY=cca_xxx node openai_sdk.mjs
 */
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: `${(process.env.CCA_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')}/v1`,
  apiKey: process.env.CCA_KEY,
});

const answer = await client.chat.completions.create({
  model: 'default',
  messages: [{ role: 'user', content: 'Explain a rainbow in two sentences.' }],
});
console.log(answer.choices[0].message.content);

console.log('\n--- streaming ---');
const stream = await client.chat.completions.create({
  model: 'default',
  messages: [{ role: 'user', content: 'List three prime numbers.' }],
  stream: true,
}, {
  // Server-side conversation: only the new turn travels, and the CLI process
  // stays warm between calls.
  headers: { 'X-Conversation-Id': 'node-demo-1' },
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
console.log();
