import http from 'http';
import healthcheck from './healthcheck.js';
const server = http.createServer((req, res) => {
    if (healthcheck(req, res))
        return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
//# sourceMappingURL=server.js.map