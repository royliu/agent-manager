import os from 'node:os';
import path from 'node:path';
import { bold, dim } from '../ui/format.js';

export type Shell = 'zsh' | 'bash' | 'fish';

export function detectShell(): Shell {
  const sh = path.basename(process.env.SHELL ?? '');
  if (sh === 'fish') return 'fish';
  if (sh === 'bash') return 'bash';
  return 'zsh';
}

/** The rc file the hook belongs in, as the user would write it. */
export function rcFileFor(shell: Shell): string {
  return shell === 'fish' ? '~/.config/fish/config.fish' : shell === 'bash' ? '~/.bashrc' : '~/.zshrc';
}

export function rcPathFor(shell: Shell): string {
  return rcFileFor(shell).replace(/^~/, os.homedir());
}

/** Marks the hook in an rc file, so it is never added twice. */
export const HOOK_MARKER = '# ---- agent-manager shell integration ----';

/**
 * AGENT_MANAGER_SHELL=2 marks the 0.7.0 hook, which handles both `am use` and
 * `am profile use`; a value of 1 is the older hook, which handles only `am use`.
 */
const POSIX = `${HOOK_MARKER}
# Lets "am profile use" change the current shell, not just the saved default.
export AGENT_MANAGER_SHELL=2
am() {
  if [ "$1" = "use" ] || { [ "$1" = "profile" ] && [ "$2" = "use" ]; }; then
    command am "$@" || return $?
    if [ "$1" = "use" ]; then shift; else shift 2; fi
    local __am_env
    __am_env="$(command am shell env "$@" 2>/dev/null)" && eval "$__am_env"
  else
    command am "$@"
  fi
}
# ---- end agent-manager ----`;

const FISH = `${HOOK_MARKER}
set -gx AGENT_MANAGER_SHELL 2
function am
    if test (count $argv) -gt 0 -a "$argv[1]" = "use"; or test (count $argv) -gt 1 -a "$argv[1]" = "profile" -a "$argv[2]" = "use"
        command am $argv; or return $status
        set -l __am_rest $argv[2..-1]
        if test "$argv[1]" = "profile"
            set __am_rest $argv[3..-1]
        end
        set -l __am_env (command am shell env $__am_rest 2>/dev/null)
        for line in $__am_env
            # translate "export K=V" / "unset K" into fish
            set -l parts (string split -m 2 " " -- $line)
            switch $parts[1]
                case export
                    set -l kv (string split -m 1 "=" -- $parts[2])
                    set -gx $kv[1] (string trim -c "'" -- $kv[2])
                case unset
                    set -e $parts[2]
            end
        end
    else
        command am $argv
    end
end
# ---- end agent-manager ----`;

export function shellHookBody(shell: Shell): string {
  return shell === 'fish' ? FISH : POSIX;
}

/** `am shell hook [shell]`: print the hook; the rc file to put it in goes to stderr. */
export function shellHookCommand(shellArg?: string): void {
  const shell = (shellArg as Shell | undefined) ?? detectShell();
  if (process.stdout.isTTY) {
    const rc = rcFileFor(shell);
    console.error('');
    console.error(`  ${bold('Add this to')} ${rc}${dim(':')}`);
    console.error(dim(`  (or run: am shell hook >> ${rc} && exec ${shell})`));
    console.error('');
  }
  console.log(shellHookBody(shell));
}
