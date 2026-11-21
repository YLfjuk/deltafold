import { ProjectChange } from "../changes.ts";

export const headers = ProjectChange.make("escape-headers", { bump: "patch", area: "api" })`
	Escape header values before sending requests.
`;
