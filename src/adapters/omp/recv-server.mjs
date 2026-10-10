// Throwaway M0 receiver: logs every POST body it gets, then answers 204.
//   node src/adapters/omp/recv-server.mjs
// Overrides: FLOWCARD_RECV_PORT (default 47824), FLOWCARD_RECV_LOG (default /tmp/omp-adapter-recv.log).
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const logPath = process.env.FLOWCARD_RECV_LOG ?? "/tmp/omp-adapter-recv.log";
const port = Number(process.env.FLOWCARD_RECV_PORT ?? 47824);

createServer((req, res) => {
	let body = "";
	req.on("data", chunk => (body += chunk));
	req.on("end", () => {
		const line = `${new Date().toISOString()} ${req.method} ${req.url} ${body}\n`;
		appendFileSync(logPath, line);
		process.stdout.write(line);
		res.writeHead(204).end();
	});
}).listen(port, "127.0.0.1", () => {
	console.log(`listening on 127.0.0.1:${port} -> ${logPath}`);
});
