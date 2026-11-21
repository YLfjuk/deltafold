import { ReleaseChange } from "@deltafold/release";

export const ProjectChange = ReleaseChange.define<{ area: "api" | "docs" }>();
