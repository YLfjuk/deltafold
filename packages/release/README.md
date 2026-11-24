# @deltafold/release

`@deltafold/release` plans and applies local releases for packages modeled with
`deltafold`. You configure a release group once with your version strategy,
dependent policy, and file locations. For each release, it reads manifests and
pending change modules, calculates next versions and dependent range updates,
writes generated version modules and edits, and removes consumed pending modules.

`@deltafold/release` edits local workspace files only. It never commits, tags,
pushes, or publishes packages.

- [Install](#install)
- [Configure a release group](#configure-a-release-group)
- [Resolve, plan, and apply](#resolve-plan-and-apply)
- [Render changelogs](#render-changelogs)
- [License](#license)

## Install

```sh
pnpm add -D @deltafold/release deltafold effect
```

`@deltafold/release` requires `deltafold` and `effect` 4 as peer dependencies.
Its workspace file helpers use Effect's `FileSystem` service.

- `@deltafold/release`: release groups, SemVer strategies, dependent policies,
  and `ReleaseFiles` workspace helpers.
- `@deltafold/release/changelog`: `bySignificance` sections and the
  `dependencies` plugin for `deltafold/changelog`.

## Configure a release group

Define a release change factory with `ReleaseChange.define`, then register each
package in `Release.make`.

```ts
import {
	DependentsPolicy,
	Release,
	ReleaseChange,
	ReleaseFiles,
	SemVerStrategy,
} from "@deltafold/release";
import { adapter } from "./packages/adapter/.deltafold/package.ts";
import { widgets } from "./packages/widgets/.deltafold/package.ts";

export const ProjectChange = ReleaseChange.define<{ readonly area: "api" | "docs" }>();

export const release = Release.make("widgets", {
	packages: [
		{
			package: widgets,
			files: ReleaseFiles.at("packages/widgets", { manifest: "package.json" }),
		},
		{
			package: adapter,
			files: ReleaseFiles.at("packages/adapter", { manifest: "package.json", index: false }),
		},
	],
	change: ProjectChange,
	version: SemVerStrategy.make({ bump: (change) => change.metadata.bump }),
	dependents: DependentsPolicy.propose(),
	replacements: [
		{
			files: ["packages/widgets/src/*.ts", "docs/*.md"],
			match: "@next",
			versionOf: widgets,
		},
	],
});
```

- `ReleaseChange.define` creates a headless `deltafold` `Change` factory whose
  metadata carries `bump` as `"major"`, `"minor"`, or `"patch"`. Any
  `Change.define` factory also works.
- `ReleaseFiles.at` configures each package's manifest path and versions
  directory. That directory defaults to `.deltafold/versions` and keeps an
  `index.ts` module unless `index: false` is set.
- `SemVerStrategy.make` calculates stable and prerelease SemVer versions across
  the shared group or per-package overrides.
- `DependentsPolicy.propose()` rewrites internal dependency ranges when a new
  version falls outside them and proposes releases for affected dependents.
- `replacements` replaces literal tokens such as `@next` across matched files
  when the target package releases.

## Resolve, plan, and apply

Pending change modules live on disk before a release assigns versions to them,
for example under `packages/widgets/.deltafold/changes/timeout.ts`:

```ts
import { ProjectChange } from "../../../../.deltafold/change.ts";

export const timeout = ProjectChange.make("rename-timeout", { bump: "major", area: "api" })`
	Rename timeout to requestTimeout.
`;
```

Use `ReleaseFiles.resolve`, `release.plan`, `ReleaseFiles.prepare`, and
`ReleaseFiles.apply` to inspect and apply edits:

```ts
import { Effect, Result } from "effect";

import { ReleaseFiles } from "@deltafold/release";
import { release } from "./deltafold.config.ts";
import { adapter } from "./packages/adapter/.deltafold/package.ts";
import { timeout } from "./packages/widgets/.deltafold/changes/timeout.ts";
import { widgets } from "./packages/widgets/.deltafold/package.ts";

export const runRelease = Effect.gen(function* () {
	const resolved = yield* ReleaseFiles.resolve(release, {
		packages: [{ package: widgets, changes: [timeout] }, adapter],
	});

	const planned = release.plan(resolved.input);
	if (Result.isFailure(planned)) return yield* Effect.fail(planned.failure);

	const prepared = yield* ReleaseFiles.prepare(planned.success, {
		pending: ["packages/*/.deltafold/changes/*.ts"],
		snapshot: resolved.snapshot,
	});

	return yield* ReleaseFiles.apply(prepared);
});
```

`ReleaseFiles.resolve` and `ReleaseFiles.prepare` never write to disk.
`ReleaseFiles.apply` checks that no read file or glob match changed after
preparation, writes generated version modules, manifests, and replacements, and
removes consumed pending modules. If a write fails, it restores earlier writes
where possible and fails with the paths it could not restore.

## Render changelogs

Pair `deltafold/changelog` with `@deltafold/release/changelog` to group changes
under Major Changes, Minor Changes, and Patch Changes headings and append
Updated Dependencies sections from recorded range updates.

```ts
import { ReleaseChangelog } from "@deltafold/release/changelog";
import { Version } from "deltafold";
import { Changelog } from "deltafold/changelog";
import * as Markdown from "deltafold/markdown";

const changelog = Changelog.make<ReleaseChangelog.DependencyMetadata>({
	sections: ReleaseChangelog.bySignificance,
	plugins: [ReleaseChangelog.dependencies()],
});

Markdown.render(
	changelog.history(adapter, {
		releases: [
			Version.withMetadata(v2, {
				dependencies: [
					{
						dependency: "@acme/widgets",
						field: "peerDependencies",
						from: "^1.2.0",
						to: "^2.0.0",
						version: "2.0.0",
					},
				],
			}),
		],
	}),
);
```

## License

[MIT](https://github.com/YLfjuk/deltafold/blob/main/LICENSE)
