import { Duration, Option } from "effect";
import { Flag } from "effect/cli";

import { policies } from "../failure.ts";

export const fromFlag = Flag.String("from").pipe(
	Flag.withMetavar("VERSION"),
	Flag.withDescription("Version to start from"),
);
export const toFlag = Flag.String("to").pipe(
	Flag.withMetavar("VERSION"),
	Flag.withDescription("Version to reach"),
);
export const routeFlag = Flag.String("route").pipe(
	Flag.withMetavar("ROUTE"),
	Flag.withDescription("Select a candidate route by its identifier"),
	Flag.optional,
);
export const policyFlag = Flag.Literals("policy", policies).pipe(
	Flag.withDescription("Choose between candidate routes"),
	Flag.optional,
);
export const explainFlag = Flag.Boolean("explain").pipe(
	Flag.withDefault(false),
	Flag.withDescription("Explain instructions that rules removed or replaced"),
);
export const formatFlag = Flag.Literals("format", ["markdown", "html"]).pipe(
	Flag.withDefault("markdown"),
	Flag.withDescription("Document format"),
);
export const outputFlag = Flag.String("output").pipe(
	Flag.withMetavar("PATH"),
	Flag.withDescription("Write the document to a file instead of stdout"),
	Flag.optional,
);

export const unitMillis = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/** Parses durations such as `500ms`, `30s`, `2m`, or `1h`. */
export const parseDuration = (text: string): Option.Option<Duration.Duration> => {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text.trim());
	const amount = match?.[1];
	const unit = match?.[2];
	if (amount === undefined || (unit !== "ms" && unit !== "s" && unit !== "m" && unit !== "h")) {
		return Option.none();
	}

	return Option.some(Duration.millis(Number(amount) * unitMillis[unit]));
};

export const durationFlag = (name: string, description: string) =>
	Flag.String(name).pipe(
		Flag.withMetavar("DURATION"),
		Flag.withDescription(description),
		Flag.filterMap(
			parseDuration,
			(text) => `Expected a duration such as 500ms, 30s, or 2m, got "${text}"`,
		),
		Flag.optional,
	);
