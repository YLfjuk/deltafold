// The package type-checks without Node.js types. Tests that create directory links
// use Node's symlink directly, because only it can create Windows junctions.
declare module "node:fs/promises" {
	export function symlink(
		target: string,
		path: string,
		type?: "dir" | "file" | "junction",
	): Promise<void>;
}
