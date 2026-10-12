import { assertPinnedHost } from "./pinned-host.mjs";
const { pin } = await assertPinnedHost();
process.stdout.write(`Qualified host ${pin.version} at ${pin.commit}\n`);
