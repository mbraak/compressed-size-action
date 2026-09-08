import path from 'path';
import { toBool, getDeltaText, iconForDifference, diffTable, diffReport, parsePatterns, getPackageManagerAndInstallScript, fileExists, stripHash, errorMessage } from '../src/utils';

test('toBool', () => {
	expect(toBool('1')).toBe(true);
	expect(toBool('true')).toBe(true);
	expect(toBool('yes')).toBe(true);

	expect(toBool('0')).toBe(false);
	expect(toBool('false')).toBe(false);
	expect(toBool('no')).toBe(false);
});

test('getDeltaText', () => {
	expect(getDeltaText(5000, 20000)).toBe('+5 kB (+25%)');
	expect(getDeltaText(-5000, 20000)).toBe('-5 kB (-25%)');
	expect(getDeltaText(210, 0)).toBe('+210 B (new file)');
	expect(getDeltaText(0, 0)).toBe('0 B');
	expect(getDeltaText(4875, 20000)).toBe('+4.88 kB (+24.38%)');
	expect(getDeltaText(-4875, 20000)).toBe('-4.88 kB (-24.38%)');
});

test('iconForDifference', () => {
	expect(iconForDifference(0, 5000)).toBe('');
	expect(iconForDifference(5500, 5000)).toBe('🆘');
	expect(iconForDifference(-550, 5000)).toBe('👏');
});

test('diffTable', () => {
	const files = [
		{
			filename: 'one.js',
			size: 5000,
			delta: 2500
		},
		{
			filename: 'two.js',
			size: 5000,
			delta: -2500
		},
		{
			filename: 'three.js',
			size: 300,
			delta: 0
		},
		{
			filename: 'four.js',
			size: 4500,
			delta: 9
		},
		{
			filename: 'five.js',
			size: 6500,
			delta: 0
		},
	];
	const defaultOptions = {
		compression: 'gzip' as const,
		showTotal: true,
		collapseUnchanged: true,
		omitUnchanged: false,
		minimumChangeThreshold: 1,
		sortBy: 'Filename:asc' as const
	};

	expect(diffTable(files, { ...defaultOptions })).toMatchSnapshot();
	expect(diffTable(files, { ...defaultOptions, showTotal: false })).toMatchSnapshot();
	expect(diffTable(files, { ...defaultOptions, collapseUnchanged: false })).toMatchSnapshot();
	expect(diffTable(files, { ...defaultOptions, omitUnchanged: true })).toMatchSnapshot();
	expect(diffTable(files, { ...defaultOptions, minimumChangeThreshold: 10 })).toMatchSnapshot();
	expect(diffTable(files.map(file => ({...file, delta: 0})), { ...defaultOptions })).toMatchSnapshot();

	expect(diffTable([files[2]], { ...defaultOptions })).toMatchSnapshot();

	expect(diffTable(files, { ...defaultOptions, sortBy: 'Filename:desc' })).toMatchSnapshot();
	expect(diffTable(files, { ...defaultOptions, sortBy: 'Size:asc' })).toMatchSnapshot();
	expect(diffTable(files, { ...defaultOptions, sortBy: 'Change:desc' })).toMatchSnapshot();
});

test('getPackageManagerAndInstallScript', async () => {
	let cwd = process.cwd();
	let { packageManager, installScript } = await getPackageManagerAndInstallScript(cwd);
	expect(packageManager).toBe('npm');
	expect(installScript).toBe('npm ci');

	cwd = path.join(cwd, 'tests');
	({ packageManager, installScript } = await getPackageManagerAndInstallScript(cwd));
	expect(packageManager).toBe('npm');
	expect(installScript).toBe('npm install');
});

test('fileExists', async () => {
	expect(await fileExists('package.json')).toBe(true);
	expect(await fileExists('file-that-does-not-exist')).toBe(false);
});

test('stripHash', () => {
	expect(stripHash('\\b\\w{5}\\.')!('foo.abcde.js')).toBe('foo.js');
	expect(stripHash('\\.(\\w{5})\\.chunk\\.js$')!('foo.abcde.chunk.js')).toBe('foo.*****.chunk.js');
	expect(stripHash('')).toBe(undefined);
});

test('errorMessage', () => {
	expect(errorMessage(new Error('boom'))).toBe('boom');
	expect(errorMessage(new TypeError('bad type'))).toBe('bad type');
	expect(errorMessage('plain string')).toBe('plain string');
	expect(errorMessage(42)).toBe('42');
	expect(errorMessage(undefined)).toBe('undefined');
});

test('diffTable with gzip information', () => {
	const files = [
		{ filename: 'one.js', size: 5000, delta: 2500 },
		{ filename: 'two.js', size: 5000, delta: -2500 },
		{ filename: 'three.js', size: 300, delta: 0 },
		{ filename: 'four.js', size: 200, delta: 200 }
	];
	const gzipFiles = [
		{ filename: 'one.js', size: 1500, delta: 500 },
		{ filename: 'two.js', size: 1600, delta: -400 },
		{ filename: 'three.js', size: 120, delta: 0 },
		{ filename: 'four.js', size: 90, delta: 90 }
	];
	const options = {
		compression: 'none' as const,
		showTotal: true,
		collapseUnchanged: true,
		omitUnchanged: false,
		minimumChangeThreshold: 1,
		sortBy: 'Filename:asc' as const
	};

	const out = diffTable(files, options, gzipFiles);
	expect(out).toContain('**Size Change:** +200 B (+1.94%) ');
	expect(out).toContain('**Gzip Change:** +190 B (+6.09%)');
	expect(out).toContain('**Total Size:** 10.5 kB');
	expect(out).toContain('**Total Gzip Size:** 3.31 kB');

	// Primary tables keep their usual shape.
	expect(out).toContain('<details open><summary>📦 <strong>View Changed (uncompressed)</strong></summary>');
	expect(out).toContain('| `one.js` | 5 kB | +2.5 kB (+100%) | 🆘 |');
	expect(out).toContain('| Filename | Size | Change |  |');
	expect(out).not.toContain('| Gzip Size |');

	// Gzip gets its own tables listing the same files.
	expect(out).toContain('<details open><summary>📦 <strong>View Changed (gzip)</strong></summary>');
	expect(out).toContain('| `one.js` | 1.5 kB | +500 B (+50%) | 🆘 |');
	expect(out).toContain('| `four.js` | 90 B | +90 B (new file) | 🆕 |');
	// Unchanged files only appear once, without a gzip counterpart.
	expect(out).toContain('<details><summary>ℹ️ <strong>View Unchanged</strong></summary>');
	expect(out).not.toContain('View Unchanged (gzip)');
	expect(out).not.toContain('| `three.js` | 120 B |');
	expect(out).toMatchSnapshot();

	// Without gzip data the table keeps its original shape.
	const plain = diffTable(files, options);
	expect(plain).not.toContain('Gzip');
	expect(plain).not.toContain('gzip');
});

test('diffTable names the compression method in the title', () => {
	const files = [{ filename: 'one.js', size: 5000, delta: 2500 }];
	const options = { sortBy: 'Filename:asc' as const };

	expect(diffTable(files, { ...options, compression: 'gzip' })).toContain('📦 <strong>View Changed (gzip)</strong>');
	expect(diffTable(files, { ...options, compression: 'brotli' })).toContain('📦 <strong>View Changed (brotli)</strong>');
	expect(diffTable(files, { ...options, compression: 'none' })).toContain('📦 <strong>View Changed (uncompressed)</strong>');
});

test('parsePatterns', () => {
	const fallback = '**/dist/**/*.{js,mjs,cjs}';

	expect(parsePatterns('', fallback)).toEqual([fallback]);
	expect(parsePatterns('  \n\n', fallback)).toEqual([fallback]);
	expect(parsePatterns('dist/**/*.js', fallback)).toEqual(['dist/**/*.js']);
	// Patterns may contain commas inside braces, so only newlines separate them.
	expect(parsePatterns('dist/**/*.{js,mjs}\n  lib/**/*.js  \r\n\nbuild/*.css\n', fallback)).toEqual([
		'dist/**/*.{js,mjs}',
		'lib/**/*.js',
		'build/*.css'
	]);
});

test('diffReport', () => {
	const options = {
		compression: 'gzip' as const,
		showTotal: true,
		collapseUnchanged: true,
		omitUnchanged: false,
		minimumChangeThreshold: 1,
		sortBy: 'Filename:asc' as const
	};
	const app = [
		{ filename: 'app/index.js', size: 5000, delta: 2500 },
		{ filename: 'app/vendor.js', size: 300, delta: 0 }
	];
	const lib = [{ filename: 'lib/index.js', size: 1000, delta: -100 }];

	// A single pattern renders exactly like diffTable, with no heading.
	const single = diffReport([{ pattern: 'app/**/*.js', files: app.map(f => ({ ...f })) }], options);
	expect(single).toBe(diffTable(app.map(f => ({ ...f })), options));
	expect(single).not.toContain('###');

	const multi = diffReport(
		[
			{ pattern: 'app/**/*.js', files: app.map(f => ({ ...f })) },
			{ pattern: 'lib/**/*.js', files: lib.map(f => ({ ...f })) }
		],
		options
	);
	const appHeading = multi.indexOf('### `app/**/*.js`');
	const libHeading = multi.indexOf('### `lib/**/*.js`');
	expect(appHeading).toBe(0);
	expect(libHeading).toBeGreaterThan(appHeading);
	// Each block carries its own totals and tables.
	expect(multi.slice(appHeading, libHeading)).toContain('**Total Size:** 5.3 kB');
	expect(multi.slice(appHeading, libHeading)).toContain('| `app/index.js` | 5 kB | +2.5 kB (+100%) | 🆘 |');
	expect(multi.slice(appHeading, libHeading)).toContain('View Unchanged');
	expect(multi.slice(libHeading)).toContain('**Total Size:** 1 kB');
	expect(multi.slice(libHeading)).toContain('| `lib/index.js` | 1 kB | -100 B (-9.09%) | ✅ |');
	expect(multi.slice(libHeading)).not.toContain('View Unchanged');
	expect(multi).not.toMatch(/\n{3,}/);
	expect(multi).toMatchSnapshot();
});
