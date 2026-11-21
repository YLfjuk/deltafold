import { ProjectChange } from "../changes.ts";
import { timeoutGuide } from "../docs/links.ts";

export const timeout = ProjectChange.make("rename-timeout", { bump: "major", area: "api" })`
	Rename timeout to requestTimeout. See ${timeoutGuide}.
`;
