import { Array as Arr, Cause, Context, Effect, Option, Result, Schema, Scope } from "effect";
import type { SourceFile } from "typescript-7.1/ast";
import type { Project as CompilerProject } from "typescript-7.1/async";

import { type Action, Handler } from "deltafold";
import { applyEdits, type Edits, type FileEdit, makeEdits, splitByteOrderMark } from "./edits.ts";
import {
	type AdapterCause,
	CompilerFailed,
	EditRejected,
	type Failure,
	type GuardedError,
	ReadFailed,
	SyntaxErrors,
	TransformFailed,
	UnknownError,
	type WriteFailed,
} from "./errors.ts";
import { checkJson, isJsonPath } from "./jsonc.ts";
import { byCodePoint, compareCodePoints, ordering } from "./paths.ts";
import type { Info } from "./project.ts";
import { type Internals, internals, type Opened, Workspace, type Write } from "./workspace.ts";

/** Named Effect services that Promise transforms declare. */
// oxlint-disable-next-line typescript/no-generated-empty-object-type -- Transforms without services declare an empty service map.
export type NoServices = Record<never, never>;

export type ServiceIds<S extends Handler.ServiceMap> = {
	[K in keyof S]: S[K] extends Context.Key<infer I, any> ? I : never;
}[keyof S];

export type ResolvedServices<S extends Handler.ServiceMap> = {
	readonly [K in keyof S]: S[K]["Service"];
};

/** The files of one compiler project that the action matched. */
export type Unit = {
	readonly info: Info;
	readonly project: CompilerProject;
	/** Root-relative paths, sorted. */
	readonly files: ReadonlyArray<string>;
	/** Source files of `files` that have no syntax errors. */
	readonly sources: ReadonlyMap<string, SourceFile>;
	/** Whether any file of the unit has syntax errors. */
	readonly blocked: boolean;
	readonly workspace: Internals;
	/** The root-relative path of a matched file, from any name the compiler uses for it. */
	readonly pathOf: (fileName: string) => string | undefined;
	/** The name under which the compiler knows a matched file. */
	readonly compilerPath: (path: string) => string;
	/** Edit helpers that accept nodes of the given root-relative paths only. */
	readonly edits: (allowed: ReadonlyArray<string>) => Edits;
};

/** What the transforms of one unit produced. */
export type UnitResult<C> = {
	readonly failures: ReadonlyArray<Failure<C>>;
	readonly edits: ReadonlyArray<FileEdit>;
};

/** The writes that a prepare phase hands to its apply phase. */
type Pending = { readonly writes: ReadonlyArray<Write> };

const request = <T>(actionId: string, root: string, evaluate: () => PromiseLike<T>) =>
	Effect.tryPromise({
		try: () => Promise.resolve(evaluate()),
		catch: (cause) => new CompilerFailed({ actionId, root, stage: "request", cause }),
	});

const projectInfo = (workspace: Internals, root: string, project: CompilerProject): Info => {
	const config = project.configFileName;
	if (config === undefined) return { kind: "inferred", id: String(project.id) };
	const absolute = String(config).replaceAll("\\", "/");
	const prefix = `${workspace.canonical(root)}/`;

	return {
		kind: "configured",
		config: workspace.canonical(absolute).startsWith(prefix)
			? absolute.slice(prefix.length)
			: absolute,
	};
};

const infoKey = (info: Info) => (info.kind === "configured" ? info.config : `inferred:${info.id}`);

const compareFailures = <C>(a: Failure<C>, b: Failure<C>) =>
	ordering(
		compareCodePoints(a.path ?? "", b.path ?? "") ||
			compareCodePoints(infoKey(a.project), infoKey(b.project)),
	);

const loadUnits = (
	actionId: string,
	root: string,
	workspace: Internals,
	opened: Opened,
	paths: ReadonlyArray<string>,
	raws: ReadonlyMap<string, string>,
) =>
	Effect.gen(function* () {
		const { snapshot } = opened;
		const compilerPath = (path: string) => opened.compilerPath(workspace.absolute(path));
		const byCanonical = new Map<string, string>();
		for (const path of paths) {
			for (const name of [workspace.absolute(path), compilerPath(path)]) {
				const key = workspace.canonical(name);
				const owner = byCanonical.get(key);
				// Two matched files must never share a compiler name.
				if (owner !== undefined && owner !== path) {
					return yield* new CompilerFailed({
						actionId,
						root,
						stage: "snapshot",
						cause: new Error(`${path} and ${owner} share the compiler name ${name}`),
					});
				}
				byCanonical.set(key, path);
			}
		}
		const pathOf = (fileName: string) => byCanonical.get(workspace.canonical(fileName));
		const groups = new Map<string, { project: CompilerProject; files: Array<string> }>();
		for (const path of paths) {
			const project = yield* request(actionId, root, () =>
				snapshot.getDefaultProjectForFile(compilerPath(path)),
			);
			if (project === undefined) {
				return yield* new CompilerFailed({
					actionId,
					root,
					stage: "request",
					cause: new Error(`The compiler assigned no project to ${path}`),
				});
			}
			const key = String(project.id);
			const group = groups.get(key) ?? { project, files: [] };
			group.files.push(path);
			groups.set(key, group);
		}

		const units: Array<Unit> = [];
		const failures: Array<Failure<SyntaxErrors>> = [];
		for (const { project, files } of groups.values()) {
			const info = projectInfo(workspace, root, project);
			const sources = new Map<string, SourceFile>();
			let blocked = false;
			for (const path of files) {
				const sourceFile = yield* request(actionId, root, () =>
					project.program.getSourceFile(compilerPath(path)),
				);
				if (
					sourceFile === undefined ||
					sourceFile.text !== splitByteOrderMark(raws.get(path)!).text
				) {
					return yield* new ReadFailed({ actionId, root, path, reason: "changed" });
				}
				const diagnostics = yield* request(actionId, root, () =>
					project.program.getSyntacticDiagnostics(compilerPath(path)),
				);
				if (diagnostics.length > 0) {
					blocked = true;
					failures.push({
						project: info,
						path,
						cause: new SyntaxErrors({
							path,
							messages: diagnostics.map((diagnostic) => diagnostic.text),
						}),
					});
				} else sources.set(path, sourceFile);
			}

			const edits = (allowed: ReadonlyArray<string>) => {
				const permitted = new Set(allowed);

				return makeEdits((sourceFile) => {
					const fileName = String(sourceFile.fileName);
					const path = pathOf(fileName);
					if (path === undefined || !permitted.has(path)) {
						throw new EditRejected({
							path: path ?? fileName,
							reason: "The transform may not edit this file",
							ranges: [],
						});
					}

					return path;
				});
			};

			units.push({
				info,
				project,
				files,
				sources,
				blocked,
				workspace,
				pathOf,
				compilerPath,
				edits,
			});
		}

		return { units, failures };
	});

/**
 * The prepare phase shared by file and project transforms: match, lock, read, open a
 * snapshot, run the transforms, and compute the files to write. The snapshot closes
 * when preparation ends; the locks stay with the occurrence until it ends.
 */
export const prepare = <C, R>(
	action: Action.Any,
	include: ReadonlyArray<string>,
	run: (unit: Unit) => Effect.Effect<UnitResult<C | AdapterCause>, CompilerFailed, R>,
): Effect.Effect<
	Handler.Preparation<Pending>,
	TransformFailed<C> | ReadFailed | CompilerFailed,
	Workspace | Scope.Scope | R
> =>
	Effect.gen(function* () {
		const service = yield* Workspace;
		const workspace = internals(service);
		const { root } = service;

		const paths = yield* workspace.match(action.id, include);
		if (paths.length === 0) return Handler.skip("No files match the include patterns");

		yield* service.lock(paths);
		const raws = new Map<string, string>();
		for (const path of paths) raws.set(path, yield* workspace.read(action.id, path));

		const { failures, edits, projects } = yield* Effect.scoped(
			Effect.gen(function* () {
				const opened = yield* workspace.open(
					action.id,
					paths.map((path) => ({ path, text: splitByteOrderMark(raws.get(path)!).text })),
				);
				const loaded = yield* loadUnits(action.id, root, workspace, opened, paths, raws);
				const collected: Array<Failure<C | AdapterCause>> = [...loaded.failures];
				const produced: Array<FileEdit> = [];
				const owners = new Map<string, Info>();
				for (const unit of loaded.units) {
					for (const path of unit.files) owners.set(path, unit.info);
					const result = yield* run(unit);
					collected.push(...result.failures);
					produced.push(...result.edits);
				}

				return { failures: collected, edits: produced, projects: owners };
			}),
		);
		if (failures.length > 0) {
			return yield* new TransformFailed<C>({
				actionId: action.id,
				root,
				failures: Arr.sort(failures, compareFailures<C | AdapterCause>),
			});
		}

		const byPath = new Map<string, Array<FileEdit>>();
		for (const edit of edits) {
			const list = byPath.get(edit.path) ?? [];
			list.push(edit);
			byPath.set(edit.path, list);
		}
		const writes: Array<Write> = [];
		const rejected: Array<Failure<EditRejected>> = [];
		for (const path of Arr.sort(byPath.keys(), byCodePoint)) {
			const raw = raws.get(path)!;
			const { bom, text } = splitByteOrderMark(raw);
			const applied = applyEdits(path, text, byPath.get(path)!);
			const project = projects.get(path)!;
			if (applied instanceof EditRejected) {
				rejected.push({ project, path, cause: applied });
				continue;
			}
			const reason = isJsonPath(path) ? checkJson(text, applied) : undefined;
			if (reason !== undefined) {
				rejected.push({
					project,
					path,
					cause: new EditRejected({ path, reason, ranges: [] }),
				});
				continue;
			}
			const next = bom + applied;
			if (next !== raw) writes.push({ path, expected: raw, text: next });
		}
		if (rejected.length > 0) {
			return yield* new TransformFailed<C>({ actionId: action.id, root, failures: rejected });
		}
		if (writes.length === 0) return Handler.skip("No matched file would change");

		return Handler.prepared<Pending>({ writes });
	});

/** The apply phase: writes the prepared files. */
export const apply = (
	actionId: string,
	pending: Pending,
): Effect.Effect<void, WriteFailed, Workspace> =>
	Effect.gen(function* () {
		const service = yield* Workspace;
		yield* internals(service).write(actionId, pending.writes);
	});

/** Keeps adapter causes and recognized errors; wraps the rest in `UnknownError`. */
export const classify =
	<G extends ReadonlyArray<Handler.ErrorGuard>>(guards: G) =>
	(cause: unknown): GuardedError<G[number]> | UnknownError | EditRejected => {
		if (cause instanceof EditRejected) return cause;
		const declared = guards.some((guard) =>
			Schema.isSchema(guard) ? Schema.is(guard)(cause) : guard(cause),
		);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A guard recognized the cause.
		return declared ? (cause as GuardedError<G[number]>) : new UnknownError({ cause });
	};

/** Resolves a Promise transform's declared services. */
export const resolveServices = <S extends Handler.ServiceMap>(services: S | undefined) =>
	Effect.map(
		Effect.context<ServiceIds<S>>(),
		(context) =>
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries does not track keys.
			Object.fromEntries(
				Reflect.ownKeys(services ?? {}).map((name) => [
					name,
					Context.get(context, services![name]!),
				]),
			) as ResolvedServices<S>,
	);

/**
 * Runs a Promise transform with an `AbortSignal` that interruption aborts. A rejection
 * becomes a failure result; interruption stays interruption.
 */
export const runPromise = <T, C>(
	call: (signal: AbortSignal) => PromiseLike<T> | T,
	classifyCause: (cause: unknown) => C,
): Effect.Effect<Result.Result<T, C>> =>
	Effect.result(
		Effect.tryPromise({
			// Declaring `signal` makes Effect.tryPromise allocate an AbortController.
			try: (signal) => Promise.resolve(call(signal)),
			catch: classifyCause,
		}),
	);

/**
 * Runs an Effect transform. Its failures keep their type; a defect becomes
 * `UnknownError`, or stays an `EditRejected` thrown by an edit helper. Interruption
 * stays interruption.
 */
export const runEffect = <T, E, R>(
	transform: Effect.Effect<T, E, R>,
): Effect.Effect<Result.Result<T, E | UnknownError | EditRejected>, never, R> =>
	Effect.result(
		Effect.catchCause(
			transform,
			(cause): Effect.Effect<never, E | UnknownError | EditRejected> => {
				if (Cause.hasInterrupts(cause)) return Effect.failCause(Cause.interrupt());
				const failure = Cause.findErrorOption(cause);
				if (Option.isSome(failure)) return Effect.fail(failure.value);
				const defect = Cause.squash(cause);

				return Effect.fail(
					defect instanceof EditRejected ? defect : new UnknownError({ cause: defect }),
				);
			},
		),
	);
