import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

export type GitDirty = {
  staged: number;
  unstaged: number;
  untracked: number;
};

export type GitPr = {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  title: string;
  mergeable: string | null;
} | null;

export type GitStatus = {
  ok: true;
  cwd: string;
  toplevel: string;
  repo: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: GitDirty;
  pr: GitPr;
  ghAvailable: boolean;
};

export type GitStatusError = {
  ok: false;
  cwd: string;
  error: string;
};

async function safeRun(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 5000,
): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function getGitStatus(
  cwd: string,
): Promise<GitStatus | GitStatusError> {
  const toplevelOut = await safeRun(
    "git",
    ["rev-parse", "--show-toplevel"],
    cwd,
  );
  if (!toplevelOut) {
    return { ok: false, cwd, error: "not a git repo" };
  }
  const toplevel = toplevelOut.trim();

  // Prefer the origin remote's repo name (handles worktrees, where the
  // toplevel dir is e.g. "compassionate-kalam-9ac724" not "slack-claude-bridge").
  let repo = path.basename(toplevel);
  const originUrl = await safeRun(
    "git",
    ["config", "--get", "remote.origin.url"],
    toplevel,
    2000,
  );
  if (originUrl) {
    const m = originUrl.trim().match(/[\/:]([^\/:]+?)(?:\.git)?$/);
    if (m && m[1]) repo = m[1];
  }

  const branchOut = await safeRun(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    toplevel,
  );
  const branch = branchOut ? branchOut.trim() : null;
  const detached = !branch;

  const upstreamOut = await safeRun(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    toplevel,
  );
  const upstream = upstreamOut ? upstreamOut.trim() : null;

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const aheadBehind = await safeRun(
      "git",
      ["rev-list", "--left-right", "--count", `${upstream}...HEAD`],
      toplevel,
    );
    if (aheadBehind) {
      const parts = aheadBehind.trim().split(/\s+/);
      behind = Number(parts[0]) || 0;
      ahead = Number(parts[1]) || 0;
    }
  }

  // Dirty state via porcelain v1: each line "XY path", "??" = untracked.
  const dirty: GitDirty = { staged: 0, unstaged: 0, untracked: 0 };
  const porcelain = await safeRun(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    toplevel,
  );
  if (porcelain) {
    const lines = porcelain.split("\n").filter((l) => l.length >= 2);
    for (const line of lines) {
      const xy = line.slice(0, 2);
      if (xy === "??") {
        dirty.untracked++;
        continue;
      }
      if (xy[0] !== " " && xy[0] !== "?") dirty.staged++;
      if (xy[1] !== " " && xy[1] !== "?") dirty.unstaged++;
    }
  }

  let pr: GitPr = null;
  let ghAvailable = false;
  const ghVer = await safeRun("gh", ["--version"], toplevel, 2000);
  if (ghVer) {
    ghAvailable = true;
    if (branch) {
      const prJson = await safeRun(
        "gh",
        [
          "pr",
          "view",
          "--json",
          "number,url,state,isDraft,title,mergeable",
        ],
        toplevel,
        4000,
      );
      if (prJson) {
        try {
          const parsed = JSON.parse(prJson);
          pr = {
            number: parsed.number,
            url: parsed.url,
            state: parsed.state,
            isDraft: !!parsed.isDraft,
            title: parsed.title || "",
            mergeable: parsed.mergeable ?? null,
          };
        } catch {}
      }
    }
  }

  return {
    ok: true,
    cwd,
    toplevel,
    repo,
    branch,
    detached,
    upstream,
    ahead,
    behind,
    dirty,
    pr,
    ghAvailable,
  };
}

export type GitDiff = {
  ok: true;
  cwd: string;
  toplevel: string;
  diff: string;
  diffTruncated: boolean;
  commitsAhead: { sha: string; subject: string }[];
};

export async function getGitDiff(
  cwd: string,
  maxDiffBytes = 200 * 1024,
): Promise<GitDiff | GitStatusError> {
  const toplevelOut = await safeRun(
    "git",
    ["rev-parse", "--show-toplevel"],
    cwd,
  );
  if (!toplevelOut) {
    return { ok: false, cwd, error: "not a git repo" };
  }
  const toplevel = toplevelOut.trim();

  const stagedDiff =
    (await safeRun("git", ["diff", "--cached"], toplevel, 8000)) || "";
  const unstagedDiff =
    (await safeRun("git", ["diff"], toplevel, 8000)) || "";

  // Untracked files: synthesize a /dev/null-vs-file diff for each, capped
  // at 20 files. Uses --no-index which exits 1 on diff present, so safeRun
  // returning null is fine; we just stitch what works.
  let untrackedDiff = "";
  const untrackedList = await safeRun(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    toplevel,
    3000,
  );
  if (untrackedList) {
    const files = untrackedList.split("\n").filter(Boolean).slice(0, 20);
    for (const f of files) {
      const piece = await safeRun(
        "git",
        ["diff", "--no-index", "--", "/dev/null", f],
        toplevel,
        3000,
      );
      if (piece) untrackedDiff += piece;
    }
  }

  let diff = "";
  if (stagedDiff) diff += "# Staged\n" + stagedDiff + "\n";
  if (unstagedDiff) diff += "# Unstaged\n" + unstagedDiff + "\n";
  if (untrackedDiff) diff += "# Untracked\n" + untrackedDiff + "\n";

  let diffTruncated = false;
  if (diff.length > maxDiffBytes) {
    diff = diff.slice(0, maxDiffBytes);
    diffTruncated = true;
  }

  const upstreamOut = await safeRun(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    toplevel,
  );
  const range = upstreamOut ? `${upstreamOut.trim()}..HEAD` : "HEAD";
  const logOut =
    (await safeRun(
      "git",
      ["log", range, "--oneline", "-n", "20"],
      toplevel,
      4000,
    )) || "";
  const commitsAhead = logOut
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sp = line.indexOf(" ");
      return sp === -1
        ? { sha: line, subject: "" }
        : { sha: line.slice(0, sp), subject: line.slice(sp + 1) };
    });

  return {
    ok: true,
    cwd,
    toplevel,
    diff,
    diffTruncated,
    commitsAhead,
  };
}
