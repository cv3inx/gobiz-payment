// Tiny leveled logger — colored badges, icons, aligned scopes. ANSI auto-off
// when not a TTY (PM2 log files stay plain).
// ponytail: no winston/pino. A few lines cover it for a single-process app.
const useColor = process.stdout.isTTY;

// ANSI helpers
const reset = '\x1b[0m';
const fg = (code, s) => (useColor ? `\x1b[${code}m${s}${reset}` : s);
const style = (codes, s) => (useColor ? `\x1b[${codes}m${s}${reset}` : s);
const dim = (s) => fg(90, s);
const bold = (s) => style('1', s);

const LEVELS = {
   info:  { label: 'INFO', icon: 'ℹ', badge: '48;5;24;97'  },  // white on blue
   ok:    { label: 'OK',   icon: '✔', badge: '48;5;28;97'  },  // white on green
   warn:  { label: 'WARN', icon: '▲', badge: '48;5;130;97' },  // white on amber
   error: { label: 'FAIL', icon: '✖', badge: '48;5;124;97' },  // white on red
   http:  { label: 'HTTP', icon: '⇄', badge: '48;5;54;97'  },  // white on purple
};

function ts() {
   return new Date().toTimeString().slice(0, 8);
}

// Fixed-width scope so messages line up in a column.
function padScope(scope) {
   const s = scope.slice(0, 8).padEnd(8);
   return s;
}

function badge(L) {
   // colored: icon + label on a bg badge. plain: fixed-width [LABEL] for aligned PM2 logs.
   if (useColor) return style(L.badge, ` ${L.icon} ${L.label.padEnd(4)} `);
   return `[${L.label.padEnd(4)}]`;
}

function emit(level, scope, msg) {
   const L = LEVELS[level] || LEVELS.info;
   const line = [
      dim(ts()),
      badge(L),
      useColor ? bold(fg(36, padScope(scope))) : padScope(scope),
      dim('│'),
      msg,
   ].join(' ');
   (level === 'error' ? console.error : console.log)(line);
}

/** Scoped logger: log('watcher').info('...') → "12:00:00  ℹ INFO   watcher  │ ..." */
export function log(scope = 'app') {
   return {
      info:  (m) => emit('info', scope, m),
      warn:  (m) => emit('warn', scope, m),
      error: (m) => emit('error', scope, m),
      ok:    (m) => emit('ok', scope, m),
   };
}

// Expose level palette so the HTTP request logger (morgan) can match the style.
export const LEVEL_META = LEVELS;
export { useColor, dim, fg, style, bold, badge, padScope, ts };

export default log;
