#!/usr/bin/env bash
# Clawstly - easy RPC control for Git Bash / WSL.

set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLI="$ROOT/bin/clawstly-oc-rpc.js"
CLI_WIN="$CLI"
APP="Clawstly"
PORT=47474

to_win_path() {
  local p="$1" drive rest
  case "$p" in
    /mnt/[a-zA-Z]/*)
      drive="${p:5:1}"; rest="${p:7}"
      echo "${drive^^}:\\${rest//\//\\}"
      ;;
    /[a-zA-Z]/*)
      drive="${p:1:1}"; rest="${p:3}"
      echo "${drive^^}:\\${rest//\//\\}"
      ;;
    *) echo "$p" ;;
  esac
}

# Windows Node needs a Windows-style script path, even when launched from Git Bash.
if command -v cygpath >/dev/null 2>&1; then
  CLI_WIN="$(cygpath -w "$CLI")"
else
  CLI_WIN="$(to_win_path "$CLI")"
fi

to_posix_path() {
  local p="$1"
  case "$p" in
    [A-Za-z]:\\*)
      p="/mnt/$(printf '%s' "${p:0:1}" | tr 'A-Z' 'a-z')/$(printf '%s' "${p:3}" | tr '\\' '/')"
      ;;
  esac
  printf '%s\n' "$p"
}

json_string() {
  local key="$1" file="$2" line
  [ -f "$file" ] || return 0
  line="$(grep -E "\"$key\"[[:space:]]*:" "$file" | head -n1)"
  [ -n "$line" ] || return 0
  printf '%s\n' "$line" | sed -E "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\\1/"
}

json_number() {
  local key="$1" file="$2" line
  [ -f "$file" ] || return 0
  line="$(grep -E "\"$key\"[[:space:]]*:" "$file" | head -n1)"
  [ -n "$line" ] || return 0
  printf '%s\n' "$line" | sed -E "s/.*\"$key\"[[:space:]]*:[[:space:]]*([0-9]+).*/\\1/"
}

state_dir() {
  local user_part base
  user_part="$(printf '%s' "$ROOT" | sed -E 's#^/(mnt/)?[a-zA-Z]/Users/([^/]+)/.*#\2#')"
  for base in "${TMPDIR:-}" "${TEMP:-}" "${TMP:-}" \
              "/mnt/c/Users/$user_part/AppData/Local/Temp" \
              "/c/Users/$user_part/AppData/Local/Temp"; do
    [ -n "$base" ] || continue
    base="$(to_posix_path "$base")"
    if [ -d "$base/clawstly-oc-rpc" ]; then
      printf '%s\n' "$base/clawstly-oc-rpc"
      return
    fi
  done
  printf '%s\n' "${TMPDIR:-/tmp}/clawstly-oc-rpc"
}

if [ ! -f "$CLI" ]; then
  echo "Cannot find CLI at: $CLI"
  read -r -p "Press Enter to exit..." _
  exit 1
fi

# Git Bash normally inherits Node on PATH. If it does not, fall back to the
# Windows `where node` lookup so the launcher still works from a plain shell.
NODE=(node)
if ! command -v node >/dev/null 2>&1; then
  if command -v cmd.exe >/dev/null 2>&1; then
    NODE=(cmd.exe /c node)
  else
    echo "Node.js was not found on PATH. Install Node 18+ and try again."
    read -r -p "Press Enter to exit..." _
    exit 1
  fi
fi

rpc() {
  (cd "$ROOT" && "${NODE[@]}" "$CLI_WIN" "$@")
}

read_config() {
  local file="$ROOT/config.json" app="$APP" model="Claude Opus" metric="cost" value
  if [ -f "$file" ]; then
    value="$(json_string appName "$file")"
    [ -n "$value" ] && app="$value"
    if grep -Eq '"displayModel"[[:space:]]*:' "$file"; then
      model="$(json_string displayModel "$file")"
    fi
    value="$(json_string displayMetric "$file")"
    [ -n "$value" ] && metric="$value"
  fi
  printf '%s\n%s\n%s\n' "$app" "$model" "$metric"
}

daemon_pid() {
  local dir pid_file info_file pid info_pid beat now_sec
  dir="$(state_dir)"
  pid_file="$dir/daemon.pid"
  info_file="$dir/daemon.json"
  [ -f "$pid_file" ] || return 0

  pid="$(tr -d '[:space:]' < "$pid_file")"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac

  if [ -f "$info_file" ]; then
    info_pid="$(json_number pid "$info_file")"
    beat="$(json_number beatAt "$info_file")"
    if [ -n "$info_pid" ] && [ "$info_pid" != "$pid" ]; then
      return 0
    fi
    if [ -n "$beat" ]; then
      now_sec="$(date +%s)"
      if [ $((now_sec - beat / 1000)) -gt 300 ]; then
        return 0
      fi
    fi
  fi
  printf '%s\n' "$pid"
}

pause_user() {
  echo
  read -r -p "Press ENTER to continue." _ || true
}

header() {
  clear 2>/dev/null || true
  local cfg app model metric pid
  cfg="$(read_config)"
  {
    IFS= read -r app
    IFS= read -r model
    IFS= read -r metric
  } <<< "$cfg"
  pid="$(daemon_pid)"
  [ -n "$pid" ] || pid="stopped"
  [ -n "$app" ] || app="$APP"
  [ -n "$model" ] || model="real model"

  local label="$APP - RPC control" inner=48 pad left right
  pad=$((inner - ${#label}))
  [ "$pad" -lt 0 ] && pad=0
  left=$(((pad + 1) / 2))
  right=$((pad - left))
  printf '+%*s+\n' "$inner" '' | tr ' ' '-'
  printf '|%*s%s%*s|\n' "$left" '' "$label" "$right" ''
  printf '+%*s+\n' "$inner" '' | tr ' ' '-'
  echo
  echo " Daemon : $pid"
  echo " App    : $app"
  echo " Model  : $model"
  echo " Metric : $metric"
  echo
}

main_menu() {
  header
  cat <<'EOF'
 1  Start RPC
 2  Stop RPC
 3  Restart RPC
 4  Status
 5  Health check
 6  Open dashboard
 7  Change displayed model
 8  Token / cost display
 9  Exit

EOF
}

model_menu() {
  header
  cat <<'EOF'
Displayed model on Discord

 1  GPT Sol
 2  GPT Luna
 3  GPT Astra
 4  Claude Opus
 5  Claude Sonnet
 6  Claude Haiku
 7  Claude Fable
 8  Real model (privacy off)
 9  Custom label...
 0  Back

EOF
}

metric_menu() {
  header
  cat <<'EOF'
What should Discord show?

 1  Tokens           -> 46.63M tokens
 2  Estimated cost   -> ~$0.42
 3  Both             -> 46.63M tokens, ~$0.42
 0  Back

EOF
}

dashboard_up() {
  local url="http://127.0.0.1:$PORT/api/settings"
  # Git Bash's curl cannot always see a Windows loopback socket started by a
  # hidden PowerShell child, so ask Windows netstat first.
  if command -v cmd.exe >/dev/null 2>&1; then
    # No grep -q here: closing the pipe early gives cmd.exe SIGPIPE, and with
    # pipefail that makes a successful LISTENING match look like a failure.
    cmd.exe /c netstat -ano 2>/dev/null | grep -F "127.0.0.1:$PORT" | grep -F "LISTENING" >/dev/null 2>&1
  elif command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 "$url" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null --timeout=2 "$url" >/dev/null 2>&1
  else
    return 1
  fi
}

start_dashboard() {
  local url="http://127.0.0.1:$PORT" up=0 i
  if dashboard_up; then
    up=1
  else
    (cd "$ROOT" && CLAWSTLY_RPC_NO_OPEN=1 "${NODE[@]}" "$CLI_WIN" serve >/dev/null 2>&1 &)
    for i in $(seq 1 20); do
      if dashboard_up; then up=1; break; fi
      sleep 0.25
    done
  fi
  if [ "$up" -eq 1 ]; then
    if command -v cmd.exe >/dev/null 2>&1; then
      cmd.exe /c start "" "$url" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$url" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then
      open "$url" >/dev/null 2>&1 || true
    fi
    echo "Dashboard: $url"
  else
    echo "Dashboard did not start on $url" >&2
    echo "Start it manually with: node bin/clawstly-oc-rpc.js serve" >&2
  fi
}

model_choice() {
  model_menu
  local choice
  read -r -p "Choice: " choice
  choice="${choice%$'\r'}"
  case "$choice" in
    1) rpc model sol || true; pause_user ;;
    2) rpc model luna || true; pause_user ;;
    3) rpc model astra || true; pause_user ;;
    4) rpc model opus || true; pause_user ;;
    5) rpc model sonnet || true; pause_user ;;
    6) rpc model haiku || true; pause_user ;;
    7) rpc model fable || true; pause_user ;;
    8) rpc model real || true; pause_user ;;
    9)
      local label
      read -r -p "Model label: " label
      label="${label%$'\r'}"
      if [ -n "$label" ]; then rpc model "$label" || true; fi
      pause_user
      ;;
    0) ;;
    *) echo "Unknown choice."; pause_user ;;
  esac
}

metric_choice() {
  metric_menu
  local choice
  read -r -p "Choice: " choice
  choice="${choice%$'\r'}"
  case "$choice" in
    1) rpc metric tokens || true; pause_user ;;
    2) rpc metric cost || true; pause_user ;;
    3) rpc metric both || true; pause_user ;;
    0) ;;
    "") ;;
    *) echo "Unknown choice."; pause_user ;;
  esac
}

# Direct arguments (./run.sh model sol) skip the interactive menu.
if [ "$#" -gt 0 ]; then
  action="$1"
  shift
  case "$action" in
    start) rpc start; exit $? ;;
    stop) rpc stop; exit $? ;;
    restart) rpc restart; exit $? ;;
    status) rpc status; exit $? ;;
    doctor) rpc doctor; exit $? ;;
    dashboard) start_dashboard; exit 0 ;;
    model) rpc model "$@"; exit $? ;;
    metric) rpc metric "$@"; exit $? ;;
    *)
      echo "Unknown action: $action"
      echo "start | stop | restart | status | doctor | dashboard | model | metric"
      exit 1
      ;;
  esac
fi

while true; do
  main_menu
  # Closing stdin (piped/menu automation) should exit, not spin forever.
  read -r -p "Choice: " choice || exit 0
  choice="${choice%$'\r'}"
  case "$choice" in
    1) rpc start || true; pause_user ;;
    2) rpc stop || true; pause_user ;;
    3) rpc restart || true; pause_user ;;
    4) rpc status || true; pause_user ;;
    5) rpc doctor || true; pause_user ;;
    6) start_dashboard; pause_user ;;
    7) model_choice ;;
    8) metric_choice ;;
    9) exit 0 ;;
    *) echo "Unknown choice."; pause_user ;;
  esac
done
