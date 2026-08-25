#!/usr/bin/env bash
set -euo pipefail

# 参数 1：目标平台，只允许 linux 或 macos。
# 参数 2：Chromium 浏览器文件的输出目录。
# 环境变量 PI_WEB_PACKAGE_ROOT：可选，Pi Web 根目录，默认是仓库根目录。
if [[ $# -ne 2 ]]; then
  echo "用法: $0 <linux|macos> <浏览器输出目录>" >&2
  exit 2
fi

platform=$1
browser_output_root=$2
script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
package_root=${PI_WEB_PACKAGE_ROOT:-$(cd "${script_root}/.." && pwd)}

case "${platform}" in
  linux|macos) ;;
  *)
    echo "不支持的目标平台: ${platform}" >&2
    exit 2
    ;;
esac

playwright_cli="${package_root}/node_modules/.bin/playwright-cli"
if [[ ! -x "${playwright_cli}" ]]; then
  echo "缺少可执行文件: ${playwright_cli}" >&2
  exit 1
fi

mkdir -p "${browser_output_root}"
browser_output_root=$(cd "${browser_output_root}" && pwd)
install_arguments=(install-browser chromium)
if [[ "${platform}" == "linux" ]]; then
  # Linux runner 同时安装并验证 Ubuntu 24.04 ARM64 所需的 Chromium 系统依赖。
  install_arguments+=(--with-deps)
fi

# 不传 --only-shell 或 --no-shell，确保产物同时包含有头 Chromium 和无头 shell。
PLAYWRIGHT_BROWSERS_PATH="${browser_output_root}" \
  "${playwright_cli}" "${install_arguments[@]}"

# chromium-* 是可有头运行的完整浏览器；不能用无头 shell 冒充完整离线安装。
if [[ -z "$(find "${browser_output_root}" -maxdepth 1 -type d -name 'chromium-*' -print -quit)" ]]; then
  echo "浏览器下载结果缺少完整 Chromium: ${browser_output_root}" >&2
  exit 1
fi
if [[ -z "$(find "${browser_output_root}" -maxdepth 1 -type d -name 'chromium_headless_shell-*' -print -quit)" ]]; then
  echo "浏览器下载结果缺少 Chromium 无头 shell: ${browser_output_root}" >&2
  exit 1
fi
