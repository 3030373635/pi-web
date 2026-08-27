#!/usr/bin/env bash
set -euo pipefail

# 参数 1：python-build-standalone 的 install_only_stripped tar.gz 文件。
# 参数 2：同版本 full 归档，用于提取 PYTHON.json 和底层组件许可证。
# 参数 3：包含固定版本和 SHA256 的 Python requirements 锁文件。
# 参数 4：生成的可迁移 Python 运行时目录。
if [[ $# -ne 4 ]]; then
  echo "用法: $0 <python.tar.gz> <python-metadata.tar.zst> <requirements.lock> <输出目录>" >&2
  exit 2
fi

python_archive=$1
metadata_archive=$2
requirements_lock=$3
runtime_root=$4

if [[ ! -f "${python_archive}" ]]; then
  echo "Python 压缩包不存在: ${python_archive}" >&2
  exit 1
fi
if [[ ! -f "${metadata_archive}" ]]; then
  echo "Python 元数据压缩包不存在: ${metadata_archive}" >&2
  exit 1
fi
if [[ ! -f "${requirements_lock}" ]]; then
  echo "Python requirements 锁文件不存在: ${requirements_lock}" >&2
  exit 1
fi
if [[ -e "${runtime_root}" || -L "${runtime_root}" ]]; then
  echo "Python 运行时输出目录已存在: ${runtime_root}" >&2
  exit 1
fi

runtime_parent=$(dirname "${runtime_root}")
mkdir -p "${runtime_parent}"
# 所有工作都在同一文件系统的临时目录完成，成功后一次性移动，失败不会留下半成品。
work_root=$(mktemp -d "${runtime_parent}/.python-runtime-build.XXXXXX")
trap 'rm -rf "${work_root}"' EXIT
runtime_stage="${work_root}/runtime"
wheelhouse="${work_root}/wheelhouse"
metadata_stage="${work_root}/metadata"
mkdir -p "${runtime_stage}" "${wheelhouse}" "${metadata_stage}"

# install_only 压缩包固定包含一层 python 目录，去掉该层以获得稳定的 bin/python3 路径。
tar -xzf "${python_archive}" -C "${runtime_stage}" --strip-components=1
if [[ ! -x "${runtime_stage}/bin/python3" ]]; then
  echo "Python 压缩包中缺少可执行文件 bin/python3" >&2
  exit 1
fi

# 构建机可能比目标系统更新，因此先显式解析 aarch64 + GLIBC 2.31 及更老兼容标签的 wheel。
"${runtime_stage}/bin/python3" -m pip download \
  --dest "${wheelhouse}" \
  --platform manylinux_2_31_aarch64 \
  --platform manylinux_2_30_aarch64 \
  --platform manylinux_2_29_aarch64 \
  --platform manylinux_2_28_aarch64 \
  --platform manylinux_2_27_aarch64 \
  --platform manylinux_2_26_aarch64 \
  --platform manylinux_2_25_aarch64 \
  --platform manylinux_2_24_aarch64 \
  --platform manylinux_2_23_aarch64 \
  --platform manylinux_2_22_aarch64 \
  --platform manylinux_2_21_aarch64 \
  --platform manylinux_2_20_aarch64 \
  --platform manylinux_2_19_aarch64 \
  --platform manylinux_2_18_aarch64 \
  --platform manylinux_2_17_aarch64 \
  --platform manylinux2014_aarch64 \
  --python-version 3.12 \
  --implementation cp \
  --abi cp312 \
  --require-hashes \
  --only-binary=:all: \
  --no-cache-dir \
  --requirement "${requirements_lock}"

# 仅从已按目标 ABI 筛选的 wheelhouse 安装，禁止在较新构建机上回退到 PyPI 重新选包。
"${runtime_stage}/bin/python3" -m pip install \
  --no-index \
  --find-links "${wheelhouse}" \
  --require-hashes \
  --only-binary=:all: \
  --no-cache-dir \
  --no-compile \
  --requirement "${requirements_lock}"

licenses_root="${runtime_stage}/licenses"
runtime_licenses_root="${licenses_root}/runtime-components"
package_licenses_root="${licenses_root}/python-packages"
mkdir -p "${runtime_licenses_root}/licenses" "${package_licenses_root}"

# full 归档包含构建时使用的 OpenSSL、libffi、SQLite 等组件许可证和机器可读构建清单。
tar -xf "${metadata_archive}" -C "${metadata_stage}" python/PYTHON.json python/licenses
if [[ ! -f "${metadata_stage}/python/PYTHON.json" || ! -d "${metadata_stage}/python/licenses" ]]; then
  echo "Python 元数据压缩包缺少 PYTHON.json 或组件许可证" >&2
  exit 1
fi
cp "${metadata_stage}/python/PYTHON.json" "${runtime_licenses_root}/PYTHON.json"
cp -a "${metadata_stage}/python/licenses/." "${runtime_licenses_root}/licenses/"

# python-build-standalone 与 CPython 一致，将主许可证放在 lib/pythonX.Y 目录。
python_license=$(find "${runtime_stage}/lib" -maxdepth 2 -type f -iname 'LICENSE*' -print -quit)
if [[ -z "${python_license}" ]]; then
  echo "Python 运行时缺少许可证文件" >&2
  exit 1
fi
cp "${python_license}" "${licenses_root}/Python-LICENSE.txt"

site_packages=$(find "${runtime_stage}/lib" -maxdepth 2 -type d -name site-packages -print -quit)
if [[ -z "${site_packages}" ]]; then
  echo "Python 运行时缺少 site-packages 目录" >&2
  exit 1
fi

# 保留 dist-info 内许可证的原始层级，避免不同包或 vendored 依赖的同名文件互相覆盖。
while IFS= read -r -d '' license_file; do
  relative_path=${license_file#"${site_packages}/"}
  destination="${package_licenses_root}/${relative_path}"
  mkdir -p "$(dirname "${destination}")"
  cp "${license_file}" "${destination}"
done < <(
  find "${site_packages}" -type f \
    \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) \
    -path '*dist-info/*' -print0
)

# pip inspect 记录所有已安装分发包的名称、版本和元数据，便于离线产物许可证审计。
"${runtime_stage}/bin/python3" -m pip inspect --local > "${licenses_root}/python-packages.json"

# 临时目录与最终目录位于同一父目录，移动完成后调用方只会看到完整运行时。
mv "${runtime_stage}" "${runtime_root}"
