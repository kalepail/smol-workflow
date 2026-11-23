import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const sdkDir = resolve(repoRoot, 'ext/smol-sdk')
const sdkTsconfig = resolve(sdkDir, 'tsconfig.json')
const sdkDist = resolve(sdkDir, 'dist')
const tscBin = resolve(repoRoot, 'node_modules/.bin/tsc')

if (!existsSync(tscBin)) {
	throw new Error(`TypeScript binary not found at ${tscBin}. Run pnpm install first.`)
}

execFileSync(tscBin, ['-p', sdkTsconfig, '--outDir', sdkDist], {
	cwd: repoRoot,
	stdio: 'inherit',
})

function isSameFile(a, b) {
	if (!existsSync(a) || !existsSync(b)) return false
	const sa = statSync(a)
	const sb = statSync(b)
	return sa.dev === sb.dev && sa.ino === sb.ino
}

function safeCopyFile(srcFile, dstFile) {
	if (isSameFile(srcFile, dstFile)) {
		return
	}
	mkdirSync(dirname(dstFile), { recursive: true })
	if (existsSync(dstFile)) {
		// Unlink before copying so stale hardlinks are cleanly replaced
		unlinkSync(dstFile)
	}
	copyFileSync(srcFile, dstFile)
}

function safeSyncDir(srcDir, dstDir) {
	mkdirSync(dstDir, { recursive: true })
	for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
		const srcPath = join(srcDir, entry.name)
		const dstPath = join(dstDir, entry.name)
		if (entry.isDirectory()) {
			safeSyncDir(srcPath, dstPath)
		} else if (entry.isFile()) {
			safeCopyFile(srcPath, dstPath)
		}
	}
}

const installedSdkDir = resolve(repoRoot, 'node_modules/smol-sdk')
if (existsSync(installedSdkDir)) {
	const isSameDir = realpathSync(installedSdkDir) === realpathSync(sdkDir)
	if (!isSameDir) {
		safeSyncDir(sdkDist, resolve(installedSdkDir, 'dist'))

		const sdkPkg = resolve(sdkDir, 'package.json')
		const installedPkg = resolve(installedSdkDir, 'package.json')
		if (existsSync(sdkPkg)) {
			safeCopyFile(sdkPkg, installedPkg)
		}
	}
}
