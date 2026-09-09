/**
 * Shared type definitions. This project ships plain ESM with JSDoc types so it
 * runs straight from a git checkout with no build step; `npm run typecheck`
 * still gives full TypeScript checking during development.
 */

/**
 * @typedef {Object} ApiKey
 * @property {string} key
 * @property {string} name          Human label used in logs and metrics.
 * @property {string[]|null} agents Agent profiles this key may use (null = all).
 * @property {number|null} rpm      Per-key requests/minute override.
 * @property {number|null} daily    Per-key requests/day override (0 = unlimited).
 * @property {boolean} admin        May call /v1/admin/* and read /metrics.
 */

/**
 * @typedef {Object} Agent
 * @property {string} name
 * @property {string} description
 * @property {string} model
 * @property {string} systemPrompt        Replaces Claude Code's default prompt.
 * @property {string} appendSystemPrompt
 * @property {string[]} tools             Empty = pure chat, no tools at all.
 * @property {string} permissionMode
 * @property {string} workdir
 * @property {string[]} addDirs
 * @property {string} mcpConfig
 * @property {string} effort
 * @property {boolean} allowImages
 * @property {number} prewarm             Idle processes kept spawned for latency.
 * @property {number} maxReplyChars       0 = unlimited.
 * @property {string[]} extraArgs
 */

/**
 * @typedef {{type:'text', text:string}} TextBlock
 * @typedef {{type:'image', source:{type:'base64', media_type:string, data:string}}} ImageBlock
 * @typedef {TextBlock|ImageBlock} ContentBlock
 */

/**
 * @typedef {Object} TurnResult
 * @property {string} text
 * @property {string} sessionId
 * @property {string} stopReason
 * @property {{input:number, output:number, cacheRead:number, cacheCreation:number}} usage
 * @property {number} costUsd
 * @property {number} durationMs
 * @property {string} model
 */

/**
 * @typedef {Object} RateLimitSnapshot
 * @property {string} status
 * @property {number|null} resetsAt          Unix seconds.
 * @property {Record<string, {utilization:number, resetsAt:number|null}>} windows
 * @property {number} observedAt             Unix ms.
 */

export {};
