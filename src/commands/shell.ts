import path from 'node:path';
import { bold, dim } from '../ui/format.js';

type Shell = 'zsh' | 'bash' | 'fish';

function detectShell(): Shell {
  const sh = path.basename(process.env.SHELL ?? '');
  if (sh === 'fish') return 'fish';
  if (sh === 'bash') return 'bash';
  return 'zsh';
}

const POSIX = `# ---- agent-manager shell integration ----
# Lets \`am use\` change the current shell, not just the saved default.
export AGENT_MANAGER_SHELL=1
am() {
  case "$1" in
    use)
      command am "$@" || return $?
      shift
      local __am_env
      __am_env="$(command am env "$@" 2>/dev/null)" && eval "$__am_env"
      ;;
    *)
      command am "$@"
      ;;
  esac
}
# ---- end agent-manager ----`;

const FISH = `# ---- agent-manager shell integration ----
set -gx AGENT_MANAGER_SHELL 1
function am
    if test (count $argv) -gt 0 -a "$argv[1]" = "use"
        command am $argv; or return $status
        set -l __am_env (command am env $argv[2..-1] 2>/dev/null)
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

export function shellInitCommand(shellArg?: string): void {
  const shell = (shellArg as Shell | undefined) ?? detectShell();
  const body = shell === 'fish' ? FISH : POSIX;

  if (process.stdout.isTTY) {
    const rc =
      shell === 'fish'
        ? '~/.config/fish/config.fish'
        : shell === 'bash'
          ? '~/.bashrc'
          : '~/.zshrc';
    console.error('');
    console.error(`  ${bold('Add this to')} ${rc}${dim(':')}`);
    console.error(dim(`  (or run: am shell-init >> ${rc} && exec ${shell})`));
    console.error('');
  }
  console.log(body);
}
