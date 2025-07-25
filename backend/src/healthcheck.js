// healthchech.jks

function healthcheck(req, res) {
	if (req.url === 'health' && req.method === 'GET') {
		// sends headers
		res.writeHead(200, { 'Content-Type': 'application/json' });
		// sends a response and ends connection
		res.end(JSON.stringify({status: 'ok'}));
		return true;
	}
	return false;
}
