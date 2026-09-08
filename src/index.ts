import {
  getInput,
  setFailed,
  startGroup,
  endGroup,
  debug,
} from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { exec } from "@actions/exec";
import { FileSizes } from "./fileSizes";
import type { CompressionMethod } from "./compression";
import {
  getPackageManagerAndInstallScript,
  diffTable,
  toBool,
  stripHash,
  getSortOrder,
  setOutput,
  errorMessage,
} from "./utils";

type Octokit = ReturnType<typeof getOctokit>;
type ActionContext = typeof context;

interface CheckResult {
  conclusion: "success" | "failure" | "neutral";
  output: {
    title: string;
    summary: string;
  };
}

async function run(
  octokit: Octokit,
  context: ActionContext,
  token: string,
): Promise<void> {
  const { number: pull_number } = context.issue;

  try {
    debug("pr" + JSON.stringify(context.payload, null, 2));
  } catch {}

  let baseSha: string | null | undefined;
  let baseRef: string | undefined;
  if (context.eventName == "push") {
    baseSha = context.payload.before;
    baseRef = context.payload.ref;

    console.log(`Pushed new commit on top of ${baseRef} (${baseSha})`);
  } else if (
    context.eventName == "pull_request" ||
    context.eventName == "pull_request_target"
  ) {
    const pr = context.payload.pull_request;
    if (!pr) throw new Error("missing context.payload.pull_request");
    baseSha = pr.base.sha;
    baseRef = pr.base.ref;

    console.log(`PR #${pull_number} is targeted at ${baseRef} (${baseRef})`);
  } else {
    throw new Error(
      `Unsupported eventName in github.context: ${context.eventName}. Only "pull_request", "pull_request_target", and "push" triggered workflows are currently supported.`,
    );
  }

  const inputBaseRef = getInput("base-ref");
  if (inputBaseRef) {
    console.log(`Setting base ref to: "${inputBaseRef}"`);
    baseRef = inputBaseRef;
    // fallback base sha doesn't make sense if given an explicit base ref:
    baseSha = null;
  }

  if (getInput("cwd")) process.chdir(getInput("cwd"));

  const plugin = new FileSizes({
    compression: getInput("compression") as CompressionMethod,
    pattern: getInput("pattern") || "**/dist/**/*.{js,mjs,cjs}",
    exclude: getInput("exclude") || "{**/*.map,**/node_modules/**}",
    stripHash: stripHash(getInput("strip-hash")),
  });

  const buildScript = getInput("build-script") || "build";
  const cwd = process.cwd();

  let { packageManager, installScript } =
    await getPackageManagerAndInstallScript(cwd);
  if (getInput("install-script")) {
    installScript = getInput("install-script");
  }

  startGroup(`[current] Install Dependencies`);
  console.log(`Installing using ${installScript}`);
  await exec(installScript);
  endGroup();

  startGroup(`[current] Build using ${packageManager}`);
  console.log(`Building using ${packageManager} run ${buildScript}`);
  await exec(`${packageManager} run ${buildScript}`);
  endGroup();

  const newSizes = await plugin.readFromDisk(cwd);

  // In case the build step alters a JSON-file, ....
  await exec(`git reset --hard`);

  startGroup(`[base] Checkout target branch`);
  try {
    if (!baseRef) throw Error("missing context.payload.pull_request.base.ref");
    await exec(`git fetch -n origin ${baseRef}:${baseRef}`);
    console.log("successfully fetched base.ref");
  } catch (e) {
    console.log("fetching base.ref failed", errorMessage(e));
    if (baseSha === null) {
      throw new Error("base.ref fetch failed and no base.sha as fallback");
    } else {
      try {
        await exec(`git fetch -n origin ${baseSha}`);
        console.log("successfully fetched base.sha");
      } catch (e) {
        console.log("fetching base.sha failed", errorMessage(e));
        try {
          await exec(`git fetch -n`);
        } catch (e) {
          console.log("fetch failed", errorMessage(e));
        }
      }
    }
  }

  const cleanScript = getInput("clean-script");
  if (cleanScript) {
    startGroup(`[target] Cleanup via ${packageManager} run ${cleanScript}`);
    await exec(`${packageManager} run ${cleanScript}`);
    endGroup();
  }

  console.log("checking out and building base commit");
  try {
    if (!baseRef) throw Error("missing context.payload.base.ref");
    await exec(`git reset --hard ${baseRef}`);
  } catch (e) {
    if (!baseSha) throw e;
    await exec(`git reset --hard ${baseSha}`);
  }
  endGroup();

  startGroup(`[base] Install Dependencies`);

  ({ packageManager, installScript } =
    await getPackageManagerAndInstallScript(cwd));
  if (getInput("install-script")) {
    installScript = getInput("install-script");
  }

  console.log(`Installing using ${installScript}`);
  await exec(installScript);
  endGroup();

  startGroup(`[base] Build using ${packageManager}`);
  await exec(`${packageManager} run ${buildScript}`);
  endGroup();

  // In case the build step alters a JSON-file, ....
  await exec(`git reset --hard`);

  const oldSizes = await plugin.readFromDisk(cwd);

  const diff = plugin.getDiff(oldSizes, newSizes);

  startGroup(`Size Differences:`);
  const cliText = plugin.printSizes(diff);
  console.log(cliText);
  endGroup();

  const markdownDiff = diffTable(diff, {
    collapseUnchanged: toBool(getInput("collapse-unchanged")),
    omitUnchanged: toBool(getInput("omit-unchanged")),
    showTotal: toBool(getInput("show-total")),
    minimumChangeThreshold: parseInt(getInput("minimum-change-threshold"), 10),
    sortBy: getSortOrder(getInput("sort-by")),
  });

  let outputRawMarkdown = false;

  const commentInfo = {
    ...context.repo,
    issue_number: pull_number,
  };

  const commentKey = getInput("comment-key");

  const comment = {
    ...commentInfo,
    body:
      markdownDiff +
      `\n\n<a href="https://github.com/preactjs/compressed-size-action"><sub>compressed-size-action${commentKey ? `::${commentKey}` : ""}</sub></a>`,
  };

  setOutput("comment-body", comment.body);

  if (
    context.eventName !== "pull_request" &&
    context.eventName !== "pull_request_target"
  ) {
    console.log(
      "No PR associated with this action run. Not posting a check or comment.",
    );
    outputRawMarkdown = false;
  } else if (toBool(getInput("use-check"))) {
    if (token) {
      const finish = await createCheck(octokit, context);
      await finish({
        conclusion: "success",
        output: {
          title: `Compressed Size Action`,
          summary: markdownDiff,
        },
      });
    } else {
      outputRawMarkdown = true;
    }
  } else {
    startGroup(`Updating stats PR comment`);
    let commentId: number | undefined;
    try {
      const comments = (await octokit.rest.issues.listComments(commentInfo))
        .data;
      const commentRegExp = new RegExp(
        `<sub>\\s*(compressed|gzip)-size-action${commentKey ? `::${commentKey}` : ""}</sub>`,
      );
      for (let i = comments.length; i--; ) {
        const c = comments[i];
        if (c.body && commentRegExp.test(c.body)) {
          commentId = c.id;
          break;
        }
      }
    } catch (e) {
      console.log("Error checking for previous comments: " + errorMessage(e));
    }

    if (commentId) {
      console.log(`Updating previous comment #${commentId}`);
      try {
        await octokit.rest.issues.updateComment({
          ...context.repo,
          comment_id: commentId,
          body: comment.body,
        });
      } catch (e) {
        console.log("Error editing previous comment: " + errorMessage(e));
        commentId = undefined;
      }
    }

    // no previous or edit failed
    if (!commentId) {
      console.log("Creating new comment");
      try {
        await octokit.rest.issues.createComment(comment);
      } catch (e) {
        console.log(`Error creating comment: ${errorMessage(e)}`);
        console.log(`Submitting a PR review comment instead...`);
        try {
          const issue = context.issue;
          await octokit.rest.pulls.createReview({
            owner: issue.owner,
            repo: issue.repo,
            pull_number: issue.number,
            event: "COMMENT",
            body: comment.body,
          });
        } catch (e) {
          console.log(`Error creating PR review: ${errorMessage(e)}`);
          outputRawMarkdown = true;
        }
      }
    }
    endGroup();
  }

  if (outputRawMarkdown) {
    console.log(
      `
			Error: compressed-size-action was unable to comment on your PR.
			This can happen for PR's originating from a fork without write permissions.
			You can copy the size table directly into a comment using the markdown below:
			\n\n${comment.body}\n\n
		`.replace(/^(\t|  )+/gm, ""),
    );
  }

  console.log("All done!");
}

/**
 * Create a check and return a function that updates (completes) it
 */
async function createCheck(octokit: Octokit, context: ActionContext) {
  const check = await octokit.rest.checks.create({
    ...context.repo,
    name: "Compressed Size",
    head_sha: context.payload.pull_request?.head.sha,
    status: "in_progress",
  });

  return async (details: CheckResult): Promise<void> => {
    await octokit.rest.checks.update({
      ...context.repo,
      check_run_id: check.data.id,
      completed_at: new Date().toISOString(),
      status: "completed",
      ...details,
    });
  };
}

(async () => {
  try {
    const token = getInput("repo-token");
    const octokit = getOctokit(token);
    await run(octokit, context, token);
  } catch (e) {
    setFailed(errorMessage(e));
  }
})();
