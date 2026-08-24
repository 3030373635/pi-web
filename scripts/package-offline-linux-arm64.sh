#!/usr/bin/env bash
set -euo pipefail

# 参数 1：Node.js 官方 Linux ARM64 .tar.xz 压缩包路径。
# 参数 2：生成离线包的输出目录。
# 环境变量 PI_WEB_PACKAGE_ROOT：可选，待打包的 Pi Web 根目录，默认是仓库根目录。
# 环境变量 PI_WEB_BUILD_NODE：可选，构建环境的 Node.js 路径，默认从 PATH 查找 node。
if [[ $# -ne 2 ]]; then
  echo "用法: $0 <node-linux-arm64.tar.xz> <输出目录>" >&2
  exit 2
fi

node_archive=$1
output_root=$2
script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
package_root=${PI_WEB_PACKAGE_ROOT:-$(cd "${script_root}/.." && pwd)}
build_node=${PI_WEB_BUILD_NODE:-node}

if [[ ! -f "${node_archive}" ]]; then
  echo "Node.js 压缩包不存在: ${node_archive}" >&2
  exit 1
fi

for required_path in .next bin node_modules public package.json next.config.ts LICENSE; do
  if [[ ! -e "${package_root}/${required_path}" ]]; then
    echo "缺少打包所需文件: ${package_root}/${required_path}" >&2
    exit 1
  fi
done

# 使用构建环境的 Node.js 解析 JSON，避免文本匹配误读嵌套对象中的 version 字段。
package_version=$("${build_node}" -e '
  const packageJson = require(process.argv[1]);
  if (typeof packageJson.version === "string") process.stdout.write(packageJson.version);
' "${package_root}/package.json")
if [[ -z "${package_version}" ]]; then
  echo "无法从 package.json 读取版本号" >&2
  exit 1
fi

bundle_name="pi-web-${package_version}-linux-arm64"
mkdir -p "${output_root}"
work_root=$(mktemp -d)
trap 'rm -rf "${work_root}"' EXIT

bundle_root="${work_root}/${bundle_name}"
app_root="${bundle_root}/app"
runtime_root="${bundle_root}/runtime"
mkdir -p "${app_root}" "${runtime_root}"

# 生产构建仍依赖外置的 Pi SDK 和 Next.js 包，因此 node_modules 必须随离线包分发。
cp -a "${package_root}/.next" "${app_root}/.next"
cp -a "${package_root}/bin" "${app_root}/bin"
cp -a "${package_root}/node_modules" "${app_root}/node_modules"
cp -a "${package_root}/public" "${app_root}/public"
cp "${package_root}/package.json" "${app_root}/package.json"
cp "${package_root}/next.config.ts" "${app_root}/next.config.ts"
cp "${package_root}/LICENSE" "${bundle_root}/LICENSE"

# 官方 Node.js 压缩包包含一层版本目录，去掉该目录以形成稳定的 runtime/bin/node 路径。
tar -xJf "${node_archive}" -C "${runtime_root}" --strip-components=1
if [[ ! -x "${runtime_root}/bin/node" ]]; then
  echo "Node.js 压缩包中缺少可执行文件 runtime/bin/node" >&2
  exit 1
fi

cat > "${bundle_root}/start.sh" <<'EOF'
#!/usr/bin/env sh
set -eu

# 从脚本所在目录启动，确保离线包移动或改名后仍能正确解析相对路径。
bundle_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "${bundle_root}"
exec ./runtime/bin/node ./app/bin/pi-web.js --no-open "$@"
EOF
chmod 755 "${bundle_root}/start.sh"

archive_path="${output_root}/${bundle_name}.tar.gz"
tar -czf "${archive_path}" -C "${work_root}" "${bundle_name}"
echo "${archive_path}"
