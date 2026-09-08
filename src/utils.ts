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

/**
 * Create a Markdown table from text rows
 */
function markdownTable(rows: string[][]): string {
	if (rows.length == 0) {
		return '';
	}

	// Skip all empty columns
	while (rows.every(columns => !columns[columns.length - 1])) {
		for (const columns of rows) {
			columns.pop();
		}
	}

	const [firstRow] = rows;
	let columnLength = firstRow.length;

	// Hide `Change` column if they are all `0 B`
	if (columnLength === 3 && rows.every(columns => columns[2] === '0 B')) {
		columnLength -= 1;
		for (const columns of rows) {
			columns.pop();
		}
	}

	if (columnLength === 0) {
		return '';
	}

	return [
		// Header
		['Filename', 'Size', 'Change', ''].slice(0, columnLength),
		// Align
		[':---', ':---:', ':---:', ':---:'].slice(0, columnLength),
		// Body
		...rows
	].map(columns => `| ${columns.join(' | ')} |`).join('\n');
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

/**
 * Create a Markdown table showing diff data
 */
export function diffTable(
	files: Diff[],
	{ showTotal, collapseUnchanged, omitUnchanged, minimumChangeThreshold = 1, sortBy }: DiffTableOptions
): string {
	const changedRows: string[][] = [];
	const unChangedRows: string[][] = [];

	const [sortByColumn, sortByDirection] = sortBy.split(':') as [DiffTableColumn, SortOrder];
	const key = columnIndex[sortByColumn];

	files.sort((a, b) => {
		const [left, right] = sortByDirection === 'asc' ? [a, b] : [b, a];
		return left[key].toString().localeCompare(right[key].toString(), undefined, { numeric: true });
	});

	let totalSize = 0;
	let totalDelta = 0;
	for (const file of files) {
		const { filename, size, delta } = file;
		totalSize += size;

		const originalSize = size - delta;
		const isUnchanged = Math.abs(delta) < minimumChangeThreshold;

		if (!isUnchanged) totalDelta += delta;

		if (isUnchanged && omitUnchanged) continue;

		const row = [
			`\`${filename}\``,
			prettyBytes(size),
			getDeltaText(delta, originalSize),
			iconForDifference(delta, originalSize)
		];
		if (isUnchanged && collapseUnchanged) {
			unChangedRows.push(row);
		} else {
			changedRows.push(row);
		}
	}

	let out = '';

	if (changedRows.length !== 0) {
		const outChanged = markdownTable(changedRows);
		out = `<details open><summary>📦 <strong>View Changed</strong></summary>\n\n${outChanged}\n\n</details>`;
	}

	if (unChangedRows.length !== 0) {
		const outUnchanged = markdownTable(unChangedRows);
		out += `\n\n<details><summary>ℹ️ <strong>View Unchanged</strong></summary>\n\n${outUnchanged}\n\n</details>\n\n`;
	}

	if (showTotal) {
		const totalOriginalSize = totalSize - totalDelta;
		const totalDeltaText = getDeltaText(totalDelta, totalOriginalSize);
		const totalIcon = iconForDifference(totalDelta, totalOriginalSize);
		out = `**Total Size:** ${prettyBytes(totalSize)}\n\n${out}`;
		out = `**Size Change:** ${totalDeltaText} ${totalIcon}\n\n${out}`;
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
