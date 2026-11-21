import { timeoutGuide } from "../../docs/links.ts";
import { ProjectChange } from "../change.ts";

export const timeout = ProjectChange.make("rename-timeout", { bump: "major", area: "api" })`
	Rename timeout to requestTimeout. See ${timeoutGuide}.
`;
