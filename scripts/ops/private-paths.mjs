import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, basename, isAbsolute, join, relative, sep, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
function inside(root, target) {
  const suffix = relative(root.toLowerCase(), target.toLowerCase());
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep));
}
export async function admitPrivatePath(candidate, { repositoryRoot = process.cwd(), allowIgnoredLocal = false, mustExist = false } = {}) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) throw new Error('Private output requires an absolute path.');
  const repository = await realpath(repositoryRoot), lexical = resolve(candidate), parent = await realpath(dirname(lexical));
  const canonical = join(parent, basename(lexical));
  let stat;
  try { stat = await lstat(lexical); } catch (error) { if (error.code !== 'ENOENT' || mustExist) throw error; }
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error('Private file must be a regular unlinked file.');
  if (stat && (await realpath(lexical)).toLowerCase() !== canonical.toLowerCase()) throw new Error('Private file cannot redirect through a symlink.');
  if (inside(repository, lexical) || inside(repository, canonical)) {
    if (!allowIgnoredLocal || basename(lexical) !== '.env.local' || canonical.toLowerCase() !== join(repository, '.env.local').toLowerCase()) throw new Error('Private file must remain outside Git.');
    try { await exec('git', ['ls-files', '--error-unmatch', '--', '.env.local'], { cwd: repository }); throw new Error('ENV_TRACKED'); }
    catch (error) { if (error.message === 'ENV_TRACKED' || error.code !== 1) throw new Error('Local environment cannot be tracked.'); }
    await exec('git', ['check-ignore', '--quiet', '--', '.env.local'], { cwd: repository });
  }
  return canonical;
}
export async function writeExclusivePrivateJson(candidate, value, options = {}) {
  const target = await admitPrivatePath(candidate, options);
  const file = await open(target, 'wx', 0o600);
  try { await admitPrivatePath(target, { ...options, mustExist: true }); await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  return target;
}
export async function withPrivateFile(candidate, action, options = {}) {
  const target = await admitPrivatePath(candidate, { ...options, mustExist: true });
  const file = await open(target, 'r+');
  try {
    const pinned = await file.stat(), current = await lstat(target);
    if (pinned.nlink !== 1 || pinned.dev !== current.dev || pinned.ino !== current.ino) throw new Error('Private file changed during admission.');
    await admitPrivatePath(target, { ...options, mustExist: true });
    return await action(file, target);
  } finally { await file.close(); }
}
export async function replacePinnedContents(file, text) {
  const bytes = Buffer.from(text); await file.write(bytes, 0, bytes.length, 0); await file.truncate(bytes.length); await file.sync();
}
export async function verifyLinkedProject(repositoryRoot, expected) {
  const root = await realpath(repositoryRoot), folder = join(root, '.vercel'), target = join(folder, 'project.json');
  const dir = await lstat(folder), file = await lstat(target);
  if (!dir.isDirectory() || dir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || !inside(root, await realpath(target))) throw new Error('Vercel link must be a regular local project file.');
  const handle = await open(target, 'r');
  try {
    const context = JSON.parse(await handle.readFile('utf8'));
    if (context.projectId !== expected.projectId || context.orgId !== expected.orgId || (context.projectName ?? context.name) !== expected.name || (context.name !== undefined && context.name !== expected.name)) throw new Error('Vercel project/team/name mismatch.');
    return root;
  } finally { await handle.close(); }
}
