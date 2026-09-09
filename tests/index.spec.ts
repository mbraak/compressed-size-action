/**
 * Tests for the action entry point (src/index.ts).
 *
 * The module runs its `run()` function on import, so every test resets the
 * module registry, configures the mocked inputs/context, imports the module
 * fresh and waits for it to either log "All done!" or call `setFailed`.
 */

import type { FileSizeMap } from '../src/fileSizes';

type MockOctokit = ReturnType<typeof makeOctokit>;

const mocks = vi.hoisted(() => ({
	inputs: {} as Record<string, string>,
	context: {} as Record<string, any>,
	/** Sizes returned by successive `readFromDisk` calls: first the PR build, then the base build. */
	sizes: [] as FileSizeMap[],
	/** Same, for the extra gzip instance created when the compression input is `none`. */
	gzipSizes: [] as FileSizeMap[],
	/** Commands that should throw when passed to `exec`. */
	execFailures: {} as Record<string, Error>,
	execCalls: [] as string[],
	/** `pattern` of every FileSizes instance that read from disk, in call order. */
	readPatterns: [] as string[],
	state: { done: false, failure: null as string | null },
	octokit: null as MockOctokit | null
}));

vi.mock('@actions/core', () => ({
	getInput: vi.fn((name: string) => mocks.inputs[name] ?? ''),
	setFailed: vi.fn((message: string) => {
		mocks.state.failure = message;
		mocks.state.done = true;
	}),
	startGroup: vi.fn(),
	endGroup: vi.fn(),
	debug: vi.fn()
}));

vi.mock('@actions/github', () => ({
	context: mocks.context,
	getOctokit: vi.fn(() => mocks.octokit)
}));

vi.mock('@actions/exec', () => ({
	exec: vi.fn(async (command: string) => {
		mocks.execCalls.push(command);
		const failure = mocks.execFailures[command];
		if (failure) throw failure;
		return 0;
	})
}));

vi.mock('../src/fileSizes', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/fileSizes')>();
	class FileSizes extends actual.FileSizes {
		override readFromDisk = async (): Promise<FileSizeMap> => {
			mocks.readPatterns.push(this.options.pattern);
			const isGzipCompanion = mocks.inputs.compression === 'none' && this.options.compression === 'gzip';
			const sizes = (isGzipCompanion ? mocks.gzipSizes : mocks.sizes).shift() ?? {};
			const result: FileSizeMap = {};
			for (const [file, size] of Object.entries(sizes)) {
				result[this.options.stripHash(file)] = size;
			}
			return result;
		};
	}
	return { ...actual, FileSizes };
});

const DEFAULT_INPUTS = {
	'repo-token': 'secret-token',
	'build-script': 'build',
	compression: 'gzip',
	'show-total': 'true',
	'collapse-unchanged': 'true',
	'minimum-change-threshold': '1',
	'sort-by': 'Filename:asc'
};

const NEW_SIZES: FileSizeMap = { 'dist/index.js': 1500, 'dist/added.js': 100 };
const OLD_SIZES: FileSizeMap = { 'dist/index.js': 1000, 'dist/removed.js': 200 };

const FOOTER_REGEXP = /<a href="https:\/\/github\.com\/preactjs\/compressed-size-action"><sub>compressed-size-action(::[^<]+)?<\/sub><\/a>$/;

/**
 * Mirrors the shape of the client returned by `getOctokit` in @actions/github v5+,
 * where REST endpoint methods live under the `rest` namespace.
 */
interface ExistingComment {
	id: number;
	body: string;
}

interface CommentBody {
	body: string;
	[key: string]: unknown;
}

function makeOctokit() {
	return {
		rest: {
			issues: {
				listComments: vi.fn(async (_params: unknown): Promise<{ data: ExistingComment[] }> => ({ data: [] })),
				updateComment: vi.fn(async (_params: CommentBody & { comment_id: number }) => ({})),
				createComment: vi.fn(async (_params: CommentBody) => ({}))
			},
			pulls: {
				createReview: vi.fn(async (_params: CommentBody) => ({}))
			},
			checks: {
				create: vi.fn(async (_params: unknown) => ({ data: { id: 42 } })),
				update: vi.fn(async (_params: Record<string, unknown>) => ({}))
			}
		}
	};
}

const REPO = { owner: 'preactjs', repo: 'compressed-size-action' };

function pullRequestContext(overrides: Record<string, unknown> = {}) {
	return {
		eventName: 'pull_request',
		repo: REPO,
		issue: { ...REPO, number: 123 },
		payload: {
			pull_request: {
				number: 123,
				base: { sha: 'base-sha', ref: 'main' },
				head: { sha: 'head-sha' }
			}
		},
		...overrides
	};
}

function pushContext() {
	return {
		eventName: 'push',
		repo: REPO,
		issue: { ...REPO, number: undefined },
		payload: { before: 'before-sha', ref: 'refs/heads/main' }
	};
}

let logs: string[];

beforeEach(() => {
	logs = [];
	vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		const line = args.map(String).join(' ');
		logs.push(line);
		if (line === 'All done!') mocks.state.done = true;
	});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	delete process.env.GITHUB_OUTPUT;
});

afterEach(() => {
	vi.restoreAllMocks();
});

interface RunOptions {
	inputs?: Record<string, string>;
	context?: Record<string, any>;
	sizes?: FileSizeMap[];
	gzipSizes?: FileSizeMap[];
	execFailures?: Record<string, Error>;
	octokit?: MockOctokit;
}

async function runAction({
	inputs = {},
	context = pullRequestContext(),
	sizes = [NEW_SIZES, OLD_SIZES],
	gzipSizes = [],
	execFailures = {},
	octokit = makeOctokit()
}: RunOptions = {}) {
	for (const key of Object.keys(mocks.inputs)) delete mocks.inputs[key];
	Object.assign(mocks.inputs, DEFAULT_INPUTS, inputs);

	for (const key of Object.keys(mocks.context)) delete mocks.context[key];
	Object.assign(mocks.context, context);

	mocks.sizes.length = 0;
	mocks.sizes.push(...sizes.map((s) => ({ ...s })));
	mocks.gzipSizes.length = 0;
	mocks.gzipSizes.push(...gzipSizes.map((s) => ({ ...s })));

	for (const key of Object.keys(mocks.execFailures)) delete mocks.execFailures[key];
	Object.assign(mocks.execFailures, execFailures);

	mocks.execCalls.length = 0;
	mocks.readPatterns.length = 0;
	mocks.state.done = false;
	mocks.state.failure = null;
	mocks.octokit = octokit;

	vi.resetModules();
	await import('../src/index');
	await vi.waitFor(() => {
		if (!mocks.state.done) throw new Error('action has not finished yet');
	});

	return {
		failure: mocks.state.failure,
		execCalls: [...mocks.execCalls],
		readPatterns: [...mocks.readPatterns],
		octokit,
		logs
	};
}

describe('src/index.ts', () => {
	test('builds both branches and posts a new PR comment', async () => {
		const { failure, execCalls, octokit } = await runAction();

		expect(failure).toBeNull();
		expect(execCalls).toEqual([
			'npm ci',
			'npm run build',
			'git reset --hard',
			'git fetch -n origin main:main',
			'git reset --hard main',
			'npm ci',
			'npm run build',
			'git reset --hard'
		]);

		expect(octokit.rest.issues.listComments).toHaveBeenCalledWith({ ...REPO, issue_number: 123 });
		expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
		expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);

		const { body, ...target } = octokit.rest.issues.createComment.mock.calls[0][0];
		expect(target).toEqual({ ...REPO, issue_number: 123 });
		expect(body).toMatch(FOOTER_REGEXP);
		expect(body).toContain('**Size Change:** +400 B (+33.33%) 🚨');
		expect(body).toContain('**Total Size:** 1.6 kB');
		expect(body).toContain('| `dist/index.js` | 1.5 kB | +500 B (+50%) | 🆘 |');
		expect(body).toContain('| `dist/added.js` | 100 B | +100 B (new file) | 🆕 |');
		expect(body).toContain('| `dist/removed.js` | 0 B | -200 B (removed) | 🏆 |');
		expect(body).toMatchSnapshot();
	});

	test('writes the comment body to the comment-body output', async () => {
		const { logs, octokit } = await runAction();

		const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
		const expected = `::set-output name=comment-body::${body.replace(/\n/g, '%0A')}`;
		expect(logs).toContain(expected);
	});

	test('updates an existing comment from a previous run', async () => {
		const octokit = makeOctokit();
		octokit.rest.issues.listComments.mockResolvedValue({
			data: [
				{ id: 1, body: 'Unrelated comment' },
				{ id: 2, body: 'Old report\n\n<a href="..."><sub>compressed-size-action</sub></a>' },
				{ id: 3, body: 'Keyed report\n\n<a href="..."><sub>compressed-size-action::other</sub></a>' }
			]
		});

		const result = await runAction({ octokit });

		expect(result.failure).toBeNull();
		expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
		expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
		expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
			...REPO,
			comment_id: 2,
			body: expect.stringMatching(FOOTER_REGEXP)
		});
	});

	test('recognises comments from the legacy gzip-size-action footer', async () => {
		const octokit = makeOctokit();
		octokit.rest.issues.listComments.mockResolvedValue({
			data: [{ id: 7, body: '<sub>gzip-size-action</sub>' }]
		});

		await runAction({ octokit });

		expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
			expect.objectContaining({ comment_id: 7 })
		);
	});

	test('matches a previous comment with whitespace inside the footer', async () => {
		const octokit = makeOctokit();
		octokit.rest.issues.listComments.mockResolvedValue({
			data: [{ id: 9, body: 'Report\n\n<a href="..."><sub>\n  compressed-size-action</sub></a>' }]
		});

		await runAction({ octokit });

		expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
		expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
			expect.objectContaining({ comment_id: 9 })
		);
	});

	test('scopes the footer and comment lookup by comment-key', async () => {
		const octokit = makeOctokit();
		octokit.rest.issues.listComments.mockResolvedValue({
			data: [
				{ id: 2, body: '<sub>compressed-size-action</sub>' },
				{ id: 3, body: '<sub>compressed-size-action::client</sub>' }
			]
		});

		await runAction({ octokit, inputs: { 'comment-key': 'client' } });

		expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
		const { comment_id, body } = octokit.rest.issues.updateComment.mock.calls[0][0];
		expect(comment_id).toBe(3);
		expect(body).toMatch(/<sub>compressed-size-action::client<\/sub><\/a>$/);
	});

	test('creates a new comment when editing the previous one fails', async () => {
		const octokit = makeOctokit();
		octokit.rest.issues.listComments.mockResolvedValue({
			data: [{ id: 2, body: '<sub>compressed-size-action</sub>' }]
		});
		octokit.rest.issues.updateComment.mockRejectedValue(new Error('nope'));

		const { failure, logs } = await runAction({ octokit });

		expect(failure).toBeNull();
		expect(logs).toContain('Error editing previous comment: nope');
		expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
	});

	test('still succeeds when listing comments fails', async () => {
		const octokit = makeOctokit();
		octokit.rest.issues.listComments.mockRejectedValue(new Error('forbidden'));

		const { failure, logs } = await runAction({ octokit });

		expect(failure).toBeNull();
		expect(logs).toContain('Error checking for previous comments: forbidden');
		expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
	});

	test('falls back to a PR review when commenting fails', async () => {
		const octokit = makeOctokit();
		octokit.rest.issues.createComment.mockRejectedValue(new Error('Resource not accessible'));

		const { failure, logs } = await runAction({ octokit });

		expect(failure).toBeNull();
		expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith({
			...REPO,
			pull_number: 123,
			event: 'COMMENT',
			body: expect.stringMatching(FOOTER_REGEXP)
		});
		expect(logs.some((l) => l.includes('unable to comment on your PR'))).toBe(false);
	});

	test('prints the raw markdown when both commenting and reviewing fail', async () => {
		const octokit = makeOctokit();
		octokit.rest.issues.createComment.mockRejectedValue(new Error('Resource not accessible by integration'));
		octokit.rest.pulls.createReview.mockRejectedValue(new Error('Must have admin rights to Repository.'));

		const { failure, logs } = await runAction({ octokit });

		expect(failure).toBeNull();
		expect(logs).toContain('Error creating comment: Resource not accessible by integration');
		expect(logs).toContain('Error creating PR review: Must have admin rights to Repository.');
		const raw = logs.find((l) => l.includes('unable to comment on your PR'));
		expect(raw).toBeDefined();
		expect(raw).toContain('**Size Change:**');
		expect(raw).toMatch(/<sub>compressed-size-action<\/sub><\/a>/);
	});

	test('supports pull_request_target events', async () => {
		const { failure, octokit } = await runAction({
			context: pullRequestContext({ eventName: 'pull_request_target' })
		});

		expect(failure).toBeNull();
		expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
	});

	test('reports through a check run when use-check is enabled', async () => {
		const { failure, octokit } = await runAction({ inputs: { 'use-check': 'true' } });

		expect(failure).toBeNull();
		expect(octokit.rest.checks.create).toHaveBeenCalledWith({
			...REPO,
			name: 'Compressed Size',
			head_sha: 'head-sha',
			status: 'in_progress'
		});
		expect(octokit.rest.checks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				...REPO,
				check_run_id: 42,
				status: 'completed',
				conclusion: 'success',
				output: {
					title: 'Compressed Size Action',
					summary: expect.stringContaining('**Size Change:**')
				}
			})
		);
		expect(octokit.rest.checks.update.mock.calls[0][0].completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
	});

	test('prints raw markdown when use-check is enabled without a token', async () => {
		const { failure, octokit, logs } = await runAction({
			inputs: { 'use-check': 'true', 'repo-token': '' }
		});

		expect(failure).toBeNull();
		expect(octokit.rest.checks.create).not.toHaveBeenCalled();
		expect(logs.some((l) => l.includes('unable to comment on your PR'))).toBe(true);
	});

	test('compares against the previous commit on push events without commenting', async () => {
		const { failure, execCalls, octokit, logs } = await runAction({ context: pushContext() });

		expect(failure).toBeNull();
		expect(logs).toContain('Pushed new commit on top of refs/heads/main (before-sha)');
		expect(execCalls).toContain('git fetch -n origin refs/heads/main:refs/heads/main');
		expect(execCalls).toContain('git reset --hard refs/heads/main');
		expect(logs).toContain('No PR associated with this action run. Not posting a check or comment.');
		expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
		expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
		expect(octokit.rest.checks.create).not.toHaveBeenCalled();
	});

	test('fails on unsupported events', async () => {
		const { failure, execCalls } = await runAction({
			context: { eventName: 'schedule', repo: REPO, issue: { ...REPO }, payload: {} }
		});

		expect(failure).toMatch(/Unsupported eventName in github\.context: schedule/);
		expect(execCalls).toEqual([]);
	});

	test('falls back to the base sha when fetching the base ref fails', async () => {
		const { failure, execCalls, logs } = await runAction({
			execFailures: { 'git fetch -n origin main:main': new Error('ref not found') }
		});

		expect(failure).toBeNull();
		expect(logs).toContain('fetching base.ref failed ref not found');
		expect(execCalls).toContain('git fetch -n origin base-sha');
		expect(logs).toContain('successfully fetched base.sha');
		expect(execCalls).toContain('git reset --hard main');
	});

	test('resets to the base sha when the base ref cannot be reset to', async () => {
		const { failure, execCalls } = await runAction({
			execFailures: {
				'git fetch -n origin main:main': new Error('ref not found'),
				'git reset --hard main': new Error('unknown revision')
			}
		});

		expect(failure).toBeNull();
		expect(execCalls).toContain('git reset --hard base-sha');
	});

	test('falls back to a plain fetch when neither ref nor sha can be fetched', async () => {
		const { failure, execCalls, logs } = await runAction({
			execFailures: {
				'git fetch -n origin main:main': new Error('no ref'),
				'git fetch -n origin base-sha': new Error('no sha')
			}
		});

		expect(failure).toBeNull();
		expect(logs).toContain('fetching base.sha failed no sha');
		expect(execCalls).toContain('git fetch -n');
	});

	test('uses base-ref input instead of the PR base and disables the sha fallback', async () => {
		const { failure, execCalls, logs } = await runAction({ inputs: { 'base-ref': 'v2' } });

		expect(failure).toBeNull();
		expect(logs).toContain('Setting base ref to: "v2"');
		expect(execCalls).toContain('git fetch -n origin v2:v2');
		expect(execCalls).toContain('git reset --hard v2');
		expect(execCalls).not.toContain('git fetch -n origin base-sha');
	});

	test('fails when the base-ref input cannot be fetched', async () => {
		const { failure, execCalls } = await runAction({
			inputs: { 'base-ref': 'v2' },
			execFailures: { 'git fetch -n origin v2:v2': new Error('no such ref') }
		});

		expect(failure).toBe('base.ref fetch failed and no base.sha as fallback');
		expect(execCalls).not.toContain('git reset --hard v2');
	});

	test('honours install-script, build-script and clean-script inputs', async () => {
		const { failure, execCalls } = await runAction({
			inputs: {
				'install-script': 'npm install --legacy-peer-deps',
				'build-script': 'bundle',
				'clean-script': 'clean'
			}
		});

		expect(failure).toBeNull();
		expect(execCalls).toEqual([
			'npm install --legacy-peer-deps',
			'npm run bundle',
			'git reset --hard',
			'git fetch -n origin main:main',
			'npm run clean',
			'git reset --hard main',
			'npm install --legacy-peer-deps',
			'npm run bundle',
			'git reset --hard'
		]);
	});

	test('changes into the cwd input before running', async () => {
		const chdir = vi.spyOn(process, 'chdir').mockImplementation(() => {});

		const { failure } = await runAction({ inputs: { cwd: 'packages/app' } });

		expect(failure).toBeNull();
		expect(chdir).toHaveBeenCalledWith('packages/app');
	});

	test('passes table options through to the markdown report', async () => {
		const sizes: FileSizeMap[] = [
			{ 'dist/a.js': 1000, 'dist/b.js': 500, 'dist/c.js': 300 },
			{ 'dist/a.js': 900, 'dist/b.js': 500, 'dist/c.js': 295 }
		];

		const { octokit } = await runAction({
			sizes,
			inputs: {
				'show-total': 'false',
				'omit-unchanged': 'true',
				'minimum-change-threshold': '10',
				'sort-by': 'Size:desc'
			}
		});

		const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
		expect(body).not.toContain('**Size Change:**');
		expect(body).not.toContain('**Total Size:**');
		expect(body).not.toContain('dist/b.js');
		expect(body).not.toContain('dist/c.js');
		expect(body).not.toContain('View Unchanged');
		expect(body).toContain('| `dist/a.js` | 1 kB | +100 B (+11.11%) | ⚠️ |');
	});

	test('strips hashes from filenames before comparing', async () => {
		const sizes: FileSizeMap[] = [{ 'dist/index.abcde.js': 1200 }, { 'dist/index.fghij.js': 1000 }];

		const { octokit } = await runAction({
			sizes,
			inputs: { 'strip-hash': '\\.(\\w{5})\\.js$' }
		});

		const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
		expect(body).toContain('| `dist/index.*****.js` | 1.2 kB | +200 B (+20%) | 🚨 |');
		expect(body).not.toContain('abcde');
		expect(body).not.toContain('fghij');
	});

	test('reports gzip sizes alongside uncompressed sizes when compression is none', async () => {
		const sizes: FileSizeMap[] = [{ 'dist/index.js': 12000 }, { 'dist/index.js': 10000 }];
		const gzipSizes: FileSizeMap[] = [{ 'dist/index.js': 4000 }, { 'dist/index.js': 3500 }];

		const { failure, octokit, logs } = await runAction({ sizes, gzipSizes, inputs: { compression: 'none' } });

		expect(failure).toBeNull();
		const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
		expect(body).toContain('**Size Change:** +2 kB (+20%) 🚨');
		expect(body).toContain('**Gzip Change:** +500 B (+14.29%)');
		expect(body).toContain('**Total Size:** 12 kB');
		expect(body).toContain('**Total Gzip Size:** 4 kB');
		expect(body).toContain('<summary>📦 <strong>View Changed (uncompressed)</strong></summary>');
		expect(body).toContain('| `dist/index.js` | 12 kB | +2 kB (+20%) | 🚨 |');
		expect(body).toContain('<summary>📦 <strong>View Changed (gzip)</strong></summary>');
		expect(body).toContain('| `dist/index.js` | 4 kB | +500 B (+14.29%) | ⚠️ |');
		expect(logs).toContain(' dist/index.js ⏤ 12 kB (+2 kB)\n');
		expect(logs).toContain(' dist/index.js ⏤ 4 kB (+500 B)\n');
	});

	test('uses the default pattern when none is configured', async () => {
		const { readPatterns } = await runAction();

		expect(readPatterns).toEqual(['**/dist/**/*.{js,mjs,cjs}', '**/dist/**/*.{js,mjs,cjs}']);
	});

	test('reports one table per configured pattern', async () => {
		// Reads happen per pattern in order: PR build for both, then base build for both.
		const sizes: FileSizeMap[] = [
			{ 'packages/app/dist/index.js': 5000 },
			{ 'packages/lib/dist/index.js': 1000 },
			{ 'packages/app/dist/index.js': 2500 },
			{ 'packages/lib/dist/index.js': 1100 }
		];

		const { failure, readPatterns, octokit, logs } = await runAction({
			sizes,
			inputs: { pattern: 'packages/app/dist/**/*.js\n\npackages/lib/dist/**/*.js\n' }
		});

		expect(failure).toBeNull();
		expect(readPatterns).toEqual([
			'packages/app/dist/**/*.js',
			'packages/lib/dist/**/*.js',
			'packages/app/dist/**/*.js',
			'packages/lib/dist/**/*.js'
		]);

		const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
		const appHeading = body.indexOf('### `packages/app/dist/**/*.js`');
		const libHeading = body.indexOf('### `packages/lib/dist/**/*.js`');
		expect(appHeading).toBe(0);
		expect(libHeading).toBeGreaterThan(appHeading);
		expect(body.slice(appHeading, libHeading)).toContain('**Size Change:** +2.5 kB (+100%) 🆘');
		expect(body.slice(appHeading, libHeading)).toContain('| `packages/app/dist/index.js` | 5 kB | +2.5 kB (+100%) | 🆘 |');
		expect(body.slice(libHeading)).toContain('**Size Change:** -100 B (-9.09%) ✅');
		expect(body.slice(libHeading)).toContain('| `packages/lib/dist/index.js` | 1 kB | -100 B (-9.09%) | ✅ |');
		expect(body).toMatch(FOOTER_REGEXP);

		// The job log gets one group per pattern as well.
		expect(logs).toContain(' packages/app/dist/index.js ⏤ 5 kB (+2.5 kB)\n');
		expect(logs).toContain(' packages/lib/dist/index.js ⏤ 1 kB (-100 B)\n');
	});

	test('does not measure gzip separately for other compression modes', async () => {
		const { failure, octokit } = await runAction({ inputs: { compression: 'brotli' } });

		expect(failure).toBeNull();
		const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
		expect(body).toContain('📦 <strong>View Changed (brotli)</strong>');
		expect(body).not.toContain('gzip');
		expect(body).not.toContain('Gzip');
	});

	test('fails when a pattern matches no files in the current build', async () => {
		const { failure, execCalls, octokit } = await runAction({
			sizes: [{}, OLD_SIZES],
			inputs: { pattern: 'build/**/*.js' }
		});

		expect(failure).toBe(
			'No files found for pattern: "build/**/*.js". Check the "pattern", "exclude" and "cwd" inputs and make sure the build script produces the expected output.'
		);
		// Fails before the base branch is checked out and built.
		expect(execCalls).toEqual(['npm ci', 'npm run build']);
		expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
	});

	test('names every unmatched pattern when several are configured', async () => {
		const { failure } = await runAction({
			sizes: [{}, { 'packages/lib/dist/index.js': 1000 }, {}],
			inputs: { pattern: 'packages/app/dist/**/*.js\npackages/lib/dist/**/*.js\npackages/cli/dist/**/*.js' }
		});

		expect(failure).toContain('No files found for patterns: "packages/app/dist/**/*.js", "packages/cli/dist/**/*.js"');
	});

	test('does not fail when files only exist in the current build', async () => {
		const { failure, octokit } = await runAction({ sizes: [NEW_SIZES, {}] });

		expect(failure).toBeNull();
		expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
	});

	test('fails the action when the build fails', async () => {
		const { failure, octokit } = await runAction({
			execFailures: { 'npm run build': new Error('build exploded') }
		});

		expect(failure).toBe('build exploded');
		expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
	});
});
