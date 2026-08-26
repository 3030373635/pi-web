#!/usr/bin/env sh
set -eu

# 包装器位于 <离线包>/runtime/bin，通过固定相对位置找到真实 Playwright CLI。
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bundle_root=$(CDPATH= cd -- "${script_root}/../.." && pwd)
real_cli="${bundle_root}/app/node_modules/.bin/playwright-cli"

if [ ! -x "${real_cli}" ]; then
  echo "缺少 Playwright CLI: ${real_cli}" >&2
  exit 127
fi

# Playwright CLI 默认选择系统 Chrome；离线包未显式指定时必须改用随包分发的 Chromium。
PLAYWRIGHT_MCP_BROWSER=${PLAYWRIGHT_MCP_BROWSER:-chromium}
export PLAYWRIGHT_MCP_BROWSER

# 非 Linux ARM64 平台没有麒麟 Mali GBM 冲突，直接保留原始启动行为。
system_name=$(uname -s)
machine_name=$(uname -m)
if [ "${system_name}" != "Linux" ] || { [ "${machine_name}" != "aarch64" ] && [ "${machine_name}" != "arm64" ]; }; then
  exec "${real_cli}" "$@"
fi

# 同时查找有头 Chromium 和默认无头 shell，避免只验证非实际启动的 ELF。
browser_root=${PLAYWRIGHT_BROWSERS_PATH:-${bundle_root}/browsers}
browser_executables=$(
  for browser_name in chrome headless_shell; do
    find "${browser_root}" -type f -name "${browser_name}" -perm -u+x -print 2>/dev/null | head -n 1
  done
)
if [ -z "${browser_executables}" ]; then
  exec "${real_cli}" "$@"
fi

# 任一实际浏览器缺少目标 GBM 符号时才进入回退，其他启动错误保持原行为。
requires_gbm_fallback=0
while IFS= read -r browser_executable; do
  if [ -z "${browser_executable}" ]; then
    continue
  fi
  if default_probe_output=$(LD_BIND_NOW=1 "${browser_executable}" --version 2>&1); then
    continue
  fi
  case "${default_probe_output}" in
    *"undefined symbol: gbm_bo_map"*|*"undefined symbol: gbm_bo_unmap"*)
      requires_gbm_fallback=1
      ;;
  esac
done <<EOF
${browser_executables}
EOF

if [ "${requires_gbm_fallback}" -eq 0 ]; then
  exec "${real_cli}" "$@"
fi

# 输出目标机器上可能提供 libgbm.so.1 的路径。
# 参数：无。PI_WEB_GBM_LIBRARY 可由运维显式指定唯一候选库。
list_gbm_candidates() {
  if [ -n "${PI_WEB_GBM_LIBRARY:-}" ]; then
    printf '%s\n' "${PI_WEB_GBM_LIBRARY}"
    return
  fi

  for library_path in \
    /lib/aarch64-linux-gnu/libgbm.so.1 \
    /usr/lib/aarch64-linux-gnu/libgbm.so.1
  do
    if [ -r "${library_path}" ]; then
      printf '%s\n' "${library_path}"
    fi
  done

  if command -v ldconfig >/dev/null 2>&1; then
    ldconfig -p 2>/dev/null | awk '$1 == "libgbm.so.1" { print $NF }'
  fi
}

# 使用指定 GBM 库探测 Chromium 是否能完成所有启动前符号解析。
# 参数 1：Chromium 可执行文件。参数 2：待探测的 libgbm.so.1 绝对路径。
probe_browser_with_library() {
  probe_browser=$1
  probe_library=$2
  probe_preload="${probe_library}${LD_PRELOAD:+:${LD_PRELOAD}}"

  LD_BIND_NOW=1 LD_PRELOAD="${probe_preload}" \
    "${probe_browser}" --version >/dev/null 2>&1
}

# 验证候选库不会破坏包内任一种 Chromium 启动模式。
# 参数 1：待探测的 libgbm.so.1 绝对路径。
probe_all_browsers_with_library() {
  all_browsers_library=$1

  while IFS= read -r browser_executable; do
    if [ -z "${browser_executable}" ]; then
      continue
    fi
    if ! probe_browser_with_library "${browser_executable}" "${all_browsers_library}"; then
      return 1
    fi
  done <<EOF
${browser_executables}
EOF

  return 0
}

selected_library=""
candidate_list=$(list_gbm_candidates | awk 'NF && !seen[$0]++')
while IFS= read -r candidate_library; do
  if [ -z "${candidate_library}" ] || [ ! -r "${candidate_library}" ]; then
    continue
  fi
  if probe_all_browsers_with_library "${candidate_library}"; then
    selected_library=${candidate_library}
    break
  fi
done <<EOF
${candidate_list}
EOF

if [ -z "${selected_library}" ]; then
  echo "Chromium 的系统 libgbm 缺少 gbm_bo_map 或 gbm_bo_unmap，未找到可兼容 Chromium 的 libgbm。" >&2
  exec "${real_cli}" "$@"
fi

# 仅包装后的 Playwright CLI 及其 Chromium 子进程继承覆盖，不修改系统动态链接配置。
LD_PRELOAD="${selected_library}${LD_PRELOAD:+:${LD_PRELOAD}}"
export LD_PRELOAD
echo "已为 Chromium 选择兼容的 libgbm: ${selected_library}" >&2
exec "${real_cli}" "$@"
