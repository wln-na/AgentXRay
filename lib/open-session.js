// Open/locate a collected agent session on the local machine — the
// AgentXRay counterpart of Flux Island's TerminalJumpService. Given a
// normalized session summary (log file path + cwd), it either reveals the
// log file in Finder (locate) or opens the session in the most native way
// for its platform (open): run the resume command in a fresh iTerm2/Terminal
// window for CLI agents, launch the owning GUI app, or open the log file
// with the default editor. Everything degrades to a copyable path/command on
// non-macOS or when the target is gone, so the frontend always has a
// fallback action.
//
// Command execution is injectable (`run`) so unit tests can assert on the
// exact command lines without touching the real desktop (see test/open.test.js).

const fsp = require('fs/promises');
const { existsSync } = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

const IS_MAC = process.platform === 'darwin';

// Platforms whose sessions resume natively in a terminal CLI (the primary
// "打开" action; no GUI host exists). The command strings deliberately mirror
// the frontend's resumeCommand() copy button so "复制恢复命令" and "打开"
// stay consistent.
const RESUME_PLATFORMS = new Set(['claude-code', 'omp']);

// Platforms whose sessions live inside a GUI app. "打开" launches the app;
// when the platform exposes a session-level deep link, that is tried first so
// the app not only opens but navigates to the exact session.
const APP_PLATFORMS = {
  // Codex Desktop host (ChatGPT desktop app). The Codex thread id equals the
  // rollout session id (both are the `01a…` ULID; ~/.codex/.codex-global-state.json
  // tracks these ids under thread-descriptions-v1 / heartbeat-thread-permissions-by-id),
  // so `codex://threads/<sessionId>` deep-links straight into the session.
  codex: { app: 'ChatGPT', deepLink: (sessionId) => `codex://threads/${encodeURIComponent(sessionId)}` },
  'claude-desktop': { app: 'Claude' },
  // Two different apps share the display name "Doubao" (Doubao 2.app is the
  // current one, com.bot.pc.doubao; the old Doubao.app is com.bot.neotix.doubao),
  // so the bundle id must be used to launch the right app.
  // www.doubao.com/chat/<conversationId> is the session-level deep link: the
  // Doubao work client (a Chromium shell) opens it in its embedded browser and
  // navigates straight into the conversation. It must be opened with
  // `open -a "Doubao 2" <url>` — a bare `open <url>` would route the https URL
  // to the system default browser instead.
  doubao: {
    app: 'Doubao',
    label: 'Doubao 2',
    bundleId: 'com.bot.pc.doubao',
    deepLink: (sessionId) => `https://www.doubao.com/chat/${encodeURIComponent(sessionId)}`,
    deepLinkApp: 'Doubao 2',
  },
  cursor: { app: 'Cursor' },
};

// App-first platforms with a fallback chain when the app cannot be launched:
//   - codex: fall back to resuming the session in a terminal (CLI fallback);
//   - claude-desktop / cursor: fall back to opening the log with the editor.
const APP_TERMINAL_FALLBACK = new Set(['codex']);
const APP_EDITOR_FALLBACK = new Set(['claude-desktop', 'cursor']);

// iTerm2 is preferred when installed; otherwise macOS Terminal.
const ITERM_APP_PATHS = ['/Applications/iTerm.app', path.join(process.env.HOME || '', 'Applications', 'iTerm.app')];

function terminalAppName() {
  return ITERM_APP_PATHS.some((p) => existsSync(p)) ? 'iTerm2' : 'Terminal';
}

/** The shell command line that resumes a session in its CLI (array form for execFile). */
function resumeCommandFor(platform, sessionId, cwd) {
  let file;
  let args;
  if (platform === 'codex') {
    file = 'codex';
    args = ['resume', sessionId, '--yolo'];
  } else if (platform === 'claude-code') {
    file = 'claude';
    args = ['--dangerously-skip-permissions', '--resume', sessionId];
  } else if (platform === 'omp') {
    file = 'omp';
    args = ['--auto-approve', `--resume=${sessionId}`];
  } else {
    return null;
  }
  return { file, args, cwd: cwd || null };
}

/**
 * Join a resume command into one shell line (`cd <cwd> && <cmd> …`).
 * Only the cwd needs quoting: `resume.file`/`args` are fixed literals from
 * our own table plus a sanitized session id (SESSION_ID_RE), so they never
 * carry shell metacharacters.
 */
function shellCommandLine(resume, cwd) {
  const cmdLine = [resume.file, ...resume.args].join(' ');
  if (!cwd) return cmdLine;
  return `cd ${shellQuote(cwd)} && ${cmdLine}`;
}

/** POSIX single-quote escaping: 'a b' → 'a' 'b'-ish; safe for sh/osascript. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Escape a string for embedding inside a double-quoted AppleScript literal. */
function escapeAppleScript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Default command runner (execFile, argument arrays only — no shell interpolation). */
async function runCommand(file, args, opts = {}) {
  // Test seam: AGENTXRAY_OPEN_SESSION_RECORD_FILE makes the runner record
  // (file, args) lines instead of executing them, so route-level happy paths
  // can be verified without touching the real desktop (test/open.test.js).
  const recordFile = process.env.AGENTXRAY_OPEN_SESSION_RECORD_FILE;
  if (recordFile) {
    const { appendFile } = require('fs/promises');
    await appendFile(recordFile, JSON.stringify({ file, args }) + '\n');
    return '';
  }
  const { stdout } = await execFileAsync(file, args, { timeout: 8000, ...opts });
  return stdout.trim();
}

/** macOS: reveal a file in Finder (`open -R`). Returns the trimmed stdout. */
function revealInFinder(filePath, run = runCommand) {
  return run('open', ['-R', filePath]);
}

/** macOS: open a file with its default application. */
function openWithDefaultApp(filePath, run = runCommand) {
  return run('open', [filePath]);
}

/** macOS: launch an app by display name (`open -a`). */
function openApp(appName, run = runCommand) {
  return run('open', ['-a', appName]);
}

/**
 * macOS: launch an app, preferring its bundle id (`open -b`) when known.
 * Multiple installed apps can share one display name (e.g. "Doubao"), where
 * `open -a` may resolve to the wrong copy; the bundle id is unambiguous.
 */
async function launchApp(platformSpec, run = runCommand) {
  const { bundleId, app } = platformSpec;
  if (bundleId) {
    try {
      await run('open', ['-b', bundleId]);
      return;
    } catch {
      // Bundle id failed → fall back to the display-name launch below.
    }
  }
  await openApp(app, run);
}

/**
 * Best-effort detection of a process currently holding a session log open
 * (e.g. the ChatGPT desktop app actively writing a codex rollout). This is the
 * "open in another app" situation: the session is being used/written by
 * another client, so this view may not see live updates. Uses `lsof -t` +
 * `ps`; returns null when nothing holds the file, on non-macOS, in test
 * record mode, or on any probe error (never throws — probing is advisory).
 */
async function detectActiveWriter(filePath, opts = {}) {
  const { isMac = IS_MAC, run = runCommand } = opts;
  if (!isMac || !filePath || process.env.AGENTXRAY_OPEN_SESSION_RECORD_FILE) return null;
  try {
    const pids = await run('lsof', ['-t', filePath]);
    const pid = String(pids || '')
      .trim()
      .split('\n')
      .find(Boolean);
    if (!pid) return null;
    const comm = await run('ps', ['-p', pid, '-o', 'comm=']);
    const proc = String(comm || '').trim();
    return { pid, process: proc ? path.basename(proc) : null };
  } catch {
    return null;
  }
}

/**
 * macOS: run a shell command line in a fresh terminal window.
 * Prefers iTerm2 when installed, else Terminal.
 *
 * iTerm2 note: `create window with default profile command "…"` execs the
 * whole string as a single program instead of passing it to the shell, so a
 * compound line like `cd '…' && codex resume …` dies instantly ("A session
 * ended very soon after starting"). We therefore create a plain window and
 * send the command with `write text` — iTerm types it into the session's
 * login shell, so PATH/profile behaviour is normal and a failing command
 * leaves the shell open to show the error. Terminal.app's `do script`
 * already routes through the shell and needs no such workaround.
 */
async function openInTerminal(cmdLine, run = runCommand) {
  const escaped = escapeAppleScript(cmdLine);
  const app = terminalAppName();
  const script =
    app === 'iTerm2'
      ? `tell application "iTerm"\n  set newWindow to (create window with default profile)\n  tell current session of current tab of newWindow\n    write text "${escaped}"\n  end tell\n  activate\nend tell`
      : `tell application "Terminal"\n  do script "${escaped}"\n  activate\nend tell`;
  await run('/usr/bin/osascript', ['-e', script]);
  return app;
}

/**
 * Locate a session: reveal its log file in Finder.
 * @returns {{ ok: true, action: 'locate', detail: string }}
 *        | {{ ok: false, error: string, fallback: { type: 'copy-path', path: string } }}
 */
async function locateSession(filePath, opts = {}) {
  const { isMac = IS_MAC, run = runCommand } = opts;
  if (!filePath) {
    return { ok: false, error: '会话没有可定位的日志文件', fallback: null };
  }
  if (!isMac) {
    return { ok: false, error: '定位仅在 macOS 上可用', fallback: { type: 'copy-path', path: filePath } };
  }
  try {
    await fsp.access(filePath);
  } catch {
    return { ok: false, error: '会话日志已不存在', fallback: { type: 'copy-path', path: filePath } };
  }
  try {
    await revealInFinder(filePath, run);
    return { ok: true, action: 'locate', detail: `已在 Finder 中定位会话日志：${filePath}` };
  } catch (error) {
    return {
      ok: false,
      error: `定位失败：${error.message}`,
      fallback: { type: 'copy-path', path: filePath },
    };
  }
}

/**
 * Open a session in the most native way for its platform:
 *   - codex → deep-link into the exact session in the ChatGPT app
 *     (`codex://threads/<sessionId>` — the Codex thread id equals the rollout
 *     session id), falling back to launching the app, then to resuming the
 *     session in a fresh iTerm2/Terminal window;
 *   - claude-desktop / cursor → launch the owning app, falling back to opening
 *     the log with the default editor;
 *   - doubao → deep-link into the exact conversation in the Doubao work client
 *     (`open -a "Doubao 2" https://www.doubao.com/chat/<conversationId>`), falling
 *     back to launching the app;
 *   - claude-code / omp → resume in a fresh iTerm2/Terminal window;
 *   - other platforms → open the log file with the default editor.
 * Non-macOS and missing targets degrade to a copyable path/command.
 */
async function openSession(platform, sessionId, filePath, cwd, opts = {}) {
  const { isMac = IS_MAC, run = runCommand } = opts;
  const fallbackPath = { type: 'copy-path', path: filePath || cwd || '' };

  // App-first platforms: "打开" opens the owning GUI app, deep-linking to the
  // exact session when the platform supports it.
  if (APP_PLATFORMS[platform]) {
    const spec = APP_PLATFORMS[platform];
    const { app, deepLink } = spec;
    const display = spec.label || app;
    const terminalFallback = APP_TERMINAL_FALLBACK.has(platform);
    const editorFallback = APP_EDITOR_FALLBACK.has(platform);
    const deepLinkUrl = deepLink && sessionId ? deepLink(sessionId) : null;

    if (!isMac) {
      // Non-macOS cannot launch the app; give the most useful fallback.
      if (terminalFallback) {
        const resume = resumeCommandFor(platform, sessionId, cwd);
        const cmdLine = resume && shellCommandLine(resume, cwd);
        if (cmdLine) {
          return {
            ok: false,
            error: `仅支持在 macOS 上打开 ${display}`,
            fallback: { type: 'copy-command', command: cmdLine },
          };
        }
      }
      return {
        ok: false,
        error: `仅支持在 macOS 上打开 ${display}`,
        fallback: filePath ? fallbackPath : null,
      };
    }

    try {
      // 1) Deep link to the exact session when available. Most deep links are
      // custom-scheme URLs that LaunchServices routes to the owning app; doubao
      // is an https URL, so it must be opened with `open -a <app>` to stay
      // inside the Doubao work client instead of the system browser.
      if (deepLinkUrl) {
        try {
          const openArgs = spec.deepLinkApp ? ['-a', spec.deepLinkApp, deepLinkUrl] : [deepLinkUrl];
          await run('open', openArgs);
          const locateDetail = filePath ? ` 日志文件可通过「定位」在 Finder 中查看：${filePath}` : '';
          return { ok: true, action: 'open', detail: `已在 ${display} 中打开会话${locateDetail}` };
        } catch (deepLinkError) {
          // Deep link failed → fall through to plain app launch.
          console.warn(
            `[open-session] ${platform} deep link failed, falling back to app launch:`,
            deepLinkError.message
          );
        }
      }
      // 2) Plain app launch (activates the app, no session navigation).
      await launchApp(spec, run);
      const locateDetail = filePath ? ` 日志文件可通过「定位」在 Finder 中查看：${filePath}` : '';
      const noDeepLinkNote = deepLink ? '' : '（该应用无会话级深链）';
      return { ok: true, action: 'open', detail: `已打开 ${display}${noDeepLinkNote}${locateDetail}` };
    } catch (error) {
      // App launch failed → walk the fallback chain for this platform.
      if (terminalFallback) {
        const resume = resumeCommandFor(platform, sessionId, cwd);
        if (resume) {
          const cmdLine = shellCommandLine(resume, cwd);
          try {
            const termApp = await openInTerminal(cmdLine, run);
            return {
              ok: true,
              action: 'open',
              detail: `未找到 ${display} 应用，已在 ${termApp} 新窗口中恢复会话：${cmdLine}`,
            };
          } catch (termError) {
            const msg = String(termError.message || termError);
            const hint = msg.includes('-25211') ? '（需要「系统设置 → 隐私与安全性 → 辅助功能」授权）' : '';
            return {
              ok: false,
              error: `打开 ${display} 失败且终端续跑失败${hint}：${msg}`,
              fallback: { type: 'copy-command', command: cmdLine },
            };
          }
        }
      }
      if (editorFallback && filePath) {
        try {
          await fsp.access(filePath);
          await openWithDefaultApp(filePath, run);
          return {
            ok: true,
            action: 'open',
            detail: `未找到 ${display} 应用，已用默认应用打开会话日志：${filePath}`,
          };
        } catch {
          // fall through to the generic error below
        }
      }
      return {
        ok: false,
        error: `打开 ${display} 失败：${error.message}`,
        fallback: editorFallback && filePath ? fallbackPath : null,
      };
    }
  }

  // CLI-first platforms: resume in a fresh terminal window.
  if (RESUME_PLATFORMS.has(platform)) {
    const resume = resumeCommandFor(platform, sessionId, cwd);
    if (!resume) {
      return { ok: false, error: `平台 ${platform} 不支持恢复命令`, fallback: null };
    }
    const cmdLine = shellCommandLine(resume, cwd);
    if (!isMac) {
      return {
        ok: false,
        error: '终端续跑仅在 macOS 上可用',
        fallback: { type: 'copy-command', command: cmdLine },
      };
    }
    try {
      const app = await openInTerminal(cmdLine, run);
      return { ok: true, action: 'open', detail: `已在 ${app} 新窗口中恢复会话：${cmdLine}` };
    } catch (error) {
      const msg = String(error.message || error);
      const hint = msg.includes('-25211') ? '（需要「系统设置 → 隐私与安全性 → 辅助功能」授权）' : '';
      return {
        ok: false,
        error: `终端续跑失败${hint}：${msg}`,
        fallback: { type: 'copy-command', command: cmdLine },
      };
    }
  }

  if (APP_PLATFORMS[platform]) {
    const spec = APP_PLATFORMS[platform];
    const display = spec.label || spec.app;
    if (!isMac) {
      return {
        ok: false,
        error: `仅支持在 macOS 上打开 ${display}`,
        fallback: filePath ? fallbackPath : null,
      };
    }
    try {
      await launchApp(spec, run);
      const locateDetail = filePath ? ` 日志文件可通过「定位」在 Finder 中查看：${filePath}` : '';
      return { ok: true, action: 'open', detail: `已打开 ${display}（该应用无会话级深链）${locateDetail}` };
    } catch (error) {
      return {
        ok: false,
        error: `打开 ${display} 失败：${error.message}`,
        fallback: filePath ? fallbackPath : null,
      };
    }
  }

  // File-based platforms: open the log with the default editor.
  if (!filePath) {
    return { ok: false, error: '会话没有可打开的日志文件', fallback: null };
  }
  try {
    await fsp.access(filePath);
  } catch {
    return { ok: false, error: '会话日志已不存在', fallback: fallbackPath };
  }
  if (!isMac) {
    return {
      ok: false,
      error: '打开文件仅在 macOS 上可用',
      fallback: fallbackPath,
    };
  }
  try {
    await openWithDefaultApp(filePath, run);
    return { ok: true, action: 'open', detail: `已用默认应用打开：${filePath}` };
  } catch (error) {
    return {
      ok: false,
      error: `打开文件失败：${error.message}`,
      fallback: fallbackPath,
    };
  }
}

module.exports = {
  RESUME_PLATFORMS,
  APP_PLATFORMS,
  IS_MAC,
  resumeCommandFor,
  shellCommandLine,
  shellQuote,
  escapeAppleScript,
  runCommand,
  terminalAppName,
  locateSession,
  openSession,
  detectActiveWriter,
  revealInFinder,
  openWithDefaultApp,
  openApp,
  launchApp,
  openInTerminal,
};
