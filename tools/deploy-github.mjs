/**
 * 通过 GitHub REST API 把当前仓库发布到 GitHub Pages。
 *
 * 为什么不用 git push？
 *   有些网络环境下 github.com 的 443 端口不通，但 api.github.com 是通的。
 *   这个脚本只走 api.github.com，所以照样能把代码和提交推上去。
 *
 * 关键细节：它用本地 git 索引里已经规范化过行尾的内容来建 tree，
 * 然后把 GitHub 生成的那次提交原样写回本地（并校验 SHA 一致），
 * 所以你之后正常 git push 也不会出现历史分叉。
 *
 * 用法：
 *   node tools/deploy-github.mjs <用户名/仓库名> [--token-file 路径] [--private] [--message "提交说明"]
 *
 * 令牌用 classic token 的 repo 权限即可（创建仓库 + 推文件 + 开启 Pages）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = 'https://api.github.com';

function parseArgs(argv) {
  const args = { repo: null, tokenFile: null, isPrivate: false, message: null, fresh: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token-file') args.tokenFile = argv[++i];
    else if (a === '--private') args.isPrivate = true;
    else if (a === '--message') args.message = argv[++i];
    else if (a === '--fresh') args.fresh = true;
    else rest.push(a);
  }
  args.repo = rest[0] ?? null;
  return args;
}

function git(...cmdArgs) {
  return execFileSync('git', cmdArgs, { maxBuffer: 128 * 1024 * 1024 });
}

function gitText(...cmdArgs) {
  return git(...cmdArgs).toString('utf8').trim();
}

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'mobile-holdem-deploy',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = data?.message ?? text;
    const extra = data?.errors ? ` ${JSON.stringify(data.errors)}` : '';
    const err = new Error(`${method} ${path} → ${res.status} ${detail}${extra}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 限制并发地跑一批异步任务，避免一次发出几十个请求。 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (!args.repo || !args.repo.includes('/')) {
  console.error('用法: node tools/deploy-github.mjs <用户名/仓库名> [--token-file 路径] [--private]');
  process.exit(1);
}

const tokenFile = resolve(args.tokenFile ?? 'gh-token.txt');
let token = '';
try {
  token = readFileSync(tokenFile, 'utf8').trim();
} catch {
  console.error(`读不到令牌文件：${tokenFile}`);
  process.exit(1);
}
if (!token) {
  console.error(`令牌文件是空的：${tokenFile}`);
  process.exit(1);
}

const [owner, repoName] = args.repo.split('/');
const slug = `${owner}/${repoName}`;

const user = await api(token, 'GET', '/user');
console.log(`以 ${user.login} 的身份操作 → ${slug}`);

// --- 1. 仓库不存在就建 ------------------------------------------------

try {
  await api(token, 'GET', `/repos/${slug}`);
  console.log('仓库已存在，直接写内容。');
} catch (err) {
  if (err.status !== 404) throw err;
  const payload = {
    name: repoName,
    private: args.isPrivate,
    description: '手机网页版单机德州扑克：6 人桌、无限注、固定盲注',
    has_wiki: false,
    auto_init: false,
  };
  const path = owner.toLowerCase() === user.login.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`;
  await api(token, 'POST', path, payload);
  console.log(`已创建${args.isPrivate ? '私有' : '公开'}仓库 ${slug}`);
}

// --- 2. 空仓库要先生成一个初始提交 -------------------------------------
// GitHub 的 Git Data API 不允许在完全没有提交的仓库上建 tree，
// 所以先用 Contents API 塞一个占位文件把默认分支撑起来。

let parentSha = null;
try {
  const ref = await api(token, 'GET', `/repos/${slug}/git/ref/heads/main`);
  parentSha = ref.object.sha;
} catch (err) {
  if (err.status !== 404 && err.status !== 409) throw err;
}

if (!parentSha) {
  await api(token, 'PUT', `/repos/${slug}/contents/.git-bootstrap`, {
    message: 'bootstrap',
    content: Buffer.from('bootstrap\n').toString('base64'),
  });
  console.log('仓库是空的，已生成占位提交（稍后会被本次提交顶掉，不会留下痕迹）。');
}

// --- 3. 建 tree -------------------------------------------------------

const localTree = gitText('write-tree');
const listing = gitText('ls-files', '-s').split('\n').filter(Boolean);
if (listing.length === 0) {
  console.error('git 索引是空的，先执行 git add -A。');
  process.exit(1);
}

const files = listing.map((line) => {
  const tab = line.indexOf('\t');
  const [mode, sha] = line.slice(0, tab).split(/\s+/);
  const path = line.slice(tab + 1);
  // 从 git 对象里取内容，而不是读工作区文件 —— 索引里的内容已经做过
  // 行尾规范化（autocrlf），这样 API 算出的 tree SHA 才和本地一致。
  return { path, mode, content: git('cat-file', 'blob', sha).toString('base64') };
});

// GitHub 的 tree 接口不接受内联内容，所以先逐个上传 blob 再组 tree。
const entries = await mapLimit(files, 6, async (file) => {
  const blob = await api(token, 'POST', `/repos/${slug}/git/blobs`, {
    content: file.content,
    encoding: 'base64',
  });
  return { path: file.path, mode: file.mode, type: 'blob', sha: blob.sha };
});

// 注意：这个接口的参数名是 tree（数组），不是 entries
const tree = await api(token, 'POST', `/repos/${slug}/git/trees`, { tree: entries });
console.log(`已上传 ${files.length} 个文件 → tree ${tree.sha.slice(0, 10)}`);
if (tree.sha !== localTree) {
  console.warn(
    `注意：远端 tree（${tree.sha.slice(0, 10)}）和本地 write-tree（${localTree.slice(0, 10)}）不一致，` +
      '稍后本地历史可能会分叉，必要时重新 clone 即可。'
  );
}

// --- 4. 建提交 --------------------------------------------------------

const identity =
  user.name && user.email
    ? { name: user.name, email: user.email }
    : { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const author = { ...identity, date };
const message = args.message ?? '德州扑克：单机 6 人桌无限注，含规则引擎、机器人对手与移动端界面';

const commit = await api(token, 'POST', `/repos/${slug}/git/commits`, {
  message,
  tree: tree.sha,
  // --fresh：忽略已有历史，直接造一个根提交把分支顶掉（测试阶段反复发布会用到）
  parents: parentSha && !args.fresh ? [parentSha] : [],
  author,
  committer: author,
});
console.log(`已创建提交 ${commit.sha.slice(0, 10)}`);

// 分支可能还不存在（新建的空仓库），也可能已经被占位提交撑起来了
try {
  await api(token, 'POST', `/repos/${slug}/git/refs`, {
    ref: 'refs/heads/main',
    sha: commit.sha,
  });
} catch (err) {
  if (err.status !== 422) throw err;
  await api(token, 'PATCH', `/repos/${slug}/git/refs/heads/main`, {
    sha: commit.sha,
    force: true,
  });
}
console.log('分支 main 已更新');

// --- 5. 把这次提交原样写回本地，保持两边一致 --------------------------

function commitObjectText(withTrailingNewline) {
  // 注意：这个接口返回的 tree / parents 都是 { sha, url } 对象，不是字符串
  const shaOf = (v) => (typeof v === 'string' ? v : v.sha);
  const lines = [`tree ${shaOf(commit.tree)}`];
  for (const p of commit.parents) lines.push(`parent ${shaOf(p)}`);
  const seconds = Math.floor(Date.parse(author.date) / 1000);
  const who = (role) => `${role} ${author.name} <${author.email}> ${seconds} +0000`;
  lines.push(who('author'), who('committer'), '', message);
  return lines.join('\n') + (withTrailingNewline ? '\n' : '');
}

let localWritten = false;
for (const trailing of [true, false]) {
  const text = commitObjectText(trailing);
  const sha = execFileSync('git', ['hash-object', '-t', 'commit', '--stdin'], {
    input: text,
  })
    .toString('utf8')
    .trim();
  if (sha === commit.sha) {
    execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], { input: text });
    localWritten = true;
    break;
  }
}

try {
  const hasRemote = gitText('remote').split('\n').includes('origin');
  const url = `https://github.com/${slug}.git`;
  if (hasRemote) git('remote', 'set-url', 'origin', url);
  else git('remote', 'add', 'origin', url);

  if (localWritten) {
    git('update-ref', 'refs/heads/main', commit.sha);
    git('update-ref', 'refs/remotes/origin/main', commit.sha);
    git('symbolic-ref', 'HEAD', 'refs/heads/main');
    git('branch', '--set-upstream-to=origin/main', 'main');
    console.log('本地 main 已对齐到远端提交，git status 现在是干净的。');
  } else {
    console.log('远端提交已创建（本地未对齐，需要时重新 clone 即可）。');
  }
} catch (err) {
  console.warn(`本地 git 收尾时出了问题（不影响线上）：${err.message}`);
}

// --- 6. 开启 Pages ----------------------------------------------------

const pagesBody = { source: { branch: 'main', path: '/' } };
let pages;
try {
  pages = await api(token, 'POST', `/repos/${slug}/pages`, pagesBody);
  console.log('已开启 GitHub Pages（从 main 分支根目录发布）。');
} catch (err) {
  if (err.status !== 409) throw err;
  // 更新接口返回 204 空响应，要再查一次才能拿到地址
  await api(token, 'PUT', `/repos/${slug}/pages`, pagesBody);
  pages = await api(token, 'GET', `/repos/${slug}/pages`);
  console.log('GitHub Pages 已存在，已更新发布源。');
}

const url = pages.html_url ?? `https://${owner}.github.io/${repoName}/`;
console.log(`\n发布地址（首次构建要等 1 到 2 分钟）：\n  ${url}\n`);
