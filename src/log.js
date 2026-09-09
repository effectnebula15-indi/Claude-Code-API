/**
 * Structured JSON logging on stdout — the format every container log shipper
 * already understands. No dependencies, no log files to rotate.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let threshold = LEVELS.info;

/** @param {string} level */
export function setLevel(level) {
  threshold = LEVELS[/** @type {keyof typeof LEVELS} */ (level)] ?? LEVELS.info;
}

/**
 * @param {keyof typeof LEVELS} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line, replacer) + '\n');
}

/**
 * Keep Error objects readable instead of serialising to `{}`.
 *
 * @param {string} _key
 * @param {unknown} value
 */
function replacer(_key, value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** @typedef {(msg: string, fields?: Record<string, unknown>) => void} LogFn */

export const log = {
  /** @type {LogFn} */ debug: (m, f) => emit('debug', m, f),
  /** @type {LogFn} */ info: (m, f) => emit('info', m, f),
  /** @type {LogFn} */ warn: (m, f) => emit('warn', m, f),
  /** @type {LogFn} */ error: (m, f) => emit('error', m, f),
};
