import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

const root = process.cwd();
const files = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);

const errors = [];
const forbiddenPrefixes = ['.superpowers/', 'docs/superpowers/', 'deploy/'];
const forbiddenDocExtensions = new Set(['.docx', '.pdf', '.zip']);

for (const file of files) {
  if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
    errors.push(`${file}: 不应提交 Agent 过程或旧部署目录`);
  }
  if (file.endsWith('.DS_Store')) {
    errors.push(`${file}: 不应提交系统缓存`);
  }
  if (file.startsWith('docs/') && forbiddenDocExtensions.has(extname(file))) {
    errors.push(`${file}: 文档目录不接受不可审阅的二进制文档`);
  }
}

const markdownFiles = files.filter((file) => file.endsWith('.md'));
for (const file of markdownFiles) {
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) {
    errors.push(`${file}: Git 索引中的文档不存在`);
    continue;
  }

  const source = readFileSync(absolute, 'utf8');
  for (const pattern of [
    /\/Users\/[^\s)`"']+/gu,
    /\/private\/tmp\/[^\s)`"']+/gu,
    /root@\d{1,3}(?:\.\d{1,3}){3}/gu,
  ]) {
    if (pattern.test(source)) {
      errors.push(`${file}: 包含本机绝对路径或真实服务器坐标`);
    }
  }

  const targets = [];
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    targets.push(match[1]);
  }
  for (const match of source.matchAll(/<(?:img|a)\s+[^>]*(?:src|href)="([^"]+)"/giu)) {
    targets.push(match[1]);
  }

  for (const rawTarget of targets) {
    const target = normalizeTarget(rawTarget);
    if (!target || isExternalTarget(target)) continue;
    const withoutFragment = target.split('#', 1)[0].split('?', 1)[0];
    if (!withoutFragment) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(withoutFragment);
    } catch {
      errors.push(`${file}: 无法解析链接 ${rawTarget}`);
      continue;
    }

    const linkedPath = resolve(dirname(absolute), decoded);
    if (!existsSync(linkedPath)) {
      errors.push(`${file}: 断链 ${rawTarget}`);
    }
  }
}

if (errors.length > 0) {
  console.error('Documentation checks failed:\n');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Documentation checks passed (${markdownFiles.length} Markdown files).`);

function normalizeTarget(rawTarget) {
  const trimmed = rawTarget.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1);
  }
  return trimmed.split(/\s+["']/u, 1)[0];
}

function isExternalTarget(target) {
  return (
    target.startsWith('#') ||
    target.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/iu.test(target)
  );
}
