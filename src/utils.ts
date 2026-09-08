import fs from 'fs';
import path from 'path';
import { EOL } from 'os';
import prettyBytes from 'pretty-bytes';

import type { Diff } from './fileSizes';

export interface PackageManagerInfo {
	packageManager: string;
	installScript: string;
}

export async function getPackageManagerAndInstallScript(cwd: string): Promise<PackageManagerInfo> {
	const [yarnLockExists, pnpmLockExists, bunLockBinaryExists, bunLockExists, packageLockExists, denoLockExists] = await Promise.all([
		fileExists(path.resolve(cwd, 'yarn.lock')),
		fileExists(path.resolve(cwd, 'pnpm-lock.yaml')),
		fileExists(path.resolve(cwd, 'bun.lockb')),
		fileExists(path.resolve(cwd, 'bun.lock')),
		fileExists(path.resolve(cwd, 'package-lock.json')),
		fileExists(path.resolve(cwd, 'deno.lock')),
	]);

	let packageManager = 'npm';
	let installScript = 'npm install';
	if (yarnLockExists) {
		installScript = 'yarn --frozen-lockfile';
		packageManager = 'yarn';
	} else if (pnpmLockExists) {
		installScript = 'pnpm install --frozen-lockfile';
		packageManager = 'pnpm';
	} else if (bunLockBinaryExists || bunLockExists) {
		installScript = 'bun install --frozen-lockfile';
		packageManager = 'bun';
	} else if (denoLockExists) {
		installScript = 'deno install --frozen';
		packageManager = 'deno';
	} else if (packageLockExists) {
		installScript = 'npm ci';
	}

	return { packageManager, installScript };
}

/**
 * Check if a given file exists and can be accessed.
 */
export async function fileExists(filename: string): Promise<boolean> {
	try {
		await fs.promises.access(filename, fs.constants.F_OK);
		return true;
	} catch {}
	return false;
}

/**
 * Build a function that removes any matched hash patterns from a filename.
 * Capture groups are replaced with asterisks; without groups the whole match is removed.
 * Returns `undefined` when no pattern is given.
 */
export function stripHash(regex?: string): ((fileName: string) => string) | undefined {
	if (regex) {
		console.log(`Stripping hash from build chunks using '${regex}' pattern.`);
		return function (fileName) {
			return fileName.replace(new RegExp(regex), (str, ...args: unknown[]) => {
				// The last two replacer arguments are the match offset and the whole string.
				const hashes = args.slice(0, -2).filter((c): c is string => c != null);
				if (hashes.length) {
					for (const hash of hashes) {
						str = str.replace(hash, hash.replace(/./g, '*'));
					}
					return str;
				}
				return '';
			});
		};
	}

	return undefined;
}

export function getDeltaText(delta: number, originalSize: number): string {
	let deltaText = (delta > 0 ? '+' : '') + prettyBytes(delta);
	if (Math.abs(delta) === 0) {
		// only print size
	} else if (originalSize === 0) {
		deltaText += ` (new file)`;
	} else if (originalSize === -delta) {
		deltaText += ` (removed)`;
	} else {
		const percentage = Number(((delta / originalSize) * 100).toFixed(2));
		deltaText += ` (${percentage > 0 ? '+' : ''}${percentage}%)`;
	}
	return deltaText;
}

export function iconForDifference(delta: number, originalSize: number): string {
	if (originalSize === 0) return '🆕';

	const percentage = Math.round((delta / originalSize) * 100);
	if (percentage >= 50) return '🆘';
	else if (percentage >= 20) return '🚨';
	else if (percentage >= 10) return '⚠️';
	else if (percentage >= 5) return '🔍';
	else if (percentage <= -50) return '🏆';
	else if (percentage <= -20) return '🎉';
	else if (percentage <= -10) return '👏';
	else if (percentage <= -5) return '✅';
	return '';
}

interface Column {
	header: string;
	align: string;
	/** Hide the column when every cell equals this value. */
	hideIfAll?: string;
}

/**
 * Create a Markdown table from text rows, dropping columns that carry no information.
 */
function markdownTable(columns: Column[], rows: string[][]): string {
	if (rows.length == 0) {
		return '';
	}

	columns = columns.slice();
	rows = rows.map(row => row.slice());
	for (let i = columns.length - 1; i >= 0; i--) {
		const { hideIfAll } = columns[i];
		if (hideIfAll !== undefined && rows.every(row => row[i] === hideIfAll)) {
			columns.splice(i, 1);
			for (const row of rows) row.splice(i, 1);
		}
	}

	if (columns.length === 0) {
		return '';
	}

	return [
		columns.map(column => column.header),
		columns.map(column => column.align),
		...rows
	].map(cells => `| ${cells.join(' | ')} |`).join('\n');
}

export type DiffTableColumn = 'Filename' | 'Size' | 'Change';
export type SortOrder = 'asc' | 'desc';
export type SortBy = `${DiffTableColumn}:${SortOrder}`;

export interface DiffTableOptions {
	showTotal?: boolean;
	collapseUnchanged?: boolean;
	omitUnchanged?: boolean;
	minimumChangeThreshold?: number;
	sortBy: SortBy;
}

const columnIndex: Record<DiffTableColumn, keyof Diff> = {
	Filename: 'filename',
	Size: 'size',
	Change: 'delta'
};

const COLUMNS: Column[] = [
	{ header: 'Filename', align: ':---' },
	{ header: 'Size', align: ':---:' },
	{ header: 'Change', align: ':---:', hideIfAll: '0 B' },
	{ header: '', align: ':---:', hideIfAll: '' }
];

function sizeRow({ filename, size, delta }: Diff): string[] {
	const originalSize = size - delta;
	return [
		`\`${filename}\``,
		prettyBytes(size),
		getDeltaText(delta, originalSize),
		iconForDifference(delta, originalSize)
	];
}

function detailsSection(title: string, rows: string[][], open: boolean): string {
	return `<details${open ? ' open' : ''}><summary>${title}</summary>\n\n${markdownTable(COLUMNS, rows)}\n\n</details>`;
}

/**
 * Create a Markdown table showing diff data.
 *
 * When a second diff measured with gzip is given, the changed files are listed
 * again in a "View Changed (gzip)" table and the totals include gzip figures.
 */
export function diffTable(
	files: Diff[],
	{ showTotal, collapseUnchanged, omitUnchanged, minimumChangeThreshold = 1, sortBy }: DiffTableOptions,
	gzipFiles?: Diff[]
): string {
	const changedRows: string[][] = [];
	const unChangedRows: string[][] = [];
	const gzipChangedRows: string[][] = [];

	const [sortByColumn, sortByDirection] = sortBy.split(':') as [DiffTableColumn, SortOrder];
	const key = columnIndex[sortByColumn];

	files.sort((a, b) => {
		const [left, right] = sortByDirection === 'asc' ? [a, b] : [b, a];
		return String(left[key]).localeCompare(String(right[key]), undefined, { numeric: true });
	});

	const gzipByFilename = new Map(gzipFiles?.map(file => [file.filename, file]));

	let totalSize = 0;
	let totalDelta = 0;
	let totalGzipSize = 0;
	let totalGzipDelta = 0;
	for (const file of files) {
		const { filename, size, delta } = file;
		const gzip = gzipByFilename.get(filename);
		totalSize += size;
		totalGzipSize += gzip?.size ?? 0;

		// A file counts as unchanged based on its primary size, so the gzip
		// table lists exactly the files from the primary changed table.
		const isUnchanged = Math.abs(delta) < minimumChangeThreshold;

		if (!isUnchanged) {
			totalDelta += delta;
			totalGzipDelta += gzip?.delta ?? 0;
		}

		if (isUnchanged && omitUnchanged) continue;

		if (isUnchanged && collapseUnchanged) {
			unChangedRows.push(sizeRow(file));
		} else {
			changedRows.push(sizeRow(file));
			if (gzip) gzipChangedRows.push(sizeRow(gzip));
		}
	}

	let out = '';

	if (changedRows.length !== 0) {
		out = detailsSection('📦 <strong>View Changed</strong>', changedRows, true);
	}

	if (gzipChangedRows.length !== 0) {
		out += `\n\n${detailsSection('📦 <strong>View Changed (gzip)</strong>', gzipChangedRows, true)}`;
	}

	if (unChangedRows.length !== 0) {
		out += `\n\n${detailsSection('ℹ️ <strong>View Unchanged</strong>', unChangedRows, false)}\n\n`;
	}

	if (showTotal) {
		const totalOriginalSize = totalSize - totalDelta;
		const totalDeltaText = getDeltaText(totalDelta, totalOriginalSize);
		const totalIcon = iconForDifference(totalDelta, totalOriginalSize);
		const lines = [`**Size Change:** ${totalDeltaText} ${totalIcon}`];
		if (gzipFiles) {
			lines.push(`**Gzip Change:** ${getDeltaText(totalGzipDelta, totalGzipSize - totalGzipDelta)}`);
		}
		lines.push(`**Total Size:** ${prettyBytes(totalSize)}`);
		if (gzipFiles) {
			lines.push(`**Total Gzip Size:** ${prettyBytes(totalGzipSize)}`);
		}
		out = `${lines.join('\n\n')}\n\n${out}`;
	}

	return out;
}

/**
 * Convert a string "true"/"yes"/"1" argument value to a boolean
 */
export function toBool(v: string): boolean {
	return /^(1|true|yes)$/.test(v);
}

export function getSortOrder(sortBy: string): SortBy {
	const validColumns = ['Filename', 'Size', 'Change'];
	const validDirections = ['asc', 'desc'];

	const [column, direction] = sortBy.split(':');
	if (validColumns.includes(column) && validDirections.includes(direction)) {
		return sortBy as SortBy;
	}
	console.warn(`Invalid 'order-by' value '${sortBy}', defaulting to 'Filename:asc'`);
	return 'Filename:asc';
}

export function setOutput(name: string, value: string): void {
	const outputPath = process.env.GITHUB_OUTPUT;

	if (outputPath) {
		const delimiter = `ghadelimiter_${Date.now()}`;
		fs.appendFileSync(outputPath, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
		return;
	}

	console.log(
		`::set-output name=${name}::${String(value).replace(/\n/g, '%0A').replace(/\r/g, '%0D')}`
	);
}

/**
 * Extract a human readable message from a thrown value.
 */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
