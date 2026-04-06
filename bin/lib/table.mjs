import { createRequire } from "module";

const require = createRequire(import.meta.url);
export const Table = require("cli-table3");
