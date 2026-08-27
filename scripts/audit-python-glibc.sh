#!/usr/bin/env bash
set -euo pipefail

# 参数 1：需要审计的 Python 运行时根目录。
# 参数 2：允许的最高 GLIBC 版本，例如 2.31。
if [[ $# -ne 2 ]]; then
  echo "用法: $0 <Python 运行时目录> <最高 GLIBC 版本>" >&2
  exit 2
fi

runtime_root=$1
maximum_glibc_version=$2

if [[ ! -d "${runtime_root}" ]]; then
  echo "Python 运行时目录不存在: ${runtime_root}" >&2
  exit 1
fi
if [[ ! "${maximum_glibc_version}" =~ ^[0-9]+\.[0-9]+$ ]]; then
  echo "无效的 GLIBC 版本: ${maximum_glibc_version}" >&2
  exit 2
fi
for required_command in file readelf; do
  if ! command -v "${required_command}" > /dev/null; then
    echo "缺少 ELF 审计命令: ${required_command}" >&2
    exit 1
  fi
done

elf_count=0
highest_glibc_version=0
while IFS= read -r -d '' runtime_file; do
  if [[ $(file -b "${runtime_file}") != *ELF* ]]; then
    continue
  fi
  elf_count=$((elf_count + 1))

  # readelf 的 version info 同时覆盖程序和共享库实际声明的 GLIBC 符号依赖。
  glibc_versions=$(
    readelf --version-info "${runtime_file}" 2> /dev/null \
      | grep -Eo 'GLIBC_[0-9]+\.[0-9]+(\.[0-9]+)?' \
      | sed 's/^GLIBC_//' \
      | sort -Vu \
      || true
  )
  while IFS= read -r glibc_version; do
    if [[ -z "${glibc_version}" ]]; then
      continue
    fi
    if [[ $(printf '%s\n%s\n' "${highest_glibc_version}" "${glibc_version}" | sort -V | tail -1) == "${glibc_version}" ]]; then
      highest_glibc_version=${glibc_version}
    fi
    if [[ "${glibc_version}" != "${maximum_glibc_version}" \
      && $(printf '%s\n%s\n' "${maximum_glibc_version}" "${glibc_version}" | sort -V | tail -1) == "${glibc_version}" ]]; then
      echo "${runtime_file} 依赖 GLIBC_${glibc_version}，高于允许的 ${maximum_glibc_version}" >&2
      exit 1
    fi
  done <<< "${glibc_versions}"
done < <(find "${runtime_root}" -type f -print0)

if [[ ${elf_count} -eq 0 ]]; then
  echo "Python 运行时中未找到 ELF 文件: ${runtime_root}" >&2
  exit 1
fi

echo "已审计 ${elf_count} 个 ELF 文件，最高 GLIBC 符号版本: ${highest_glibc_version}"
