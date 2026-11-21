import { History, Package } from "deltafold";
import manifest from "../package.json" with { type: "json" };
import { version } from "./versions/1.2.0.ts";
import { versions } from "./versions/index.ts";

export const widgets = Package.make(manifest.name, {
	history: History.make({ versions: [version, ...versions], migrations: [] }),
});
