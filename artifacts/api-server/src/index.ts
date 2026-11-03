import app from "./app";
import { createServer } from "node:http";
import { logger } from "./lib/logger";
import { initializeSafetyRealtime } from "./lib/safety";

const rawPort = process.env["PORT"] || "3000";


const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
initializeSafetyRealtime(server);

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});
