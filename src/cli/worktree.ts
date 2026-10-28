import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { GitInfo } from '../store.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

export function repoRoot(dir: string): string {
  return realpathSync(git(dir, 'rev-parse', '--show-toplevel'));
}

/** Snapshot of the git state a tree is at. Undefined outside a repository. */
export function captureGitInfo(dir: string): GitInfo | undefined {
  try {
    const commit = git(dir, 'rev-parse', 'HEAD');
    const ref = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    const dirty = git(dir, 'status', '--porcelain').length > 0;
    return { commit, branch: ref === 'HEAD' ? null : ref, dirty };
  } catch {
    return undefined;
  }
}

/** The commit a revision names, and its branch when the revision is a branch. */
export function resolveRef(repoDir: string, ref: string): GitInfo {
  let commit: string;
  try {
    commit = git(repoDir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    throw new Error(`Unknown git revision "${ref}"`);
  }
  const full = git(repoDir, 'rev-parse', '--symbolic-full-name', ref);
  const branch = full.replace(/^refs\/(heads|remotes)\//, '');
  return { commit, branch: branch && branch !== full ? branch : null, dirty: false };
}

export interface Checkout {
  /** Root of the tree. */
  dir: string;
  git: GitInfo;
  /** Releases whatever opening the tree created. Safe to call more than once. */
  dispose(): void;
}

/**
 * Links every node_modules between the repository root and `depDir` from the
 * working checkout into `dir` where the tree has none, so both trees resolve
 * the same packages. Returns a function removing the links it made.
 */
function linkModules(root: string, dir: string, depDir: string): () => void {
  const links: string[] = [];
  for (let current = realpathSync(depDir); current.startsWith(root); current = dirname(current)) {
    const modules = join(current, 'node_modules');
    const link = join(dir, relative(root, current), 'node_modules');
    if (existsSync(modules) && !existsSync(link)) {
      symlinkSync(modules, link, 'dir');
      links.push(link);
    }
    if (current === root) break;
  }
  return () => {
    for (const link of links.splice(0)) rmSync(link, { force: true });
  };
}

/**
 * Detached checkout of a revision in a temporary worktree. Dependencies are
 * not installed there, they are linked from the working checkout so only the
 * code under test differs.
 */
export function checkoutRef(repoDir: string, ref: string, depDir: string): Checkout {
  const root = repoRoot(repoDir);
  const info = resolveRef(root, ref);
  const dir = mkdtempSync(join(tmpdir(), 'labs-worktree-'));
  git(root, 'worktree', 'add', '--detach', '--quiet', dir, info.commit);
  linkModules(root, dir, depDir);

  return {
    dir,
    git: info,
    dispose() {
      try {
        git(root, 'worktree', 'remove', '--force', dir);
      } catch {
        rmSync(dir, { recursive: true, force: true });
        try {
          git(root, 'worktree', 'prune');
        } catch {}
      }
    },
  };
}

/**
 * An existing checkout of the repository, such as a worktree another tool
 * created. Dependencies it already has are used as they are, missing ones are
 * linked from the working checkout for the run and unlinked afterwards.
 */
export function useTree(repoDir: string, dir: string, depDir: string): Checkout {
  const root = repoRoot(repoDir);
  const tree = realpathSync(dir);
  const info = captureGitInfo(tree);
  if (!info) throw new Error(`"${dir}" is not a git checkout`);
  return { dir: tree, git: info, dispose: linkModules(root, tree, depDir) };
}

/**
 * A side of a run named on the command line. An existing directory is used as
 * a tree, anything else is a git revision checked out into a temporary
 * worktree.
 */
export function openSide(repoDir: string, spec: string, depDir: string): Checkout {
  if (existsSync(spec) && statSync(spec).isDirectory()) return useTree(repoDir, spec, depDir);
  return checkoutRef(repoDir, spec, depDir);
}
