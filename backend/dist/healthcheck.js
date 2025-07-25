export default function healthcheck(req, res) {
    if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return true;
    }
    return false;
}
//# sourceMappingURL=healthcheck.js.map